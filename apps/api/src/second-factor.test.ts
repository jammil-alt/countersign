// The second step of signing in (docs/plan.md §1.83) through the API, with a fake WorkOS and an
// in-memory code service: off without its setting; on, a password sign-in is pending and reaches
// only the step's routes; setting up a number, codes, recovery codes shown once, "remember this
// browser" for 30 days, operators held to an authenticator app, the limit on wrong codes, and an
// operator's reset forgetting every browser.

import type { WorkOSAuthentication, WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { appUser, auditEvent } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import type { Bindings } from "./env";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const PASSWORD = "s".repeat(64);
const verifier = memoryCodeVerifier("246810");
let signingIn: WorkOSAuthentication | null = null;

const workos: WorkOSClient = {
  authorizationUrl: ({ state }) => `https://workos.test/authorize?state=${state}`,
  authenticateWithCode: vi.fn(async () => {
    if (!signingIn) throw new Error("nobody is signing in");
    return signingIn;
  }),
  refresh: vi.fn(async () => {
    if (!signingIn) throw new Error("nobody");
    return signingIn;
  }),
  logoutUrl: () => "https://workos.test/logout",
  revokeSession: vi.fn(async () => undefined),
  organizationName: vi.fn(async () => null),
  sendInvitation: vi.fn(async () => ({ id: "inv_1", acceptUrl: null })),
  revokeInvitation: vi.fn(async () => "revoked" as const),
};

const h = await createApiHarness({
  env: {
    ENVIRONMENT: "staging",
    AUTH_PROVIDER: "workos",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    APP_ORIGIN: "https://staging.mezonas.test",
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000001",
    ENCRYPTION_KEY: "second-factor-test-key-0123456789abcdef",
  },
  workos,
  codeVerifier: verifier,
});
afterAll(() => h?.close());

/** A browser: its cookies, kept across requests as Set-Cookie says. */
class Browser {
  jar = new Map<string, string>();
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0\b/.test(c) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
}

describe.skipIf(!h)("the second step of signing in (§1.83)", () => {
  const H = h as ApiHarness;
  let wuid = 0;

  async function request(
    b: Browser,
    method: string,
    path: string,
    body?: unknown,
    env: Partial<Bindings> = {},
  ) {
    const headers: Record<string, string> = {};
    const cookie = b.header();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await H.app.request(
      path,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      { ...H.env, ...env },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    b.take(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json: j(json), location: res.headers.get("location") };
  }

  /** WorkOS ids by app user, so the same person signs in as the same WorkOS user each time. */
  const workosIds = new Map<string, string>();

  /** Signs `userId` in with a password through WorkOS, in `b`; answers where the callback sent it. */
  async function signIn(
    b: Browser,
    userId: string,
    env: Partial<Bindings> = {},
    method = "Password",
  ) {
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.id, userId));
    if (!u) throw new Error("no user");
    let id = workosIds.get(userId);
    if (!id) {
      id = `wu_${++wuid}`;
      workosIds.set(userId, id);
    }
    signingIn = {
      user: { id, email: u.email, firstName: null, lastName: null, emailVerified: true },
      organizationId: null,
      refreshToken: `rt_${id}`,
      sessionId: `sess_${id}`,
      authenticationMethod: method,
    };
    // A new sign-in starts without the last session (the browser keeps the remembered device).
    b.jar.delete("__Host-cs_session");
    const start = await request(b, "GET", "/api/auth/sign-in?return_to=/inbox", undefined, env);
    const state = new URL(start.location ?? "").searchParams.get("state") ?? "";
    const done = await request(
      b,
      "GET",
      `/api/auth/callback?code=c${Math.random()}&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(done.status).toBe(302);
    return done.location;
  }

  const lastAudit = async (action: string, userId: string) =>
    (
      await H.t.db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, action), eq(auditEvent.actorUserId, userId)))
        .orderBy(asc(auditEvent.id))
    ).at(-1);

  it("changes nothing while it is off", async () => {
    const b = new Browser();
    const off = { TWILIO_VERIFY_SERVICE_SID: "" };
    expect(await signIn(b, H.B.admin, off)).toBe("/inbox");
    expect((await request(b, "GET", "/api/session", undefined, off)).status).toBe(200);
    const status = await request(b, "GET", "/api/auth/second-factor", undefined, off);
    expect(status.json).toMatchObject({ state: "exempt", enabled: false, setupNeeded: false });
  });

  const admin = new Browser();
  let recovery: string[] = [];

  it("holds a password sign-in at the step: only the step's routes answer", async () => {
    expect(await signIn(admin, H.A.admin)).toBe("/sign-in/second-step?return_to=%2Finbox");
    for (const path of ["/api/session", "/api/overview", "/api/inbox"]) {
      const res = await request(admin, "GET", path);
      expect(res.status, path).toBe(401);
      expect(res.json.error.code, path).toBe("second_factor_required");
    }
    const status = await request(admin, "GET", "/api/auth/second-factor");
    expect(status.json).toMatchObject({
      state: "pending",
      enabled: true,
      allowed: ["totp", "sms", "whatsapp"],
      methods: [],
      setupNeeded: true,
      recoveryCodesLeft: 0,
    });
    expect(await lastAudit("session.sign_in", H.A.admin)).toMatchObject({
      outcome: "ok",
      target: { method: "Password", second_factor: "pending" },
    });
  });

  it("sets up a number: a wrong code is refused, the right one passes and shows recovery codes once", async () => {
    const setup = await request(admin, "POST", "/api/auth/second-factor/setup", {
      kind: "sms",
      phone: "+15551234567",
    });
    expect(setup.status, JSON.stringify(setup.json)).toBe(200);
    expect(setup.json).toEqual({ kind: "sms", otpauthUri: null, phoneHint: "•••• 4567" });
    expect(verifier.sent.at(-1)).toEqual({ to: "+15551234567", channel: "sms" });

    const wrong = await request(admin, "POST", "/api/auth/second-factor/verify", {
      kind: "sms",
      code: "000000",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error.code).toBe("wrong_code");

    const right = await request(admin, "POST", "/api/auth/second-factor/verify", {
      kind: "sms",
      code: "246810",
      remember: true,
    });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    recovery = right.json.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(recovery[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(right.json.recoveryCodesLeft).toBe(10);
    expect(admin.jar.has("__Host-cs_device")).toBe(true);

    expect((await request(admin, "GET", "/api/session")).status).toBe(200);
    // Done: the step's actions refuse, and setting up again is not allowed.
    const again = await request(admin, "POST", "/api/auth/second-factor/verify", {
      kind: "sms",
      code: "246810",
    });
    expect(again.json.error.code).toBe("not_pending");
    expect(await lastAudit("session.second_factor", H.A.admin)).toMatchObject({
      outcome: "ok",
      target: { method: "sms", remembered: "30d" },
    });
    expect(await lastAudit("session.recovery_codes", H.A.admin)).toMatchObject({ outcome: "ok" });
  });

  it("skips the code on the remembered browser, and asks again on another", async () => {
    expect(await signIn(admin, H.A.admin)).toBe("/inbox");
    expect((await request(admin, "GET", "/api/session")).status).toBe(200);
    expect(await lastAudit("session.sign_in", H.A.admin)).toMatchObject({
      target: { second_factor: "remembered" },
    });

    const other = new Browser();
    expect(await signIn(other, H.A.admin)).toMatch(/^\/sign-in\/second-step/);
    const status = await request(other, "GET", "/api/auth/second-factor");
    expect(status.json).toMatchObject({
      setupNeeded: false,
      methods: [{ kind: "sms", phoneHint: "•••• 4567", verified: true }],
    });
    const setup = await request(other, "POST", "/api/auth/second-factor/setup", { kind: "totp" });
    expect(setup.json.error.code).toBe("already_set_up");
    await request(other, "POST", "/api/auth/second-factor/send", { kind: "sms" });
    const passed = await request(other, "POST", "/api/auth/second-factor/verify", {
      kind: "sms",
      code: "246810",
    });
    expect(passed.json).toMatchObject({ ok: true, recoveryCodes: null, recoveryCodesLeft: 10 });
    expect(other.jar.has("__Host-cs_device")).toBe(false);
  });

  it("takes a recovery code once", async () => {
    const b = new Browser();
    await signIn(b, H.A.admin);
    const code = (recovery[0] ?? "").toLowerCase().replace("-", "");
    const ok = await request(b, "POST", "/api/auth/second-factor/recovery", { code });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.recoveryCodesLeft).toBe(9);

    const c = new Browser();
    await signIn(c, H.A.admin);
    const reused = await request(c, "POST", "/api/auth/second-factor/recovery", {
      code: recovery[0],
    });
    expect(reused.status).toBe(422);
  });

  it("refuses after 5 wrong codes in 15 minutes", async () => {
    const b = new Browser();
    await signIn(b, H.A.user);
    await request(b, "POST", "/api/auth/second-factor/setup", {
      kind: "whatsapp",
      phone: "+447700900123",
    });
    expect(verifier.sent.at(-1)).toEqual({ to: "+447700900123", channel: "whatsapp" });
    for (let i = 0; i < 5; i++) {
      const r = await request(b, "POST", "/api/auth/second-factor/verify", {
        kind: "whatsapp",
        code: "111111",
      });
      expect(r.status).toBe(422);
    }
    const blocked = await request(b, "POST", "/api/auth/second-factor/verify", {
      kind: "whatsapp",
      code: "246810",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("too_many_attempts");
  });

  const operator = new Browser();

  it("holds operators to an authenticator app, shown once as a link", async () => {
    await signIn(operator, H.operator);
    const status = await request(operator, "GET", "/api/auth/second-factor");
    expect(status.json.allowed).toEqual(["totp"]);
    const sms = await request(operator, "POST", "/api/auth/second-factor/setup", {
      kind: "sms",
      phone: "+15559876543",
    });
    expect(sms.status).toBe(403);
    const totp = await request(operator, "POST", "/api/auth/second-factor/setup", {
      kind: "totp",
    });
    expect(totp.status, JSON.stringify(totp.json)).toBe(200);
    expect(totp.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const passed = await request(operator, "POST", "/api/auth/second-factor/verify", {
      kind: "totp",
      code: "246810",
    });
    expect(passed.json.recoveryCodes).toHaveLength(10);
    expect((await request(operator, "GET", "/api/ops/clients")).status).toBe(200);
  });

  it("lets an operator reset a person's methods, which forgets every browser", async () => {
    const res = await request(operator, "POST", `/api/ops/users/${H.A.admin}/second-factor/reset`, {
      reason: "Lost phone, confirmed on a call",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.removed).toBe(1);
    expect(await lastAudit("session.second_factor_reset", H.operator)).toMatchObject({
      target: { user: H.A.admin, reason: "Lost phone, confirmed on a call" },
    });
    // The remembered browser is forgotten; the next sign-in sets up again.
    expect(await signIn(admin, H.A.admin)).toMatch(/^\/sign-in\/second-step/);
    const status = await request(admin, "GET", "/api/auth/second-factor");
    expect(status.json).toMatchObject({ setupNeeded: true, methods: [], recoveryCodesLeft: 0 });
    // Only people in the operator's clients.
    const stranger = await request(
      operator,
      "POST",
      "/api/ops/users/00000000-0000-4000-8000-000000000999/second-factor/reset",
      { reason: "nobody" },
    );
    expect(stranger.status).toBe(404);
  });

  it("exempts a company SSO sign-in", async () => {
    const b = new Browser();
    expect(await signIn(b, H.B.user, {}, "SSO")).toBe("/inbox");
    expect((await request(b, "GET", "/api/session")).status).toBe(200);
  });
});
