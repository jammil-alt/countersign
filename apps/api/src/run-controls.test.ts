// v0.12 W1-E: run controls and model calls (ARCHITECTURE §10.10; docs/plan.md §1.40, M17) against
// a real database as cs_worker: a run that failed at its write step is retried from it and makes
// the already-signed write once under its original key without asking again; an approval older
// than 72 hours or a tightened matrix asks again; cancel ends a waiting run; replay is a test run
// in the same client that writes nothing; failures group by error; the runs CSV; model calls with
// redacted bodies, never in the portal; saved views are each operator's own.

import { dbModelCalls } from "@countersign/agents";
import { DEV_USER_HEADER } from "@countersign/auth";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput, shortRunId } from "@countersign/core";
import { connection, externalAction, inboxItem, run, stepRun, toolCall } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** testBundle's workflow with a note before the write, so a retry has a step to reuse. */
function bundle(): AgentBundle {
  const b = testBundle() as AgentBundleInput;
  const [wf] = b.workflows ?? [];
  if (!wf) throw new Error("no workflow");
  wf.workflow.steps = [
    {
      id: "hello",
      name: "Say hello",
      kind: "notify",
      channel: "thread",
      message: "Starting",
      client: { visible: false },
    },
    ...wf.workflow.steps,
  ];
  return AgentBundle.parse(b);
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("run controls", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    modelCallBodies: H.objects,
  });

  /** Resolves the item a run waits on through the API (approve), and returns the event it sent. */
  const approveAs = (who: string, seen: string[] = [], before?: (kind: string) => void) => {
    return async (_name: string, type: string) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no open item for ${type}`);
      seen.push(item.kind);
      before?.(item.kind);
      const res = await H.call(who, "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    };
  };

  const startLive = async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    return { runId, params };
  };

  /** A live run whose approved write fails when it is made (the record is gone by then). */
  const failedAtWrite = async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const { runId, params } = await startLive();
    const step = new FakeWorkflowStep(
      approveAs(admin("a"), [], () => H.backend.company(H.A.connectionId).delete("r1")),
    );
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toMatchObject({ status: "failed", nodeId: "update" });
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    return runId;
  };

  const retry = async (runId: string) => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/retry`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = j(res.json).runId as string;
    const params = H.instances.started.get(id);
    if (!params) throw new Error("the retry was not started");
    return { id, params, body: j(res.json) };
  };

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: bundle(),
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
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    const test = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v1}/test-run`,
      { workflow: "fix-record" },
    );
    const testParams = H.instances.started.get(j(test.json).runId);
    if (!testParams) throw new Error("the test run was not started");
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(
        new FakeWorkflowStep(async (_n, type) => {
          const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
          const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
          if (!item) throw new Error(`no open item for ${type}`);
          await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
            decision: "approve",
          });
          return H.instances.events.find((e) => e.event.type === type)?.event.payload;
        }),
      ),
    );
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
  });

  it("retries from the failed step, reusing earlier outputs and making the signed write once", async () => {
    const first = await failedAtWrite();
    const [failed] = await H.t.db.select().from(run).where(eq(run.id, first));
    // The error key names the tool that failed (docs/plan.md §1.40).
    const key = (failed?.error as { key?: string } | undefined)?.key ?? "";
    expect(key.slice(0, TESTKIT_UPDATE_TOOL.length + 1)).toBe(`${TESTKIT_UPDATE_TOOL}:`);
    const [original] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, first));
    expect(original).toMatchObject({ status: "failed", idempotencyKey: `${first}:update:0` });
    const writesBefore = H.backend.writes.length;

    const { id, params, body } = await retry(first);
    expect(body).toEqual({ runId: id, shortId: shortRunId(id), resumeFrom: "update" });
    const [row] = await H.t.db.select().from(run).where(eq(run.id, id));
    expect(row).toMatchObject({ retryOf: first, resumeFrom: "update", mode: "live" });

    const seen: string[] = [];
    const result = await executeRun(
      deps(),
      params,
      cloudflareStepRunner(new FakeWorkflowStep(approveAs(admin("a"), seen))),
    );
    expect(result).toEqual({ status: "succeeded" });
    // Only the person step asked; the write ran under its approval, not a new one.
    expect(seen).toEqual(["approval"]);
    const written = H.backend.writes.slice(writesBefore);
    expect(written.map((w) => w.idempotencyKey)).toEqual([`${first}:update:0`]);
    const [after] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.id, original?.id as string));
    expect(after?.status).toBe("done");
    expect(await H.t.db.select().from(externalAction).where(eq(externalAction.runId, id))).toEqual(
      [],
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, id));
    const hello = steps.find((s) => s.nodeId === "hello");
    expect(hello).toMatchObject({
      status: "succeeded",
      summary: `reused from ${shortRunId(first)}`,
    });
    const update = steps.find((s) => s.nodeId === "update");
    const [call] = await H.t.db
      .select()
      .from(toolCall)
      .where(eq(toolCall.stepRunId, update?.id as string));
    expect(call).toMatchObject({ externalActionId: original?.id, status: "succeeded" });
    expect(call?.output).toMatchObject({ approvedVia: "retry_of", retryOf: first });

    // One retry per run, and only failed live runs.
    const again = await H.call(OPERATOR, "POST", `/api/ops/runs/${first}/retry`);
    expect([again.status, j(again.json).error.code]).toEqual([409, "already_retried"]);
    const done = await H.call(OPERATOR, "POST", `/api/ops/runs/${id}/retry`);
    expect([done.status, j(done.json).error.code]).toEqual([409, "not_failed"]);
    // Clients never retry.
    expect((await H.call(admin("a"), "POST", `/api/ops/runs/${first}/retry`)).status).toBe(403);
  });

  it("asks again when the approval is 72 hours old", async () => {
    const first = await failedAtWrite();
    await H.t.db
      .update(externalAction)
      .set({ approvedAt: new Date(Date.now() - 73 * 3_600_000) })
      .where(eq(externalAction.runId, first));
    const { id, params } = await retry(first);
    const seen: string[] = [];
    const result = await executeRun(
      deps(),
      params,
      cloudflareStepRunner(new FakeWorkflowStep(approveAs(admin("a"), seen))),
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(seen).toEqual(["external_action", "approval"]);
    expect(H.backend.writes.at(-1)?.idempotencyKey).toBe(`${id}:update:0`);
  });

  it("asks again for an automatic write once the client has tightened its matrix", async () => {
    const first = await failedAtWrite();
    // As if the system had approved it (the automatic path): no signer.
    await H.t.db
      .update(externalAction)
      .set({ approvedBy: null })
      .where(eq(externalAction.runId, first));
    const { params } = await retry(first);
    const seen: string[] = [];
    await executeRun(
      deps(),
      params,
      cloudflareStepRunner(new FakeWorkflowStep(approveAs(admin("a"), seen))),
    );
    // The gate asks for this write (approval required), so the system's approval isn't carried.
    expect(seen).toEqual(["external_action", "approval"]);
  });

  it("refuses a write the client has since switched off", async () => {
    const first = await failedAtWrite();
    const [conn] = await H.t.db
      .select()
      .from(connection)
      .where(eq(connection.id, H.A.connectionId));
    await H.t.db
      .update(connection)
      .set({
        permissions: {
          ...(conn?.permissions as NonNullable<typeof conn>["permissions"]),
          update: "off",
        },
      })
      .where(eq(connection.id, H.A.connectionId));
    try {
      const { params } = await retry(first);
      const writes = H.backend.writes.length;
      const result = await executeRun(
        deps(),
        params,
        cloudflareStepRunner(new FakeWorkflowStep(approveAs(admin("a")))),
      );
      expect(result).toMatchObject({ status: "failed", nodeId: "update" });
      expect(H.backend.writes.length).toBe(writes);
    } finally {
      await H.t.db
        .update(connection)
        .set({ permissions: conn?.permissions as never })
        .where(eq(connection.id, H.A.connectionId));
    }
  });

  it("replays a run as a test run in the same client, which writes nothing", async () => {
    const first = await failedAtWrite();
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${first}/replay`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = j(res.json).runId as string;
    const [row] = await H.t.db.select().from(run).where(eq(run.id, id));
    expect(row).toMatchObject({ tenantId: H.A.tenantId, mode: "test", agentId });
    expect(row?.trigger).toMatchObject({ type: "manual", replayOf: first });
    const params = H.instances.started.get(id);
    if (!params) throw new Error("not started");
    const writes = H.backend.writes.length;
    await executeRun(
      deps(),
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(async (_n, type) => {
          const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
          const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
          if (!item) throw new Error(`no open item for ${type}`);
          await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
            decision: "approve",
          });
          return H.instances.events.find((e) => e.event.type === type)?.event.payload;
        }),
      ),
    );
    expect(H.backend.writes.length).toBe(writes);
  });

  it("cancels a waiting run: steps cancelled, items expired, proposed changes rejected", async () => {
    const { runId, params } = await startLive();
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    // The run waits on its write's approval and never hears back.
    void executeRun(
      deps(),
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(() => {
          waiting();
          return new Promise(() => {});
        }),
      ),
    );
    await reached;
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/cancel`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toEqual({ runId, status: "cancelled" });
    expect(H.instances.terminated).toContain(runId);
    const [r] = await H.t.db.select().from(run).where(eq(run.id, runId));
    expect(r?.status).toBe("cancelled");
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
    expect(steps.find((s) => s.nodeId === "update")?.status).toBe("cancelled");
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
    expect(items.map((i) => i.status)).toEqual(["expired"]);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(action).toMatchObject({ status: "rejected", error: { code: "run_cancelled" } });
    const twice = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/cancel`);
    expect([twice.status, j(twice.json).error.code]).toEqual([409, "not_open"]);
  });

  it("waits for a change being made before it cancels", async () => {
    const { runId, params } = await startLive();
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    void executeRun(
      deps(),
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(() => {
          waiting();
          return new Promise(() => {});
        }),
      ),
    );
    await reached;
    await H.t.db
      .update(externalAction)
      .set({ status: "executing" })
      .where(eq(externalAction.runId, runId));
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/cancel`);
    expect([res.status, j(res.json).error.code]).toEqual([409, "writing"]);
    expect(H.instances.terminated).not.toContain(runId);
    const [r] = await H.t.db.select().from(run).where(eq(run.id, runId));
    expect(r?.status).not.toBe("cancelled");
  });

  it("filters both lists by RunFilter, groups failures by error, and counts per day", async () => {
    const failedKey = `${TESTKIT_UPDATE_TOOL}:failed`;
    const grouped = await H.call(OPERATOR, "GET", "/api/ops/runs?groupBy=error&perDay=1");
    expect(grouped.status, JSON.stringify(grouped.json)).toBe(200);
    const group = j(grouped.json).groups.find((g: { key: string }) => g.key === failedKey);
    expect(group).toMatchObject({
      count: expect.any(Number),
      clients: [{ id: H.A.tenantId, name: expect.any(String) }],
      agents: [agentId],
    });
    expect(group.count).toBeGreaterThanOrEqual(4);
    expect(j(grouped.json).perDay.at(-1)).toMatchObject({ runs: expect.any(Number) });

    const byKey = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/runs?errorKey=${encodeURIComponent(failedKey)}&statuses=failed`,
    );
    expect(j(byKey.json).runs.length).toBe(group.count);
    // A retry's run was tried twice.
    const twice = await H.call(OPERATOR, "GET", "/api/ops/runs?attemptsOver=1");
    expect(j(twice.json).runs.every((r: { id: string }) => r.id)).toBe(true);
    expect(j(twice.json).runs.length).toBeGreaterThanOrEqual(1);
    const retries = await H.t.db.select({ id: run.id, retryOf: run.retryOf }).from(run);
    const retried = retries.filter((r) => r.retryOf).map((r) => r.id);
    expect(
      j(twice.json)
        .runs.map((r: { id: string }) => r.id)
        .sort(),
    ).toEqual(retried.sort());
    // Short ids, and who signed.
    const [some] = retried;
    const short = await H.call(OPERATOR, "GET", `/api/ops/runs?text=${shortRunId(some as string)}`);
    expect(j(short.json).runs.map((r: { id: string }) => r.id)).toEqual([some]);
    const [adminUser] = await H.t.db
      .select({ by: inboxItem.resolvedBy })
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.kind, "approval")))
      .limit(1);
    const signed = await H.call(OPERATOR, "GET", `/api/ops/runs?signedBy=${adminUser?.by}`);
    expect(j(signed.json).runs.length).toBeGreaterThanOrEqual(1);
    const changed = await H.call(OPERATOR, "GET", "/api/ops/runs?changedConnector=testkit");
    expect(j(changed.json).runs.length).toBeGreaterThanOrEqual(1);
    // v0.14 W4-B: the amount of a change, where its tool declares it (the testkit: 12.00 USD).
    const over = await H.call(OPERATOR, "GET", "/api/ops/runs?amountOver=11&amountCurrency=USD");
    expect(over.status, JSON.stringify(over.json)).toBe(200);
    expect(j(over.json).runs.length).toBeGreaterThanOrEqual(1);
    for (const q of [
      "amountOver=12&amountCurrency=USD",
      "amountUnder=12&amountCurrency=USD",
      "amountOver=11&amountCurrency=EUR",
    ]) {
      expect(j((await H.call(OPERATOR, "GET", `/api/ops/runs?${q}`)).json).runs).toEqual([]);
    }
    const between = await H.call(
      admin("a"),
      "GET",
      "/api/runs?amountOver=11&amountUnder=13&amountCurrency=USD",
    );
    expect(j(between.json).runs.length).toBeGreaterThanOrEqual(1);
    expect((await H.call(OPERATOR, "GET", "/api/ops/runs?amountOver=11")).status).toBe(400);
    const manual = await H.call(OPERATOR, "GET", "/api/ops/runs?startedBy=schedule");
    expect(j(manual.json).runs).toEqual([]);

    // The portal: its own live runs, never the back office's keys.
    const portal = await H.call(admin("a"), "GET", "/api/runs?statuses=failed&perDay=1");
    expect(portal.status).toBe(200);
    const failedLive = await H.t.db
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.tenantId, H.A.tenantId), eq(run.mode, "live"), eq(run.status, "failed")));
    expect(j(portal.json).runs.length).toBe(failedLive.length);
    expect(forbiddenKeys(portal.json)).toEqual([]);
    for (const q of ["costOver=0", "mode=test", "errorKey=x", `clients=${H.B.tenantId}`]) {
      const refused = await H.call(admin("a"), "GET", `/api/runs?${q}`);
      expect(refused.status, q).toBe(400);
    }
  });

  it("downloads the runs list as CSV", async () => {
    const res = await H.app.request(
      "/api/ops/runs.csv?statuses=failed",
      { headers: { [DEV_USER_HEADER]: OPERATOR } },
      H.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mezonas-runs-/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    const lines = text
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    expect(lines[0]).toBe(
      "id,client,agent,version,started,status,failed step,error key,attempts,cost",
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/^R-[0-9a-f]{6},.*,Record keeping,v\d+,.*,failed,update,/);
    expect((await H.call(admin("a"), "GET", "/api/ops/runs.csv")).status).toBe(403);
  });

  it("keeps each model call with a redacted body for the back office only", async () => {
    const [r] = await H.t.db
      .select()
      .from(run)
      .where(and(eq(run.tenantId, H.A.tenantId), eq(run.mode, "live")))
      .limit(1);
    const [s] = await H.t.db
      .select()
      .from(stepRun)
      .where(eq(stepRun.runId, r?.id as string))
      .limit(1);
    if (!r || !s) throw new Error("no run");
    await dbModelCalls(H.db, { bodies: H.objects }).record(H.A.tenantId, {
      runId: r.id,
      stepRunId: s.id,
      agentVersionId: r.agentVersionId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokensIn: 120,
      tokensOut: 30,
      costUsd: "0.000101",
      durationMs: 812,
      stopReason: "end_turn",
      request: {
        messages: [{ role: "user", content: "Card 4111 1111 1111 1111 on the invoice" }],
        source: { type: "base64", data: "QUJD".repeat(10) },
      },
      answer: { content: [{ type: "text", text: "Paid by 4111111111111111" }] },
    });
    const list = await H.call(OPERATOR, "GET", `/api/ops/runs/${r.id}/model-calls`);
    expect(list.status).toBe(200);
    const [call] = j(list.json).modelCalls;
    expect(call).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokensIn: 120,
      tokensOut: 30,
      costUsd: "0.0002",
      durationMs: 812,
      stopReason: "end_turn",
    });
    // v0.13 W2-H: the run page names the models each step ran on; steps without calls list none.
    const detail = j((await H.call(OPERATOR, "GET", `/api/ops/runs/${r.id}`)).json);
    const byId = new Map(
      detail.steps.map((st: { id: string; models: string[] }) => [st.id, st.models]),
    );
    expect(byId.get(s.id)).toEqual(["claude-opus-5-5"]);
    for (const [id, models] of byId) if (id !== s.id) expect(models).toEqual([]);
    const one = await H.call(OPERATOR, "GET", `/api/ops/model-calls/${call.id}`);
    const text = JSON.stringify(j(one.json).body);
    expect(text).toContain("[card ending 1111]");
    expect(text).not.toContain("4111");
    expect(text).toContain("bytes not kept");
    expect([
      ...(await H.objects.list({ prefix: `tenants/${H.A.tenantId}/model-calls/` })).objects,
    ]).toHaveLength(1);
    // Never the portal's, and never another operator's client.
    expect((await H.call(admin("a"), "GET", `/api/ops/model-calls/${call.id}`)).status).toBe(403);
    expect((await H.call(user("a"), "GET", `/api/ops/runs/${r.id}/model-calls`)).status).toBe(403);
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/model-calls/${call.id}`)).status).toBe(
      404,
    );
    const portalRun = await H.call(admin("a"), "GET", `/api/runs/${r.id}`);
    expect(forbiddenKeys(portalRun.json)).toEqual([]);
    expect(JSON.stringify(portalRun.json)).not.toContain("claude-opus");
  });

  it("keeps saved views to the operator who saved them", async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/saved-views", {
      name: "Failed this week",
      filters: { statuses: ["failed"], since: "2026-11-01T00:00:00Z" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const view = j(made.json).view;
    expect(view).toMatchObject({ surface: "ops_runs", filters: { statuses: ["failed"] } });
    const dup = await H.call(OPERATOR, "POST", "/api/ops/saved-views", {
      name: "Failed this week",
      filters: {},
    });
    expect([dup.status, j(dup.json).error.code]).toEqual([409, "name_taken"]);
    // Another operator neither sees nor deletes it, and may use the same name for their own.
    const theirs = await H.call(OTHER_OPERATOR, "GET", "/api/ops/saved-views");
    expect(j(theirs.json).views).toEqual([]);
    const del = await H.call(OTHER_OPERATOR, "DELETE", `/api/ops/saved-views/${view.id}`);
    expect(del.status).toBe(404);
    const own = await H.call(OTHER_OPERATOR, "POST", "/api/ops/saved-views", {
      name: "Failed this week",
      filters: { statuses: ["cancelled"] },
    });
    expect(own.status).toBe(200);
    const mine = await H.call(OPERATOR, "GET", "/api/ops/saved-views");
    expect(j(mine.json).views.map((v: { id: string }) => v.id)).toEqual([view.id]);
    // A filter that isn't a RunFilter is refused; clients have no views.
    const bad = await H.call(OPERATOR, "POST", "/api/ops/saved-views", {
      name: "Bad",
      filters: { costOver: "lots" },
    });
    expect(bad.status).toBe(400);
    expect((await H.call(admin("a"), "GET", "/api/ops/saved-views")).status).toBe(403);
    const gone = await H.call(OPERATOR, "DELETE", `/api/ops/saved-views/${view.id}`);
    expect([gone.status, j(gone.json)]).toEqual([200, { deleted: true }]);
    expect(j((await H.call(OPERATOR, "GET", "/api/ops/saved-views")).json).views).toEqual([]);
  });
});
