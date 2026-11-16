// The phone app's routes (docs/plan.md §1.116): signing in from the app. Desk items and everything
// else the app shows use the portal's own routes.

import { z } from "zod";
import { PkceChallenge, PkceVerifier } from "../mobile/mobile";
import { defineRoute } from "./contract";

export const MobileSessionResponse = z.object({
  /** The sealed session, sent back in MOBILE_SESSION_HEADER on every request. */
  session: z.string().min(1),
  /** When it ends at the latest (12 hours after sign-in). */
  expiresAt: z.string(),
});
export type MobileSessionResponse = z.infer<typeof MobileSessionResponse>;

export const mobileRoutes = {
  // Sign-in from the app: the app opens this in the system browser with its PKCE challenge; it
  // runs the usual WorkOS sign-in and ends at `mobileHandoff`, which sends the browser back to the
  // app (mezonas://signed-in?code=…). Full-page navigations, not JSON.
  mobileSignIn: defineRoute({
    method: "GET",
    path: "/api/mobile/sign-in",
    auth: "public",
    roles: [],
    summary: "Start signing in from the phone app (redirects to sign-in)",
    query: z.object({ challenge: PkceChallenge }),
    response: z.object({}),
  }),
  mobileHandoff: defineRoute({
    method: "GET",
    path: "/api/mobile/handoff",
    auth: "public",
    roles: [],
    summary: "After sign-in: hand the session to the phone app (redirects to the app)",
    response: z.object({}),
  }),
  mobileSession: defineRoute({
    method: "POST",
    path: "/api/mobile/session",
    auth: "public",
    roles: [],
    summary: "The phone app trades its handoff code and PKCE verifier for its session",
    body: z.strictObject({ code: z.string().min(1).max(8192), verifier: PkceVerifier }),
    response: MobileSessionResponse,
  }),
} as const;
