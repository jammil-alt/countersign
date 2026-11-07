// Compliance controls (docs/plan.md §1.35): the audit log written by every session route, the
// operator's audit and access-review routes, security headers, a client's HIPAA mode (turning it
// on, offering connectors, the run-time tool policy and model guard) and retiring a client.

import { createTwilioConnector, MemoryObjectStore } from "@countersign/connectors";
import { parseCoveredProcessors } from "@countersign/core";
import { auditEvent, tenant } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";
import {
  ComplianceRefusal,
  guardModels,
  hipaaToolPolicy,
  profileReader,
} from "./compliance/policy";
import { purgeRetiredFiles } from "./compliance/retention";

const h = await createApiHarness({
  env: { BAA_PROCESSORS: "cloudflare,neon,workos,anthropic" },
  connectors: () => [createTwilioConnector()],
});
afterAll(() => h?.close());

describe.skipIf(!h)("compliance", () => {
  const harness = h as NonNullable<typeof h>;
  const call = harness.call.bind(harness);
  const { A, B, C } = harness;

  const rows = (where = sql`true`) =>
    harness.t.db.select().from(auditEvent).where(where).orderBy(auditEvent.id);

  describe("the audit log", () => {
    it("writes a row for a portal read, with who, the client, the route and the origin", async () => {
      const res = await call(admin("a"), "GET", "/api/runs", undefined, {
        "cf-connecting-ip": "203.0.113.9",
        "user-agent": "test-agent",
      });
      expect(res.status).toBe(200);
      const [row] = (await rows(eq(auditEvent.action, "GET /api/runs"))).slice(-1);
      expect(row).toMatchObject({
        tenantId: A.tenantId,
        actorKind: "user",
        actorEmail: admin("a"),
        actorRole: "client_admin",
        outcome: "ok",
        httpStatus: 200,
        ip: "203.0.113.9",
        userAgent: "test-agent",
      });
    });

    it("writes refused requests too: a client user reaching the back office", async () => {
      const res = await call(admin("a"), "GET", "/api/ops/clients");
      expect(res.status).toBe(403);
      const [row] = (await rows(eq(auditEvent.action, "GET /api/ops/clients"))).slice(-1);
      expect(row).toMatchObject({ outcome: "refused", httpStatus: 403, actorEmail: admin("a") });
    });

    it("names the client a back-office request acted in, from ?client= or a path id", async () => {
      await call(OPERATOR, "GET", `/api/ops/clients/${B.tenantId}/compliance`);
      const [row] = (
        await rows(eq(auditEvent.action, "GET /api/ops/clients/:id/compliance"))
      ).slice(-1);
      expect(row).toMatchObject({ tenantId: B.tenantId, target: { id: B.tenantId } });
    });

    it("is read by operators, limited to the clients they serve", async () => {
      const mine = await call(OPERATOR, "GET", "/api/ops/audit?limit=500");
      expect(mine.status).toBe(200);
      const events = (mine.json as { events: { client: { id: string } | null }[] }).events;
      expect(events.length).toBeGreaterThan(0);
      const clients = new Set(events.map((e) => e.client?.id ?? null));
      expect(clients.has(C.tenantId)).toBe(false);
      const other = await call(OTHER_OPERATOR, "GET", "/api/ops/audit?limit=500");
      const otherClients = new Set(
        (other.json as { events: { client: { id: string } | null }[] }).events.map(
          (e) => e.client?.id ?? null,
        ),
      );
      expect(otherClients.has(A.tenantId)).toBe(false);
      expect((await call(admin("a"), "GET", "/api/ops/audit")).status).toBe(403);
    });

    it("filters and pages", async () => {
      const page = await call(OPERATOR, "GET", "/api/ops/audit?limit=1&action=GET%20/api/");
      const body = page.json as { events: { id: string; action: string }[]; nextBefore: string };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.action.startsWith("GET /api/")).toBe(true);
      expect(body.nextBefore).toBe(body.events[0]?.id);
      const next = await call(OPERATOR, "GET", `/api/ops/audit?limit=1&before=${body.nextBefore}`);
      const older = (next.json as { events: { id: string }[] }).events[0];
      expect(older && older.id < body.nextBefore).toBe(true);
    });

    it("reviews access: each user, their roles, and when they were last seen", async () => {
      const res = await call(OPERATOR, "GET", "/api/ops/access-review");
      expect(res.status).toBe(200);
      const users = (
        res.json as {
          users: { email: string; memberships: { client: { id: string } }[]; lastSeenAt: string }[];
        }
      ).users;
      const a = users.find((u) => u.email === admin("a"));
      expect(a?.memberships.map((m) => m.client.id)).toEqual([A.tenantId]);
      expect(a?.lastSeenAt).toBeTruthy();
      expect(users.some((u) => u.memberships.some((m) => m.client.id === C.tenantId))).toBe(false);
    });
  });

  it("sends security headers on every API answer", async () => {
    const res = await call(admin("a"), "GET", "/api/runs");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const health = await call(null, "GET", "/api/health");
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  describe("HIPAA mode", () => {
    it("can't be turned on while an uncovered connector is offered", async () => {
      expect(
        (
          await call(OPERATOR, "PUT", `/api/ops/clients/${A.tenantId}/connectors`, {
            offered: ["upload", "twilio"],
          })
        ).status,
      ).toBe(200);
      const view = await call(OPERATOR, "GET", `/api/ops/clients/${A.tenantId}/compliance`);
      expect(view.json).toMatchObject({ hipaa: false, readiness: { ready: false } });
      const on = await call(OPERATOR, "PUT", `/api/ops/clients/${A.tenantId}/compliance`, {
        hipaa: true,
        reason: "Clinic",
      });
      expect(on.status).toBe(409);
      expect(JSON.stringify(on.json)).toContain("Twilio");
    });

    it("turns on with a reason once nothing uncovered is offered, and is logged", async () => {
      await call(OPERATOR, "PUT", `/api/ops/clients/${A.tenantId}/connectors`, {
        offered: ["upload", "testkit"],
      });
      const on = await call(OPERATOR, "PUT", `/api/ops/clients/${A.tenantId}/compliance`, {
        hipaa: true,
        reason: "Clinic",
      });
      expect(on.status).toBe(200);
      expect(on.json).toMatchObject({
        hipaa: true,
        changes: [{ setting: "hipaa", to: true, reason: "Clinic" }],
      });
      expect(
        (on.json as { processors: { id: string; covered: boolean }[] }).processors.find(
          (p) => p.id === "openai",
        ),
      ).toMatchObject({ covered: false });
    });

    it("refuses to offer an uncovered connector to a HIPAA client", async () => {
      const res = await call(OPERATOR, "PUT", `/api/ops/clients/${A.tenantId}/connectors`, {
        offered: ["upload", "twilio"],
      });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.json)).toContain("no signed BAA");
    });

    it("refuses tool calls and model calls that need an uncovered vendor, for that client only", async () => {
      const covered = parseCoveredProcessors("cloudflare,neon,workos,anthropic");
      const policy = hipaaToolPolicy(profileReader(harness.db), covered);
      expect(
        await policy.refuseTool({
          tenantId: A.tenantId,
          toolId: "sms.send",
          connectorId: "twilio",
        }),
      ).toContain("Twilio");
      expect(
        await policy.refuseTool({
          tenantId: B.tenantId,
          toolId: "sms.send",
          connectorId: "twilio",
        }),
      ).toBeNull();
      expect(
        await policy.refuseTool({
          tenantId: A.tenantId,
          toolId: "testkit.records.search",
          connectorId: "testkit",
        }),
      ).toBeNull();

      const inner: LlmTransport = { create: vi.fn(async () => ({}) as never) };
      const guarded = guardModels(inner, A.tenantId, profileReader(harness.db), covered);
      await expect(
        guarded.create({ model: "openai:gpt-5.5", max_tokens: 10, messages: [] }),
      ).rejects.toBeInstanceOf(ComplianceRefusal);
      await guarded.create({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [] });
      expect(inner.create).toHaveBeenCalledTimes(1);
      const forB = guardModels(inner, B.tenantId, profileReader(harness.db), covered);
      await forB.create({ model: "openai:gpt-5.5", max_tokens: 10, messages: [] });
      expect(inner.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("retiring a client", () => {
    it("needs the client's name typed again", async () => {
      const res = await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/retire`, {
        reason: "Contract ended",
        confirmName: "Client A",
      });
      expect(res.status).toBe(422);
    });

    it("retires: the client's users can't sign in, its connections are gone, and it is logged", async () => {
      expect((await call(admin("b"), "GET", "/api/runs")).status).toBe(200);
      const res = await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/retire`, {
        confirmName: "client b",
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        retiredAt: expect.any(String),
        purgeAfter: expect.any(String),
        // No reason asked for: the log says what happened.
        changes: [{ setting: "retired", reason: "Retired from the back office" }],
      });
      expect((await call(admin("b"), "GET", "/api/runs")).status).toBe(403);
      const conn = await harness.t.db.execute<{ status: string; c: unknown }>(
        sql`select status, credentials_encrypted as c from connection where tenant_id = ${B.tenantId}`,
      );
      for (const r of conn) expect(r).toMatchObject({ status: "disconnected", c: null });
      // The operator still sees it, to see the retirement through.
      expect(
        (await call(OPERATOR, "GET", `/api/ops/clients/${B.tenantId}/compliance`)).status,
      ).toBe(200);
      expect(
        (
          await call(OPERATOR, "POST", `/api/ops/clients/${B.tenantId}/retire`, {
            reason: "again",
            confirmName: "Client B",
          })
        ).status,
      ).toBe(409);
    });

    it("deletes a retired client's files 30 days later, once, and leaves other clients' alone", async () => {
      const objects = new MemoryObjectStore();
      const bytes = new Uint8Array([1, 2, 3]);
      await objects.put(`tenants/${B.tenantId}/content/ab/abc`, bytes);
      await objects.put(`tenants/${B.tenantId}/feedback/x.jpg`, bytes);
      await objects.put(`tenants/${A.tenantId}/content/ab/abc`, bytes);
      const soon = await purgeRetiredFiles(harness.db, objects, new Date(Date.now() + 86_400_000));
      expect(soon).toEqual([]);
      const later = new Date(Date.now() + 31 * 86_400_000);
      expect(await purgeRetiredFiles(harness.db, objects, later)).toEqual([
        { tenantId: B.tenantId, files: 2 },
      ]);
      expect((await objects.list({ prefix: `tenants/${B.tenantId}/` })).objects).toEqual([]);
      expect((await objects.list({ prefix: `tenants/${A.tenantId}/` })).objects).toHaveLength(1);
      expect(await purgeRetiredFiles(harness.db, objects, later)).toEqual([]);
      const [t] = await harness.t.db
        .select({ settings: tenant.settings })
        .from(tenant)
        .where(eq(tenant.id, B.tenantId));
      expect(t?.settings).toMatchObject({ purge: { files_deleted_at: later.toISOString() } });
      expect(
        await rows(
          and(eq(auditEvent.tenantId, B.tenantId), eq(auditEvent.action, "client.purge_files")),
        ),
      ).toHaveLength(1);
    });
  });
});
