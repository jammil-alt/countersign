// The demo seed (SEED_DEMO=1): Harbor Millwork and Fox River Cabinetry with weeks of runs each;
// running it twice changes nothing, it leaves the Demo client and the Sandbox as they were, each
// client's rows are its own under RLS, and its versions, changes and findings keep the platform's
// invariants.

import {
  type AgentBundle,
  bundleHash,
  holdsProcess,
  isUuid,
  validateBundle,
} from "@countersign/core";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import {
  agent,
  agentVersion,
  connection,
  document,
  externalAction,
  inboxItem,
  run,
  TENANT_TABLES,
} from "./schema";
import { type SeedResult, seed } from "./seed";
import { FOX_RIVER_PROFILE, HARBOR, HARBOR_PEOPLE, seedDemo } from "./seed-demo";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();
const PURCHASE_COST = "qbo.item.update_purchase_cost";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}

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

  it("adds Fox River Cabinetry as a second client of its own, leaving Harbor Millwork as it was", async () => {
    const harbor = await seedDemo(t.db, { operatorId: base.users.operator });
    const before = await counts();
    const fox = await seedDemo(t.db, {
      operatorId: base.users.operator,
      profile: FOX_RIVER_PROFILE,
    });
    const after = await counts();
    expect(fox.tenantId).not.toBe(harbor.tenantId);
    // Every row it adds is its own; nothing of Harbor Millwork or the others changed.
    for (const [key, n] of Object.entries(before)) expect(after[key], key).toBe(n);
    for (const key of Object.keys(after)) {
      if (!(key in before)) expect(key.endsWith(`:${fox.tenantId}`), key).toBe(true);
    }
    // The same weeks of work: four agents and as many runs and documents, its own people.
    expect(Object.keys(fox.agents).sort()).toEqual(Object.keys(harbor.agents).sort());
    // About as many runs: its times are later, so a daily check can fall either side of "now".
    expect(Math.abs(fox.counts.runs - harbor.counts.runs)).toBeLessThanOrEqual(2);
    expect(fox.counts.documents).toBe(34);
    expect(after[`run:${fox.tenantId}`]).toBe(fox.counts.runs);
    const users = await t.db.$client<{ email: string; role: string }[]>`
      select u.email, m.role from membership m join app_user u on u.id = m.user_id
      where m.tenant_id = ${fox.tenantId} order by u.email`;
    expect(users).toEqual([
      { email: FOX_RIVER_PROFILE.people.admin.email, role: "client_admin" },
      { email: "operator@example.com", role: "operator" },
      { email: FOX_RIVER_PROFILE.people.user.email, role: "client_user" },
    ]);
    const [client] = await t.db.$client<{ name: string }[]>`
      select name from tenant where id = ${fox.tenantId}`;
    expect(client?.name).toBe("Fox River Cabinetry");
    // Its invoices are its own numbers, not Harbor Millwork's.
    const numbers = await t.db.$client<{ n: string }[]>`
      select distinct d.tenant_id::text as n from document d
      where d.filename = 'Northline_Invoice_20398.pdf'`;
    expect(numbers.map((r) => r.n)).toEqual([harbor.tenantId]);
    // Twice is the same as once.
    expect(
      await seedDemo(t.db, { operatorId: base.users.operator, profile: FOX_RIVER_PROFILE }),
    ).toEqual(fox);
    expect(await counts()).toEqual(after);
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
        ["price-keeper", "trial", "active"],
        ["supervisor", "live", "active"],
      ]);
      expect(agents.find((a) => a.slug === "supervisor")?.serviceName).toBe("Supervisor");
      for (const a of agents) {
        expect(a.liveVersionId, a.slug).not.toBeNull();
        expect(a.templateId === null, a.slug).toBe(a.slug === "price-keeper");
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

  it("runs the Price keeper on QuickBooks, with no testkit anywhere for the client", async () => {
    const d = await seedDemo(t.db, { operatorId: base.users.operator });
    await withTenant(t.db, d.tenantId, async (tx) => {
      await asWorker(tx);
      // The testkit is for the Sandbox and template test copies, never this client.
      const connections = await tx
        .select()
        .from(connection)
        .where(eq(connection.tenantId, d.tenantId));
      expect(connections.map((c) => c.connector).sort()).toEqual(["qbo", "upload"]);
      const qbo = must(connections.find((c) => c.connector === "qbo"));

      const [keeper] = await tx
        .select()
        .from(agent)
        .where(and(eq(agent.tenantId, d.tenantId), eq(agent.slug, "price-keeper")));
      expect(keeper?.serviceName).toBe("Price keeper");
      expect(keeper?.bindings).toEqual({ qbo: qbo.id });
      const [live] = await tx
        .select()
        .from(agentVersion)
        .where(eq(agentVersion.id, must(keeper?.liveVersionId)));
      const stored = must(live).bundle;
      expect(holdsProcess(stored)).toBe(false);
      const bundle = stored as AgentBundle;
      expect(bundle.definition.extraTools).toEqual([PURCHASE_COST]);
      // Invariant 8: its one write step asks for a signature.
      const writes = bundle.workflows
        .flatMap((w) => w.workflow.steps)
        .flatMap((s) => (s.kind === "action" ? [[s.tool, s.approval.required]] : []));
      expect(writes).toEqual([[PURCHASE_COST, "required"]]);
      expect(JSON.stringify(bundle)).not.toContain("testkit");

      // Its changes: the item and its cost before and after, as decimal strings. Dana signed all
      // three; two were written and QuickBooks refused one (the item changed since it was read).
      const actions = await tx
        .select()
        .from(externalAction)
        .where(
          and(eq(externalAction.tenantId, d.tenantId), eq(externalAction.tool, PURCHASE_COST)),
        );
      expect(actions.map((a) => a.status).sort()).toEqual(["done", "done", "failed"]);
      for (const a of actions) {
        expect(a.connectionId).toBe(qbo.id);
        expect(a.approvedBy).toBe(d.users.admin);
        const before = a.before as { name: string; purchaseCost: string };
        const input = a.input as { purchaseCost: string };
        expect(before.name).not.toBe("");
        expect(before.purchaseCost).toMatch(/^\d+\.\d{4}$/);
        expect(input.purchaseCost).toMatch(/^\d+\.\d{4}$/);
        expect(input.purchaseCost).not.toBe(before.purchaseCost);
      }
      expect(actions.find((a) => a.status === "failed")?.error).toEqual({
        message: expect.stringContaining("changed in QuickBooks since it was read"),
      });

      // The Supervisor's open finding on it, for the operator.
      const findings = await tx
        .select()
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, d.tenantId),
            eq(inboxItem.subjectType, "supervisor_finding"),
            eq(inboxItem.status, "open"),
          ),
        );
      const onKeeper = findings.filter((f) => f.title.startsWith("Price keeper:"));
      expect(onKeeper.map((f) => f.assigneeRole)).toEqual(["operator"]);
    });

    // Not even a row the client's session can't see.
    const testkit = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from connection
      where tenant_id = ${d.tenantId} and connector = 'testkit'`;
    expect(testkit).toEqual([{ n: 0 }]);
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
