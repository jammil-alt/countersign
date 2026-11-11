// The first load's head start (docs/audit-plan.md 4.3). `main.tsx` asks who is signed in before
// React mounts, and the session provider takes that answer instead of asking again, so the
// session call runs while React renders the frame (and, on /ops, while the back office's chunk
// loads: App.tsx). The frame's first calls follow its answer, through the store only (session.tsx).
import type { SessionResponse } from "@countersign/core";
import { type ApiClient, api } from "../api/client";
import { apiRoutes } from "../api/routes";
import type { ApiStore } from "../api/store";

let early: Promise<SessionResponse> | null = null;

/** Asks `/api/session` now; the session provider takes the answer (`takeEarlySession`). */
export function startSessionEarly(client: ApiClient = api): void {
  const answer = client.call(apiRoutes.session);
  // Read later by the provider; a refusal is handled there, not reported as unhandled here.
  answer.catch(() => {});
  early = answer;
}

/** The early answer, once; every later refresh asks again. Null when none was started (tests). */
export function takeEarlySession(): Promise<SessionResponse> | null {
  const answer = early;
  early = null;
  return answer;
}

/**
 * The frame's first calls, for the surface this session lands on: the back office's client names
 * for an operator, the portal's overview and Feedback switch for a client's user. They go into the
 * store as the frame asks them (ops/OpsLayout.tsx, portal/PortalApp.tsx), so the frame finds them
 * there instead of asking, while the session's language loads and React renders.
 */
// DECISION: asked only once the session has answered, never beside it: with WorkOS a request that
// refreshes the access token rotates the refresh token, and a second request racing it with the
// old cookie revokes the session (packages/auth/src/workos/adapter.ts). The surface comes from the
// session (an operator is sent to /ops wherever they land), so no call is made that would be
// refused and audited. Only the calls the frame makes on every page; a page's own data waits.
export function prefetchFrame(store: ApiStore, session: SessionResponse): void {
  if (session.operator) {
    store.prefetch(apiRoutes.opsClients, { query: { view: "names" } });
  } else {
    store.prefetch(apiRoutes.portalOverview, {});
    store.prefetch(apiRoutes.portalFeedbackStatus, {});
  }
}
