// The first load's head start (docs/audit-plan.md 4.3). `main.tsx` asks who is signed in before
// React mounts, and the session provider takes that answer instead of asking again, so the
// session call runs while React renders the frame (and, on /ops, while the back office's chunk
// loads: App.tsx). The frame's first calls start with it, through the store only (session.tsx).
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
 * The frame's first calls, for the surface the address opens: the back office's client names, or
 * the portal's overview and Feedback switch. They go into the store as the frame asks them
 * (ops/OpsLayout.tsx, portal/PortalApp.tsx), so the frame finds them there instead of asking.
 * Whether anything was asked.
 */
// DECISION: only the calls the frame makes on every page, keyed exactly as it asks them; a page's
// own data waits for the session. Sign-in and the pages that do not sit in a frame ask nothing.
export function prefetchFrame(store: ApiStore, pathname: string): boolean {
  if (pathname === "/sign-in" || pathname.startsWith("/sign-in/")) return false;
  if (pathname === "/ops" || pathname.startsWith("/ops/")) {
    store.prefetch(apiRoutes.opsClients, { query: { view: "names" } });
  } else {
    store.prefetch(apiRoutes.portalOverview, {});
    store.prefetch(apiRoutes.portalFeedbackStatus, {});
  }
  return true;
}
