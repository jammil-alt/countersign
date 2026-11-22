// The back office's MCP connector held to HIPAA mode (docs/plan.md §1.190, docs/hipaa-plan.md
// T1), against a real database as cs_worker with a fake AuthKit. Client A is in HIPAA mode with
// Anthropic's API covered but not claude.ai; client B is not. A call naming A is refused, a call
// across clients is refused while A is served, the lists of clients leave A out, and calls about B
// (and an operator serving only normal clients) are answered as before. Once `claude_ai` is
// recorded, A is answered too.

import { appUser, auditEvent, tenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import type { Bindings } from "./env";
import { auditEventSink, type McpAuditEntry } from "./mcp/audit";
import { memoryRateLimiter } from "./mcp/limits";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ISSUER = "https://auth.mezonas.test";
const ORIGIN = "https://staging.mezonas.test";
const RESOURCE = `${ORIGIN}/mcp`;
const API_ONLY = "cloudflare,neon,workos,anthropic";

const signing = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" }],
});
const audit: McpAuditEntry[] = [];
const clock = new Date("2026-11-22T12:00:00Z");

const h = await createApiHarness({
  env: {
    ENVIRONMENT: "staging",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_COOKIE_PASSWORD: "mcp-test-cookie-password-0123456789abcdef",
    APP_ORIGIN: ORIGIN,
    WORKOS_AUTHKIT_DOMAIN: ISSUER,
    BAA_PROCESSORS: API_ONLY,
  },
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
    audit: (c) => {
      const rows = auditEventSink(c.get("req").services().db, c);
      return {
        async record(entry) {
          audit.push(entry);
          await rows.record(entry);
        },
      };
    },
    rateLimiter: () => memoryRateLimiter(10_000),
    now: () => clock,
  },
});
afterAll(() => h?.close());

async function token(sub: string): Promise<string> {
  const now = Math.floor(clock.getTime() / 1000);
  return new SignJWT({ sid: "session_x" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(sub)
    .setIssuedAt(now - 5)
    .setExpirationTime(now + 3600)
    .sign(signing.privateKey);
}

describe.skipIf(!h)("MCP connector and HIPAA mode", () => {
  const H = h as ApiHarness;
  let opToken = "";
  let otherToken = "";
  let nextId = 1;

  async function tool(
    bearer: string,
    name: string,
    args: Record<string, unknown> = {},
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      },
      { ...H.env, ...env },
    );
    expect(res.status).toBe(200);
    const result = j(await res.json()).result as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.map((c) => c.text ?? "").join("\n");
    return {
      text,
      isError: result.isError === true,
      data: () => {
        const m = /<untrusted-data source="[^"]+">\n([\s\S]*)\n<\/untrusted-data>/.exec(text);
        if (!m?.[1]) throw new Error(`no data block in: ${text}`);
        return j(JSON.parse(m[1]));
      },
    };
  }

  async function setHipaa(tenantId: string, hipaa: boolean) {
    const [row] = await H.t.db
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    await H.t.db
      .update(tenant)
      .set({ settings: { ...settings, compliance: { hipaa } } })
      .where(eq(tenant.id, tenantId));
  }

  const ids = (list: { id: string }[]) => list.map((c) => c.id).sort();

  beforeAll(async () => {
    await H.t.db
      .update(appUser)
      .set({ workosUserId: "user_operator" })
      .where(eq(appUser.id, H.operator));
    await H.t.db
      .update(appUser)
      .set({ workosUserId: "user_other_operator" })
      .where(eq(appUser.id, H.otherOperator));
    opToken = await token("user_operator");
    otherToken = await token("user_other_operator");
  });

  describe("no client in HIPAA mode", () => {
    it("answers every call as before", async () => {
      const who = await tool(opToken, "whoami");
      expect(who.isError).toBe(false);
      expect(ids(who.data().clients)).toEqual([H.A.tenantId, H.B.tenantId].sort());
      expect(who.text).not.toContain("HIPAA");
      expect((await tool(opToken, "runs_list")).isError).toBe(false);
      expect((await tool(opToken, "client_get", { client: H.A.tenantId })).isError).toBe(false);
    });
  });

  describe("client A in HIPAA mode, claude.ai not covered", () => {
    beforeAll(() => setHipaa(H.A.tenantId, true));
    afterAll(() => setHipaa(H.A.tenantId, false));

    it("refuses a call that names the HIPAA client, before the tool reads anything", async () => {
      const before = await H.t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "mcp tool connections_list"));
      for (const [name, args] of [
        ["client_get", { client: H.A.tenantId }],
        ["records_search", { client: H.A.tenantId }],
        ["connections_list", { client: H.A.tenantId }],
        ["runs_list", { client: H.A.tenantId }],
        ["marketing_report", { client: H.A.tenantId, report: "overview" }],
      ] as const) {
        const res = await tool(opToken, name, args);
        expect(res.isError, name).toBe(true);
        expect(res.text).toBe(
          `hipaa: ${name} through Claude sends data to Anthropic (claude.ai), which has no signed BAA; this client is in HIPAA mode`,
        );
        expect(res.text).not.toContain("<untrusted-data");
      }
      // The tool never ran: no read of its own was audited, only the refused call.
      const after = await H.t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "mcp tool connections_list"));
      expect(after.length).toBe(before.length);
      const refused = audit.filter((e) => e.tool === "connections_list").at(-1);
      expect(refused).toMatchObject({
        event: "mcp.tool_call",
        tenantId: H.A.tenantId,
        outcome: "error",
        code: "hipaa",
        status: 409,
      });
      const [row] = await H.t.db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, "mcp.tool_call connections_list"),
            eq(auditEvent.tenantId, H.A.tenantId),
          ),
        );
      expect(row).toMatchObject({ outcome: "refused", httpStatus: 409 });
    });

    it("refuses a call across clients, and a read by id, while the operator serves it", async () => {
      for (const [name, args] of [
        ["runs_list", {}],
        ["inbox_list", {}],
        ["feedback_list", {}],
        ["connections_list", {}],
        ["ops_health", {}],
        ["run_get", { id: crypto.randomUUID() }],
        ["feedback_get", { id: crypto.randomUUID() }],
        ["code_requests_list", {}],
        ["catalog_search", { query: "invoice" }],
      ] as const) {
        const res = await tool(opToken, name, args);
        expect(res.isError, name).toBe(true);
        expect(res.text, name).toContain(
          `hipaa: ${name} through Claude may return any client you serve and sends data to Anthropic (claude.ai), which has no signed BAA; 1 client you serve is in HIPAA mode.`,
        );
      }
    });

    it("answers calls about the normal client", async () => {
      const client = await tool(opToken, "client_get", { client: H.B.tenantId });
      expect(client.isError).toBe(false);
      expect(client.data().client.id).toBe(H.B.tenantId);
      const conns = await tool(opToken, "connections_list", { client: H.B.tenantId });
      expect(conns.isError).toBe(false);
      expect(conns.data().connections.map((c: { client: { id: string } }) => c.client.id)).toEqual([
        H.B.tenantId,
      ]);
      expect((await tool(opToken, "runs_list", { client: H.B.tenantId })).isError).toBe(false);
      expect((await tool(opToken, "records_search", { client: H.B.tenantId })).isError).toBe(false);
    });

    it("leaves the HIPAA client out of whoami and clients_list", async () => {
      const who = await tool(opToken, "whoami");
      expect(who.isError).toBe(false);
      expect(ids(who.data().clients)).toEqual([H.B.tenantId]);
      expect(who.text).toContain("serving 2 clients. 1 client in HIPAA mode is left out here");
      const list = await tool(opToken, "clients_list");
      expect(list.isError).toBe(false);
      expect(ids(list.data().clients)).toEqual([H.B.tenantId]);
      expect(list.text).toContain("1 client in HIPAA mode is left out here");
      expect(list.text).not.toContain(H.A.tenantId);
    });

    it("answers an operator who serves no client in HIPAA mode, across clients too", async () => {
      const who = await tool(otherToken, "whoami");
      expect(ids(who.data().clients)).toEqual([H.C.tenantId]);
      expect(who.text).not.toContain("HIPAA");
      expect((await tool(otherToken, "runs_list")).isError).toBe(false);
      expect((await tool(otherToken, "connections_list")).isError).toBe(false);
    });

    it("answers the HIPAA client once claude.ai's BAA is recorded", async () => {
      const covered = { BAA_PROCESSORS: `${API_ONLY},claude_ai` };
      const client = await tool(opToken, "client_get", { client: H.A.tenantId }, covered);
      expect(client.isError).toBe(false);
      expect(client.data().client.id).toBe(H.A.tenantId);
      expect((await tool(opToken, "runs_list", {}, covered)).isError).toBe(false);
      const who = await tool(opToken, "whoami", {}, covered);
      expect(ids(who.data().clients)).toEqual([H.A.tenantId, H.B.tenantId].sort());
    });
  });
});
