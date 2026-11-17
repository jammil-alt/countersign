// Runs that would otherwise silently not happen: a schedule tick the cron missed is started on a
// later tick (within 15 minutes, never for a time before the agent last changed), and the
// reconciler starts a run whose instance never started and fails a run whose instance ended
// without finishing it.

import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  agentChange,
  contact,
  event,
  inboxItem,
  reachOut,
  run,
  stepRun,
} from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SLOAN_SWEEP_MINUTE } from "./account/sloan";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { BANKFEED_CRON_MINUTE } from "./bankfeed/sync";
import { CAPTURE_CRON_MINUTE } from "./conversations/cron";
import { A2P_CRON_MINUTE } from "./messaging/a2p";
import { HEALTH_MINUTE } from "./observability/health";
import { RAMP_POLL_MINUTE } from "./ramp/poll";
import { QBO_CRON_MINUTE } from "./routes/qbo";
import { cronTick, USAGE_SWEEP_MINUTE } from "./runs/dispatch";
import {
  RECONCILE_AFTER_MS,
  RECONCILE_EVERY_MINUTES,
  RECONCILE_MINUTE,
  RECONCILE_PER_CLIENT,
  reconcileClientRuns,
  reconcileRuns,
} from "./runs/reconcile";
import { SEARCH_SYNC_MINUTE } from "./search-sync";
import { TRANSLATION_SWEEP_MINUTE } from "./translate/service";
import { ZOHO_CRON_MINUTE } from "./zoho/sync";

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

describe.skipIf(!h)("the cron's model work waits for every client's minute", () => {
  const H = h as ApiHarness;

  it("starts every client's schedules before a hanging model call (summaries) begins", async () => {
    const ids: string[] = [];
    for (const [tenantId, slug] of [
      [H.A.tenantId, "slow-first-sam"],
      [H.B.tenantId, "slow-second-sam"],
    ] as const) {
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
        slug,
        bundle: bundle(slug, { type: "schedule", cron: "45 9 * * *", tz: "UTC" }),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      const id = j(created.json).agent.id as string;
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
      );
      await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
      ids.push(id);
    }
    let release: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedBefore: number[] = [];
    let called: readonly string[] = [];
    const done = cronTick(
      {
        db: H.db,
        instances: H.instances,
        afterClients: async (clients) => {
          called = clients;
          for (const id of ids) {
            const rows = await H.t.db.select().from(run).where(eq(run.agentId, id));
            startedBefore.push(rows.filter((r) => H.instances.started.has(r.id)).length);
          }
          await hanging;
        },
      },
      at("09:45:20"),
    );
    await vi.waitFor(() => expect(called.length).toBeGreaterThan(0));
    // Both clients' 09:45 runs started before the model work, whichever client it was for.
    expect(startedBefore).toEqual([1, 1]);
    expect(called).toEqual(expect.arrayContaining([H.A.tenantId, H.B.tenantId]));
    release();
    await done;
  });
});

describe.skipIf(!h)("the run reconciler", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const later = () => new Date(Date.now() + RECONCILE_AFTER_MS + 60_000);
  const reconcile = (when = later()) =>
    reconcileClientRuns({ db: H.db, instances: H.instances }, H.B.tenantId, when);
  const rowOf = async (id: string) => (await H.t.db.select().from(run).where(eq(run.id, id)))[0];
  const failedEventsOf = (runId: string) =>
    H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, runId)));

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
    expect(await reconcile()).toEqual({ started: 0, failed: 0, quiet: 0 });
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
    const [who] = await H.t.db
      .insert(contact)
      .values({ tenantId: H.B.tenantId, name: "Vendor Val", email: "val@vendor.example.com" })
      .returning();
    const [ro] = await H.t.db
      .insert(reachOut)
      .values({
        tenantId: H.B.tenantId,
        agentId,
        agentVersionId: (await rowOf(runId))?.agentVersionId as string,
        runId,
        nodeId: "ask",
        contactId: who?.id as string,
        subject: "price check",
        purpose: "ask for a price",
        urgency: "normal",
        plan: {},
        status: "open",
      })
      .returning();
    const reachOutId = ro?.id as string;
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
    expect(await failedEventsOf(runId)).toHaveLength(1);
    // Its reach-out ends too: nobody is reminded for a run that is over.
    const [ended] = await H.t.db.select().from(reachOut).where(eq(reachOut.id, reachOutId));
    expect(ended).toMatchObject({ status: "ended", outcome: "no_reply", reason: "the run ended" });
    expect(ended?.runReceivedAt).not.toBeNull();
    // Reported once: the run is over, so the next pass doesn't see it.
    expect((await reconcile()).failed).toBe(0);
  });

  /** A live run row of the agent, as an API start that failed leaves it, created `ago` ms back. */
  async function orphan(ago: number) {
    const [a] = await H.t.db.select().from(agent).where(eq(agent.id, agentId));
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.B.tenantId,
        agentId,
        agentVersionId: a?.liveVersionId as string,
        workflowSlug: "main",
        mode: "live",
        trigger: { type: "manual", payload: {} },
        status: "running",
        startedAt: new Date(Date.now() - ago),
        createdAt: new Date(Date.now() - ago),
      })
      .returning();
    return r?.id as string;
  }

  it("never starts a run created more than an hour ago: it fails it, not_started", async () => {
    const runId = await orphan(2 * 60 * 60_000);
    const done = await reconcile(new Date());
    expect(done).toMatchObject({ started: 0, failed: 1, quiet: 0 });
    expect(H.instances.started.has(runId)).toBe(false);
    const r = await rowOf(runId);
    expect(r?.status).toBe("failed");
    expect(r?.error).toMatchObject({ code: "not_started", key: "run:not_started" });
    expect(await failedEventsOf(runId)).toHaveLength(1);
  });

  it("fails a run over a day old quietly: no run.failed, counted", async () => {
    const runId = await orphan(2 * 24 * 60 * 60_000);
    expect(await reconcile(new Date())).toMatchObject({ started: 0, failed: 1, quiet: 1 });
    expect((await rowOf(runId))?.status).toBe("failed");
    expect(await failedEventsOf(runId)).toEqual([]);
  });

  it("never starts a run whose agent is no longer running", async () => {
    const runId = await orphan(RECONCILE_AFTER_MS + 60_000);
    await H.t.db.update(agent).set({ runStatus: "paused" }).where(eq(agent.id, agentId));
    try {
      expect(await reconcile(new Date())).toMatchObject({ started: 0, failed: 1 });
      expect(H.instances.started.has(runId)).toBe(false);
      expect((await rowOf(runId))?.error).toMatchObject({ code: "not_started" });
    } finally {
      await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    }
  });

  it("starts nothing and fails nothing when the engine can't say", async () => {
    const runId = await orphan(RECONCILE_AFTER_MS + 60_000);
    H.instances.failInspects = 10;
    try {
      expect(await reconcile(new Date())).toEqual({ started: 0, failed: 0, quiet: 0 });
    } finally {
      H.instances.failInspects = 0;
    }
    expect(H.instances.started.has(runId)).toBe(false);
    expect((await rowOf(runId))?.status).toBe("running");
    // Once the engine answers, it is started.
    expect((await reconcile(new Date())).started).toBe(1);
    expect(H.instances.started.has(runId)).toBe(true);
  });

  it("takes runs that never started first", async () => {
    // More open runs with a step than one pass checks, and one without.
    const busy = [];
    for (let i = 0; i < RECONCILE_PER_CLIENT * 4; i++)
      busy.push(await orphan(RECONCILE_AFTER_MS + 60_000));
    for (const id of busy) {
      H.instances.started.set(id, {} as never);
      await H.t.db.insert(stepRun).values({
        tenantId: H.B.tenantId,
        runId: id,
        nodeId: "first",
        nodeType: "skill",
        status: "waiting",
      });
    }
    const fresh = await orphan(RECONCILE_AFTER_MS + 60_000);
    expect((await reconcile(new Date())).started).toBe(1);
    expect(H.instances.started.has(fresh)).toBe(true);
    // Tidy: these runs are over.
    await H.t.db.update(run).set({ status: "cancelled" }).where(inArray(run.id, busy));
  });

  it("a cancel and a reconciler pass at once leave the run cancelled, with no run.failed", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    const runId = j(res.json).runId as string;
    // A pass runs while the cancel's instance is terminated, before its transaction commits.
    const terminate = H.instances.terminate.bind(H.instances);
    let pass: Promise<unknown> = Promise.resolve();
    H.instances.terminate = async (id: string) => {
      const out = await terminate(id);
      pass = reconcile();
      // Give the pass time to read the run and ask the engine.
      await new Promise((r) => setTimeout(r, 200));
      return out;
    };
    try {
      const cancel = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/cancel`);
      expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
      await pass;
    } finally {
      H.instances.terminate = terminate;
    }
    expect((await rowOf(runId))?.status).toBe("cancelled");
    expect(await failedEventsOf(runId)).toEqual([]);
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

  it("runs every 10 minutes, at a minute no other periodic pass uses", async () => {
    const deps = { db: H.db, instances: H.instances };
    const off = new Date(Date.UTC(2026, 10, 20, 10, (RECONCILE_MINUTE + 1) % 10));
    expect(await reconcileRuns(deps, off)).toEqual({ started: 0, failed: 0, quiet: 0 });
    const taken = new Set<number>();
    for (let m = 0; m < 60; m++) {
      if (m % 15 === QBO_CRON_MINUTE || m % 15 === RAMP_POLL_MINUTE || m % 15 === ZOHO_CRON_MINUTE)
        taken.add(m);
      if (m % 5 === 0 || m % 10 === CAPTURE_CRON_MINUTE) taken.add(m);
    }
    for (const m of [
      USAGE_SWEEP_MINUTE,
      HEALTH_MINUTE,
      SEARCH_SYNC_MINUTE,
      TRANSLATION_SWEEP_MINUTE,
    ])
      taken.add(m);
    taken.add(SLOAN_SWEEP_MINUTE).add(A2P_CRON_MINUTE).add(BANKFEED_CRON_MINUTE);
    for (let m = RECONCILE_MINUTE; m < 60; m += RECONCILE_EVERY_MINUTES) {
      expect(taken.has(m), `minute ${m}`).toBe(false);
    }
  });
});
