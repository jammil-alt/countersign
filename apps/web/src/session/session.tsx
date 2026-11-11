import type { SessionResponse } from "@countersign/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApiClient, useApiStore } from "../api/useApi";
import { identifyForErrors } from "../observability";
import { idleTooLong, watchInput } from "./activity";

// DECISION: the app checks for idleness every 30 seconds; the API refuses an idle session anyway,
// this only signs the browser out cleanly instead of failing its next call.
const IDLE_CHECK_MS = 30_000;

// Who is signed in, shared between tabs (docs/audit-plan.md 1.2). Every answer to `/api/session`
// and every sign-out writes a fingerprint of this tab's scope (a hash of user and client, never an
// answer); a tab that sees another fingerprint than its own empties its store and asks who is
// signed in, so one person's stored answers never show under another's session. A fresh page load
// counts too, so a WorkOS sign-in (which arrives as one) reaches the tabs already open.
export const SESSION_SCOPE_KEY = "cs.sessionScope";

/** FNV-1a of the scope, in hex: who it is can't be read back from it. "" when signed out. */
export function scopeFingerprint(scope: string | null): string {
  if (!scope) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < scope.length; i++) {
    h ^= scope.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function shareScope(scope: string | null): void {
  try {
    // Writing the value already there tells no one (no storage event), so this costs nothing.
    globalThis.localStorage?.setItem(SESSION_SCOPE_KEY, scopeFingerprint(scope));
  } catch {
    // Storage blocked: other tabs find out on their next call, which the API refuses or answers.
  }
}

export type SessionState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "error"; error: unknown }
  | { status: "signed_in"; session: SessionResponse };

interface SessionContextValue {
  state: SessionState;
  /** Reloads `/api/session` (after sign-in or a switch). */
  refresh: () => Promise<SessionState>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useApiClient();
  const store = useApiStore();
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async (): Promise<SessionState> => {
    let next: SessionState;
    try {
      next = { status: "signed_in", session: await client.call(apiRoutes.session) };
    } catch (error) {
      next =
        isApiError(error) && error.unauthenticated
          ? { status: "signed_out" }
          : {
              status: "error",
              error,
            };
    }
    // Stored answers belong to one user and one active client: anything else empties the store
    // before a screen can read it (docs/audit-plan.md 1.2). Signed out, the store stays closed
    // until the signed-in screens have gone (the effect below opens it).
    if (next.status === "signed_in") {
      store.open();
      store.setScope(`${next.session.user.id}\u0001${next.session.activeTenantId ?? ""}`);
    } else {
      // A session that ended closes the store (the effect below opens it once its screens have
      // gone); a tab that was already signed out has nothing to drop and stays open.
      if (store.signedIn) store.close();
      else store.open();
      store.setScope("");
    }
    shareScope(store.currentScope);
    setState(next);
    if (next.status === "signed_in") {
      identifyForErrors({ id: next.session.user.id, operator: next.session.operator });
    } else if (next.status === "signed_out") {
      identifyForErrors(null);
    }
    return next;
  }, [client, store]);

  const signOut = useCallback(async () => {
    // Signing out (by hand or after the idle limit) forgets every stored answer at once, and asks
    // nothing more until the signed-in screens have gone: they would ask with the old cookie.
    store.close();
    store.setScope("");
    shareScope("");
    let redirectTo: string | null = null;
    try {
      redirectTo = (await client.call(apiRoutes.signOut)).redirectTo;
    } finally {
      // A failed sign-out still drops the local session view; the next call re-checks it.
      setState({ status: "signed_out" });
    }
    // WorkOS may name its own sign-out page; the dev adapter never does.
    if (redirectTo) window.location.assign(redirectTo);
  }, [client, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Signed out (or the session failed): the signed-in screens are gone now, so the store may
  // answer the sign-in page again.
  const status = state.status;
  useEffect(() => {
    if (status === "signed_out" || status === "error") store.open();
  }, [status, store]);

  // Another tab found someone else (or no one) signed in: forget everything and ask who is
  // signed in here now. The same fingerprint as this tab's changes nothing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_SCOPE_KEY) return;
      if ((e.newValue ?? "") === scopeFingerprint(store.currentScope)) return;
      if (store.signedIn) store.close();
      void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh, store]);

  // Signed in: count the person's input, and sign out after 30 minutes without any (§1.35).
  const signedIn = state.status === "signed_in";
  useEffect(() => {
    if (!signedIn || typeof window === "undefined") return;
    const stop = watchInput(window);
    const timer = setInterval(() => {
      if (idleTooLong()) void signOut();
    }, IDLE_CHECK_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [signedIn, signOut]);

  const value = useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionState(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionState outside <SessionProvider>");
  return ctx;
}

/** The signed-in session; only for screens rendered behind the sign-in gate. */
export function useSession(): SessionResponse {
  const { state } = useSessionState();
  if (state.status !== "signed_in") throw new Error("useSession before sign-in");
  return state.session;
}

/** Where a user lands after sign-in (plan §1.2): operators in /ops, clients in /. */
export function homeFor(session: SessionResponse): string {
  return session.operator ? "/ops" : "/";
}

export function displayName(user: SessionResponse["user"]): string {
  return user.name?.trim() || user.email;
}

/** The header avatar's one letter, as in the design. */
export function userInitial(user: SessionResponse["user"]): string {
  return (displayName(user)[0] ?? "?").toUpperCase();
}
