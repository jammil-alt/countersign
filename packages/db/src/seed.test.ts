// The seed: the operator, two clients, memberships and the platform templates as live v1 rows whose
// bundles pass core's validation; running it twice changes nothing. And the seeded rows are where
// RLS says they are: templates for operator sessions only.

import { bundleHash, validateBundle } from "@countersign/core";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  externalAction,
  inboxItem,
  membership,
  rawRecord,
  run,
  stepRun,
  toolCall,
} from "./schema";
import {
  DEMO_AGENT_SLUG,
  DEMO_CONNECTOR,
  DEMO_RECORD_BEFORE,
  DEMO_TOOL,
  loadDemoAgent,
  loadSeedTemplates,
  loadSeedVersions,
  SEED_USERS,
  seed,
} from "./seed";
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
    // Five templates (six versions with Sloan) and the Demo client's one agent.
    expect(afterFirst).toEqual({ tenants: 2, users: 2, memberships: 3, agents: 6, versions: 7 });

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
      .where(isNull(agent.tenantId))
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

  it("puts one change on the Demo client's Desk, on the test kit, in the runtime's shape", async () => {
    const { tenants, users, demoDesk: d } = await seed(t.db);
    const rows = await withTenant(t.db, tenants.demo, async (tx) => {
      await asWorker(tx);
      return {
        items: await tx.select().from(inboxItem).where(eq(inboxItem.tenantId, tenants.demo)),
        actions: await tx
          .select()
          .from(externalAction)
          .where(eq(externalAction.tenantId, tenants.demo)),
        runs: await tx.select().from(run).where(eq(run.tenantId, tenants.demo)),
        steps: await tx.select().from(stepRun).where(eq(stepRun.tenantId, tenants.demo)),
        calls: await tx.select().from(toolCall).where(eq(toolCall.tenantId, tenants.demo)),
        agents: await tx.select().from(agent).where(eq(agent.tenantId, tenants.demo)),
        versions: await tx
          .select()
          .from(agentVersion)
          .where(eq(agentVersion.tenantId, tenants.demo)),
        connections: await tx
          .select()
          .from(connection)
          .where(eq(connection.tenantId, tenants.demo)),
        records: await tx.select().from(rawRecord).where(eq(rawRecord.tenantId, tenants.demo)),
      };
    });

    // The connection and the tool are the testkit's: nothing outside the platform.
    expect(rows.connections).toMatchObject([
      { id: d.connectionId, connector: DEMO_CONNECTOR, status: "connected" },
    ]);
    expect(rows.records).toMatchObject([
      { id: d.recordId, connectionId: d.connectionId, externalId: DEMO_RECORD_BEFORE.id },
    ]);

    // The client agent: trial, live v1, approval on, a manual trigger only.
    expect(rows.agents).toMatchObject([
      {
        id: d.agentId,
        kind: "client",
        slug: DEMO_AGENT_SLUG,
        stage: "trial",
        runStatus: "active",
        liveVersionId: d.agentVersionId,
        bindings: { [DEMO_CONNECTOR]: d.connectionId },
      },
    ]);
    const [version] = rows.versions;
    expect(version).toMatchObject({ id: d.agentVersionId, version: 1, status: "live" });
    if (!version) throw new Error("no version");
    expect(validateBundle(version.bundle).valid).toBe(true);
    expect(version.bundle.definition.permissions.mode).toBe("suggest_only");
    for (const w of version.bundle.workflows) {
      expect(w.workflow.trigger.on.type).toBe("manual");
      for (const s of w.workflow.steps) {
        if (s.kind === "action") {
          expect(s.tool).toBe(DEMO_TOOL);
          expect(s.approval.required).toBe("required");
        }
      }
    }

    // A live run waiting on its step, the step's call, the proposed action and its item.
    expect(rows.runs).toMatchObject([
      { id: d.runId, mode: "live", status: "waiting", agentVersionId: d.agentVersionId },
    ]);
    expect(rows.steps).toMatchObject([
      { id: d.stepRunId, runId: d.runId, status: "waiting", agentVersionId: d.agentVersionId },
    ]);
    expect(rows.calls).toMatchObject([
      {
        stepRunId: d.stepRunId,
        tool: DEMO_TOOL,
        status: "awaiting_approval",
        externalActionId: d.actionId,
      },
    ]);
    expect(rows.actions).toMatchObject([
      {
        id: d.actionId,
        connectionId: d.connectionId,
        tool: DEMO_TOOL,
        runId: d.runId,
        stepRunId: d.stepRunId,
        agentVersionId: d.agentVersionId,
        idempotencyKey: `${d.runId}:update:0`,
        status: "proposed",
        inboxItemId: d.inboxItemId,
        before: DEMO_RECORD_BEFORE,
        approvedBy: null,
        executedAt: null,
      },
    ]);
    expect(rows.items).toMatchObject([
      {
        id: d.inboxItemId,
        kind: "external_action",
        status: "open",
        agentId: d.agentId,
        subjectType: "external_action",
        subjectId: d.actionId,
        runId: d.runId,
        assigneeRole: "client_admin",
        assigneeUserId: null,
        batchKey: `${d.runId}:update`,
        payload: {
          tool: DEMO_TOOL,
          connector: DEMO_CONNECTOR,
          connectionId: d.connectionId,
          before: DEMO_RECORD_BEFORE,
          actionId: d.actionId,
          sources: [d.recordId],
        },
      },
    ]);
    expect(users.demoAdmin).toBeTruthy();
    // The id the end-to-end walkthrough signs and undoes (apps/web/e2e/walkthroughs.mjs).
    expect(d.inboxItemId).toBe("c99a8abe-0e92-5dee-bf29-46ef82002f23");

    // Nothing of it reaches the Sandbox.
    const sandbox = await withTenant(t.db, tenants.sandbox, async (tx) => {
      await asWorker(tx);
      return tx.select({ id: inboxItem.id }).from(inboxItem);
    });
    expect(sandbox).toEqual([]);
  });

  it("adds no second Desk item when run again, and leaves a signed one as it is", async () => {
    const { demoDesk: d } = await seed(t.db);
    const deskCounts = async () => {
      const [row] = await t.db.$client<{ items: number; actions: number; runs: number }[]>`select
          (select count(*)::int from inbox_item) as items,
          (select count(*)::int from external_action) as actions,
          (select count(*)::int from run) as runs`;
      return row;
    };
    expect(await deskCounts()).toEqual({ items: 1, actions: 1, runs: 1 });
    // A person signed it (as the resolve route would): seeding again doesn't reopen it.
    await t.db
      .update(inboxItem)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(inboxItem.id, d.inboxItemId));
    await seed(t.db);
    expect(await deskCounts()).toEqual({ items: 1, actions: 1, runs: 1 });
    const [item] = await t.db.select().from(inboxItem).where(eq(inboxItem.id, d.inboxItemId));
    expect(item?.status).toBe("resolved");
  });
});

describe("the Demo client agent's file", () => {
  it("is a valid client bundle whose only write is the testkit's, approval on", async () => {
    const demo = await loadDemoAgent();
    expect(validateBundle(demo.bundle).valid).toBe(true);
    expect(demo.bundle.definition.kind).not.toBe("platform");
    expect(demo.bundle.definition.extraTools).toEqual([DEMO_TOOL]);
    const steps = demo.bundle.workflows.flatMap((w) => w.workflow.steps);
    expect(steps).toMatchObject([
      { id: "update", kind: "action", tool: DEMO_TOOL, approval: { required: "required" } },
    ]);
  });
});
