// The phone app's routes (docs/plan.md §1.99): signing in from the app, the person's phones and
// their phone notifications. The app's session travels in MOBILE_SESSION_HEADER (`mobileSession`
// below turns it into the cookie every session route reads); Desk items, signing and the rest are
// the portal's own routes.

import {
  MOBILE_HANDOFF_PATH,
  mobileHandoff,
  mobileRedeem,
  mobileSessionFromSetCookies,
  mobileStartCookie,
  withMobileSession,
  workosStateOf,
} from "@countersign/auth";
import {
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
import { auditAlone } from "../audit";
import { type AppEnv, HttpError, mount, mountPublic } from "../http";
import {
  myDevice,
  myDevices,
  registerDevice,
  removeDevice,
  toMyDevice,
  updateDevice,
} from "../mobile/devices";
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

const toApp = (reason: string) => `${MOBILE_SIGNED_IN_URL}?error=${encodeURIComponent(reason)}`;

async function myPush(tx: Tx, tenantId: string, userId: string): Promise<MyPush> {
  const t = await tenantRow(tx, tenantId);
  const p = personPush((t?.settings ?? {}) as Record<string, unknown>, userId);
  const devices = (await myDevices(tx, tenantId, userId)).filter((d) => d.pushToken).length;
  return { on: p.push, every: p.pushEvery, showClient: p.pushShowsClient, devices };
}

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
    const password = workosPassword(c);
    if (!password) return c.redirect(toApp("dev_sign_in"), 302);
    const r = await mobileHandoff(c.req.raw, password, new Date());
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
      actorKind: "anonymous",
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

  mount(app, routes.registerDevice, async ({ tx, tenantIds, session, body }) => ({
    device: toMyDevice(
      await registerDevice(tx, tenantIds[0] as string, session.user.id, body, new Date()),
    ),
  }));

  mount(app, routes.updateDevice, async ({ tx, tenantIds, session, params, body }) => ({
    device: toMyDevice(
      await updateDevice(tx, tenantIds[0] as string, session.user.id, params.id, body, new Date()),
    ),
  }));

  mount(app, routes.removeDevice, async ({ tx, tenantIds, session, params }) => {
    const tenantId = tenantIds[0] as string;
    await myDevice(tx, tenantId, session.user.id, params.id);
    await removeDevice(tx, tenantId, session.user.id, params.id, new Date());
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
