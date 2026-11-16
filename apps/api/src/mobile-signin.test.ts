// Signing in from the phone app (docs/plan.md §1.116) with the second step on (§1.100), through
// the API with a fake WorkOS and an in-memory code service: the phone's sign-in is held at the
// step like any password sign-in, even on a browser remembered for 30 days; the handoff sends a
// pending session back to the step and hands over only a passed one; the app then uses the
// session in its header, and the audit log names the phone sign-in.

import type { WorkOSAuthentication, WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { MOBILE_SESSION_HEADER } from "@countersign/core";
import { appUser, auditEvent } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import type { Bindings } from "./env";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const PASSWORD = "p".repeat(64);
const verifier = memoryCodeVerifier("135790");
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
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000002",
    ENCRYPTION_KEY: "mobile-signin-test-key-0123456789abcdef",
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

// RFC 7636 appendix B's verifier and its S256 challenge.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe.skipIf(!h)("signing in from the phone app with the second step on", () => {
  const H = h as ApiHarness;

  async function request(
    b: Browser | null,
    method: string,
    path: string,
    options: { body?: unknown; env?: Partial<Bindings>; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    const cookie = b?.header();
    if (cookie) headers.cookie = cookie;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const res = await H.app.request(
      path,
      {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      { ...H.env, ...options.env },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    b?.take(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {
      status: res.status,
      json: j(json),
      location: res.headers.get("location"),
      headers: res.headers,
    };
  }

  async function asWorkOSUser(userId: string, method = "Password") {
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.id, userId));
    if (!u) throw new Error("no user");
    signingIn = {
      user: {
        id: `wu_${userId}`,
        email: u.email,
        firstName: null,
        lastName: null,
        emailVerified: true,
      },
      organizationId: null,
      refreshToken: `rt_${userId}`,
      sessionId: `sess_${userId}`,
      authenticationMethod: method,
    };
  }

  /** A sign-in through WorkOS that starts at `start`; answers where the callback sent it. */
  async function signInFrom(b: Browser, start: string, env: Partial<Bindings> = {}) {
    b.jar.delete("__Host-cs_session");
    const first = await request(b, "GET", start, { env });
    const state = new URL(first.location ?? "").searchParams.get("state") ?? "";
    const done = await request(
      b,
      "GET",
      `/api/auth/callback?code=c${Math.random()}&state=${encodeURIComponent(state)}`,
      { env },
    );
    expect(done.status).toBe(302);
    return done.location;
  }

  const audits = (action: string, userId: string) =>
    H.t.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action), eq(auditEvent.actorUserId, userId)))
      .orderBy(asc(auditEvent.id));

  const browser = new Browser();
  let code = "";

  it("sets up the person's code in this browser, remembered for 30 days", async () => {
    await asWorkOSUser(H.B.admin);
    await signInFrom(browser, "/api/auth/sign-in?return_to=/inbox");
    await request(browser, "POST", "/api/auth/second-factor/setup", {
      body: { kind: "sms", phone: "+15557654321" },
    });
    const right = await request(browser, "POST", "/api/auth/second-factor/verify", {
      body: { kind: "sms", code: "135790", remember: true },
    });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    expect(browser.jar.has("__Host-cs_device")).toBe(true);
    // The same browser's next sign-in for the web skips the code.
    expect(await signInFrom(browser, "/api/auth/sign-in?return_to=/inbox")).toBe("/inbox");
  });

  it("holds the phone's sign-in at the step, even on the remembered browser", async () => {
    const at = await signInFrom(browser, `/api/mobile/sign-in?challenge=${CHALLENGE}`);
    expect(at).toBe("/sign-in/second-step?return_to=%2Fapi%2Fmobile%2Fhandoff");
    expect((await audits("session.sign_in", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      target: { method: "Password", second_factor: "pending", app: "phone" },
    });
  });

  it("sends a pending session back to the step instead of handing it over", async () => {
    const r = await request(browser, "GET", "/api/mobile/handoff");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/sign-in/second-step?return_to=%2Fapi%2Fmobile%2Fhandoff");
    expect(browser.jar.has("__Host-cs_mobile")).toBe(true);
    expect(browser.jar.has("__Host-cs_session")).toBe(true);
  });

  it("hands over the session once the step is passed, and the browser keeps none", async () => {
    await request(browser, "POST", "/api/auth/second-factor/send", { body: { kind: "sms" } });
    const passed = await request(browser, "POST", "/api/auth/second-factor/verify", {
      body: { kind: "sms", code: "135790" },
    });
    expect(passed.status, JSON.stringify(passed.json)).toBe(200);
    const r = await request(browser, "GET", "/api/mobile/handoff");
    expect(r.status).toBe(302);
    expect(r.location?.startsWith("mezonas://signed-in?code=")).toBe(true);
    code = new URL(r.location ?? "").searchParams.get("code") ?? "";
    expect(browser.jar.has("__Host-cs_session")).toBe(false);
    expect(browser.jar.has("__Host-cs_mobile")).toBe(false);
  });

  it("gives the app its session for its verifier, then answers it in the header", async () => {
    const wrong = await request(null, "POST", "/api/mobile/session", {
      body: { code, verifier: "w".repeat(43) },
    });
    expect([wrong.status, wrong.json.error.code]).toEqual([401, "verifier_mismatch"]);
    const r = await request(null, "POST", "/api/mobile/session", {
      body: { code, verifier: VERIFIER },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await audits("session.mobile_sign_in", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      actorKind: "user",
    });

    const me = await request(null, "GET", "/api/session", {
      headers: { [MOBILE_SESSION_HEADER]: r.json.session },
    });
    expect(me.status, JSON.stringify(me.json)).toBe(200);
    expect(me.json.user.id).toBe(H.B.admin);
    expect(me.headers.get("set-cookie")).toBeNull();
  });

  it("lets an SSO sign-in through without the code, as in a browser", async () => {
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`)).toBe(
      "/api/mobile/handoff",
    );
    const r = await request(b, "GET", "/api/mobile/handoff");
    expect(r.location?.startsWith("mezonas://signed-in?code=")).toBe(true);
  });

  it("is exempt while the step is off", async () => {
    await asWorkOSUser(H.B.admin);
    const off = { TWILIO_VERIFY_SERVICE_SID: "" };
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`, off)).toBe(
      "/api/mobile/handoff",
    );
    const r = await request(b, "GET", "/api/mobile/handoff", { env: off });
    expect(r.location?.startsWith("mezonas://signed-in?code=")).toBe(true);
  });
});
