// Runs end to end in Node: the StepRunner adapter over a fake WorkflowStep, executeRun (what
// RunWorkflow does) against the database with the real agents runtime and the testkit connector,
// inbox resolution resuming the run through the API, test runs that never write, the client
// timeline without internal steps or cost, and the senses dispatcher and cron.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import { agent, event, externalAction, inboxItem, run, stepRun, usageDaily } from "@countersign/db";
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
import { cronTick } from "./runs/dispatch";
import { executeRun } from "./runs/execute";
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
});
