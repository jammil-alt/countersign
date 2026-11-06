// v0.13 W2-I: run oversight through the real ports and database as cs_worker (ARCHITECTURE §10.11;
// docs/plan.md §1.54, M31). A write step's corrected input is a new change: the gate decides it
// again under its own key and asks for approval again; a write that reached the client's tool is
// never retried; a test run oversees and writes nothing; `run.failed` carries the diagnosis.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, event, externalAction, inboxItem, oversightDecision } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** One write, from the trigger's input, with failures reviewed. */
function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Records clerk", role: "keeps records", mission: "keep records right" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Change records only when asked.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
      memory: { enabled: false },
      oversight: { review: "failures" },
    },
    workflows: [
      {
        slug: "fix-record",
        name: "Fix a record",
        workflow: {
          schemaVersion: 3,
          trigger: {
            id: "trg-manual",
            on: {
              type: "manual",
              input: {
                type: "object",
                properties: { id: { type: "string" }, amount: { type: "string" } },
              },
            },
          },
          steps: [
            {
              id: "update",
              name: "Update the record",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "{{trigger.id}}", amount: "{{trigger.amount}}" },
              approval: { required: "required" },
            },
          ],
        },
      },
    ],
  } satisfies AgentBundleInput);
}

const h = await createApiHarness();
afterAll(() => h?.close());

const decide = (input: Record<string, unknown>) =>
  new FakeModel([{ toolUse: { name: "finish", input } }]);

describe.skipIf(!h)("run oversight through the API's ports", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let versionId = "";
  const deps = (transport: FakeModel) => ({
    db: H.db,
    platform: H.platform,
    transport,
    instances: H.instances,
  });

  /** Approves, as the client admin, each item the run waits on. */
  const approving = (seen: string[]) => async (_name: string, type: string) => {
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
    const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    seen.push(item.id);
    const who = item.assigneeRole === "operator" ? OPERATOR : admin("a");
    const path =
      who === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`;
    const res = await H.call(who, "POST", path, { decision: "approve" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return H.instances.events.find((e) => e.event.type === type)?.event.payload;
  };

  const start = async (input: Record<string, unknown>): Promise<RunParams> => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
      input,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return H.instances.started.get(j(res.json).runId) as RunParams;
  };

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "overseen-clerk",
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
    versionId = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Activation (a passing test run first) is tested elsewhere: here the agent just runs.
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
  });

  it("decides a corrected write afresh: its own key, a new approval, written once", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const writes = H.backend.writes.length;
    // "12,00" is not an amount: the write is refused before anything is proposed.
    const params = await start({ id: "r1", amount: "12,00" });
    const model = decide({
      action: "retry_with",
      input: { id: "r1", amount: "12.00" },
      note: "The amount used a comma for the decimal point.",
      sources: [],
    });
    const approved: string[] = [];
    const step = new FakeWorkflowStep(approving(approved));
    expect(await executeRun(deps(model), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(actions.map((a) => [a.idempotencyKey, a.status, a.input])).toEqual([
      [`${params.runId}:update:o1:0`, "done", { id: "r1", amount: "12.00" }],
    ]);
    // The corrected change waited for a person's approval, as any write in suggest-only mode.
    expect(approved).toEqual([actions[0]?.inboxItemId]);
    expect(H.backend.writes.slice(writes).map((w) => w.idempotencyKey)).toEqual([
      `${params.runId}:update:o1:0`,
    ]);
  });

  it("never retries a write that reached the client's tool: it stops, with an operator item", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const writes = H.backend.writes.length;
    const params = await start({ id: "r1", amount: "13.00" });
    // The record is gone by the time the approved write is made: the call reaches the tool and fails.
    const step = new FakeWorkflowStep(async (name, type) => {
      H.backend.company(H.A.connectionId).delete("r1");
      return approving([])(name, type);
    });
    const model = decide({ action: "retry", note: "Try again.", sources: [] });
    const result = await executeRun(deps(model), params, cloudflareStepRunner(step));
    expect(result).toMatchObject({ status: "failed", nodeId: "update" });
    expect(result.diagnosis).toContain("reached the client's tool");
    expect(model.requests).toHaveLength(0);
    expect(H.backend.writes.length).toBe(writes);
    const [row] = await H.t.db
      .select()
      .from(oversightDecision)
      .where(eq(oversightDecision.runId, params.runId));
    expect(row).toMatchObject({ action: "stop", model: "none" });
    const items = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, params.runId), eq(inboxItem.subjectType, "oversight_stop")));
    expect(items).toEqual([expect.objectContaining({ kind: "review", assigneeRole: "operator" })]);
    // `run.failed` carries the agent's diagnosis for the supervisor (operator side only).
    const [failed] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "run.failed"), eq(event.subjectId, params.runId)));
    expect(failed?.payload).toMatchObject({ diagnosis: expect.stringContaining("reached") });
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
  });

  it("oversees a test run too, and the test run writes nothing", async () => {
    const writes = H.backend.writes.length;
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
      { workflow: "fix-record", payload: { id: "r1", amount: "14,00" } },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    const model = decide({
      action: "retry_with",
      input: { id: "r1", amount: "14.00" },
      note: "Comma for the decimal point.",
      sources: [],
    });
    expect(
      await executeRun(deps(model), params, cloudflareStepRunner(new FakeWorkflowStep())),
    ).toEqual({ status: "succeeded" });
    expect(H.backend.writes.length).toBe(writes);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(actions.map((a) => a.status)).toEqual(["proposed"]);
    const decisions = await H.t.db
      .select()
      .from(oversightDecision)
      .where(eq(oversightDecision.runId, params.runId));
    expect(decisions.map((d) => d.action)).toEqual(["retry_with"]);
  });

  it("fails the step as before when the agent's answer is not a valid decision", async () => {
    const params = await start({ id: "r1", amount: "15,00" });
    const model = decide({ action: "continue", note: "Looks fine.", sources: [] });
    const result = await executeRun(
      deps(model),
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "update" });
    expect(result).not.toHaveProperty("diagnosis");
    const rows = await H.t.db
      .select()
      .from(oversightDecision)
      .where(eq(oversightDecision.runId, params.runId));
    expect(rows).toEqual([]);
  });
});
