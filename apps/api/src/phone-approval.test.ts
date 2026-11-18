// Approving a sign-in on the phone app (docs/plan.md §1.154) through the API, with a fake WorkOS,
// an in-memory code service and a fake Expo: the browser asks, the phone lists what waits and
// answers, signed with its key; the right number passes the step once, for the asking page only;
// a wrong number or "It wasn't me" denies it; a signature that doesn't verify, from another
// person's phone, a removed phone or too long ago changes nothing; the browser can be remembered
// by the phone; operators and people without a phone are never offered it.

import type { WorkOSAuthentication, WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { signInApprovalText, signInListText } from "@countersign/core";
import {
  appUser,
  auditEvent,
  membership,
  personDevice,
  signInApproval,
  userFactor,
} from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { EXPO_PUSH_URL } from "./notify/push";
import { browserInWords, choicesFor } from "./second-factor/phone";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const b64url = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64url");

async function phoneKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    publicKey: {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: jwk.x as string,
      y: jwk.y as string,
    },
    sign: async (text: string) =>
      b64url(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
  };
}

const PASSWORD = "s".repeat(64);
const ENCRYPTION_KEY = "phone-approval-test-key-0123456789abcdef";
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

/** What reached Expo. */
const pushed: Array<Array<Record<string, unknown>>> = [];
const fetchFake = async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== EXPO_PUSH_URL) throw new Error(`unexpected fetch ${String(url)}`);
  const batch = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
  pushed.push(batch);
  return new Response(
    JSON.stringify({ data: batch.map((_, i) => ({ status: "ok", id: `t${i}` })) }),
  );
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
    ENCRYPTION_KEY,
    MOBILE_PUSH: "on",
  },
  workos,
  codeVerifier: memoryCodeVerifier("246810"),
  fetch: fetchFake as never,
});
afterAll(() => h?.close());

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

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

describe("what the phone shows of the browser", () => {
  it("names the browser and the system, never the user agent", () => {
    expect(browserInWords(CHROME_MAC)).toBe("Chrome on macOS");
    expect(
      browserInWords(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      browserInWords(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
      ),
    ).toBe("Edge on Windows");
    expect(browserInWords(null)).toBe("A browser");
  });

  it("offers three different numbers, the browser's among them, the same each time", async () => {
    for (let n = 10; n <= 99; n++) {
      const id = `0190a1b2-0000-7000-8000-0000000000${n}`;
      const choices = await choicesFor("k", id, n);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      expect(choices).toContain(n);
      for (const c of choices) expect(c >= 10 && c <= 99).toBe(true);
      expect(await choicesFor("k", id, n)).toEqual(choices);
    }
  });
});

describe.skipIf(!h)("approving a sign-in on the phone (§1.154)", () => {
  const H = h as ApiHarness;
  let wuid = 0;

  async function request(b: Browser | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { "user-agent": CHROME_MAC };
    const cookie = b?.header();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await H.app.request(
      path,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      H.env,
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
    return { status: res.status, json: j(json), location: res.headers.get("location") };
  }

  const workosIds = new Map<string, string>();

  async function signIn(b: Browser, userId: string) {
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
      authenticationMethod: "Password",
    };
    b.jar.delete("__Host-cs_session");
    const start = await request(b, "GET", "/api/auth/sign-in?return_to=/inbox");
    const state = new URL(start.location ?? "").searchParams.get("state") ?? "";
    const done = await request(
      b,
      "GET",
      `/api/auth/callback?code=c${Math.random()}&state=${encodeURIComponent(state)}`,
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

  type Key = Awaited<ReturnType<typeof phoneKey>>;
  let person = "";
  let key: Key;
  let phoneId = "";

  /** A phone set up to sign for `userId` in `tenantId`. */
  async function addPhone(userId: string, tenantId: string, k: Key, token: string | null) {
    const [row] = await H.t.db
      .insert(personDevice)
      .values({
        tenantId,
        userId,
        name: "Dana's iPhone",
        platform: "ios",
        pushToken: token,
        publicKey: k.publicKey,
      })
      .returning({ id: personDevice.id });
    return row?.id ?? "";
  }

  let n = 0;
  /**
   * A new client user in client A with a text method and a phone set up to sign: each test starts
   * in a fresh window of the person's limits (5 tries and 5 sends in 15 minutes; audit rows are
   * never deleted).
   */
  async function fresh() {
    const [u] = await H.t.db
      .insert(appUser)
      .values({ email: `dana${++n}@a.example.com`, name: "Dana" })
      .returning({ id: appUser.id });
    person = u?.id ?? "";
    await H.t.db
      .insert(membership)
      .values({ tenantId: H.A.tenantId, userId: person, role: "client_user" });
    // A code method first: a phone signs in through the step itself.
    await H.t.db
      .insert(userFactor)
      .values({ userId: person, kind: "sms", phone: "+15551230000", verifiedAt: new Date() });
    key = await phoneKey();
    phoneId = await addPhone(person, H.A.tenantId, key, `ExponentPushToken[dana${n}]`);
  }

  const at = () => new Date().toISOString();

  async function list(k: Key, userId: string, deviceId: string, when = at()) {
    return request(null, "POST", "/api/mobile/sign-in-approvals", {
      userId,
      deviceId,
      at: when,
      signature: await k.sign(signInListText({ userId, deviceId, at: when })),
    });
  }

  async function decide(
    k: Key,
    approvalId: string,
    decision: "approve" | "deny",
    number: number | null,
    opts: { userId?: string; deviceId?: string; at?: string } = {},
  ) {
    const userId = opts.userId ?? person;
    const deviceId = opts.deviceId ?? phoneId;
    const when = opts.at ?? at();
    return request(null, "POST", `/api/mobile/sign-in-approvals/${approvalId}/decide`, {
      userId,
      deviceId,
      at: when,
      decision,
      number,
      signature: await k.sign(
        signInApprovalText({ approvalId, userId, deviceId, decision, number, at: when }),
      ),
    });
  }

  async function ask(b: Browser) {
    expect(await signIn(b, person)).toBe("/sign-in/second-step?return_to=%2Finbox");
    const asked = await request(b, "POST", "/api/auth/second-factor/phone", {});
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    return asked.json as { id: string; key: string; number: number; phones: number };
  }

  it("offers the phone once a code method is set up, and approves with the right number", async () => {
    await fresh();
    const b = new Browser();
    expect(await signIn(b, person)).toBe("/sign-in/second-step?return_to=%2Finbox");
    const status = await request(b, "GET", "/api/auth/second-factor");
    expect(status.json).toMatchObject({ state: "pending", phones: 1 });

    pushed.length = 0;
    const asked = await request(b, "POST", "/api/auth/second-factor/phone", {});
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const { id, key: browserKey, number } = asked.json;
    expect(number).toBeGreaterThanOrEqual(10);
    expect(asked.json.phones).toBe(1);

    // The push names nothing: no number, browser, place or client.
    expect(pushed).toHaveLength(1);
    const [message] = pushed[0] ?? [];
    expect(message).toMatchObject({ to: `ExponentPushToken[dana${n}]`, title: "Mezonas" });
    expect(JSON.stringify(message)).not.toContain(String(number));
    expect(JSON.stringify(message)).not.toContain("Chrome");
    expect(j(message).data.path).toBe(`/sign-in-approval?id=${id}`);

    const waiting = await list(key, person, phoneId);
    expect(waiting.status, JSON.stringify(waiting.json)).toBe(200);
    expect(waiting.json.approvals).toHaveLength(1);
    const [w] = waiting.json.approvals;
    expect(w).toMatchObject({ id, browser: "Chrome on macOS" });
    expect(w.choices).toContain(number);
    expect(JSON.stringify(waiting.json)).not.toContain(browserKey);

    const check = { id, key: browserKey, remember: true };
    expect((await request(b, "POST", "/api/auth/second-factor/phone/check", check)).json).toEqual({
      status: "pending",
      passed: null,
    });

    const approved = await decide(key, id, "approve", number);
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(approved.json).toEqual({ status: "approved" });
    expect(await lastAudit("session.phone_approval", person)).toMatchObject({
      outcome: "ok",
      target: { approval: id, device: phoneId, step: "approved" },
    });

    // Another page (not the key) finds nothing; the asking page passes, once.
    const other = new Browser();
    other.jar = new Map(b.jar);
    const wrongKey = await request(other, "POST", "/api/auth/second-factor/phone/check", {
      ...check,
      key: "A".repeat(43),
    });
    expect(wrongKey.status).toBe(404);
    const passed = await request(b, "POST", "/api/auth/second-factor/phone/check", check);
    expect(passed.status, JSON.stringify(passed.json)).toBe(200);
    expect(passed.json.status).toBe("approved");
    expect(passed.json.passed).toMatchObject({ ok: true, recoveryCodes: null });
    expect((await request(b, "GET", "/api/session")).status).toBe(200);
    expect(b.jar.has("__Host-cs_device")).toBe(true);
    expect(await lastAudit("session.second_factor", person)).toMatchObject({
      outcome: "ok",
      target: { method: "phone", remembered: "30d" },
    });
    const [row] = await H.t.db.select().from(signInApproval).where(eq(signInApproval.id, id));
    expect(row).toMatchObject({ status: "approved", deviceId: phoneId });
    expect(row?.usedAt).not.toBeNull();

    // Remembered by the phone: the next sign-in in this browser skips the step.
    expect(await signIn(b, person)).toBe("/inbox");
  });

  it("denies on a wrong number or 'It wasn't me', and the browser is told", async () => {
    await fresh();
    const b = new Browser();
    const first = await ask(b);
    const wrong = [10, 11, 12].find((n) => n !== first.number) as number;
    expect((await decide(key, first.id, "approve", wrong)).json).toEqual({ status: "denied" });
    expect(await lastAudit("session.phone_approval", person)).toMatchObject({
      outcome: "refused",
      target: { step: "wrong_number" },
    });
    const told = await request(b, "POST", "/api/auth/second-factor/phone/check", {
      id: first.id,
      key: first.key,
    });
    expect(told.json).toEqual({ status: "denied", passed: null });
    // Answered once: a second answer finds nothing waiting.
    expect((await decide(key, first.id, "approve", first.number)).status).toBe(409);

    const second = await request(b, "POST", "/api/auth/second-factor/phone", {});
    expect((await decide(key, second.json.id, "deny", null)).json).toEqual({ status: "denied" });
    expect(await lastAudit("session.phone_approval", person)).toMatchObject({
      target: { step: "denied" },
    });
    expect((await request(b, "GET", "/api/session")).status).toBe(401);
  });

  it("ends an earlier request when the person asks again", async () => {
    await fresh();
    const b = new Browser();
    const first = await ask(b);
    const second = await request(b, "POST", "/api/auth/second-factor/phone", {});
    const ids = (await list(key, person, phoneId)).json.approvals.map((a: { id: string }) => a.id);
    expect(ids).toEqual([second.json.id]);
    expect((await decide(key, first.id, "approve", first.number)).status).toBe(409);
    expect(
      (
        await request(b, "POST", "/api/auth/second-factor/phone/check", {
          id: first.id,
          key: first.key,
        })
      ).json.status,
    ).toBe("expired");
  });

  it("changes nothing for a signature that doesn't verify, another person's phone, or an old time", async () => {
    await fresh();
    const b = new Browser();
    const asked = await ask(b);
    const stranger = await phoneKey();
    // Signed by another key for this phone.
    const forged = await decide(stranger, asked.id, "approve", asked.number);
    expect(forged.status).toBe(403);
    expect(forged.json.error.code).toBe("signature_required");
    // A phone of someone else's, naming this person.
    const otherPhone = await addPhone(H.A.admin, H.A.tenantId, stranger, null);
    const theirs = await decide(stranger, asked.id, "approve", asked.number, {
      deviceId: otherPhone,
    });
    expect(theirs.status).toBe(403);
    // Too long ago.
    const old = await decide(key, asked.id, "approve", asked.number, {
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(old.status).toBe(401);
    expect(old.json.error.code).toBe("signature_stale");
    // A list signed as something else.
    const replay = await request(null, "POST", "/api/mobile/sign-in-approvals", {
      userId: person,
      deviceId: phoneId,
      at: at(),
      signature: await key.sign("mezonas-sign:v1"),
    });
    expect(replay.status).toBe(403);
    // Still waiting, untouched.
    const [row] = await H.t.db.select().from(signInApproval).where(eq(signInApproval.id, asked.id));
    expect(row?.status).toBe("pending");
  });

  it("stops working for a removed phone, even after it approved", async () => {
    await fresh();
    const k = await phoneKey();
    const spare = await addPhone(person, H.A.tenantId, k, null);
    const b = new Browser();
    const asked = await ask(b);
    expect((await decide(k, asked.id, "approve", asked.number, { deviceId: spare })).status).toBe(
      200,
    );
    await H.t.db
      .update(personDevice)
      .set({ revokedAt: new Date(), publicKey: null })
      .where(eq(personDevice.id, spare));
    const check = await request(b, "POST", "/api/auth/second-factor/phone/check", {
      id: asked.id,
      key: asked.key,
    });
    expect(check.json).toEqual({ status: "expired", passed: null });
    expect((await list(k, person, spare)).status).toBe(403);
  });

  it("is never offered to someone with no phone, nor to an operator", async () => {
    await fresh();
    const b = new Browser();
    await H.t.db
      .insert(userFactor)
      .values({ userId: H.B.user, kind: "sms", phone: "+15551239999", verifiedAt: new Date() });
    expect(await signIn(b, H.B.user)).toBe("/sign-in/second-step?return_to=%2Finbox");
    expect((await request(b, "GET", "/api/auth/second-factor")).json.phones).toBe(0);
    const none = await request(b, "POST", "/api/auth/second-factor/phone", {});
    expect(none.status).toBe(409);
    expect(none.json.error.code).toBe("no_phone");

    // An operator with a phone row (never made by the app, which refuses operators) gets nothing.
    const k = await phoneKey();
    await addPhone(H.operator, H.A.tenantId, k, null);
    const ops = new Browser();
    expect(await signIn(ops, H.operator)).toBe("/sign-in/second-step?return_to=%2Finbox");
    expect((await request(ops, "GET", "/api/auth/second-factor")).json.phones).toBe(0);
    expect((await request(ops, "POST", "/api/auth/second-factor/phone", {})).status).toBe(409);
  });
});
