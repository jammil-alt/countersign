// The second step of signing in (docs/plan.md §1.83), through the API with the WorkOS sign-in and a
// fake Twilio Verify: a password sign-in is pending until a code is checked; client users set up
// texts, WhatsApp or an authenticator app, operators the app only; recovery codes, limits, an
// operator's reset, and approving a Claude connection to the Ops MCP server.

import { newSession, SESSION_COOKIE, sealSession, type WorkOSClient } from "@countersign/auth";
import { fakeVerify } from "@countersign/connectors/testing";
import { SECOND_FACTOR_MAX_TRIES } from "@countersign/core";
import { appUser, userFactor } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { claudeConnectionGate } from "./mcp/approval";

const PASSWORD = "p".repeat(64);
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const workos: WorkOSClient = {
  authorizationUrl: ({ state }) => `https://workos.test/authorize?state=${state}`,
  authenticateWithCode: vi.fn(async () => {
    throw new Error("not used");
  }),
  refresh: vi.fn(async () => {
    throw new Error("not used");
  }),
  logoutUrl: () => "https://workos.test/logout",
  revokeSession: vi.fn(async () => undefined),
  organizationName: vi.fn(async () => null),
  sendInvitation: vi.fn(async () => ({ id: "inv_1", acceptUrl: null })),
  revokeInvitation: vi.fn(async () => "revoked" as const),
};

const env = {
  ENVIRONMENT: "staging",
  AUTH_PROVIDER: "workos",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  WORKOS_COOKIE_PASSWORD: PASSWORD,
  APP_ORIGIN: "https://staging.mezonas.test",
  ENCRYPTION_KEY,
  TWILIO_VERIFY_WHATSAPP: "on",
};

const fake = fakeVerify();
const h = await createApiHarness({ env, workos, verify: fake.client });
afterAll(() => h?.close());

describe.skipIf(!h)("second step of signing in", () => {
  const H = h as ApiHarness;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const rows = await H.t.db.select({ id: appUser.id, email: appUser.email }).from(appUser);
    for (const r of rows) ids[r.email] = r.id;
  });

  /** A fresh sign-in's cookie: `pending` (a password sign-in) or `done`. */
  async function cookieFor(email: string, mf: "pending" | "done" = "pending") {
    const now = Math.floor(Date.now() / 1000);
    const payload = newSession(
      {
        userId: ids[email] ?? "",
        workosUserId: `wu_${email}`,
        email,
        workosOrganizationId: null,
        sessionId: `sess_${email}`,
        refreshToken: "rt",
        secondFactor: "pending",
      },
      now,
    );
    const sealed = mf === "done" ? { ...payload, mf: "done" as const } : payload;
    return `${SESSION_COOKIE}=${await sealSession(sealed, PASSWORD)}`;
  }

  async function req(method: string, path: string, cookie: string, body?: unknown) {
    const res = await H.app.request(
      path,
      {
        method,
        headers: {
          cookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      H.env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    const text = await res.text();
    const next = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return {
      status: res.status,
      json: text ? JSON.parse(text) : null,
      cookie: next ? (next.split(";")[0] ?? "") : null,
    };
  }

  it("keeps a pending sign-in out of everything but the second step", async () => {
    const cookie = await cookieFor(admin("a"));
    const session = await req("GET", "/api/session", cookie);
    expect(session.status).toBe(401);
    expect(j(session.json).error.code).toBe("second_factor_required");
    expect((await req("GET", "/api/runs", cookie)).status).toBe(401);
    const state = await req("GET", "/api/auth/second-factor", cookie);
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({
      status: "pending",
      operator: false,
      allowed: ["totp", "sms", "whatsapp"],
      available: { totp: true, sms: true, whatsapp: true },
      methods: [],
      recoveryCodesLeft: 0,
    });
  });

  let recovery: string[] = [];

  it("sets up texts: the number, the first code, then recovery codes once", async () => {
    let cookie = await cookieFor(admin("a"));
    const started = await req("POST", "/api/auth/second-factor/phone", cookie, {
      method: "sms",
      phone: "+15550100000",
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json).toEqual({ sent: true, phoneHint: "•••• 0000" });
    expect(fake.sent.at(-1)).toMatchObject({ to: "+15550100000", channel: "sms" });

    const wrong = await req("POST", "/api/auth/second-factor/verify", cookie, {
      method: "sms",
      code: "000000",
    });
    expect(wrong.status).toBe(422);
    expect(j(wrong.json).error.code).toBe("wrong_code");

    const right = await req("POST", "/api/auth/second-factor/verify", cookie, {
      method: "sms",
      code: "123456",
    });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    recovery = j(right.json).recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(recovery[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    cookie = right.cookie ?? "";
    expect((await req("GET", "/api/session", cookie)).status).toBe(200);
    const [factor] = await H.t.db
      .select()
      .from(userFactor)
      .where(eq(userFactor.userId, ids[admin("a")] ?? ""));
    expect(factor).toMatchObject({ kind: "sms", phone: "+15550100000" });
    expect(factor?.verifiedAt).toBeTruthy();
  });

  it("signs in later with a recovery code, once", async () => {
    const code = recovery[0] ?? "";
    const first = await req("POST", "/api/auth/second-factor/verify", await cookieFor(admin("a")), {
      method: "recovery",
      code: code.toUpperCase(),
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(j(first.json).recoveryCodes).toBeNull();
    const again = await req("POST", "/api/auth/second-factor/verify", await cookieFor(admin("a")), {
      method: "recovery",
      code,
    });
    expect(again.status).toBe(422);
  });

  it("holds operators to the authenticator app", async () => {
    const cookie = await cookieFor(OPERATOR);
    const state = await req("GET", "/api/auth/second-factor", cookie);
    expect(state.json).toMatchObject({ operator: true, allowed: ["totp"] });
    const phone = await req("POST", "/api/auth/second-factor/phone", cookie, {
      method: "sms",
      phone: "+15550100001",
    });
    expect(phone.status).toBe(403);
    expect(j(phone.json).error.code).toBe("operator_needs_authenticator");

    const totp = await req("POST", "/api/auth/second-factor/totp", cookie);
    expect(totp.status, JSON.stringify(totp.json)).toBe(200);
    expect(j(totp.json).uri).toMatch(/^otpauth:\/\/totp\//);
    const done = await req("POST", "/api/auth/second-factor/verify", cookie, {
      method: "totp",
      code: "654321",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).recoveryCodes).toHaveLength(10);
  });

  it("stops after too many wrong codes", async () => {
    const cookie = await cookieFor(user("a"));
    await req("POST", "/api/auth/second-factor/phone", cookie, {
      method: "whatsapp",
      phone: "+15550100002",
    });
    for (let i = 0; i < SECOND_FACTOR_MAX_TRIES; i++) {
      const wrong = await req("POST", "/api/auth/second-factor/verify", cookie, {
        method: "whatsapp",
        code: "000000",
      });
      expect(wrong.status).toBe(422);
    }
    const blocked = await req("POST", "/api/auth/second-factor/verify", cookie, {
      method: "whatsapp",
      code: "123456",
    });
    expect(blocked.status).toBe(429);
    expect(j(blocked.json).error.code).toBe("too_many_attempts");
  });

  it("lets an operator reset a person's methods; they set up again", async () => {
    const op = await cookieFor(OPERATOR, "done");
    const res = await req("POST", `/api/ops/users/${ids[admin("a")]}/second-factor/reset`, op, {
      reason: "Lost phone",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ reset: true, methodsRemoved: 1 });
    const state = await req("GET", "/api/auth/second-factor", await cookieFor(admin("a")));
    expect(state.json).toMatchObject({ methods: [], recoveryCodesLeft: 0 });
    // Not a person in this operator's clients.
    expect(
      (
        await req("POST", `/api/ops/users/${ids[admin("c")]}/second-factor/reset`, op, {
          reason: "x",
        })
      ).status,
    ).toBe(404);
  });

  it("approves a Claude connection only from the operator whose it is", async () => {
    const now = new Date();
    const gate = (sessionId: string) =>
      claudeConnectionGate({
        db: H.db,
        env: H.env,
        deps: { verify: () => fake.client },
        userId: ids[OPERATOR] ?? "",
        sessionId,
        appOrigin: "https://staging.mezonas.test",
        now,
      });
    const refused = await gate("authkit_session_1");
    expect(refused.ok).toBe(false);
    const link = /\/ops\/connect-claude\/([a-z2-7]+)/.exec(refused.ok ? "" : refused.message)?.[1];
    expect(link).toBeTruthy();

    const op = await cookieFor(OPERATOR, "done");
    const seen = await req("GET", `/api/ops/claude-connections/${link}`, op);
    expect(seen.json).toMatchObject({ status: "waiting", yours: true });
    const approved = await req("POST", `/api/ops/claude-connections/${link}/approve`, op);
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(approved.json).toMatchObject({ status: "approved" });
    expect((await gate("authkit_session_1")).ok).toBe(true);
    // Another AuthKit session needs its own approval.
    expect((await gate("authkit_session_2")).ok).toBe(false);
  });
});
