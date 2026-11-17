// The phone app's routes (docs/plan.md §1.116): signing in from the app, the person's phones and
// their phone notifications. The app's session travels in MOBILE_SESSION_HEADER (`mobileSession`
// below turns it into the cookie every session route reads); Desk items, signing and the rest are
// the portal's own routes.

import {
  clearCookie,
  MOBILE_HANDOFF_PATH,
  MOBILE_START_COOKIE,
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
  isOperatorRole,
  MOBILE_SESSION_HEADER,
  MOBILE_SIGNED_IN_URL,
  type MyPush,
  PkceChallenge,
  personPush,
  routes,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auditAlone, auditInTx } from "../audit";
import { authDirectory } from "../auth";
import type { Bindings } from "../env";
import { type AppEnv, HttpError, mount, mountPublic } from "../http";
import {
  myDevice,
  myDevices,
  registerDevice,
  removeDevice,
  toMyDevice,
  updateDevice,
} from "../mobile/devices";
import { keyEnrolRefusal, PHONE_REMOVED_ACTION } from "../mobile/phone-session";
import { tenantRow } from "../notify/people";
import { mergePersonSettings } from "./notify";

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

/** Off unless MOBILE_SIGNIN is `on`. */
// DECISION (audit, 2026-11-17): no app is in the stores yet, so the phone's sign-in routes answer
// 404 until the owner turns them on (`MOBILE_SIGNIN=on`, docs/operations.md), as push waits for
// `MOBILE_PUSH`. The phone's other routes are session routes and stay as they are.
export function mobileSignInOn(env: Pick<Bindings, "MOBILE_SIGNIN"> | undefined): boolean {
  return env?.MOBILE_SIGNIN?.trim().toLowerCase() === "on";
}

const signInOff = createMiddleware<AppEnv>(async (c, next) => {
  if (mobileSignInOn(c.env)) return next();
  return c.json(
    { error: { code: "not_found", message: "signing in from the phone app is off here" } },
    404,
  );
});

const toApp = (reason: string) => `${MOBILE_SIGNED_IN_URL}?error=${encodeURIComponent(reason)}`;

async function myPush(tx: Tx, tenantId: string, userId: string): Promise<MyPush> {
  const t = await tenantRow(tx, tenantId);
  const p = personPush((t?.settings ?? {}) as Record<string, unknown>, userId);
  const devices = (await myDevices(tx, tenantId, userId)).filter((d) => d.pushToken).length;
  return { on: p.push, every: p.pushEvery, showClient: p.pushShowsClient, devices };
}

export function mobileRoutes(app: Hono<AppEnv>): void {
  for (const path of [
    routes.mobileSignIn.path,
    routes.mobileHandoff.path,
    routes.mobileSession.path,
  ]) {
    app.use(path, signInOff);
  }

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
    // DECISION (audit, 2026-11-17): the phone app is for a client's people (docs/plan.md §1.116);
    // an operator's session never leaves the browser for it. The browser keeps its session; the
    // app is told why, with no code.
    const memberships = await authDirectory(c.get("req").services().db).memberships(
      identified.userId,
    );
    if (memberships.some((m) => isOperatorRole(m.role))) {
      c.header("Set-Cookie", clearCookie(MOBILE_START_COOKIE), { append: true });
      for (const cookie of identified.setCookies) c.header("Set-Cookie", cookie, { append: true });
      return c.redirect(toApp("operator"), 302);
    }
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

  mount(app, routes.myDevices, async ({ tx, tenantIds, session }) => ({
    devices: (await myDevices(tx, tenantIds[0] as string, session.user.id)).map(toMyDevice),
  }));

  mount(app, routes.registerDevice, async ({ tx, tenantIds, session, body }) => {
    const now = new Date();
    // Audit 5.2: a signing key only from a session that recently signed in or passed its step.
    const stale = body.publicKey ? keyEnrolRefusal(session, now) : null;
    if (stale) throw new HttpError(403, "fresh_sign_in_required", stale);
    return {
      device: toMyDevice(
        await registerDevice(tx, tenantIds[0] as string, session.user.id, body, now),
      ),
    };
  });

  mount(app, routes.updateDevice, async ({ tx, tenantIds, session, params, body }) => ({
    device: toMyDevice(
      await updateDevice(tx, tenantIds[0] as string, session.user.id, params.id, body, new Date()),
    ),
  }));

  mount(app, routes.removeDevice, async ({ c, tx, tenantIds, session, params, role }) => {
    const tenantId = tenantIds[0] as string;
    await myDevice(tx, tenantId, session.user.id, params.id);
    await removeDevice(tx, tenantId, session.user.id, params.id, new Date());
    // Audit 5.2: the person's phone sessions in this client that signed in before now are over
    // (../mobile/phone-session.ts); written with the removal, so one never stands without the other.
    await auditInTx(tx, c, {
      tenantId,
      actorKind: "user",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      actorRole: role,
      action: PHONE_REMOVED_ACTION,
      outcome: "ok",
      target: { device: params.id },
    });
    return { ok: true as const };
  });

  mount(app, routes.myPush, ({ tx, tenantIds, session }) =>
    myPush(tx, tenantIds[0] as string, session.user.id),
  );

  mount(app, routes.setMyPush, async ({ tx, tenantIds, session, body }) => {
    const tenantId = tenantIds[0] as string;
    await mergePersonSettings(tx, tenantId, session.user.id, {
      push: body.on,
      pushEvery: body.every,
      pushShowsClient: body.showClient,
    });
    return myPush(tx, tenantId, session.user.id);
  });
}
