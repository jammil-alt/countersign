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
  mobileSignInApp,
  mobileStartCookie,
  SECOND_FACTOR_PAGE,
  secondFactorGate,
  type WorkOSAdapter,
  withMobileSession,
  workosStateOf,
} from "@countersign/auth";
import {
  isOperatorRole,
  MOBILE_CONFIRM_PATH,
  MOBILE_SESSION_HEADER,
  MOBILE_SIGNED_IN_URL,
  MobileApp,
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
import { type AppContext, type AppEnv, HttpError, mount, mountPublic } from "../http";
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

/** The audit row of the handoff itself (§1.219): which app, who, and how it ended. */
export const HANDOFF_ACTION = "session.mobile_handoff";

/** Where a sign-in for an app stands, in the browser, before its session may go to the app. */
type HandoffGate =
  | {
      readonly go: true;
      readonly app: MobileApp;
      readonly userId: string;
      /** The session as the API just read it (a WorkOS refresh may have rotated it). */
      readonly setCookies: readonly string[];
    }
  | {
      readonly go: false;
      readonly app: MobileApp | null;
      readonly userId: string | null;
      readonly reason: "no_start" | "no_session" | "operator" | "second_factor_pending";
      readonly redirectTo: string;
      readonly setCookies: readonly string[];
    };

/**
 * Every check before the handoff, for the redirect, the confirm page and its answer alike: the
 * app's sign-in in date, the session as every route reads it (idle and 12-hour limits, a WorkOS
 * refresh), never an operator, and the second step passed (§1.100).
 */
async function handoffGate(
  c: AppContext,
  workos: WorkOSAdapter,
  password: string,
  now: Date,
): Promise<HandoffGate> {
  const app = await mobileSignInApp(c.req.raw, password, now);
  const stop = (
    reason: "no_start" | "no_session" | "operator" | "second_factor_pending",
    redirectTo: string,
    userId: string | null = null,
    setCookies: readonly string[] = [],
  ): HandoffGate => ({ go: false, app, userId, reason, redirectTo, setCookies });
  if (!app) return stop("no_start", toApp("no_start"));
  const identified = await workos.identify(c.req.raw, now);
  if (!identified.ok) return stop("no_session", toApp("no_session"));
  // DECISION (audit, 2026-11-17): our apps are for a client's people (docs/plan.md §1.116); an
  // operator's session never leaves the browser for one. The browser keeps its session; the app is
  // told why, with no code.
  const memberships = await authDirectory(c.get("req").services().db).memberships(
    identified.userId,
  );
  if (memberships.some((m) => isOperatorRole(m.role))) {
    return stop("operator", toApp("operator"), identified.userId, [
      clearCookie(MOBILE_START_COOKIE),
      ...identified.setCookies,
    ]);
  }
  // A pending step goes to its page and comes back here; the start cookie stays for that.
  if (secondFactorGate(identified)) {
    const query = new URLSearchParams({ return_to: MOBILE_HANDOFF_PATH });
    return stop(
      "second_factor_pending",
      `${SECOND_FACTOR_PAGE}?${query}`,
      identified.userId,
      identified.setCookies,
    );
  }
  return { go: true, app, userId: identified.userId, setCookies: identified.setCookies };
}

function sendCookies(c: AppContext, cookies: readonly string[]): void {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

async function auditHandoff(
  c: AppContext,
  entry: {
    readonly userId: string | null;
    readonly app: MobileApp | null;
    readonly outcome: "ok" | "refused";
    readonly reason?: string;
  },
): Promise<void> {
  const db = c.get("req").services().db;
  await auditAlone(db, c, {
    tenantId: null,
    actorKind: entry.userId ? "user" : "anonymous",
    actorUserId: entry.userId,
    actorEmail: entry.userId ? ((await authDirectory(db).user(entry.userId))?.email ?? null) : null,
    action: HANDOFF_ACTION,
    outcome: entry.outcome,
    httpStatus: 200,
    target: {
      ...(entry.app ? { app: entry.app } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

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
    routes.mobileHandoffPending.path,
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
    // §1.219: which app is asking; absent is the phone, as phones already in the field send it.
    const asking = MobileApp.safeParse(c.req.query("app") ?? "phone");
    if (!asking.success) return c.redirect(toApp("bad_request"), 302);
    const now = new Date();
    const r = await choice.workos.signIn({ returnTo: MOBILE_HANDOFF_PATH }, now);
    if (!r.ok) return c.redirect(toApp(r.code), 302);
    c.header("Set-Cookie", await mobileStartCookie(query.data, password, now, asking.data), {
      append: true,
    });
    for (const cookie of r.setCookies) c.header("Set-Cookie", cookie, { append: true });
    return c.redirect(r.redirectTo, 302);
  });

  // 2. After sign-in, still in the browser: the page that asks before the session goes to the app.
  // DECISION (open.md M8, D7; §1.219): never straight to the app. Another app on the phone or the
  // computer may have registered `mezonas://` and started this sign-in with its own challenge;
  // with the browser already signed in (or SSO), it would finish with nobody looking. The page
  // names the app and the person, and the session leaves only when they press Open.
  app.get(routes.mobileHandoff.path, async (c) => {
    const choice = c.get("req").services().auth();
    const password = workosPassword(c);
    if (!choice.ok || !choice.workos || !password) return c.redirect(toApp("dev_sign_in"), 302);
    const gate = await handoffGate(c, choice.workos, password, new Date());
    sendCookies(c, gate.setCookies);
    if (!gate.go) {
      // A refusal is the handoff's end: written here. A pending step comes back here after it.
      if (gate.reason !== "second_factor_pending") {
        await auditHandoff(c, { ...gate, outcome: "refused" });
      }
      return c.redirect(gate.redirectTo, 302);
    }
    return c.redirect(MOBILE_CONFIRM_PATH, 302);
  });

  // 2a. The confirm page reads what it asks about: which app, and who is signed in.
  mountPublic(app, routes.mobileHandoffPending, async ({ c, services }) => {
    const choice = services.auth();
    const password = workosPassword(c);
    if (!choice.ok || !choice.workos || !password) {
      throw new HttpError(404, "dev_sign_in", "sign in with the dev sign-in locally");
    }
    const gate = await handoffGate(c, choice.workos, password, new Date());
    sendCookies(c, gate.setCookies);
    if (!gate.go) throw new HttpError(404, gate.reason, "start signing in again from the app");
    const email = (await authDirectory(services.db).user(gate.userId))?.email ?? "";
    return { app: gate.app, email };
  });

  // 2b. The person's answer: Open hands the session over, sealed with the app's challenge; the
  // browser keeps neither. Cancel ends the app's sign-in and leaves the browser's session be.
  mountPublic(app, routes.mobileHandoffConfirm, async ({ c, body }) => {
    const choice = c.get("req").services().auth();
    const password = workosPassword(c);
    if (!choice.ok || !choice.workos || !password) {
      throw new HttpError(404, "dev_sign_in", "sign in with the dev sign-in locally");
    }
    const now = new Date();
    const gate = await handoffGate(c, choice.workos, password, now);
    sendCookies(c, gate.setCookies);
    if (!body.open) {
      c.header("Set-Cookie", clearCookie(MOBILE_START_COOKIE), { append: true });
      await auditHandoff(c, { ...gate, outcome: "refused", reason: "cancelled" });
      return { redirectTo: "/" };
    }
    if (!gate.go) {
      if (gate.reason !== "second_factor_pending") {
        await auditHandoff(c, { ...gate, outcome: "refused" });
      }
      return { redirectTo: gate.redirectTo };
    }
    // A WorkOS refresh just now rotated the session: the app gets the new one.
    const current = mobileSessionFromSetCookies(gate.setCookies);
    const r = await mobileHandoff(c.req.raw, password, now, current || null);
    if (!r.ok) {
      await auditHandoff(c, { ...gate, outcome: "refused", reason: r.reason });
      return { redirectTo: toApp(r.reason) };
    }
    sendCookies(c, r.setCookies);
    await auditHandoff(c, { userId: gate.userId, app: r.app, outcome: "ok" });
    return { redirectTo: r.redirectTo };
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
      // §1.219: which app took the session.
      target: { app: r.app },
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
