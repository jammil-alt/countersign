// The seed: the operator, two clients, memberships and the platform templates as live v1 rows whose
// bundles pass core's validation; running it twice changes nothing. And the seeded rows are where
// RLS says they are: templates for operator sessions only.

import { bundleHash, validateBundle } from "@countersign/core";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { agent, agentVersion, appUser, membership } from "./schema";
import { loadSeedTemplates, loadSeedVersions, SEED_USERS, seed } from "./seed";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe("seed files", () => {
  it("hold the five platform templates, each a valid bundle", async () => {
    const templates = await loadSeedTemplates();
    expect(templates.map((t) => t.slug)).toEqual([
      "bill-clerk",
      "builder",
      "coordinator",
      "document-clerk",
      "supervisor",
    ]);
    for (const t of templates) {
      expect(validateBundle(t.bundle).valid, t.slug).toBe(true);
      expect(t.bundle.definition.kind).toBe("platform");
      // Approval stays on by default (CLAUDE.md invariant 8).
      expect(t.bundle.definition.permissions.mode).toBe("suggest_only");
      expect(t.hash).toBe(await bundleHash(t.bundle));
    }
  });

  // v0.12 W2-D: the supervisor's v2 is Sloan (docs/plan.md §1.47).
  it("hold the supervisor's v2, Sloan: the three watch workflows unchanged plus chat", async () => {
    const [v1] = (await loadSeedTemplates()).filter((t) => t.slug === "supervisor");
    const later = await loadSeedVersions();
    expect(later.map((v) => `${v.slug}.v${v.version}`)).toEqual(["supervisor.v2"]);
    const v2 = later[0];
    if (!v1 || !v2) throw new Error("no supervisor seed");
    expect(v2.bundle.definition.identity.name).toBe("Sloan");
    expect(v2.bundle.definition.permissions.mode).toBe("suggest_only");
    expect(v2.bundle.definition.budgets).toEqual({ maxSteps: 8, maxCostUsd: "0.30" });
    for (const w of v1.bundle.workflows) {
      expect(v2.bundle.workflows.find((x) => x.slug === w.slug)?.workflow).toEqual(w.workflow);
    }
    const chat = v2.bundle.workflows.find((w) => w.slug === "chat")?.workflow;
    expect(chat?.trigger.on).toMatchObject({ type: "event", event: "thread.message_posted" });
    expect(chat?.steps).toMatchObject([{ kind: "skill", skill: "account.chat" }]);
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

  it("inserts the operator, two clients and five live templates; twice is the same as once", async () => {
    const first = await seed(t.db);
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ tenants: 2, users: 2, memberships: 3, agents: 5, versions: 6 });

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
    expect(templates.map((r) => r.slug)).toEqual([
      "bill-clerk",
      "builder",
      "coordinator",
      "document-clerk",
      "supervisor",
    ]);
    const versions = await t.db.select().from(agentVersion);
    const supervisor = first.templates.supervisor;
    for (const r of templates) {
      expect(r.kind).toBe("template");
      expect(r.tenantId).toBeNull();
      // v0.12 W2-D: the supervisor's live version is its seeded v2 (Sloan); v1 is retired.
      if (r.slug === "supervisor") {
        const live = versions.find((v) => v.id === r.live);
        expect(live?.version).toBe(2);
        expect(live?.parentVersionId).toBe(supervisor?.versionId);
      } else {
        expect(r.live).toBe(first.templates[r.slug]?.versionId);
      }
    }

    for (const v of versions) {
      const retired = v.id === supervisor?.versionId;
      expect(v.status).toBe(retired ? "retired" : "live");
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
    expect(asOperator).toHaveLength(5);
  });
});
