// The Claude connector's approval link (docs/plan.md §1.120), through the API with a fake WorkOS (the
// browser's sign-in and its second step, codes in memory) and a fake AuthKit (Claude's tokens):
// off without the step; on, Claude connects but each tool call is refused with a link until the
// person, signed in past the step, approves it; the link is the person's own, kept as an HMAC,
// replaced on each refusal and good for 30 minutes; the approval is tied to the AuthKit session;
// a client's link opens the portal; set up wrongly, it fails closed.

import type { WorkOSAuthentication, WorkOSClient } from "@countersign/auth";
import { memoryCodeVerifier } from "@countersign/connectors";
import { appUser, auditEvent, mcpSessionApproval } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import type { Bindings } from "./env";
import { claudeClientInWords } from "./mcp/approval";
import type { McpAuditEntry } from "./mcp/audit";
import { memoryRateLimiter } from "./mcp/limits";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ISSUER = "https://auth.mezonas.test";
const ORIGIN = "https://staging.mezonas.test";
const RESOURCE = `${ORIGIN}/mcp`;
const PASSWORD = "c".repeat(64);
const LINK = /open (https:\/\/\S+\/connect-claude\/([a-z2-7]{32})) in the browser/;
const CONFIRM = /type the code ([0-9]{6}) there/;

const signing = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" }],
});

const verifier = memoryCodeVerifier("246810");
const audit: McpAuditEntry[] = [];
// Claude's clock: real time, moved back only to make a link that is already past its 30 minutes.
let clockShift = 0;
const now = () => new Date(Date.now() + clockShift);
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
    APP_ORIGIN: ORIGIN,
    WORKOS_AUTHKIT_DOMAIN: ISSUER,
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000001",
    ENCRYPTION_KEY: "approval-test-key-0123456789abcdef",
  },
  workos,
  codeVerifier: verifier,
  mcp: {
    authorizationServer: () => ({
      async discover() {
        return {
          metadata: {
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/oauth2/jwks`,
            authorization_endpoint: `${ISSUER}/oauth2/authorize`,
            registration_endpoint: `${ISSUER}/oauth2/register`,
          },
          keys,
        };
      },
    }),
    audit: () => ({
      async record(entry) {
        audit.push(entry);
      },
    }),
    rateLimiter: () => memoryRateLimiter(10_000),
    now,
  },
  // A Worker's one pooled connection: a transaction opened beside another would wait on itself.
  appDbMax: 1,
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

const WORKOS_IDS = { operator: "wu_op", other: "wu_other", adminA: "wu_admin_a" };

describe("who is asking, in words (H6)", () => {
  it("names Anthropic's clients and, for anything else, its first product name only", () => {
    expect(claudeClientInWords("claude-code/2.1.0 (cli)")).toBe("Claude Code");
    expect(claudeClientInWords("Claude-User (+https://support.anthropic.com)")).toBe("Claude");
    expect(claudeClientInWords("python-httpx/0.28.1")).toBe("python-httpx");
    expect(claudeClientInWords("<script>alert(1)</script>")).toBeNull();
    expect(claudeClientInWords(`${"x".repeat(80)}/1`)).toBe("x".repeat(40));
    expect(claudeClientInWords("")).toBeNull();
    expect(claudeClientInWords(undefined)).toBeNull();
  });
});

describe.skipIf(!h)("the Claude connector's approval link (§1.120)", () => {
  const H = h as ApiHarness;
  let nextId = 1;

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

  /** Signs a person in with a password in `b`; with `code`, passes the step too. */
  async function signIn(b: Browser, email: string, workosId: string, code?: "sms" | "totp") {
    signingIn = {
      user: { id: workosId, email, firstName: null, lastName: null, emailVerified: true },
      organizationId: null,
      refreshToken: `rt_${workosId}`,
      sessionId: `browser_${workosId}`,
      authenticationMethod: "Password",
    };
    b.jar.delete("__Host-cs_session");
    const start = await request(b, "GET", "/api/auth/sign-in?return_to=/");
    const state = new URL(start.location ?? "").searchParams.get("state") ?? "";
    const done = await request(
      b,
      "GET",
      `/api/auth/callback?code=c${Math.random()}&state=${encodeURIComponent(state)}`,
    );
    expect(done.status).toBe(302);
    if (!code) return;
    const setup = await request(b, "POST", "/api/auth/second-factor/setup", {
      kind: code,
      ...(code === "sms" ? { phone: "+15551234567" } : {}),
    });
    expect(setup.status, JSON.stringify(setup.json)).toBe(200);
    const passed = await request(b, "POST", "/api/auth/second-factor/verify", {
      kind: code,
      code: "246810",
    });
    expect(passed.status, JSON.stringify(passed.json)).toBe(200);
  }

  async function token(sub: string, sid: string | null = "authkit_1"): Promise<string> {
    const at = Math.floor(now().getTime() / 1000);
    return new SignJWT(sid ? { sid } : {})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject(sub)
      .setIssuedAt(at - 5)
      .setExpirationTime(at + 3600)
      .sign(signing.privateKey);
  }

  async function rpc(
    bearer: string,
    method: string,
    params: Record<string, unknown> = {},
    env: Partial<Bindings> = {},
  ) {
    const res = await H.app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
          "user-agent": "Claude-User (claude-code/2.1.0; +https://www.anthropic.com)",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      },
      { ...H.env, ...env },
    );
    return { status: res.status, json: j(await res.json()) };
  }

  /** whoami → { text, isError, link, code } */
  async function whoami(bearer: string, env: Partial<Bindings> = {}) {
    const res = await rpc(bearer, "tools/call", { name: "whoami", arguments: {} }, env);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const text = (res.json.result.content as { type: string; text: string }[])
      .map((c) => c.text)
      .join("\n");
    const m = LINK.exec(text);
    return {
      text,
      isError: res.json.result.isError === true,
      link: m?.[1],
      code: m?.[2] ?? "",
      confirm: CONFIRM.exec(text)?.[1] ?? "",
    };
  }

  const operator = new Browser();
  const other = new Browser();

  beforeAll(async () => {
    // Each signs in once with a password and sets up the step (an operator: an authenticator app).
    await signIn(operator, "operator@example.com", WORKOS_IDS.operator, "totp");
    await signIn(other, "other-operator@example.com", WORKOS_IDS.other, "totp");
  });

  it("changes nothing while the step is off", async () => {
    const off = await whoami(await token(WORKOS_IDS.operator, "authkit_off"), {
      TWILIO_VERIFY_SERVICE_SID: "",
    });
    expect(off.isError, off.text).toBe(false);
    expect(off.text).toContain("operator@example.com");
  });

  let firstCode = "";
  let firstConfirm = "";

  it("lets Claude connect, then answers its first tool call with the operator's link", async () => {
    const bearer = await token(WORKOS_IDS.operator);
    const init = await rpc(bearer, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("mezonas-ops");
    const list = await rpc(bearer, "tools/list");
    expect(list.json.result.tools.length).toBeGreaterThan(0);

    const refused = await whoami(bearer);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^approval_needed: approve this Claude connection first: open /);
    expect(refused.text).toContain("(the link works for 30 minutes)");
    expect(refused.text).not.toContain("operator@example.com");
    expect(refused.link).toBe(`${ORIGIN}/ops/connect-claude/${refused.code}`);
    firstCode = refused.code;
    firstConfirm = refused.confirm;
    expect(refused.text).toContain(`type the code ${firstConfirm} there`);
    // The log line says it was refused, without the link.
    const line = audit.at(-1);
    expect(line).toMatchObject({ tool: "whoami", outcome: "error", code: "approval_needed" });
    expect(JSON.stringify(line)).not.toContain(firstCode);
    // Kept as an HMAC, tied to the AuthKit session and the person.
    const rows = await H.t.db
      .select()
      .from(mcpSessionApproval)
      .where(eq(mcpSessionApproval.workosSessionId, "authkit_1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: H.operator, approvedAt: null });
    expect(rows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.codeHash).not.toContain(firstCode);
  });

  it("gives a new link on each refused call; the old one matches nothing", async () => {
    const again = await whoami(await token(WORKOS_IDS.operator));
    expect(again.code).not.toBe(firstCode);
    const old = await request(operator, "GET", `/api/auth/claude-connections/${firstCode}`);
    expect(old.status).toBe(404);
    firstCode = again.code;
    firstConfirm = again.confirm;
    // Still one row for the session.
    const rows = await H.t.db
      .select()
      .from(mcpSessionApproval)
      .where(eq(mcpSessionApproval.workosSessionId, "authkit_1"));
    expect(rows).toHaveLength(1);
  });

  it("can't be read or approved from a browser that hasn't passed the step", async () => {
    const pending = new Browser();
    await signIn(pending, "operator@example.com", WORKOS_IDS.operator);
    for (const [method, path] of [
      ["GET", `/api/auth/claude-connections/${firstCode}`],
      ["POST", `/api/auth/claude-connections/${firstCode}/approve`],
    ] as const) {
      const res = await request(
        pending,
        method,
        path,
        method === "POST" ? { confirm: firstConfirm } : undefined,
      );
      expect(res.status, path).toBe(401);
      expect(res.json.error.code, path).toBe("second_factor_required");
    }
    const signedOut = await request(
      new Browser(),
      "GET",
      `/api/auth/claude-connections/${firstCode}`,
    );
    expect(signedOut.status).toBe(401);
  });

  it("is another person's link to no one else: it matches nothing", async () => {
    for (const [method, path] of [
      ["GET", `/api/auth/claude-connections/${firstCode}`],
      ["POST", `/api/auth/claude-connections/${firstCode}/approve`],
    ] as const) {
      const res = await request(
        other,
        method,
        path,
        method === "POST" ? { confirm: firstConfirm } : undefined,
      );
      expect(res.status, path).toBe(404);
    }
  });

  it("is approved by its own person past the step, and Claude's calls then work", async () => {
    const seen = await request(operator, "GET", `/api/auth/claude-connections/${firstCode}`);
    expect(seen.status, JSON.stringify(seen.json)).toBe(200);
    expect(seen.json.status).toBe("waiting");
    const linkEnds = new Date(seen.json.expiresAt).getTime() - Date.now();
    expect(linkEnds).toBeGreaterThan(29 * 60_000);
    expect(linkEnds).toBeLessThanOrEqual(30 * 60_000);

    // When Claude asked with this link, for the person to compare.
    expect(Math.abs(new Date(seen.json.requestedAt).getTime() - Date.now())).toBeLessThan(60_000);
    // H6: who is asking, in words, never the user agent; no place where Cloudflare gave none.
    expect(seen.json.client).toBe("Claude Code");
    expect(seen.json.place).toBeNull();
    expect(JSON.stringify(seen.json)).not.toContain("Claude-User");

    // One click is not enough: the code Claude showed must be typed, and a wrong one approves nothing.
    const bare = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${firstCode}/approve`,
      {},
    );
    expect(bare.status).toBe(400);
    const wrongCode = firstConfirm === "000000" ? "111111" : "000000";
    const wrong = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${firstCode}/approve`,
      { confirm: wrongCode },
    );
    expect([wrong.status, wrong.json.error.code]).toEqual([422, "wrong_code"]);
    const still = await request(operator, "GET", `/api/auth/claude-connections/${firstCode}`);
    expect(still.json.status).toBe("waiting");
    const [refusedRow] = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, "mcp.approve"),
          eq(auditEvent.actorUserId, H.operator),
          eq(auditEvent.outcome, "refused"),
        ),
      );
    expect(refusedRow?.target).toMatchObject({ reason: "wrong_code" });
    expect(JSON.stringify(refusedRow)).not.toContain(firstConfirm);
    expect((await whoami(await token(WORKOS_IDS.operator))).isError).toBe(true);
    // That call gave a new link and code; the person types the newest.
    const latest = await whoami(await token(WORKOS_IDS.operator));
    firstCode = latest.code;
    firstConfirm = latest.confirm;

    const ok = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${firstCode}/approve`,
      {
        confirm: firstConfirm,
      },
    );
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.status).toBe("approved");
    const lasts = new Date(ok.json.expiresAt).getTime() - new Date(ok.json.startedAt).getTime();
    expect(lasts).toBe(12 * 60 * 60 * 1000);
    const [okRow] = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, "mcp.approve"),
          eq(auditEvent.actorUserId, H.operator),
          eq(auditEvent.outcome, "ok"),
        ),
      );
    expect(okRow).toMatchObject({ outcome: "ok", tenantId: null });
    expect(JSON.stringify(okRow?.target)).not.toContain(firstCode);

    // Approving again changes nothing and writes no second row.
    const twice = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${firstCode}/approve`,
      { confirm: firstConfirm },
    );
    expect(twice.json.status).toBe("approved");
    const rows = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, "mcp.approve"),
          eq(auditEvent.actorUserId, H.operator),
          eq(auditEvent.outcome, "ok"),
        ),
      );
    expect(rows).toHaveLength(1);

    const works = await whoami(await token(WORKOS_IDS.operator));
    expect(works.isError, works.text).toBe(false);
    expect(works.text).toContain("operator@example.com");
  });

  it("is tied to the AuthKit session: a new Claude sign-in asks again", async () => {
    const fresh = await whoami(await token(WORKOS_IDS.operator, "authkit_2"));
    expect(fresh.isError).toBe(true);
    expect(fresh.code).toMatch(/^[a-z2-7]{32}$/);
    // And another operator's token on the approved session id is theirs to approve.
    const theirs = await whoami(await token(WORKOS_IDS.other, "authkit_1"));
    expect(theirs.isError).toBe(true);
  });

  it("refuses a token that names no sign-in session", async () => {
    const none = await whoami(await token(WORKOS_IDS.operator, null));
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^approval_needed: this sign-in can't be approved/);
    expect(none.link).toBeUndefined();
  });

  it("stops a link after 5 wrong codes, even sent at once; Claude then gives a new one", async () => {
    const bearer = await token(WORKOS_IDS.operator, "authkit_guesses");
    const link = await whoami(bearer);
    const wrongCode = link.confirm === "000000" ? "111111" : "000000";
    const tries = await Promise.all(
      Array.from({ length: 7 }, () =>
        request(operator, "POST", `/api/auth/claude-connections/${link.code}/approve`, {
          confirm: wrongCode,
        }),
      ),
    );
    // Four wrong codes are told so; the fifth ends the link, and any try after it finds nothing.
    expect(tries.map((t) => t.status).sort()).toEqual([404, 404, 422, 422, 422, 422, 429]);
    expect(tries.find((t) => t.status === 429)?.json.error.code).toBe("too_many_attempts");
    const right = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${link.code}/approve`,
      { confirm: link.confirm },
    );
    expect(right.status).toBe(404);
    expect((await whoami(bearer)).isError).toBe(true);
    const next = await whoami(bearer);
    const ok = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${next.code}/approve`,
      {
        confirm: next.confirm,
      },
    );
    expect(ok.json.status, JSON.stringify(ok.json)).toBe("approved");
  });

  it("says a link past its 30 minutes has expired, and won't approve it", async () => {
    clockShift = -31 * 60_000;
    const late = await whoami(await token(WORKOS_IDS.operator, "authkit_late"));
    clockShift = 0;
    const seen = await request(operator, "GET", `/api/auth/claude-connections/${late.code}`);
    expect(seen.json.status).toBe("expired");
    const refused = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${late.code}/approve`,
      { confirm: late.confirm },
    );
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("expired");
  });

  it("approves a Claude sign-in whose AuthKit session has outlived 12 hours", async () => {
    // Claude first asked 13 hours ago in this session and nobody approved; the session lives on.
    const bearer = await token(WORKOS_IDS.operator, "authkit_long");
    expect((await whoami(bearer)).isError).toBe(true);
    await H.t.db
      .update(mcpSessionApproval)
      .set({ createdAt: new Date(Date.now() - 13 * 60 * 60_000) })
      .where(eq(mcpSessionApproval.workosSessionId, "authkit_long"));
    const link = await whoami(bearer);
    const ok = await request(
      operator,
      "POST",
      `/api/auth/claude-connections/${link.code}/approve`,
      { confirm: link.confirm },
    );
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.status).toBe("approved");
    // A new 12 hours, counted from the link that was approved.
    expect(new Date(ok.json.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60_000);
    expect((await whoami(bearer)).isError).toBe(false);
  });

  it("sends a client's person to the portal, and they approve their own", async () => {
    const admin = new Browser();
    const [user] = await H.t.db.select().from(appUser).where(eq(appUser.id, H.A.admin));
    if (!user) throw new Error("no client admin");
    await signIn(admin, user.email, WORKOS_IDS.adminA, "sms");
    const refused = await whoami(await token(WORKOS_IDS.adminA, "authkit_client"));
    expect(refused.isError).toBe(true);
    expect(refused.link).toBe(`${ORIGIN}/connect-claude/${refused.code}`);
    // The operator can't approve it either.
    expect(
      (await request(operator, "GET", `/api/auth/claude-connections/${refused.code}`)).status,
    ).toBe(404);
    const ok = await request(
      admin,
      "POST",
      `/api/auth/claude-connections/${refused.code}/approve`,
      {
        confirm: refused.confirm,
      },
    );
    expect(ok.json.status, JSON.stringify(ok.json)).toBe("approved");
    const works = await whoami(await token(WORKOS_IDS.adminA, "authkit_client"));
    expect(works.isError, works.text).toBe(false);
  });

  it("fails closed when the step is set up wrongly", async () => {
    const broken = await whoami(await token(WORKOS_IDS.operator, "authkit_broken"), {
      ENCRYPTION_KEY: "",
    });
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/^second_factor_unavailable: /);
    expect(broken.link).toBeUndefined();
  });

  it("refuses a code that can't be one before reading anything", async () => {
    const res = await request(operator, "GET", "/api/auth/claude-connections/NOT-A-CODE");
    expect(res.status).toBe(400);
  });
});
