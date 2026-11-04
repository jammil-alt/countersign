// Template test runs on a chosen client's data and the activation check's test run (docs/plan.md
// §1.16): the template runs as its test copy in that client (bound to its connections, never
// written, hidden from its portal, never activated); only served clients can be chosen; a client
// agent test-runs on its own client only; the activation check answers the live version's latest
// test run so the agent page can poll it.

import { agent, externalAction, inboxItem, run, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("test runs on a chosen client", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let templateV1 = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  /** Approves, as the operator, whatever item the run waits on. */
  async function approveAsOperator(_name: string, type: string) {
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
    const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    const res = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
      decision: "approve",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return H.instances.events.find((e) => e.event.type === type)?.event.payload;
  }

  async function finish(runId: string) {
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    const step = new FakeWorkflowStep(approveAsOperator);
    return executeRun(deps(), params, cloudflareStepRunner(step));
  }

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    templateId = j(tpl.json).agent.id;
    templateV1 = j(tpl.json).version.id;
  });

  const testRun = (id: string, vid: string, body: Record<string, unknown>) =>
    H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${vid}/test-run`, {
      workflow: "fix-record",
      ...body,
    });

  it("runs a template as its test copy in the chosen client, bound to its connections", async () => {
    const res = await testRun(templateId, templateV1, { clientId: H.B.tenantId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { runId, agentId: copyId } = j(res.json);
    const [copy] = await H.t.db.select().from(agent).where(eq(agent.id, copyId));
    expect(copy).toMatchObject({
      tenantId: H.B.tenantId,
      kind: "client",
      templateId,
      testCopy: true,
      runStatus: "draft",
      // Bound to client B's testkit connection, so its steps read B's tool.
      bindings: { testkit: H.B.connectionId },
    });
    expect(H.instances.started.get(runId)).toMatchObject({
      tenantId: H.B.tenantId,
      agentId: copyId,
      mode: "test",
    });

    expect(await finish(runId)).toEqual({ status: "succeeded" });
    // Never written (invariant 8): the change is only proposed, with no inbox item for the client.
    expect(H.backend.writes).toHaveLength(0);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(actions.map((a) => [a.tenantId, a.status, a.inboxItemId])).toEqual([
      [H.B.tenantId, "proposed", null],
    ]);
    // Everything the run wrote is client B's (invariant 1).
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps.map((s) => s.tenantId))).toEqual(new Set([H.B.tenantId]));
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
    expect(items.map((i) => [i.tenantId, i.assigneeRole])).toEqual([[H.B.tenantId, "operator"]]);

    // Hidden from client B's portal, and from client A entirely.
    expect((await H.call(admin("b"), "GET", `/api/runs/${runId}`)).status).toBe(404);
    expect(j((await H.call(admin("b"), "GET", "/api/runs")).json).runs).toEqual([]);
    expect(j((await H.call(admin("b"), "GET", "/api/inbox?status=resolved")).json).items).toEqual(
      [],
    );
    const inA = await H.t.db.select().from(run).where(eq(run.tenantId, H.A.tenantId));
    expect(inA).toEqual([]);

    // The copy only test-runs.
    const activate = await H.call(OPERATOR, "POST", `/api/ops/agents/${copyId}/activate`);
    expect(activate.status).toBe(409);

    // Again on the same client: the same copy and version.
    const again = await testRun(templateId, templateV1, { clientId: H.B.tenantId });
    expect(j(again.json)).toMatchObject({ agentId: copyId, versionId: j(res.json).versionId });
    const copies = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.templateId, templateId), eq(agent.testCopy, true)));
    expect(copies).toHaveLength(1);
  });

  it("chooses only a client the operator serves", async () => {
    const started = H.instances.started.size;
    const notServed = await testRun(templateId, templateV1, { clientId: H.C.tenantId });
    expect(notServed.status).toBe(404);
    const other = await H.call(
      OTHER_OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${templateV1}/test-run`,
      { workflow: "fix-record", clientId: H.A.tenantId },
    );
    expect(other.status).toBe(404);
    expect(H.instances.started.size).toBe(started);
  });

  it("test-runs a client agent on its own client only, and the activation check follows it", async () => {
    await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions/${templateV1}/publish`);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
    });
    const agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);

    const elsewhere = await testRun(agentId, v1, { clientId: H.B.tenantId });
    expect(elsewhere.status).toBe(422);

    const activation = () => H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/activation`);
    const before = j((await activation()).json);
    expect(before.testRun).toBeNull();
    expect(before.problems).toContain("v1 has no passing test run on this client");

    const res = await testRun(agentId, v1, { clientId: H.A.tenantId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { runId } = j(res.json);
    // Going: the page sees the run and keeps checking.
    const going = j((await activation()).json);
    expect(going.testRun.id).toBe(runId);
    expect(["queued", "running"]).toContain(going.testRun.status);
    expect(going.ready).toBe(false);

    expect(await finish(runId)).toEqual({ status: "succeeded" });
    const after = j((await activation()).json);
    expect(after.testRun).toMatchObject({ id: runId, status: "succeeded" });
    expect(after.problems).toEqual([]);
    expect(after.ready).toBe(true);
  });

  it("answers no test run for a template", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/activation`);
    expect(j(res.json).testRun).toBeNull();
  });
});
