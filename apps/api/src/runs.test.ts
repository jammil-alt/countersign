// Runs end to end in Node: the StepRunner adapter over a fake WorkflowStep, executeRun (what
// RunWorkflow does) against the database with the real agents runtime and the testkit connector,
// inbox resolution resuming the run through the API, test runs that never write, the client
// timeline without internal steps or cost, and the senses dispatcher and cron.

import { createSkill, publishSkill } from "@countersign/agents";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  event,
  externalAction,
  inboxItem,
  membership,
  run,
  skill,
  stepRun,
  tenant,
  usageDaily,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { isWaitTimeout } from "@countersign/workflows";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { cronTick, dispatchByIds, dispatchTenant } from "./runs/dispatch";
import { executeRun } from "./runs/execute";
import { dbStepLog } from "./runs/ports";
import { REDELIVER_AFTER_MS } from "./runs/resume";
import { cloudflareStepRunner, isEngineTimeout } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** Every key in a JSON value that a portal response may never carry. */
function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

describe("cloudflareStepRunner", () => {
  it("passes config through, calls without it otherwise, and stores results", async () => {
    const step = new FakeWorkflowStep();
    const runner = cloudflareStepRunner(step);
    expect(await runner.do("a", async () => ({ x: 1 }))).toEqual({ x: 1 });
    expect(step.configs.get("a")).toBeUndefined();
    await runner.do("b", async () => 2, {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    });
    expect(step.configs.get("b")).toEqual({
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    });
    // A replay returns the stored result without running the work again.
    let ran = 0;
    expect(await runner.do("a", async () => ++ran)).toEqual({ x: 1 });
    expect(ran).toBe(0);
    await runner.sleep("nap", "5 seconds");
    expect(step.sleeps).toEqual(["nap"]);
  });

  it("turns the engine's timeout into WaitTimeoutError and passes other errors on", async () => {
    const timedOut = cloudflareStepRunner(new FakeWorkflowStep());
    const err = await timedOut
      .waitForEvent("w", { type: "inbox-1", timeout: "1 hour" })
      .catch((e: unknown) => e);
    expect(isWaitTimeout(err)).toBe(true);
    const broken = cloudflareStepRunner(
      new FakeWorkflowStep(async () => {
        throw new Error("engine down");
      }),
    );
    await expect(broken.waitForEvent("w", { type: "t", timeout: "1 hour" })).rejects.toThrow(
      "engine down",
    );
    const answered = cloudflareStepRunner(new FakeWorkflowStep(async () => ({ approved: true })));
    expect((await answered.waitForEvent("w", { type: "t", timeout: "1 hour" })).payload).toEqual({
      approved: true,
    });
    expect(isEngineTimeout({ name: "Error", message: "Execution timed out after 5ms" })).toBe(true);
    expect(isEngineTimeout(new Error("nope"))).toBe(false);
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("runs", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let v1 = "";
  let templateId = "";
  let templateV1 = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  /** Resolves the item a run waits on through the API, as `who`, and returns the event sent. */
  function resolver(who: string, decide: (kind: string) => "approve" | "reject" | "timeout") {
    return async (_name: string, type: string) => {
      // As the superuser: the test looks across clients.
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no open item for ${type}`);
      const decision = decide(item.kind);
      if (decision === "timeout") {
        throw Object.assign(new Error("Execution timed out after 1ms"), {
          name: "WorkflowTimeoutError",
        });
      }
      const path =
        who === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`;
      const res = await H.call(who, "POST", path, { decision });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    };
  }

  async function runOf(runId: string) {
    const [row] = await H.t.db.select().from(run).where(eq(run.id, runId));
    return row;
  }

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    templateId = tid;
    templateV1 = j(tpl.json).version.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    agentId = j(fork.json).agent.id;
    v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("refuses to activate before a passing test run, and to run before activation", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(res.status).toBe(409);
    expect(j(res.json).error.details).toContain("v1 has no passing test run on this client");
    const live = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    expect(live.status).toBe(409);
  });

  it("test-runs a version: proposes the change, never writes it, hidden from the client", async () => {
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v1}/test-run`,
      {
        workflow: "fix-record",
      },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("the test run was not started");
    expect(params.mode).toBe("test");

    // The person step of a test run goes to the operator.
    const step = new FakeWorkflowStep(resolver(OPERATOR, () => "approve"));
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(H.backend.writes).toHaveLength(0);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(actions.map((a) => a.status)).toEqual(["proposed"]);
    expect(actions[0]?.inboxItemId).toBeNull();
    expect((await runOf(runId))?.status).toBe("succeeded");

    expect((await H.call(admin("a"), "GET", `/api/runs/${runId}`)).status).toBe(404);
    const list = await H.call(admin("a"), "GET", "/api/runs");
    expect(j(list.json).runs).toEqual([]);
    const inbox = await H.call(admin("a"), "GET", "/api/inbox?status=resolved");
    expect(j(inbox.json).items).toEqual([]);
    // Resolving a test run's item emits nothing.
    await H.settle();
    const events = await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId));
    expect(events).toEqual([]);
  });

  it("refuses to test-run a version that doesn't validate", async () => {
    const bad = testBundle();
    bad.definition.skills = [{ skill: "custom:no-such-skill", settings: {} }];
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions`, {
      bundle: bad,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).errors.length).toBeGreaterThan(0);
    const started = H.instances.started.size;
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(saved.json).version.id}/test-run`,
      { workflow: "fix-record" },
    );
    expect(res.status).toBe(422);
    expect(j(res.json).error.code).toBe("invalid_bundle");
    expect(H.instances.started.size).toBe(started);
  });

  it("copies the shared skills a draft uses into the client before test-running it", async () => {
    await H.t.db.transaction(async (tx) => {
      const shared = await createSkill(tx, {
        tenantId: null,
        definition: {
          schemaVersion: 1,
          id: "custom:check-record",
          name: "Check record",
          description: "Checks a record",
          category: "custom",
          // Skill model (2026-11-10): new operator skills are AI skills (agent mode retired).
          mode: "task",
          model: { id: "claude-haiku-5-5" },
          instructions: "Check it.",
          tools: [],
          input: { type: "object" },
          output: { type: "object" },
          settings: [],
        },
      });
      await publishSkill(tx, { skillId: shared.skill.id, versionId: shared.version.id });
    });
    const withSkill = testBundle();
    withSkill.definition.skills = [{ skill: "custom:check-record", settings: {} }];
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions`, {
      bundle: withSkill,
    });
    expect(j(saved.json).errors, JSON.stringify(saved.json)).toEqual([]);
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(saved.json).version.id}/test-run`,
      { workflow: "fix-record" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // The run reads skills as the client: the client's copy is what it finds.
    const copies = await H.t.db
      .select()
      .from(skill)
      .where(and(eq(skill.tenantId, H.A.tenantId), eq(skill.slug, "shared:check-record")));
    expect(copies).toHaveLength(1);
  });

  let liveRunId = "";

  it("runs live: the client approves the change and the step, the change is made once", async () => {
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    liveRunId = j(res.json).runId;
    const params = H.instances.started.get(liveRunId);
    if (!params) throw new Error("not started");

    const seen: string[] = [];
    const step = new FakeWorkflowStep(async (name, type) => {
      // What the client sees while the run waits: the change, never cost or prompts.
      const inbox = await H.call(admin("a"), "GET", "/api/inbox");
      expect(forbiddenKeys(inbox.json)).toEqual([]);
      seen.push(...j(inbox.json).items.map((i: { kind: string }) => i.kind));
      const asUser = await H.call(user("a"), "GET", "/api/inbox");
      expect(j(asUser.json).items).toEqual([]);
      return resolver(admin("a"), () => "approve")(name, type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(seen).toEqual(["external_action", "approval"]);
    expect(H.backend.writes).toHaveLength(1);
    expect(H.backend.writes[0]?.record).toMatchObject({ id: "r1", amount: "12.00" });

    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, liveRunId));
    expect(action).toMatchObject({ status: "done", approvedBy: H.A.admin });
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, liveRunId));
    expect(Object.fromEntries(steps.map((s) => [s.nodeId, s.status]))).toEqual({
      update: "succeeded",
      confirm: "succeeded",
      internal: "succeeded",
    });
    expect((await runOf(liveRunId))?.status).toBe("succeeded");
    const usage = await H.t.db.select().from(usageDaily).where(eq(usageDaily.agentId, agentId));
    expect(usage.length).toBeGreaterThan(0);

    // Replaying the whole run (as the engine may) changes nothing and writes nothing again.
    const again = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(again).toEqual({ status: "succeeded" });
    expect(H.backend.writes).toHaveLength(1);
  });

  it("shows the client a timeline of visible steps, approvals and changes, without cost", async () => {
    const res = await H.call(admin("a"), "GET", `/api/runs/${liveRunId}`);
    expect(res.status).toBe(200);
    expect(forbiddenKeys(res.json)).toEqual([]);
    const body = j(res.json);
    expect(body.run).toMatchObject({ status: "succeeded", service: { name: "Record keeping" } });
    expect(body.steps.map((s: { label: string }) => s.label)).toEqual([
      "Corrected the record",
      "Confirm",
    ]);
    expect(body.steps[0].summary).toBe("Updated record r1");
    expect(body.approvals).toHaveLength(2);
    expect(body.approvals.every((a: { approved: boolean }) => a.approved)).toBe(true);
    expect(body.approvals[0].by).toEqual({ id: H.A.admin, name: "Client A admin" });
    expect(body.actions).toEqual([
      expect.objectContaining({ tool: TESTKIT_UPDATE_TOOL, status: "done" }),
    ]);
    // Step panel (docs/plan.md §1.95): what went in and the change before and after, by its step.
    expect(body.steps[0].input).toMatchObject({ amount: "12.00" });
    expect(body.actions[0]).toMatchObject({
      stepRunId: body.steps[0].id,
      before: expect.objectContaining({ amount: "10.00" }),
      input: expect.objectContaining({ amount: "12.00" }),
    });
    for (const path of [
      "/api/overview",
      "/api/runs",
      "/api/inbox?status=resolved",
      "/api/connections",
    ]) {
      const r = await H.call(admin("a"), "GET", path);
      expect(r.status, path).toBe(200);
      expect(forbiddenKeys(r.json), path).toEqual([]);
    }
    const overview = j((await H.call(user("a"), "GET", "/api/overview")).json);
    expect(overview.services).toEqual([
      expect.objectContaining({ id: agentId, name: "Record keeping", status: "active" }),
    ]);
    // The operator's view has the cost and the internals.
    const ops = j((await H.call(OPERATOR, "GET", `/api/ops/runs/${liveRunId}`)).json);
    expect(ops.run.costUsd).toBeDefined();
    expect(ops.steps).toHaveLength(3);
    expect(ops.actions[0].before).toMatchObject({ amount: "10.00" });
    // Another client can't read it.
    expect((await H.call(admin("b"), "GET", `/api/runs/${liveRunId}`)).status).toBe(404);
    expect(
      (
        await H.call(admin("b"), "POST", `/api/inbox/${ops.inbox[0].id}/resolve`, {
          decision: "approve",
        })
      ).status,
    ).toBe(404);
  });

  it("dispatches the events the approvals emitted, after the commit", async () => {
    await H.settle();
    const events = await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId));
    expect(events.map((e) => e.type).sort()).toEqual([
      "external_action.done",
      "inbox.resolved",
      "inbox.resolved",
      // v0.12 W2-E: the live run's finish (handoffs, docs/plan.md §1.48).
      "run.succeeded",
    ]);
    // Approvals are dispatched by the API, the run's own event by the run.
    expect(events.every((e) => e.dispatchedAt !== null)).toBe(true);
    expect(events.find((e) => e.type === "external_action.done")?.payload).toMatchObject({
      tool: TESTKIT_UPDATE_TOOL,
      connectionId: H.A.connectionId,
      runId: liveRunId,
    });
  });

  it("stops at a rejected change, and at an approval nobody answers", async () => {
    for (const outcome of ["reject", "timeout"] as const) {
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
        workflow: "fix-record",
      });
      const runId = j(res.json).runId;
      const params = H.instances.started.get(runId);
      if (!params) throw new Error("not started");
      const step = new FakeWorkflowStep(resolver(admin("a"), () => outcome));
      const result = await executeRun(deps(), params, cloudflareStepRunner(step));
      expect(result).toEqual({ status: "cancelled", reason: "rejected", nodeId: "update" });
      expect((await runOf(runId))?.status).toBe("cancelled");
      const [item] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
      expect(item?.status).toBe(outcome === "reject" ? "resolved" : "expired");
      // An expired item can't be approved afterwards.
      if (outcome === "timeout") {
        const late = await H.call(admin("a"), "POST", `/api/inbox/${item?.id}/resolve`, {
          decision: "approve",
        });
        expect(late.status).toBe(409);
      }
    }
    expect(H.backend.writes).toHaveLength(1);
  });

  it("delivers a resolution whose event failed to send: the cron re-sends until the run takes it", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    const runId = j(res.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    const cron = (at: Date) => cronTick({ db: H.db, instances: H.instances }, at);
    const sentFor = (type: string) => H.instances.events.filter((e) => e.event.type === type);

    const step = new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no item for ${type}`);
      // The engine is unreachable when the item is resolved: the person still gets their answer.
      H.instances.failSends = 1;
      const resolved = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
      expect(sentFor(type)).toEqual([]);
      const [stored] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, item.id));
      if (!stored?.resolvedAt) throw new Error("not resolved");
      // Within the first minute the cron leaves the after-commit send alone.
      await cron(new Date(stored.resolvedAt.getTime() + 1_000));
      expect(sentFor(type)).toEqual([]);
      // Then it re-sends; a failed re-send stays pending for the next tick.
      const later = new Date(stored.resolvedAt.getTime() + REDELIVER_AFTER_MS + 1_000);
      H.instances.failSends = 1;
      await cron(later);
      expect(sentFor(type)).toEqual([]);
      await cron(later);
      expect(sentFor(type)).toHaveLength(1);
      return sentFor(type)[0]?.event.payload;
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(step.waits).toHaveLength(2);

    // The run took both resolutions, so nothing is re-sent any more.
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "resolved" && i.runReceivedAt !== null)).toBe(true);
    const count = H.instances.events.length;
    await cron(new Date(Date.now() + 5 * 60_000));
    expect(H.instances.events.length).toBe(count);
    // Nor for a run that has ended, even if it never recorded taking one.
    await H.t.db.update(inboxItem).set({ runReceivedAt: null }).where(eq(inboxItem.runId, runId));
    await cron(new Date(Date.now() + 5 * 60_000));
    expect(H.instances.events.length).toBe(count);
  });

  it("keeps one step_run per step of a run: the step log upserts", async () => {
    const [r] = await H.t.db.select().from(run).where(eq(run.id, liveRunId));
    if (!r) throw new Error("no live run");
    const log = dbStepLog(H.db, {
      id: r.id,
      tenantId: r.tenantId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId,
      workflowSlug: r.workflowSlug,
      mode: "live",
    });
    const rowsOf = (nodeId: string) =>
      H.t.db
        .select()
        .from(stepRun)
        .where(and(eq(stepRun.runId, liveRunId), eq(stepRun.nodeId, nodeId)));
    const [update] = await rowsOf("update");
    // A retried step gets the row its first attempt wrote, unchanged.
    expect(await log.start({ runId: liveRunId, nodeId: "update", nodeType: "action" })).toBe(
      update?.id,
    );
    expect(await rowsOf("update")).toEqual([update]);
    // Attempts racing each other still write one row.
    const ids = await Promise.all(
      [1, 2, 3].map(() => log.start({ runId: liveRunId, nodeId: "again", nodeType: "skill" })),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await rowsOf("again")).toHaveLength(1);
    // The database refuses a second row whoever writes it.
    await expect(
      H.t.db.insert(stepRun).values({
        tenantId: r.tenantId,
        runId: liveRunId,
        nodeId: "again",
        nodeType: "skill",
      }),
    ).rejects.toThrow();
  });

  it("test-runs a template as its test copy in the Sandbox client, never as the template", async () => {
    const path = (vid: string) => `/api/ops/agents/${templateId}/versions/${vid}/test-run`;
    const noSandbox = await H.call(OPERATOR, "POST", path(templateV1), { workflow: "fix-record" });
    expect(noSandbox.status).toBe(409);
    expect(j(noSandbox.json).error.code).toBe("no_sandbox");

    const [sandbox] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true, connectors_offered: ["testkit"] } })
      .returning();
    if (!sandbox) throw new Error("no sandbox");
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox.id, userId: H.operator, role: "operator" });
    const [conn] = await H.t.db
      .insert(connection)
      .values({ tenantId: sandbox.id, connector: "testkit", status: "pending" })
      .returning();
    if (!conn) throw new Error("no connection");
    // An operator who doesn't serve the Sandbox client can't test-run there.
    const other = await H.call("other-operator@example.com", "POST", path(templateV1), {
      workflow: "fix-record",
    });
    expect(other.status).toBe(409);

    const first = await H.call(OPERATOR, "POST", path(templateV1), { workflow: "fix-record" });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const copyId = j(first.json).agentId;
    expect(copyId).not.toBe(templateId);
    const [copy] = await H.t.db.select().from(agent).where(eq(agent.id, copyId));
    expect(copy).toMatchObject({
      tenantId: sandbox.id,
      kind: "client",
      templateId,
      testCopy: true,
      runStatus: "draft",
      slug: "records-clerk-test-copy",
    });
    const [tv1] = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, templateV1));
    const [cv1] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, j(first.json).versionId));
    expect(cv1).toMatchObject({ agentId: copyId, basedOnTemplateVersionId: templateV1 });
    expect(cv1?.bundleHash).toBe(tv1?.bundleHash);
    const params = H.instances.started.get(j(first.json).runId);
    expect(params).toMatchObject({ tenantId: sandbox.id, agentId: copyId, mode: "test" });

    // Bound once to the Sandbox connection, it runs like any test run: nothing is written.
    const bind = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${copyId}/operation`, {
      bindings: { testkit: conn.id },
    });
    expect(bind.status, JSON.stringify(bind.json)).toBe(200);
    const writes = H.backend.writes.length;
    const step = new FakeWorkflowStep(resolver(OPERATOR, () => "approve"));
    if (!params) throw new Error("not started");
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(H.backend.writes).toHaveLength(writes);

    // The same version again reuses the copy and its version.
    const again = await H.call(OPERATOR, "POST", path(templateV1), { workflow: "fix-record" });
    expect(j(again.json)).toMatchObject({ agentId: copyId, versionId: j(first.json).versionId });

    // A new template version updates the copy (same step ids, bindings kept).
    const changed = testBundle("Records clerk v2");
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: changed,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const templateV2 = j(saved.json).version.id;
    const second = await H.call(OPERATOR, "POST", path(templateV2), { workflow: "fix-record" });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(j(second.json).agentId).toBe(copyId);
    expect(j(second.json).versionId).not.toBe(j(first.json).versionId);
    const [cv2] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, j(second.json).versionId));
    expect(cv2).toMatchObject({ basedOnTemplateVersionId: templateV2, version: 2 });
    const stepIds = (b: unknown) =>
      AgentBundle.parse(b).workflows[0]?.workflow.steps.map((s) => s.id);
    expect(stepIds(cv2?.bundle)).toEqual(stepIds(changed));
    const copies = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, sandbox.id), eq(agent.testCopy, true)));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.bindings).toEqual({ testkit: conn.id });

    // A test copy only test-runs, and the template itself never has a run.
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${copyId}/activate`);
    expect(act.status).toBe(409);
    expect(JSON.stringify(act.json)).toContain("test copy");
    expect(await H.t.db.select().from(run).where(eq(run.agentId, templateId))).toEqual([]);
    const listed = await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox.id}/agents`);
    expect(j(listed.json).agents).toEqual([
      expect.objectContaining({ id: copyId, testCopy: true }),
    ]);
  });

  it("routes events and schedules to the event's own client only, once", async () => {
    const bundle = AgentBundle.parse({
      ...testBundle("Watcher"),
      definition: { ...testBundle("Watcher").definition, extraTools: [] },
      workflows: [
        {
          slug: "on-resolved",
          name: "On resolved",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "trg-event", on: { type: "event", event: "inbox.resolved" } },
            steps: [
              { id: "note-1", name: "Note", kind: "notify", channel: "thread", message: "seen" },
            ],
          },
        },
        {
          slug: "every-minute",
          name: "Every minute",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "trg-cron", on: { type: "schedule", cron: "* * * * *" } },
            steps: [
              { id: "note-2", name: "Note", kind: "notify", channel: "thread", message: "tick" },
            ],
          },
        },
      ],
    });
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "watcher",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const watcher = j(created.json).agent.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${watcher}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Activation's test-run requirement is covered above; here the agent is switched on directly.
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, watcher));

    // An event of client A left undispatched, and one of client B.
    const old = new Date(Date.now() - 120_000);
    const payload = (kind: string) => ({
      inboxItemId: crypto.randomUUID(),
      kind,
      runId: null,
      approved: true,
      resolvedBy: null,
    });
    await H.t.db.insert(event).values([
      { tenantId: H.A.tenantId, type: "inbox.resolved", payload: payload("a"), createdAt: old },
      { tenantId: H.B.tenantId, type: "inbox.resolved", payload: payload("b"), createdAt: old },
    ]);
    const before = H.instances.started.size;
    const now = new Date();
    await cronTick({ db: H.db, instances: H.instances }, now);
    const started = [...H.instances.started.values()].slice(before);
    expect(started.map((r) => [r.tenantId, r.workflowSlug]).sort()).toEqual([
      [H.B.tenantId, "every-minute"],
      [H.B.tenantId, "on-resolved"],
    ]);
    const left = await H.t.db.select().from(event).where(isNull(event.dispatchedAt));
    expect(left).toEqual([]);
    // The same tick again starts nothing new: the run ids are deterministic.
    await cronTick({ db: H.db, instances: H.instances }, now);
    expect(H.instances.started.size).toBe(before + 2);
    const rows = await H.t.db
      .select()
      .from(run)
      .where(and(eq(run.agentId, watcher), eq(run.tenantId, H.B.tenantId)));
    expect(rows).toHaveLength(2);

    // The event-started run runs.
    const params = started.find((r) => r.workflowSlug === "on-resolved");
    if (!params) throw new Error("no event run");
    const result = await executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
    expect(result).toEqual({ status: "succeeded" });
  });
  // v0.12 W1-H: dispatch right after commit, once (ARCHITECTURE §8).
  it("dispatches an event once when the after-commit dispatch and the sweep race", async () => {
    // The watcher of the test above (client B) routes `inbox.resolved`.
    const payload = {
      inboxItemId: crypto.randomUUID(),
      kind: "race",
      runId: null,
      approved: true,
      resolvedBy: null,
    };
    const [e] = await H.t.db
      .insert(event)
      .values({
        tenantId: H.B.tenantId,
        type: "inbox.resolved",
        payload,
        createdAt: new Date(Date.now() - 120_000),
      })
      .returning();
    if (!e) throw new Error("setup");
    let starts = 0;
    const counting = {
      start: async (p: Parameters<typeof H.instances.start>[0]) => {
        starts += 1;
        // Slow enough that both dispatchers are in flight together.
        await new Promise((r) => setTimeout(r, 30));
        return H.instances.start(p);
      },
      sendEvent: H.instances.sendEvent.bind(H.instances),
      terminate: H.instances.terminate.bind(H.instances),
    };
    const d = { db: H.db, instances: counting };
    const [byId, sweep] = await Promise.all([
      dispatchByIds(d, H.B.tenantId, [e.id]),
      dispatchTenant(d, H.B.tenantId, { olderThanSeconds: 30 }),
    ]);
    expect(byId + sweep).toBe(1);
    expect(starts).toBe(1);
    const [row] = await H.t.db.select().from(event).where(eq(event.id, e.id));
    expect(row?.dispatchedAt).not.toBeNull();
    // Again, nothing: it is stamped.
    expect(await dispatchByIds(d, H.B.tenantId, [e.id])).toBe(0);
    expect(starts).toBe(1);
  });

  it("gives an event back to the sweep when its run's instance can't start", async () => {
    const [e] = await H.t.db
      .insert(event)
      .values({
        tenantId: H.B.tenantId,
        type: "inbox.resolved",
        payload: {
          inboxItemId: crypto.randomUUID(),
          kind: "down",
          runId: null,
          approved: true,
          resolvedBy: null,
        },
      })
      .returning();
    if (!e) throw new Error("setup");
    const down = {
      start: async () => {
        throw new Error("the Workflows engine is unreachable");
      },
      sendEvent: async () => {},
      terminate: async () => "missing" as const,
    };
    expect(await dispatchByIds({ db: H.db, instances: down }, H.B.tenantId, [e.id])).toBe(1);
    const [given] = await H.t.db.select().from(event).where(eq(event.id, e.id));
    expect(given?.dispatchedAt).toBeNull();
    // The run row is there; the next dispatch starts its instance (the same run id).
    const before = H.instances.started.size;
    expect(await dispatchByIds({ db: H.db, instances: H.instances }, H.B.tenantId, [e.id])).toBe(1);
    expect(H.instances.started.size).toBe(before + 1);
  });
});
