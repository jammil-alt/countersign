// Signing in from the phone app (docs/plan.md §1.116) with the second step on (§1.100), through
// the API with a fake WorkOS and an in-memory code service: the phone's sign-in is held at the
// step like any password sign-in, even on a browser remembered for 30 days; the handoff sends a
// pending session back to the step and hands over only a passed one; the app then uses the
// session in its header, and the audit log names the phone sign-in. §1.219: the handoff waits on
// a page that names the app (the phone or the desktop app) until the person presses Open; Cancel,
// another site's request and a used sign-in hand over nothing; every end is audited with the app.

import { sealSession, type WorkOSAuthentication, type WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { MOBILE_SESSION_HEADER } from "@countersign/core";
import { appUser, auditEvent, membership } from "@countersign/db";
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
    MOBILE_SIGNIN: "on",
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

  /** The confirm page's Open (or Cancel), as the page sends it: JSON from our own origin. */
  async function confirm(b: Browser, open = true, env: Partial<Bindings> = {}) {
    return request(b, "POST", "/api/mobile/handoff", {
      env,
      body: { open },
      headers: { origin: "https://staging.mezonas.test", "sec-fetch-site": "same-origin" },
    });
  }

  /** The browser at the handoff once signed in: the confirm page, then Open; the app's link. */
  async function handOver(b: Browser, env: Partial<Bindings> = {}) {
    const at = await request(b, "GET", "/api/mobile/handoff", { env });
    expect([at.status, at.location]).toEqual([302, "/sign-in/app"]);
    const opened = await confirm(b, true, env);
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    return String(opened.json.redirectTo);
  }

  const browser = new Browser();
  let code = "";
  let phone = "";
  const ORIGIN = { origin: "https://staging.mezonas.test" };

  async function newKey() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
  }
  const registerBody = async () => ({
    name: "Test phone",
    platform: "ios",
    pushToken: null,
    publicKey: await newKey(),
  });

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
    const at = await request(browser, "GET", "/api/mobile/handoff");
    expect([at.status, at.location]).toEqual([302, "/sign-in/app"]);
    // §1.219: nothing is handed over until the person answers the page.
    expect(browser.jar.has("__Host-cs_session")).toBe(true);
    expect(browser.jar.has("__Host-cs_mobile")).toBe(true);
    const pending = await request(browser, "GET", "/api/mobile/handoff/pending");
    expect(pending.status, JSON.stringify(pending.json)).toBe(200);
    expect(pending.json).toMatchObject({ app: "phone" });
    expect(pending.json.email).toContain("@");
    const opened = await confirm(browser);
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    const to = String(opened.json.redirectTo);
    expect(to.startsWith("mezonas://signed-in?code=")).toBe(true);
    code = new URL(to).searchParams.get("code") ?? "";
    expect(browser.jar.has("__Host-cs_session")).toBe(false);
    expect(browser.jar.has("__Host-cs_mobile")).toBe(false);
    expect((await audits("session.mobile_handoff", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      actorKind: "user",
      target: { app: "phone" },
    });
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
      target: { app: "phone" },
    });

    const me = await request(null, "GET", "/api/session", {
      headers: { [MOBILE_SESSION_HEADER]: r.json.session },
    });
    expect(me.status, JSON.stringify(me.json)).toBe(200);
    expect(me.json.user.id).toBe(H.B.admin);
    expect(me.headers.get("set-cookie")).toBeNull();
    phone = me.headers.get(MOBILE_SESSION_HEADER) || r.json.session;

    // The header is not a cookie: a change sent with it is not held to the browser's origin check.
    const push = await request(null, "PUT", "/api/settings/my-push", {
      headers: { [MOBILE_SESSION_HEADER]: r.json.session, origin: "https://elsewhere.example" },
      body: { on: true, every: "now", showClient: false },
    });
    expect(push.status, JSON.stringify(push.json)).toBe(200);
  });

  it("refuses a signing key from a session that signed in more than ten minutes ago", async () => {
    await asWorkOSUser(H.B.admin);
    const now = Math.floor(Date.now() / 1000);
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.id, H.B.admin));
    const base = {
      v: 1 as const,
      uid: H.B.admin,
      wuid: `wu_${H.B.admin}`,
      email: u?.email ?? "",
      worg: null,
      sid: `sess_${H.B.admin}`,
      rt: `rt_${H.B.admin}`,
      rat: now + 240,
      exp: now + 3600,
      lat: now,
      mf: "done" as const,
      ph: true as const,
    };
    const old = await sealSession({ ...base, iat: now - 11 * 60, mft: now - 11 * 60 }, PASSWORD);
    const refused = await request(null, "POST", "/api/me/devices", {
      headers: { [MOBILE_SESSION_HEADER]: old },
      body: await registerBody(),
    });
    expect([refused.status, refused.json.error?.code]).toEqual([403, "fresh_sign_in_required"]);
    // Without a key (notifications only) the same session may still register the phone.
    const noKey = await request(null, "POST", "/api/me/devices", {
      headers: { [MOBILE_SESSION_HEADER]: old },
      body: { ...(await registerBody()), publicKey: null },
    });
    expect(noKey.status, JSON.stringify(noKey.json)).toBe(200);
    // A second step passed just now counts as fresh.
    const stepped = await sealSession({ ...base, iat: now - 11 * 60, mft: now - 60 }, PASSWORD);
    const ok = await request(null, "POST", "/api/me/devices", {
      headers: { [MOBILE_SESSION_HEADER]: stepped },
      body: await registerBody(),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("lets a phone that just signed in add its signing key; removing a phone ends its session", async () => {
    const asPhone = { [MOBILE_SESSION_HEADER]: phone };
    const added = await request(null, "POST", "/api/me/devices", {
      headers: asPhone,
      body: await registerBody(),
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    phone = added.headers.get(MOBILE_SESSION_HEADER) || phone;
    expect((await request(null, "GET", "/api/me/devices", { headers: asPhone })).status).toBe(200);

    // The person removes the phone from a browser (this one is remembered: no code asked).
    const web = new Browser();
    web.jar = new Map(browser.jar);
    await signInFrom(web, "/api/auth/sign-in?return_to=/inbox");
    const removed = await request(web, "DELETE", `/api/me/devices/${added.json.device.id}`, {
      headers: ORIGIN,
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect((await audits("mobile.phone_removed", H.B.admin)).at(-1)).toMatchObject({
      tenantId: H.B.tenantId,
      outcome: "ok",
      target: { device: added.json.device.id },
    });

    // The phone's session is over on its next request, the session route included.
    const after = await request(null, "GET", "/api/me/devices", {
      headers: { [MOBILE_SESSION_HEADER]: phone },
    });
    expect([after.status, after.json.error.code]).toEqual([401, "session_invalid"]);
    const me = await request(null, "GET", "/api/session", {
      headers: { [MOBILE_SESSION_HEADER]: phone },
    });
    expect([me.status, me.json.error.code]).toEqual([401, "session_invalid"]);
    // The browser's session is not a phone's: it carries on.
    expect((await request(web, "GET", "/api/me/devices")).status).toBe(200);

    // A phone that signs in again afterwards (a later second than the removal) gets a session
    // that works.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`);
    const handed = await handOver(b);
    const again = await request(null, "POST", "/api/mobile/session", {
      body: {
        code: new URL(handed).searchParams.get("code") ?? "",
        verifier: VERIFIER,
      },
    });
    expect(again.status).toBe(200);
    const fresh = await request(null, "GET", "/api/me/devices", {
      headers: { [MOBILE_SESSION_HEADER]: again.json.session },
    });
    expect(fresh.status, JSON.stringify(fresh.json)).toBe(200);
  });

  it("ends a removed phone's session in every client of the person, and on the sign-in routes", async () => {
    // A person in two clients; their phone session signed in two minutes ago.
    const uid = H.A.user;
    await H.t.db
      .insert(membership)
      .values({ tenantId: H.B.tenantId, userId: uid, role: "client_user" });
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.id, uid));
    const now = Math.floor(Date.now() / 1000);
    const phone = await sealSession(
      {
        v: 1,
        uid,
        wuid: `wu_${uid}`,
        email: u?.email ?? "",
        worg: null,
        sid: `sess_${uid}`,
        rt: `rt_${uid}`,
        iat: now - 120,
        rat: now + 240,
        exp: now + 3600,
        lat: now,
        mf: "done",
        ph: true,
      },
      PASSWORD,
    );
    const asPhone = (client: string) => ({
      [MOBILE_SESSION_HEADER]: phone,
      "x-countersign-client": client,
    });
    expect(
      (await request(null, "GET", "/api/me/devices", { headers: asPhone(H.B.tenantId) })).status,
    ).toBe(200);
    // They remove a phone in client A.
    await H.t.db.insert(auditEvent).values({
      tenantId: H.A.tenantId,
      actorKind: "user",
      actorUserId: uid,
      action: "mobile.phone_removed",
      outcome: "ok",
      target: {},
    });
    for (const client of [H.A.tenantId, H.B.tenantId]) {
      for (const path of ["/api/me/devices", "/api/runs"]) {
        const r = await request(null, "GET", path, { headers: asPhone(client) });
        expect([r.status, r.json?.error?.code], `${path} in ${client}`).toEqual([
          401,
          "session_invalid",
        ]);
      }
    }
    const headers = { [MOBILE_SESSION_HEADER]: phone };
    for (const path of [
      "/api/session",
      "/api/auth/second-factor",
      `/api/auth/claude-connections/${"a".repeat(32)}`,
    ]) {
      const r = await request(null, "GET", path, { headers });
      expect([r.status, r.json?.error?.code], path).toEqual([401, "session_invalid"]);
    }
  });

  it("lets an SSO sign-in through without the code, as in a browser", async () => {
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`)).toBe(
      "/api/mobile/handoff",
    );
    expect((await handOver(b)).startsWith("mezonas://signed-in?code=")).toBe(true);
  });

  it("refuses an operator at the handoff: no code, and the browser keeps its session", async () => {
    await asWorkOSUser(H.operator);
    const off = { TWILIO_VERIFY_SERVICE_SID: "" };
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`, off)).toBe(
      "/api/mobile/handoff",
    );
    const r = await request(b, "GET", "/api/mobile/handoff", { env: off });
    expect(r.status).toBe(302);
    expect(r.location).toBe("mezonas://signed-in?error=operator");
    expect(b.jar.has("__Host-cs_mobile")).toBe(false);
    expect(b.jar.has("__Host-cs_session")).toBe(true);
    expect((await audits("session.mobile_handoff", H.operator)).at(-1)).toMatchObject({
      outcome: "refused",
      target: { app: "phone", reason: "operator" },
    });
  });

  it("answers 404 on every sign-in route unless MOBILE_SIGNIN is on", async () => {
    await asWorkOSUser(H.B.admin);
    const off = { TWILIO_VERIFY_SERVICE_SID: "" };
    const b = new Browser();
    await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`, off);
    for (const value of [undefined, "", "off", "yes"]) {
      const env = { ...off, MOBILE_SIGNIN: value } as Partial<Bindings>;
      const start = await request(
        new Browser(),
        "GET",
        `/api/mobile/sign-in?challenge=${CHALLENGE}`,
        {
          env,
        },
      );
      expect([start.status, start.json?.error?.code]).toEqual([404, "not_found"]);
      const handoff = await request(b, "GET", "/api/mobile/handoff", { env });
      expect([handoff.status, handoff.location]).toEqual([404, null]);
      const pending = await request(b, "GET", "/api/mobile/handoff/pending", { env });
      expect([pending.status, pending.json?.error?.code]).toEqual([404, "not_found"]);
      const opened = await confirm(b, true, env);
      expect([opened.status, opened.json?.error?.code]).toEqual([404, "not_found"]);
      // The browser's sign-in is untouched.
      expect(b.jar.has("__Host-cs_session")).toBe(true);
      const redeem = await request(null, "POST", "/api/mobile/session", {
        env,
        body: { code: "c", verifier: VERIFIER },
      });
      expect([redeem.status, redeem.json?.error?.code]).toEqual([404, "not_found"]);
    }
  });

  it("is exempt while the step is off", async () => {
    await asWorkOSUser(H.B.admin);
    const off = { TWILIO_VERIFY_SERVICE_SID: "" };
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`, off)).toBe(
      "/api/mobile/handoff",
    );
    expect((await handOver(b, off)).startsWith("mezonas://signed-in?code=")).toBe(true);
  });

  it("names the desktop app in every audit row of its sign-in, and on the page", async () => {
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    expect(await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}&app=desktop`)).toBe(
      "/api/mobile/handoff",
    );
    expect((await audits("session.sign_in", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      target: { app: "desktop" },
    });
    await request(b, "GET", "/api/mobile/handoff");
    const pending = await request(b, "GET", "/api/mobile/handoff/pending");
    expect(pending.json).toMatchObject({ app: "desktop" });
    const opened = await confirm(b);
    const to = String(opened.json.redirectTo);
    expect(to.startsWith("mezonas://signed-in?code=")).toBe(true);
    expect((await audits("session.mobile_handoff", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      target: { app: "desktop" },
    });
    const r = await request(null, "POST", "/api/mobile/session", {
      body: { code: new URL(to).searchParams.get("code") ?? "", verifier: VERIFIER },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await audits("session.mobile_sign_in", H.B.admin)).at(-1)).toMatchObject({
      outcome: "ok",
      target: { app: "desktop" },
    });
  });

  it("refuses an app it doesn't know", async () => {
    const r = await request(
      new Browser(),
      "GET",
      `/api/mobile/sign-in?challenge=${CHALLENGE}&app=tablet`,
    );
    expect([r.status, r.location]).toEqual([302, "mezonas://signed-in?error=bad_request"]);
  });

  it("hands nothing over on Cancel: the browser keeps its session, and the sign-in is over", async () => {
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}&app=desktop`);
    await request(b, "GET", "/api/mobile/handoff");
    const cancelled = await confirm(b, false);
    expect(cancelled.json).toEqual({ redirectTo: "/" });
    expect(b.jar.has("__Host-cs_mobile")).toBe(false);
    expect(b.jar.has("__Host-cs_session")).toBe(true);
    expect((await audits("session.mobile_handoff", H.B.admin)).at(-1)).toMatchObject({
      outcome: "refused",
      target: { app: "desktop", reason: "cancelled" },
    });
    // Open afterwards (a second tab, Back) finds no sign-in to finish.
    const late = await confirm(b, true);
    expect(late.json).toEqual({ redirectTo: "mezonas://signed-in?error=no_start" });
    const pending = await request(b, "GET", "/api/mobile/handoff/pending");
    expect([pending.status, pending.json?.error?.code]).toEqual([404, "no_start"]);
  });

  it("never hands over to a request from another site or without the page", async () => {
    await asWorkOSUser(H.B.admin, "SSO");
    const b = new Browser();
    await signInFrom(b, `/api/mobile/sign-in?challenge=${CHALLENGE}`);
    const crossSite = await request(b, "POST", "/api/mobile/handoff", {
      body: { open: true },
      headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    // A plain form post (no JSON) is refused too, so a page can't submit one for the person.
    const form = await H.app.request(
      "/api/mobile/handoff",
      {
        method: "POST",
        headers: {
          cookie: b.header(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "open=true",
      },
      H.env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    expect(form.status).toBeGreaterThanOrEqual(400);
    // The browser still holds both: the sign-in waits for the person.
    expect(b.jar.has("__Host-cs_session")).toBe(true);
    expect(b.jar.has("__Host-cs_mobile")).toBe(true);
    expect((await handOver(b)).startsWith("mezonas://signed-in?code=")).toBe(true);
  });
});
