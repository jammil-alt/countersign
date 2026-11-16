// The phone app's routes (docs/plan.md §1.116): signing in from the app. The app's session travels
// in MOBILE_SESSION_HEADER (`mobileSession` below turns it into the cookie every session route
// reads); Desk items and the rest are the portal's own routes.

import {
  MOBILE_HANDOFF_PATH,
  mobileHandoff,
  mobileRedeem,
  mobileSessionFromSetCookies,
  mobileStartCookie,
  SECOND_FACTOR_PAGE,
  secondFactorGate,
  withMobileSession,
  workosStateOf,
} from "@countersign/auth";
import {
  MOBILE_SESSION_HEADER,
  MOBILE_SIGNED_IN_URL,
  PkceChallenge,
  routes,
} from "@countersign/core";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auditAlone } from "../audit";
import { authDirectory } from "../auth";
import { type AppEnv, HttpError, mountPublic } from "../http";

/**
 * The app's session header in, as the session cookie; the session a response sets out, as the
 * header (and no Set-Cookie: the app keeps no cookies). Requests without the header are untouched.
 */
export const mobileSession = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header(MOBILE_SESSION_HEADER) === undefined) return next();
  c.req.raw = withMobileSession(c.req.raw);
  await next();
  const setCookies = c.res.headers.getSetCookie();
  if (setCookies.length === 0) return;
  const session = mobileSessionFromSetCookies(setCookies);
  // In place: assigning a new `c.res` would bring the old Set-Cookie headers back (Hono merges).
  c.res.headers.delete("set-cookie");
  if (session !== null) c.res.headers.set(MOBILE_SESSION_HEADER, session);
});

/** The cookie password the WorkOS session is sealed with; null with the dev sign-in. */
function workosPassword(c: { env: AppEnv["Bindings"] }): string | null {
  const state = workosStateOf(c.env);
  return state.state === "on" ? state.config.cookiePassword : null;
}

const toApp = (reason: string) => `${MOBILE_SIGNED_IN_URL}?error=${encodeURIComponent(reason)}`;

export function mobileRoutes(app: Hono<AppEnv>): void {
  // 1. From the app, in the system browser: remember the app's challenge, then the usual sign-in.
  app.get(routes.mobileSignIn.path, async (c) => {
    const choice = c.get("req").services().auth();
    const password = workosPassword(c);
    if (!choice.ok || !choice.workos || !password) {
      return c.redirect(toApp(choice.ok ? "dev_sign_in" : choice.refusal.code), 302);
    }
    const query = PkceChallenge.safeParse(c.req.query("challenge"));
    if (!query.success) return c.redirect(toApp("bad_request"), 302);
    const now = new Date();
    const r = await choice.workos.signIn({ returnTo: MOBILE_HANDOFF_PATH }, now);
    if (!r.ok) return c.redirect(toApp(r.code), 302);
    c.header("Set-Cookie", await mobileStartCookie(query.data, password, now), {
      append: true,
    });
    for (const cookie of r.setCookies) c.header("Set-Cookie", cookie, { append: true });
    return c.redirect(r.redirectTo, 302);
  });

  // 2. After sign-in, still in the browser: the session goes to the app, sealed with the challenge.
  app.get(routes.mobileHandoff.path, async (c) => {
    const choice = c.get("req").services().auth();
    const password = workosPassword(c);
    if (!choice.ok || !choice.workos || !password) return c.redirect(toApp("dev_sign_in"), 302);
    const now = new Date();
    // The session as every route reads it: idle and 12-hour limits, a WorkOS refresh, and the
    // second step (§1.100). A pending step goes to its page and comes back here; the start
    // cookie stays for that.
    const identified = await choice.workos.identify(c.req.raw, now);
    if (!identified.ok) return c.redirect(toApp("no_session"), 302);
    if (secondFactorGate(identified)) {
      const query = new URLSearchParams({ return_to: MOBILE_HANDOFF_PATH });
      for (const cookie of identified.setCookies) c.header("Set-Cookie", cookie, { append: true });
      return c.redirect(`${SECOND_FACTOR_PAGE}?${query}`, 302);
    }
    // A WorkOS refresh just now rotated the session: the phone gets the new one.
    const current = mobileSessionFromSetCookies(identified.setCookies);
    const r = await mobileHandoff(c.req.raw, password, now, current || null);
    if (!r.ok) return c.redirect(toApp(r.reason), 302);
    for (const cookie of r.setCookies) c.header("Set-Cookie", cookie, { append: true });
    return c.redirect(r.redirectTo, 302);
  });

  // 3. The app trades the code and its verifier for the session.
  mountPublic(app, routes.mobileSession, async ({ c, body, services }) => {
    const password = workosPassword(c);
    if (!password) {
      throw new HttpError(404, "dev_sign_in", "sign in with the dev sign-in locally");
    }
    const r = await mobileRedeem(body.code, body.verifier, password, new Date());
    if (!r.ok) {
      await auditAlone(services.db, c, {
        tenantId: null,
        actorKind: "anonymous",
        action: "session.mobile_sign_in",
        outcome: "refused",
        httpStatus: 401,
        target: { reason: r.reason },
      });
      throw new HttpError(401, r.reason, "sign in again from the app");
    }
    await auditAlone(services.db, c, {
      tenantId: null,
      actorKind: "user",
      actorUserId: r.userId,
      actorEmail: (await authDirectory(services.db).user(r.userId))?.email ?? null,
      action: "session.mobile_sign_in",
      outcome: "ok",
      httpStatus: 200,
      target: {},
    });
    return { session: r.session, expiresAt: r.expiresAt.toISOString() };
  });
}
