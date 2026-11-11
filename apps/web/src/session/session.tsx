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

// A sign-in or sign-out in one tab tells the others (docs/audit-plan.md 1.2): they empty their
// store and ask who is signed in, so one person's answers never show under another's session.
// Only a time is written, never an answer.
const SESSION_CHANGE_KEY = "cs.sessionChange";

function announceSessionChange(): void {
  try {
    globalThis.localStorage?.setItem(SESSION_CHANGE_KEY, String(Date.now()));
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
      const scope = `${next.session.user.id}\u0001${next.session.activeTenantId ?? ""}`;
      if (store.setScope(scope)) announceSessionChange();
    } else {
      // A session that ended closes the store; a page that opened signed out has nothing to drop.
      if (store.signedIn) store.close();
      store.setScope("");
    }
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
    announceSessionChange();
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

  // Another tab signed in or out: forget everything and ask who is signed in here now.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_CHANGE_KEY) return;
      store.close();
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
