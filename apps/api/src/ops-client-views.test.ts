// Speed run 6.2, 6.3 and 6.7 (docs/audit-plan.md): the back office's run page, run lists and
// client page, through the app. The answers are the ones the per-agent and whole-bundle reads gave
// (each checked against them here), the new run status route's key moves when the page would change,
// and the statement counts are pinned: none grows with the client's agents or the list's versions.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  findNodeStep,
  stepNodeOf,
} from "@countersign/core";
import {
  agentVersion,
  contact,
  inboxItem,
  modelCall,
  reachOut,
  run,
  stepRun,
  toolCall,
} from "@countersign/db";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  storedSkill,
  testBundle,
} from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type Json = any;

/** testBundle with a second workflow, so a list names more than one. */
function twoWorkflows(): AgentBundle {
  const b = testBundle() as AgentBundleInput;
  return AgentBundleSchema.parse({
    ...b,
    workflows: [
      ...b.workflows,
      {
        slug: "note",
        name: "Leave a note",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-note", on: { type: "manual", input: {} } },
          steps: [{ id: "n", name: "Note", kind: "notify", channel: "thread", message: "hello" }],
        },
      },
    ],
  });
}

/**
 * Counts the statements the app sends (every query goes through postgres-js' `unsafe`, in a
 * transaction or not; `begin` and `commit` are left out, as the measurement leaves them out).
 */
function countStatements(client: object): { reset(): void; readonly n: number } {
  let n = 0;
  const own = (target: object, prop: string) =>
    Object.getOwnPropertyDescriptor(target, prop)?.value as (...a: unknown[]) => unknown;
  const counting = (target: object) => {
    const unsafe = own(target, "unsafe");
    Object.defineProperty(target, "unsafe", {
      configurable: true,
      writable: true,
      value: (...a: unknown[]) => {
        n++;
        return unsafe.apply(target, a);
      },
    });
  };
  counting(client);
  const begin = own(client, "begin");
  Object.defineProperty(client, "begin", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const fn = args.pop() as (tx: object) => unknown;
      return begin.call(client, ...args, (tx: object) => {
        counting(tx);
        return fn(tx);
      });
    },
  });
  return {
    reset: () => {
      n = 0;
    },
    get n() {
      return n;
    },
  };
}

describe.skipIf(!h)("the back office's run page, run lists and client page", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A;
  const counter = countStatements(H.db.$client);

  async function ok(who: string, method: string, path: string, body?: unknown): Promise<Json> {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }

  /** Statements one call sends, the session's and the audit row's included. */
  async function statements(path: string): Promise<number> {
    await H.settle();
    counter.reset();
    await ok(OPERATOR, "GET", path);
    return counter.n;
  }

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** A client agent of client A, bound and published, with its first version. */
  async function agentOf(slug: string, bundle: AgentBundle = twoWorkflows()) {
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug,
      bundle,
    });
    const id = created.agent.id as string;
    const versionId = created.version.id as string;
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: A().connectionId },
      serviceName: slug,
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${versionId}/publish`);
    // A passing test run on the client, which Activate asks for.
    await H.t.db.insert(run).values({
      tenantId: A().tenantId,
      agentId: id,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "test",
      status: "succeeded",
      createdAt: ago(60),
    });
    return { id, versionId };
  }

  async function addRun(
    a: { id: string; versionId: string },
    values: Partial<typeof run.$inferInsert> & { minutesAgo: number },
  ) {
    const { minutesAgo, ...rest } = values;
    const [row] = await H.t.db
      .insert(run)
      .values({
        tenantId: A().tenantId,
        agentId: a.id,
        agentVersionId: a.versionId,
        workflowSlug: "fix-record",
        mode: "live",
        status: "succeeded",
        createdAt: ago(minutesAgo),
        ...rest,
      })
      .returning();
    if (!row) throw new Error("no run");
    return row;
  }

  let trial: { id: string; versionId: string };
  let bench: { id: string; versionId: string };
  let paused: { id: string; versionId: string };
  let failedRun: string;
  let waitingRun: string;

  beforeAll(async () => {
    // On trial (it writes): a live trial with finished and unfinished runs since it began.
    trial = await agentOf("on-trial");
    await ok(OPERATOR, "POST", `/api/ops/agents/${trial.id}/activate`);
    // The trial began a day ago.
    await H.t.db.execute(
      sql`update agent set stage_state = jsonb_set(stage_state, '{trial,startedAt}',
        to_jsonb(${ago(24 * 60).toISOString()}::text)) where id = ${trial.id}`,
    );
    for (const [minutes, status] of [
      [5, "succeeded"],
      [4, "failed"],
      [3, "running"],
    ] as const) {
      await addRun(trial, { minutesAgo: minutes, status });
    }
    // Failed at a step's check, inside a loop's numbering, and at a workflow the version lacks.
    failedRun = (
      await addRun(trial, {
        minutesAgo: 2,
        status: "failed",
        error: { nodeId: "update:confer:1", message: "the reviewer said no" },
      })
    ).id;
    await addRun(trial, {
      minutesAgo: 9 * 24 * 60,
      status: "failed",
      workflowSlug: "note",
      error: { nodeId: "n" },
    });
    await addRun(trial, { minutesAgo: 30, status: "failed", workflowSlug: "gone" });
    // A run waiting on the client: running, with an open inbox item.
    const waiting = await addRun(trial, { minutesAgo: 1, status: "running" });
    waitingRun = waiting.id;
    await H.t.db.insert(inboxItem).values({
      tenantId: A().tenantId,
      kind: "approval",
      runId: waiting.id,
      agentId: trial.id,
      title: "Sign the change",
      payload: {},
      status: "open",
    });
    // On the bench, a draft only: no live version.
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug: "draft-only",
      bundle: twoWorkflows(),
    });
    bench = { id: created.agent.id, versionId: created.version.id };
    await addRun(bench, { minutesAgo: 10, mode: "test" });
    // Live and paused by the client.
    paused = await agentOf("paused");
    await ok(OPERATOR, "POST", `/api/ops/agents/${paused.id}/stage`, {
      to: "live",
      reason: "the client asked",
    });
    await ok(admin("a"), "POST", `/api/services/${paused.id}/pause`, { reason: "month end" });
  });

  it("the client page gives each agent's go-live stage as the per-agent route does", async () => {
    const page = await ok(OPERATOR, "GET", `/api/ops/clients/${A().tenantId}`);
    const shown = page.agents.filter((a: Json) => !a.testCopy).map((a: Json) => a.id);
    expect(page.goLive.map((g: Json) => g.agentId)).toEqual(shown);
    expect(page.activity.map((a: Json) => a.agentId)).toEqual(shown);
    for (const id of [trial.id, bench.id, paused.id]) expect(shown).toContain(id);
    for (const g of page.goLive) {
      const one = await ok(OPERATOR, "GET", `/api/ops/agents/${g.agentId}/go-live`);
      expect(g.goLive, g.agentId).toEqual(one.goLive);
    }
    const stage = (id: string) => page.goLive.find((g: Json) => g.agentId === id).goLive;
    expect(stage(trial.id)).toMatchObject({ stage: "trial", writes: true });
    // Finished live runs since the trial began: one succeeded, three failed (not the old one).
    expect(stage(trial.id).trial).toMatchObject({ days: 1, runs: 4 });
    expect(stage(bench.id)).toMatchObject({ stage: "bench", liveVersion: false, writes: true });
    expect(stage(paused.id)).toMatchObject({ stage: "live", pause: { reason: "month end" } });
  });

  it("each agent's activity: its last run (waiting or not), its week and its waiting runs", async () => {
    const page = await ok(OPERATOR, "GET", `/api/ops/clients/${A().tenantId}`);
    const of = (id: string) => page.activity.find((a: Json) => a.agentId === id);
    expect(of(trial.id)).toMatchObject({
      runs7d: 6,
      waitingRuns: 1,
      lastRun: { id: waitingRun, status: "running", waiting: true },
    });
    expect(of(bench.id)).toMatchObject({
      runs7d: 0,
      waitingRuns: 0,
      lastRun: { status: "succeeded", waiting: false },
    });
    expect(of(bench.id).lastRun.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // Its test run before going live.
    expect(of(paused.id)).toMatchObject({ runs7d: 0, lastRun: { status: "succeeded" } });
  });

  it("the runs list names each run's workflow and failed step as the whole bundle does", async () => {
    const list = await ok(OPERATOR, "GET", `/api/ops/runs?client=${A().tenantId}&limit=50`);
    const versions = await H.t.db
      .select({ id: agentVersion.id, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(
        inArray(
          agentVersion.id,
          list.runs.map((r: Json) => r.agentVersionId),
        ),
      );
    const bundles = new Map(versions.map((v) => [v.id, v.bundle]));
    for (const r of list.runs) {
      const wf = bundles.get(r.agentVersionId)?.workflows.find((w) => w.slug === r.workflowSlug);
      const nodeId = r.status === "failed" ? r.error?.nodeId : undefined;
      const node = typeof nodeId === "string" ? stepNodeOf(nodeId).node : null;
      const step = wf && node ? findNodeStep(wf.workflow, node) : undefined;
      expect(r.workflowName, r.id).toBe(wf?.name ?? null);
      expect(r.errorStep, r.id).toBe(step?.name ?? null);
      // The list never carries what it does not show.
      expect(r).not.toHaveProperty("config");
    }
    const failed = list.runs.find((r: Json) => r.id === failedRun);
    expect(failed).toMatchObject({ workflowName: "Fix a record", errorStep: "Update the record" });
    expect(list.runs.find((r: Json) => r.workflowSlug === "note")).toMatchObject({
      workflowName: "Leave a note",
      errorStep: "Note",
    });
    expect(list.runs.find((r: Json) => r.workflowSlug === "gone")).toMatchObject({
      workflowName: null,
      errorStep: null,
    });
  });

  it("the run page's run is the list's, and its tool calls are the step's", async () => {
    const [step] = await H.t.db
      .insert(stepRun)
      .values({
        tenantId: A().tenantId,
        runId: failedRun,
        nodeId: "update",
        nodeType: "action",
        status: "failed",
        startedAt: ago(2),
      })
      .returning();
    if (!step) throw new Error("no step");
    await H.t.db.insert(toolCall).values({
      tenantId: A().tenantId,
      stepRunId: step.id,
      tool: "testkit.update_record",
      input: { id: "r1" },
      output: { error: "refused" },
      status: "failed",
      durationMs: 12,
    });
    const page = await ok(OPERATOR, "GET", `/api/ops/runs/${failedRun}`);
    const list = await ok(OPERATOR, "GET", `/api/ops/runs?client=${A().tenantId}&limit=50`);
    expect(page.run).toEqual(list.runs.find((r: Json) => r.id === failedRun));
    expect(page.workflow).toMatchObject({ slug: "fix-record", name: "Fix a record" });
    expect(page.toolCalls).toEqual([
      {
        id: expect.any(String),
        stepRunId: step.id,
        tool: "testkit.update_record",
        input: { id: "r1" },
        output: { error: "refused" },
        status: "failed",
        durationMs: 12,
        externalActionId: null,
      },
    ]);
  });

  it("the run status key moves with what the page shows, timestamps or not, for clients served", async () => {
    const path = `/api/ops/runs/${waitingRun}/status`;
    const key = async () => (await ok(OPERATOR, "GET", path)).key as string;
    const first = await ok(OPERATOR, "GET", path);
    expect(first).toEqual({
      id: waitingRun,
      status: "running",
      waiting: true,
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    // Nothing changed: the same key.
    expect(await key()).toBe(first.key);
    const seen = new Set([first.key]);
    /** Each change moves the key to one never seen before. */
    const moves = async (why: string, change: () => Promise<unknown>) => {
      await change();
      const k = await key();
      expect(seen.has(k), why).toBe(false);
      seen.add(k);
    };
    const tenantId = A().tenantId;
    const [step] = await H.t.db
      .insert(stepRun)
      .values({
        tenantId,
        runId: waitingRun,
        nodeId: "update",
        nodeType: "action",
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    if (!step) throw new Error("no step");
    seen.add(await key());
    const [call] = await H.t.db
      .insert(toolCall)
      .values({ tenantId, stepRunId: step.id, tool: "testkit.update_record", status: "running" })
      .returning();
    if (!call) throw new Error("no call");
    seen.add(await key());
    await moves("a tool call finishing (no timestamp)", () =>
      H.t.db
        .update(toolCall)
        .set({ status: "succeeded", output: { ok: true }, durationMs: 40 })
        .where(sql`${toolCall.id} = ${call.id}`),
    );
    await moves("a model call", () =>
      H.t.db.insert(modelCall).values({
        tenantId,
        runId: waitingRun,
        stepRunId: step.id,
        provider: "anthropic",
        model: "claude-opus-5-5",
        tokensIn: 10,
        tokensOut: 5,
        costUsd: "0.0100",
        durationMs: 300,
        stopReason: "end_turn",
        bodyKey: `tenants/${tenantId}/model-calls/x.json`,
      }),
    );
    await moves("cost added to the run (no timestamp)", () =>
      H.t.db.update(run).set({ costUsd: "0.0100" }).where(sql`${run.id} = ${waitingRun}`),
    );
    await moves("a step going from running to waiting (no timestamp)", () =>
      H.t.db.update(stepRun).set({ status: "waiting" }).where(sql`${stepRun.id} = ${step.id}`),
    );
    const [person] = await H.t.db
      .insert(contact)
      .values({ tenantId, name: "Sam Rivera", email: "sam@example.com" })
      .returning();
    if (!person) throw new Error("no contact");
    const [reach] = await H.t.db
      .insert(reachOut)
      .values({
        tenantId,
        agentId: trial.id,
        agentVersionId: trial.versionId,
        runId: waitingRun,
        stepRunId: step.id,
        nodeId: "ask",
        contactId: person.id,
        subject: `converse:${waitingRun}:ask`,
        purpose: "confirm the record",
        urgency: "normal",
        plan: {},
        status: "open",
      })
      .returning();
    if (!reach) throw new Error("no reach-out");
    seen.add(await key());
    await moves("a reply on a conversation", () =>
      H.t.db
        .update(reachOut)
        .set({ reply: { text: "Yes, that's right" } })
        .where(sql`${reachOut.id} = ${reach.id}`),
    );
    await moves("an inbox item snoozed", () =>
      H.t.db
        .update(inboxItem)
        .set({ snoozedUntil: new Date(Date.now() + 3_600_000) })
        .where(sql`${inboxItem.runId} = ${waitingRun}`),
    );
    // Client A is not this operator's.
    const other = await H.call(OTHER_OPERATOR, "GET", path);
    expect(other.status).toBe(404);
    const portal = await H.call(admin("a"), "GET", path);
    expect(portal.status).toBe(403);
  });

  it("statement counts: pinned, and none grows with the client's agents or the list's versions", async () => {
    const client = `/api/ops/clients/${A().tenantId}`;
    const runs = `/api/ops/runs?client=${A().tenantId}&limit=50`;
    const counts = {
      client: await statements(client),
      runs: await statements(runs),
      run: await statements(`/api/ops/runs/${failedRun}`),
      status: await statements(`/api/ops/runs/${waitingRun}/status`),
    };
    // Six of each are the session's and the audit row's (the scope, the user, the memberships).
    expect(counts).toEqual({ client: 14, runs: 12, run: 21, status: 7 });

    // Another agent on trial, with runs on a second version: the same statements.
    const more = await agentOf("one-more");
    await ok(OPERATOR, "POST", `/api/ops/agents/${more.id}/activate`);
    await addRun(more, { minutesAgo: 6, status: "failed", error: { nodeId: "update" } });
    expect(await statements(client)).toBe(counts.client);
    expect(await statements(runs)).toBe(counts.runs);

    // A custom skill of the client's, used by one agent: its reads come once (the skill and its
    // version), and a second agent using it adds none.
    await storedSkill(
      H,
      {
        schemaVersion: 1,
        id: "custom:recount",
        name: "Recount",
        description: "Recounts the records",
        category: "writing",
        mode: "agent",
        instructions: "Recount the records.",
        tools: [TESTKIT_UPDATE_TOOL],
        input: { type: "object", properties: {} },
        output: { type: "object", properties: {} },
      },
      A().tenantId,
    );
    const withSkill = () => {
      const b = twoWorkflows() as AgentBundleInput;
      return AgentBundleSchema.parse({
        ...b,
        definition: { ...b.definition, extraTools: [], skills: [{ skill: "custom:recount" }] },
      });
    };
    const first = await agentOf("recounter", withSkill());
    const one = await statements(client);
    expect(one).toBe(counts.client + 2);
    const page = await ok(OPERATOR, "GET", client);
    for (const g of page.goLive.filter((x: Json) => x.agentId === first.id)) {
      const alone = await ok(OPERATOR, "GET", `/api/ops/agents/${g.agentId}/go-live`);
      expect(g.goLive).toEqual(alone.goLive);
      expect(g.goLive.writes).toBe(true);
    }
    await agentOf("recounter-two", withSkill());
    expect(await statements(client)).toBe(one);
  });
});
