// The demo seed (SEED_DEMO=1): Harbor Millwork with weeks of runs; running it twice changes
// nothing, it leaves the Demo client and the Sandbox as they were, its rows are its own under RLS,
// and its versions, changes and findings keep the platform's invariants.

import { bundleHash, isUuid, validateBundle } from "@countersign/core";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import {
  agent,
  agentVersion,
  document,
  externalAction,
  inboxItem,
  run,
  TENANT_TABLES,
} from "./schema";
import { type SeedResult, seed } from "./seed";
import { HARBOR, HARBOR_PEOPLE, seedDemo } from "./seed-demo";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("demo seed", () => {
  let t: TestDatabase;
  let base: SeedResult;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    base = await seed(t.db, { e2e: true });
  });
  afterAll(async () => {
    await t?.drop();
  });

  /** Rows per tenant table, per client (null: the operator's own rows). */
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const table of TENANT_TABLES) {
      const rows = await t.db.$client.unsafe<{ tenant_id: string | null; n: number }[]>(
        `select tenant_id, count(*)::int as n from ${table} group by tenant_id`,
      );
      for (const r of rows) out[`${table}:${r.tenant_id ?? "-"}`] = r.n;
    }
    return out;
  };

  it("adds Harbor Millwork once; twice is the same as once; other clients are untouched", async () => {
    const before = await counts();
    const first = await seedDemo(t.db, { operatorId: base.users.operator });
    const afterFirst = await counts();
    const second = await seedDemo(t.db, { operatorId: base.users.operator });
    expect(second).toEqual(first);
    expect(await counts()).toEqual(afterFirst);

    // Nothing of the Demo client, the Sandbox or the templates changed.
    for (const [key, n] of Object.entries(before)) expect(afterFirst[key], key).toBe(n);
    for (const key of Object.keys(afterFirst)) {
      if (!(key in before)) expect(key.endsWith(`:${first.tenantId}`), key).toBe(true);
    }

    expect(first.counts.runs).toBeGreaterThanOrEqual(100);
    expect(first.counts.documents).toBe(34);
    expect(afterFirst[`run:${first.tenantId}`]).toBe(first.counts.runs);
    expect(afterFirst[`usage_daily:${first.tenantId}`]).toBeGreaterThan(30);
  });

  it("gives the client its people, its lead and four live client agents", async () => {
    const d = await seedDemo(t.db, { operatorId: base.users.operator });
    const users = await t.db.$client<{ email: string; role: string }[]>`
      select u.email, m.role from membership m join app_user u on u.id = m.user_id
      where m.tenant_id = ${d.tenantId} order by u.email`;
    expect(users).toEqual([
      { email: HARBOR_PEOPLE.admin.email, role: "client_admin" },
      { email: HARBOR_PEOPLE.user.email, role: "client_user" },
      { email: "operator@example.com", role: "operator" },
    ]);
    const [client] = await t.db.$client<{ timezone: string; lead: string }[]>`
      select timezone, settings->'lead'->>'userId' as lead from tenant where id = ${d.tenantId}`;
    expect(client).toEqual({ timezone: HARBOR.timezone, lead: base.users.operator });

    await withTenant(t.db, d.tenantId, async (tx) => {
      await asWorker(tx);
      const agents = await tx.select().from(agent).where(eq(agent.tenantId, d.tenantId));
      expect(agents.map((a) => [a.slug, a.stage, a.runStatus]).sort()).toEqual([
        ["bill-clerk", "live", "active"],
        ["document-clerk", "live", "active"],
        ["records-clerk", "trial", "active"],
        ["supervisor", "live", "active"],
      ]);
      expect(agents.find((a) => a.slug === "supervisor")?.serviceName).toBe("Supervisor");
      for (const a of agents) {
        expect(a.liveVersionId, a.slug).not.toBeNull();
        expect(a.templateId === null, a.slug).toBe(a.slug === "records-clerk");
      }
      // Every version is a valid bundle with its hash; forks name their template version.
      const versions = await tx
        .select()
        .from(agentVersion)
        .where(eq(agentVersion.tenantId, d.tenantId));
      for (const v of versions) {
        expect(validateBundle(v.bundle).valid).toBe(true);
        expect(v.bundleHash).toBe(await bundleHash(v.bundle));
        const forked = agents.find((a) => a.id === v.agentId)?.templateId !== null;
        expect(v.basedOnTemplateVersionId !== null).toBe(forked);
      }
      expect(versions.filter((v) => v.status === "live")).toHaveLength(4);
    });
  });

  it("keeps the inbox, the changes and the documents as the runtime writes them", async () => {
    const d = await seedDemo(t.db, { operatorId: base.users.operator });
    await withTenant(t.db, d.tenantId, async (tx) => {
      await asWorker(tx);
      const open = await tx
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.tenantId, d.tenantId), eq(inboxItem.status, "open")));
      const forClient = open.filter((i) => i.assigneeRole === "client_admin");
      const approvals = forClient.filter((i) => i.kind === "external_action");
      expect(approvals).toHaveLength(3);
      expect(forClient.filter((i) => i.kind === "request")).toHaveLength(1);
      const day = 24 * 3_600_000;
      expect(approvals.filter((i) => d.now.getTime() - i.createdAt.getTime() > day)).toHaveLength(
        1,
      );
      // Findings: open, with their fingerprint; the operator's carry their sources.
      const findings = open.filter((i) => i.subjectType === "supervisor_finding");
      expect(findings.length).toBeGreaterThanOrEqual(2);
      for (const f of findings.filter((i) => i.assigneeRole === "operator")) {
        expect((f.payload.sources as string[]).length).toBeGreaterThan(0);
      }

      const actions = await tx
        .select()
        .from(externalAction)
        .where(eq(externalAction.tenantId, d.tenantId));
      for (const a of actions) {
        expect(a.agentVersionId, a.id).not.toBeNull();
        expect(a.before, a.id).not.toBeNull();
      }
      const statuses = actions.map((a) => a.status);
      expect(statuses.filter((s) => s === "proposed")).toHaveLength(3);
      expect(statuses.filter((s) => s === "rejected")).toHaveLength(1);
      expect(statuses.filter((s) => s === "done").length).toBeGreaterThan(30);
      // Some written without a signature, some signed by the client admin.
      const done = actions.filter((a) => a.status === "done");
      expect(done.some((a) => a.approvedBy === null)).toBe(true);
      expect(done.some((a) => a.approvedBy === d.users.admin)).toBe(true);

      const duplicates = await tx
        .select({ meta: document.meta })
        .from(document)
        .where(and(eq(document.tenantId, d.tenantId), isNotNull(document.meta)));
      const marked = duplicates.filter((x) => (x.meta as { duplicateOf?: unknown }).duplicateOf);
      expect(marked).toHaveLength(1);

      // Every run names its version; runs started by an invoice name the document.
      const runs = await tx.select().from(run).where(eq(run.tenantId, d.tenantId));
      expect(runs.every((r) => isUuid(r.agentVersionId))).toBe(true);
      const byDocument = runs.filter(
        (r) => (r.trigger as { eventType?: string }).eventType === "document.extracted",
      );
      expect(byDocument.length).toBeGreaterThan(25);
    });

    // Another client's session sees none of it.
    const elsewhere = await withTenant(t.db, base.tenants.demo, async (tx) => {
      await asWorker(tx);
      return tx.select({ id: run.id }).from(run).where(eq(run.tenantId, d.tenantId));
    });
    expect(elsewhere).toEqual([]);
  });
});
