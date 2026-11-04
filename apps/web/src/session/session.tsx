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
import { useApiClient } from "../api/useApi";
import { identifyForErrors } from "../observability";

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
    setState(next);
    if (next.status === "signed_in") {
      identifyForErrors({ id: next.session.user.id, operator: next.session.operator });
    } else if (next.status === "signed_out") {
      identifyForErrors(null);
    }
    return next;
  }, [client]);

  const signOut = useCallback(async () => {
    let redirectTo: string | null = null;
    try {
      redirectTo = (await client.call(apiRoutes.signOut)).redirectTo;
    } finally {
      // A failed sign-out still drops the local session view; the next call re-checks it.
      setState({ status: "signed_out" });
    }
    // WorkOS may name its own sign-out page; the dev adapter never does.
    if (redirectTo) window.location.assign(redirectTo);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
