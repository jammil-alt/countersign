// The seed: the operator, two clients, memberships and the platform templates as live v1 rows whose
// bundles pass core's validation; running it twice changes nothing. And the seeded rows are where
// RLS says they are: templates for operator sessions only.

import { bundleHash, validateBundle } from "@countersign/core";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { agent, agentVersion, appUser, membership } from "./schema";
import { loadSeedTemplates, SEED_USERS, seed } from "./seed";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe("seed files", () => {
  it("hold the three platform templates, each a valid bundle", async () => {
    const templates = await loadSeedTemplates();
    expect(templates.map((t) => t.slug)).toEqual(["builder", "coordinator", "document-clerk"]);
    for (const t of templates) {
      expect(validateBundle(t.bundle).valid, t.slug).toBe(true);
      expect(t.bundle.definition.kind).toBe("platform");
      // Approval stays on by default (CLAUDE.md invariant 8).
      expect(t.bundle.definition.permissions.mode).toBe("suggest_only");
      expect(t.hash).toBe(await bundleHash(t.bundle));
    }
  });
});

describe.skipIf(!online)("seed", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const counts = async () => {
    const [row] = await t.db.$client<
      { tenants: number; users: number; memberships: number; agents: number; versions: number }[]
    >`select
        (select count(*)::int from tenant) as tenants,
        (select count(*)::int from app_user) as users,
        (select count(*)::int from membership) as memberships,
        (select count(*)::int from agent) as agents,
        (select count(*)::int from agent_version) as versions`;
    return row;
  };

  it("inserts the operator, two clients and three live templates; twice is the same as once", async () => {
    const first = await seed(t.db);
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ tenants: 2, users: 2, memberships: 3, agents: 3, versions: 3 });

    const second = await seed(t.db);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(afterFirst);

    const templates = await t.db
      .select({
        slug: agent.slug,
        kind: agent.kind,
        live: agent.liveVersionId,
        tenantId: agent.tenantId,
      })
      .from(agent)
      .orderBy(agent.slug);
    expect(templates.map((r) => r.slug)).toEqual(["builder", "coordinator", "document-clerk"]);
    for (const r of templates) {
      expect(r.kind).toBe("template");
      expect(r.tenantId).toBeNull();
      expect(r.live).toBe(first.templates[r.slug]?.versionId);
    }

    const versions = await t.db.select().from(agentVersion);
    for (const v of versions) {
      expect(v.status).toBe("live");
      expect(v.version).toBe(1);
      expect(validateBundle(v.bundle).valid).toBe(true);
      expect(v.bundleHash).toBe(await bundleHash(v.bundle));
    }
  });

  it("makes the operator a member of both clients and the demo admin of one", async () => {
    const { users, tenants } = await seed(t.db);
    const rows = await t.db
      .select({ tenantId: membership.tenantId, userId: membership.userId, role: membership.role })
      .from(membership);
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenantId: tenants.sandbox, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.demoAdmin, role: "client_admin" },
      ]),
    );
    const [op] = await t.db.select().from(appUser).where(eq(appUser.id, users.operator));
    expect(op?.email).toBe(SEED_USERS.operator.email);
  });

  it("leaves templates visible to operator sessions only", async () => {
    const { tenants } = await seed(t.db);
    const asClient = await withTenant(t.db, tenants.demo, async (tx) => {
      await asWorker(tx);
      return tx.select({ id: agent.id }).from(agent).where(isNull(agent.tenantId));
    });
    expect(asClient).toEqual([]);
    const asOperator = await withOperator(t.db, [tenants.demo], async (tx) => {
      await asWorker(tx);
      return tx.select({ id: agent.id }).from(agent).where(isNull(agent.tenantId));
    });
    expect(asOperator).toHaveLength(3);
  });
});
