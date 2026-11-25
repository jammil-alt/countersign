// The seed: the operator, two clients, memberships and the platform templates as live v1 rows whose
// bundles pass core's validation; running it twice changes nothing. And the seeded rows are where
// RLS says they are: templates for operator sessions only. Step model (docs/step-model-plan.md §12,
// R0): each platform template is one seeded version, its workflows in the step model.

import {
  type AgentBundle,
  bundleHash,
  holdsProcess,
  nodeIds,
  processes,
  steps,
  type Step as V3Step,
  validateBundle,
  type Workflow,
  walkSteps,
} from "@countersign/core";
import { and, eq, isNull, ne } from "drizzle-orm";
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
  loadDemoAgentVersions,
  loadSeedTemplates,
  loadSeedVersions,
  SEED_USERS,
  type SeedTemplateVersion,
  seed,
} from "./seed";
import { seedVersionBundle } from "./seed-files";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

/** Every step of a v4 process, nested ones included. */
const stepsOf = (p: processes.Process) => processes.allSteps(p).map((l) => l.step);

/** Every step of a step-model workflow, nested ones included. */
function v5Steps(list: readonly steps.Step[]): steps.Step[] {
  return list.flatMap((s) => [
    s,
    ...(s.kind === "fork"
      ? [...s.paths.flatMap((p) => v5Steps(p.steps)), ...v5Steps(s.otherwise.steps)]
      : s.kind === "for_each" || s.kind === "repeat"
        ? v5Steps(s.steps)
        : []),
  ]);
}

// Step model (docs/step-model-plan.md §12, R0): after the purge each platform agent is seeded once,
// as v1, its workflows in the step model (`schemaVersion: 5`).
describe("seed files", () => {
  it("hold the five platform templates, each one valid version in the step model", async () => {
    const templates = await loadSeedTemplates();
    expect(templates.map((t) => t.slug)).toEqual([
      "bill-clerk",
      "builder",
      "coordinator",
      "document-clerk",
      "supervisor",
    ]);
    expect(await loadSeedVersions()).toEqual([]);
    for (const t of templates) {
      expect(processes.validateAnyBundle(t.bundle).errors, t.slug).toEqual([]);
      expect(t.bundle.definition.kind).toBe("platform");
      // Approval stays on by default (CLAUDE.md invariant 8).
      expect(t.bundle.definition.permissions.mode).toBe("suggest_only");
      expect(t.hash).toBe(await bundleHash(t.bundle));
      for (const w of t.bundle.workflows) {
        if (w.workflow.schemaVersion !== 5) throw new Error(`${t.slug} ${w.slug} isn't v5`);
        const parsed = steps.Workflow.parse(w.workflow);
        expect(steps.validateWorkflow(parsed), `${t.slug} ${w.slug}`).toEqual([]);
      }
      // One agent, one process (ARCHITECTURE §10.14).
      expect(t.bundle.workflows.length, t.slug).toBeLessThanOrEqual(1);
    }
  });

  it("keep the Builder and the Coordinator without workflows or skills", async () => {
    const templates = await loadSeedTemplates();
    for (const slug of ["builder", "coordinator"]) {
      const t = templates.find((x) => x.slug === slug);
      expect(t?.bundle.workflows, slug).toEqual([]);
      expect(t?.bundle.definition.skills, slug).toEqual([]);
    }
  });

  it("ask the Bill clerk's approver for every change to the accounting system", async () => {
    const bill = (await loadSeedTemplates()).find((t) => t.slug === "bill-clerk");
    const w = bill?.bundle.workflows[0]?.workflow;
    if (w?.schemaVersion !== 5) throw new Error("no v5 Bill clerk");
    const changes = new Set([
      "qbo.bill.update_lines",
      "qbo.attachable.upload",
      "qbo.bill.update_memo",
      "accounting.bill.create",
    ]);
    const writes = v5Steps(steps.Workflow.parse(w).steps).flatMap((s) =>
      s.kind === "do" && s.uses?.type === "action" && changes.has(s.uses.action)
        ? [[s.id, s.uses.action, s.checks?.approval]]
        : [],
    );
    const approval = {
      required: "required",
      mode: "in_turn",
      ifNoAnswer: "stop",
      approvers: [{ who: "seat:bill-approver" }],
    };
    expect(writes).toMatchObject([
      ["itemize", "qbo.bill.update_lines", approval],
      ["attach", "qbo.attachable.upload", approval],
      ["memo", "qbo.bill.update_memo", approval],
      ["create", "accounting.bill.create", approval],
      ["attach-new", "qbo.attachable.upload", approval],
    ]);
  });

  it("hold Sloan's chat: one answer on Claude Sonnet 5.5, under its $0.30 cap", async () => {
    const sloan = (await loadSeedTemplates()).find((t) => t.slug === "supervisor");
    expect(sloan?.bundle.definition.identity.name).toBe("Sloan");
    expect(sloan?.bundle.definition.budgets).toEqual({ maxSteps: 8, maxCostUsd: "0.30" });
    expect(sloan?.bundle.workflows.map((w) => w.slug)).toEqual(["chat"]);
    const w = sloan?.bundle.workflows[0]?.workflow;
    if (w?.schemaVersion !== 5) throw new Error("no v5 chat");
    expect(w.triggers[0]?.on).toMatchObject({ type: "event", event: "thread.message_posted" });
    expect(w.steps).toMatchObject([
      {
        id: "answer",
        kind: "do",
        doneBy: "ai",
        uses: { type: "skill", skill: "account.chat" },
        ai: { model: { id: "claude-sonnet-5-5", maxTokens: 2048 } },
      },
      { id: "answered", kind: "end", outputs: ["out-answered"] },
    ]);
  });
});

// ── R9 (docs/plan.md §1.86, §9): the seeds as v4 ──────────────────────────────────────────────

/** The v3 person steps' `onTimeout`, by step id. */
function personTimeouts(w: Workflow): Map<string, string> {
  const out = new Map<string, string>();
  walkSteps(w, ({ step }) => {
    if (step.kind === "person") out.set(step.id, step.onTimeout);
  });
  return out;
}

/**
 * What the hand check of a v4 version holds to, against the v3 version it came from: the same
 * workflows, every trigger, step and path id kept, approval required on every write (stated on
 * every write that v3 asked approval for, never loosened) and every deadline `stop` unless v3 said
 * the run goes on (`continue`, v4 `proceed`).
 */
function expectV4Of(v4: SeedTemplateVersion, v3: AgentBundle) {
  expect(holdsProcess(v4.bundle), v4.slug).toBe(true);
  // Only the workflows moved: the definition is the earlier version's.
  expect(v4.bundle.definition).toEqual(v3.definition);
  expect(v4.bundle.workflows.map((w) => [w.slug, w.name, w.enabled])).toEqual(
    v3.workflows.map((w) => [w.slug, w.name, w.enabled]),
  );
  for (const w of v4.bundle.workflows) {
    const before = v3.workflows.find((x) => x.slug === w.slug)?.workflow;
    if (w.workflow.schemaVersion !== 4 || !before) throw new Error(`${w.slug}: not a v4 process`);
    const process = w.workflow;
    expect(processes.validateProcess(process).errors, w.slug).toEqual([]);
    // The converter's id check: every id, in the same order, so merges line up.
    expect(processes.nodeIds(process), w.slug).toEqual(nodeIds(before));
    const timeouts = personTimeouts(before);
    const v3Steps = new Map<string, V3Step>();
    walkSteps(before, ({ step }) => v3Steps.set(step.id, step));
    for (const step of stepsOf(process)) {
      const was = v3Steps.get(step.id);
      const approval = step.checks?.approval;
      expect(processes.approvalLoosenings(approval, "checks.approval"), step.id).toEqual([]);
      if (approval) {
        expect(approval).toMatchObject({ required: "required", ifNoAnswer: "stop" });
      }
      if (was?.kind === "action") {
        expect(step.kind, step.id).toBe("write");
        expect(approval?.required, step.id).toBe("required");
      }
      if (step.kind === "person") {
        const then = timeouts.get(step.id) === "continue" ? "proceed" : "stop";
        expect(step.deadline.ifNoAnswer, step.id).toBe(then);
      }
      expect(step.checks?.confer, step.id).toBeUndefined();
      expect(step.checks?.notify, step.id).toBeUndefined();
    }
  }
}

describe("seed files, R9", () => {
  it("name the version they change, and nothing else", () => {
    const files = {
      1: { schemaVersion: 1, definition: { a: 1, b: 2 }, workflows: [1] },
      2: { extends: 1, definition: { b: 3 } },
      3: { extends: 2, workflows: [] },
    };
    expect(seedVersionBundle(files, 3)).toEqual({
      schemaVersion: 1,
      definition: { a: 1, b: 3 },
      workflows: [],
    });
    expect(() => seedVersionBundle({ ...files, 4: { extends: 4 } }, 4)).toThrow(/earlier/);
    expect(() => seedVersionBundle({ ...files, 4: { extends: 1, model: "x" } }, 4)).toThrow(
      /unknown key/,
    );
    expect(() => seedVersionBundle(files, 9)).toThrow(/no version 9/);
  });

  it("hold the Demo client agent's v2: its one write as a v4 write step, approval on", async () => {
    const v1 = await loadDemoAgent();
    const later = await loadDemoAgentVersions();
    expect(later.map((v) => v.version)).toEqual([2]);
    const [v2] = later;
    if (!v2) throw new Error("no v2");
    expectV4Of(v2, v1.bundle);
    const w = v2.bundle.workflows[0]?.workflow;
    if (w?.schemaVersion !== 4) throw new Error("not v4");
    expect(w.steps).toMatchObject([
      {
        id: "update",
        kind: "write",
        tool: DEMO_TOOL,
        input: { id: "R-1002", syncToken: "0", amount: "9.1000" },
        checks: { approval: { required: "required" } },
      },
    ]);
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
    // Five templates, each its one seeded v1; and the Demo client's Sloan, its v1 forked from the
    // supervisor's live version (§1.47 "On by default").
    expect(afterFirst).toEqual({ tenants: 2, users: 2, memberships: 3, agents: 6, versions: 6 });
    expect(first.demoDesk).toBeNull();

    const second = await seed(t.db);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(afterFirst);

    const templates = await t.db
      .select({
        id: agent.id,
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
    // Each template's live version is its v1, with no parent.
    for (const r of templates) {
      expect(r.kind).toBe("template");
      expect(r.tenantId).toBeNull();
      const live = versions.find((v) => v.id === r.live);
      expect(live?.version, r.slug).toBe(1);
      expect(live?.id).toBe(first.templates[r.slug]?.versionId);
      expect(live?.parentVersionId).toBeNull();
    }

    // The templates' live versions, and the Demo client's Sloan's v1 (live too).
    const live = new Set(
      (await t.db.select({ live: agent.liveVersionId }).from(agent)).map((r) => r.live),
    );
    for (const v of versions) {
      expect(v.status).toBe(live.has(v.id) ? "live" : "retired");
      expect(processes.validateAnyBundle(v.bundle).valid).toBe(true);
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

  // docs/plan.md §1.47 "On by default": every client has Sloan on; the Sandbox has no client people.
  it("turns Sloan on for the Demo client, once, from the supervisor's live version", async () => {
    const { tenants, sloan } = await seed(t.db);
    expect(sloan).toBeTruthy();
    const [row] = await t.db
      .select()
      .from(agent)
      .where(eq(agent.id, sloan as string));
    expect(row).toMatchObject({
      tenantId: tenants.demo,
      kind: "client",
      slug: "supervisor",
      runStatus: "active",
      stage: "live",
      serviceName: "Sloan, your account agent",
      testCopy: false,
      bindings: {},
    });
    const [template] = await t.db
      .select()
      .from(agent)
      .where(eq(agent.id, row?.templateId as string));
    const [v1] = await t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, row?.liveVersionId as string));
    expect(v1?.basedOnTemplateVersionId).toBe(template?.liveVersionId);
    expect(v1?.bundle.definition.identity.name).toBe("Sloan");
    const again = await seed(t.db);
    expect(again.sloan).toBe(sloan);
    const all = await t.db
      .select()
      .from(agent)
      .where(eq(agent.templateId, template?.id as string));
    expect(all.map((a) => a.tenantId)).toEqual([tenants.demo]);
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

  // Staging's seed and the default `db:seed`: nothing of the e2e Desk item.
  it("adds none of the e2e Desk item by default", async () => {
    await seed(t.db);
    const [row] = await t.db.$client<Record<string, number>[]>`select
        (select count(*)::int from connection) as connections,
        (select count(*)::int from raw_record) as records,
        (select count(*)::int from agent where tenant_id is not null and slug <> 'supervisor') as agents,
        (select count(*)::int from run) as runs,
        (select count(*)::int from step_run) as steps,
        (select count(*)::int from tool_call) as calls,
        (select count(*)::int from external_action) as actions,
        (select count(*)::int from inbox_item) as items`;
    expect(row).toEqual({
      connections: 0,
      records: 0,
      agents: 0,
      runs: 0,
      steps: 0,
      calls: 0,
      actions: 0,
      items: 0,
    });
  });

  it("with e2e, puts one change on the Demo client's Desk, on the test kit, in the runtime's shape", async () => {
    const { tenants, users, demoDesk: d } = await seed(t.db, { e2e: true });
    if (!d) throw new Error("no Desk item seeded");
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
        // The Desk's agent; the Demo client's Sloan is seeded too (§1.47) and left out here.
        agents: await tx
          .select()
          .from(agent)
          .where(and(eq(agent.tenantId, tenants.demo), ne(agent.slug, "supervisor"))),
        versions: await tx
          .select()
          .from(agentVersion)
          .where(and(eq(agentVersion.tenantId, tenants.demo), eq(agentVersion.agentId, d.agentId))),
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

    // The client agent: trial, approval on, a manual trigger only. R9: its live version is v2, the
    // same step as a v4 process; the Desk item's run is on v1, the version it ran.
    const [version, v2] = [...rows.versions].sort((a, b) => a.version - b.version);
    expect(rows.agents).toMatchObject([
      {
        id: d.agentId,
        kind: "client",
        slug: DEMO_AGENT_SLUG,
        stage: "trial",
        runStatus: "active",
        liveVersionId: v2?.id,
        bindings: { [DEMO_CONNECTOR]: d.connectionId },
      },
    ]);
    expect(version).toMatchObject({ id: d.agentVersionId, version: 1, status: "retired" });
    expect(v2).toMatchObject({ version: 2, status: "live", parentVersionId: d.agentVersionId });
    expect(rows.versions).toHaveLength(2);
    if (!version || !v2) throw new Error("no version");
    expect(processes.validateAnyBundle(v2.bundle).valid).toBe(true);
    expect(v2.bundleHash).toBe(await bundleHash(v2.bundle));
    expect(validateBundle(version.bundle).valid).toBe(true);
    expect(version.bundle.definition.permissions.mode).toBe("suggest_only");
    for (const w of version.bundle.workflows) {
      if (w.workflow.schemaVersion !== 3) throw new Error("v1 holds v3 workflows");
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

  it("with e2e, adds no second Desk item when run again, and leaves a signed one as it is", async () => {
    const { demoDesk: d } = await seed(t.db, { e2e: true });
    if (!d) throw new Error("no Desk item seeded");
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
    await seed(t.db, { e2e: true });
    expect(await deskCounts()).toEqual({ items: 1, actions: 1, runs: 1 });
    // A default seed afterwards neither adds nor removes anything of it.
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
