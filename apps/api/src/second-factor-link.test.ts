// The emailed setup link (owner, 2026-11-19; docs/plan.md §1.100): where Mezonas can send email, a
// first sign-in with a password sets up its first method from a link sent to the sign-in address,
// never on the step's page. The link sets up a text number and/or an authenticator app, shows the
// recovery codes once, and signs nobody in; the person then passes the step with a code. A forged,
// expired or stale link, or one for a person already set up, opens nothing.

import type { WorkOSAuthentication, WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { appUser, auditEvent, membership, userFactor } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { signSetupLink } from "./second-factor/link";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const PASSWORD = "s".repeat(64);
const ENCRYPTION_KEY = "setup-link-test-key-0123456789abcdef";
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

/** What reached Resend. */
const mail: Array<Record<string, unknown>> = [];
const fetchFake = async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.resend.com/emails")) {
    throw new Error(`unexpected fetch ${String(url)}`);
  }
  mail.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return new Response(JSON.stringify({ id: `re_${mail.length}` }));
};

const ORIGIN = "https://staging.mezonas.test";
const h = await createApiHarness({
  env: {
    ENVIRONMENT: "staging",
    AUTH_PROVIDER: "workos",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    APP_ORIGIN: ORIGIN,
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000004",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "re_test",
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
  },
  workos,
  codeVerifier: verifier,
  fetch: fetchFake as never,
});
afterAll(() => h?.close());

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

describe.skipIf(!h)("the emailed setup link (owner, 2026-11-19)", () => {
  const H = h as ApiHarness;
  let n = 0;

  async function request(b: Browser | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { "accept-language": "es-MX,es;q=0.9" };
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

  /** A new client user in client A, signed in with a password in `b`: pending, no method. */
  async function newPerson(b: Browser) {
    const email = `pat${++n}@a.example.com`;
    const [u] = await H.t.db
      .insert(appUser)
      .values({ email, name: "Pat" })
      .returning({ id: appUser.id });
    const userId = u?.id ?? "";
    await H.t.db.insert(membership).values({ tenantId: H.A.tenantId, userId, role: "client_user" });
    signingIn = {
      user: { id: `wu_link_${n}`, email, firstName: null, lastName: null, emailVerified: true },
      organizationId: null,
      refreshToken: `rt_${n}`,
      sessionId: `sess_link_${n}`,
      authenticationMethod: "Password",
    };
    const start = await request(b, "GET", "/api/auth/sign-in?return_to=/inbox");
    const state = new URL(start.location ?? "").searchParams.get("state") ?? "";
    const done = await request(
      b,
      "GET",
      `/api/auth/callback?code=c${Math.random()}&state=${encodeURIComponent(state)}`,
    );
    expect(done.location).toBe("/sign-in/second-step?return_to=%2Finbox");
    return { userId, email };
  }

  /** The token in the last email's link. */
  const lastToken = () => {
    const text = String(mail.at(-1)?.text ?? "");
    const m = text.match(/\/sign-in\/setup\/([A-Za-z0-9_.-]+)/);
    return m?.[1] ?? "";
  };

  it("sends the link instead of setting up on the page, and sets up both methods from it", async () => {
    const b = new Browser();
    const { userId, email } = await newPerson(b);
    const status = await request(b, "GET", "/api/auth/second-factor");
    expect(status.json).toMatchObject({ state: "pending", setupNeeded: true, setupByEmail: true });

    // Not on this page.
    const here = await request(b, "POST", "/api/auth/second-factor/setup", { kind: "totp" });
    expect(here.status).toBe(403);
    expect(here.json.error.code).toBe("setup_by_email");

    mail.length = 0;
    const sent = await request(b, "POST", "/api/auth/second-factor/setup-link", {});
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json).toEqual({ ok: true, emailHint: "p•••@a.example.com" });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: [email], subject: "Configure su acceso a Mezonas" });
    const token = lastToken();
    expect(String(mail[0]?.text)).toContain(`${ORIGIN}/sign-in/setup/${token}`);

    // The link's page: no session.
    const page = await request(null, "GET", `/api/auth/setup-link/${token}`);
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect(page.json).toMatchObject({ emailHint: "p•••@a.example.com", allowed: ["totp", "sms"] });

    // A text number: a wrong code, then the right one, with recovery codes once.
    const sms = await request(null, "POST", `/api/auth/setup-link/${token}/setup`, {
      kind: "sms",
      phone: "+15551112222",
    });
    expect(sms.status, JSON.stringify(sms.json)).toBe(200);
    expect(sms.json.phoneHint).toBe("•••• 2222");
    const wrong = await request(null, "POST", `/api/auth/setup-link/${token}/verify`, {
      kind: "sms",
      code: "000000",
    });
    expect(wrong.status).toBe(422);
    const right = await request(null, "POST", `/api/auth/setup-link/${token}/verify`, {
      kind: "sms",
      code: "246810",
    });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    expect(right.json.recoveryCodes).toHaveLength(10);

    // And an authenticator app, from the same link: no new recovery codes.
    const totp = await request(null, "POST", `/api/auth/setup-link/${token}/setup`, {
      kind: "totp",
    });
    expect(totp.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const app = await request(null, "POST", `/api/auth/setup-link/${token}/verify`, {
      kind: "totp",
      code: "246810",
    });
    expect(app.json).toEqual({ ok: true, recoveryCodes: null });
    // Nothing left to set up: the same kind again is refused.
    const again = await request(null, "POST", `/api/auth/setup-link/${token}/setup`, {
      kind: "sms",
      phone: "+15559990000",
    });
    expect(again.status).toBe(409);

    // The link signed nobody in; the browser now passes the step with a code.
    const after = await request(b, "GET", "/api/auth/second-factor");
    expect(after.json).toMatchObject({ state: "pending", setupNeeded: false });
    await request(b, "POST", "/api/auth/second-factor/send", { kind: "sms" });
    const passed = await request(b, "POST", "/api/auth/second-factor/verify", {
      kind: "sms",
      code: "246810",
    });
    expect(passed.status, JSON.stringify(passed.json)).toBe(200);
    expect(passed.json.recoveryCodes).toBeNull();
    expect((await request(b, "GET", "/api/session")).status).toBe(200);

    const rows = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorUserId, userId),
          eq(auditEvent.action, "session.second_factor_setup"),
        ),
      )
      .orderBy(asc(auditEvent.id));
    expect(rows.map((r) => r.target)).toContainEqual({
      kind: "sms",
      via: "link",
      step: "verified",
    });
  });

  it("opens nothing for a forged, expired or stale link, or once the person was set up before it", async () => {
    const b = new Browser();
    const { userId, email } = await newPerson(b);
    const now = new Date();
    const forged = `${(await signSetupLink({ ENCRYPTION_KEY: "another-key-0123456789abcdef" }, { userId, email, now })).split(".")[0]}.${"A".repeat(43)}`;
    expect((await request(null, "GET", `/api/auth/setup-link/${forged}`)).status).toBe(404);
    const expired = await signSetupLink(H.env, {
      userId,
      email,
      now: new Date(now.getTime() - 31 * 60_000),
    });
    expect((await request(null, "GET", `/api/auth/setup-link/${expired}`)).status).toBe(404);
    // A link for an address the person no longer has.
    const oldAddress = await signSetupLink(H.env, { userId, email: "old@a.example.com", now });
    expect((await request(null, "GET", `/api/auth/setup-link/${oldAddress}`)).status).toBe(404);

    // Set up before this link was sent: the link adds nothing.
    await H.t.db.insert(userFactor).values({
      userId,
      kind: "sms",
      phone: "+15553334444",
      verifiedAt: new Date(now.getTime() - 60_000),
    });
    const late = await signSetupLink(H.env, { userId, email, now });
    expect((await request(null, "GET", `/api/auth/setup-link/${late}`)).status).toBe(404);
    const add = await request(null, "POST", `/api/auth/setup-link/${late}/setup`, { kind: "totp" });
    expect(add.status).toBe(404);
    // And no new link for someone already set up.
    const more = await request(b, "POST", "/api/auth/second-factor/setup-link", {});
    expect(more.status).toBe(409);
  });
});
