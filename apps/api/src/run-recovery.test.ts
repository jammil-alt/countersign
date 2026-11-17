// Runs that would otherwise silently not happen: a schedule tick the cron missed is started on a
// later tick (within 15 minutes, never for a time before the agent last changed), and the
// reconciler starts a run whose instance never started and fails a run whose instance ended
// without finishing it.

import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, agentChange, event, inboxItem, run } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { cronTick } from "./runs/dispatch";
import {
  RECONCILE_AFTER_MS,
  RECONCILE_MINUTE,
  reconcileClientRuns,
  reconcileRuns,
} from "./runs/reconcile";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

function bundle(name: string, on: unknown): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "does one thing", mission: "start when asked" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: { schemaVersion: 3, trigger: { id: "t", on }, steps: [] },
      },
    ],
  } as AgentBundleInput);
}

/** Tomorrow (UTC), so every agent change made by the test is before its ticks. */
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const at = (hhmmss: string) => new Date(`${day}T${hhmmss}Z`);

describe.skipIf(!h)("schedules: a missed tick is caught up", () => {
  const H = h as ApiHarness;

  async function makeAgent(slug: string, trigger: unknown) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle: bundle(slug, trigger),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return id;
  }
  const rowsOf = (agentId: string) => H.t.db.select().from(run).where(eq(run.agentId, agentId));
  const startsOf = async (agentId: string) => {
    const ids = new Set((await rowsOf(agentId)).map((r) => r.id));
    return H.instances.startCalls.filter((id) => ids.has(id));
  };
  const tick = (iso: string) => cronTick({ db: H.db, instances: H.instances }, at(iso));
  const daily = { type: "schedule", cron: "0 9 * * *", tz: "UTC" };

  it("starts the 09:00 run on a later tick when the 09:00 tick never ran, once", async () => {
    const id = await makeAgent("late-sam", daily);
    // The 09:00 and 09:01 to 09:06 ticks never ran (an outage); 09:07 finds the 09:00 run due.
    await tick("09:07:20");
    const rows = await rowsOf(id);
    expect(rows.map((r) => j(r.trigger).scheduledAt)).toEqual([at("09:00:00").toISOString()]);
    expect(await startsOf(id)).toHaveLength(1);
    // Every later tick in the lookback asks for the same run: nothing new is written or started.
    const events = (await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId)))
      .length;
    await tick("09:08:20");
    await tick("09:14:20");
    expect(await rowsOf(id)).toHaveLength(1);
    expect(await startsOf(id)).toHaveLength(1);
    expect((await H.t.db.select().from(event).where(eq(event.tenantId, H.A.tenantId))).length).toBe(
      events,
    );
  });

  it("looks back 15 minutes, no further", async () => {
    const id = await makeAgent("later-sam", daily);
    await tick("09:16:20");
    expect(await rowsOf(id)).toHaveLength(0);
  });

  it("never fires for a time before the agent last changed (activated, resumed, published)", async () => {
    const id = await makeAgent("fresh-sam", daily);
    // Switched on at 09:03, after the 09:00 tick it missed.
    await H.t.db.insert(agentChange).values({
      tenantId: H.A.tenantId,
      agentId: id,
      change: { kind: "resume" },
      createdAt: at("09:03:00"),
    });
    await tick("09:05:20");
    expect(await rowsOf(id)).toHaveLength(0);
    const hourly = await makeAgent("fresh-hal", { type: "schedule", cron: "5 9 * * *", tz: "UTC" });
    // A change a few seconds after a tick that is evaluated on time does not hold it back.
    await H.t.db.insert(agentChange).values({
      tenantId: H.A.tenantId,
      agentId: hourly,
      change: { kind: "operational" },
      createdAt: at("09:05:10"),
    });
    await tick("09:05:20");
    expect(await rowsOf(hourly)).toHaveLength(1);
  });

  it("goes on with the client's minute when an instance won't start", async () => {
    const id = await makeAgent("stalled-sam", { type: "schedule", cron: "30 9 * * *", tz: "UTC" });
    H.instances.failStarts = 1;
    const checked: string[] = [];
    await cronTick(
      {
        db: H.db,
        instances: H.instances,
        healthTick: async (tenantId) => void checked.push(tenantId),
      },
      at("09:30:20"),
    );
    // The rest of the client's minute ran.
    expect(checked).toContain(H.A.tenantId);
    const [row] = await rowsOf(id);
    if (!row) throw new Error("no run row");
    expect(H.instances.started.has(row.id)).toBe(false);
    // The reconciler starts it once it is old enough.
    const done = await reconcileClientRuns(
      { db: H.db, instances: H.instances },
      H.A.tenantId,
      new Date(row.createdAt.getTime() + RECONCILE_AFTER_MS + 60_000),
    );
    expect(done.started).toBeGreaterThanOrEqual(1);
    expect(H.instances.started.get(row.id)?.trigger).toMatchObject({
      type: "schedule",
      scheduledAt: at("09:30:00").toISOString(),
    });
  });
});

describe.skipIf(!h)("the run reconciler", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const later = () => new Date(Date.now() + RECONCILE_AFTER_MS + 60_000);
  const reconcile = (when = later()) =>
    reconcileClientRuns({ db: H.db, instances: H.instances }, H.B.tenantId, when);
  const rowOf = async (id: string) => (await H.t.db.select().from(run).where(eq(run.id, id)))[0];

  it("starts a run the API accepted but could not start", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "manny",
      bundle: bundle("manny", { type: "manual", input: { type: "object" } }),
    });
    agentId = j(created.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    H.instances.failStarts = 1;
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
      input: { n: 1 },
    });
    // DECISION in runs/reconcile.ts: the person gets the run's id; the reconciler starts it.
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    expect(H.instances.started.has(runId)).toBe(false);
    expect((await rowOf(runId))?.status).toBe("running");
    // Too young: its start may still be on its way.
    expect((await reconcile(new Date())).started).toBe(0);
    expect((await reconcile()).started).toBe(1);
    expect(H.instances.started.get(runId)).toMatchObject({
      runId,
      tenantId: H.B.tenantId,
      agentId,
      workflowSlug: "main",
      mode: "live",
      payload: { n: 1 },
      trigger: { type: "manual" },
    });
    // Started once: the next pass finds it running.
    expect(await reconcile()).toEqual({ started: 0, failed: 0 });
  });

  it("starts a retry whose start failed, so the run retried is not a dead end", async () => {
    const [failed] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.B.tenantId,
        agentId,
        agentVersionId: (await H.t.db.select().from(agent).where(eq(agent.id, agentId)))[0]
          ?.liveVersionId as string,
        workflowSlug: "main",
        mode: "live",
        trigger: { type: "manual", payload: { n: 2 } },
        status: "failed",
        error: { reason: "the tool said no", nodeId: null },
      })
      .returning();
    H.instances.failStarts = 1;
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${failed?.id}/retry`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const retryId = j(res.json).runId as string;
    expect(H.instances.started.has(retryId)).toBe(false);
    await reconcile();
    expect(H.instances.started.get(retryId)).toMatchObject({
      retryOf: failed?.id,
      payload: { n: 2 },
    });
  });

  it("fails a run whose instance ended without finishing it, once, and expires its items", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    const runId = j(res.json).runId as string;
    expect(H.instances.started.has(runId)).toBe(true);
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.B.tenantId,
        kind: "approval",
        title: "Approve the change",
        runId,
        status: "open",
      })
      .returning();
    // Still running in the engine: left alone.
    expect((await reconcile()).failed).toBe(0);
    H.instances.states.set(runId, {
      status: "errored",
      error: "Error: run:load ran out of retries",
    });
    expect((await reconcile()).failed).toBe(1);
    const r = await rowOf(runId);
    expect(r?.status).toBe("failed");
    expect(r?.finishedAt).not.toBeNull();
    expect(r?.error).toMatchObject({ code: "instance_ended", key: "run:instance_ended" });
    expect(j(r?.error).reason).toContain("errored");
    const [after] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, item?.id as string));
    expect(after?.status).toBe("expired");
    const failedEvents = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, runId)));
    expect(failedEvents).toHaveLength(1);
    // Reported once: the run is over, so the next pass doesn't see it.
    expect((await reconcile()).failed).toBe(0);
  });

  it("leaves test runs alone; a test run that won't start is failed at once", async () => {
    const [v] = await H.t.db.select().from(agent).where(eq(agent.id, agentId));
    H.instances.failStarts = 1;
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v?.liveVersionId}/test-run`,
      { workflow: "main" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const r = await rowOf(runId);
    expect(r?.status).toBe("failed");
    expect(r?.error).toMatchObject({ code: "not_started" });
    await reconcile();
    expect(H.instances.started.has(runId)).toBe(false);
  });

  it("runs every 5 minutes, at its minute", async () => {
    const deps = { db: H.db, instances: H.instances };
    const off = new Date(Date.UTC(2026, 10, 20, 10, (RECONCILE_MINUTE + 1) % 5));
    expect(await reconcileRuns(deps, off)).toEqual({ started: 0, failed: 0 });
  });
});
