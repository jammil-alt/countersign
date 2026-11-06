// v0.13 W2-I: run oversight through the real ports and database as cs_worker (ARCHITECTURE §10.11;
// docs/plan.md §1.54, M31). A write step's corrected input is a new change: the gate decides it
// again under its own key and asks for approval again; a write that reached the client's tool is
// never retried; a test run oversees and writes nothing; `run.failed` carries the diagnosis.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput, type SkillDefinition } from "@countersign/core";
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

// v0.13 M32: reading an invoice's total (a task skill on its own model), then a write from it.
const READ_INVOICE: SkillDefinition = {
  schemaVersion: 1,
  id: "test.read-invoice",
  name: "Read the invoice",
  description: "Reads an invoice's total from its text.",
  category: "test",
  mode: "task",
  model: { id: "claude-haiku-5-5", maxTokens: 512 },
  instructions: "Read the invoice's total. Follow the hint when there is one.",
  tools: [],
  input: {
    type: "object",
    properties: {
      note: { type: "string" },
      hint: { type: "string", title: "reading of the invoice" },
    },
    required: ["note"],
  },
  output: { type: "object", properties: { total: { type: "string" } }, required: ["total"] },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

/** Read the invoice, then write its total (the reading is a checkpoint: a write reads it). */
function billBundle(review: "checkpoints" | "failures"): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Bill clerk", role: "enters bills", mission: "bills match invoices" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Enter bills as the invoices say.",
      skills: [{ skill: READ_INVOICE.id, settings: {} }],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
      memory: { enabled: false },
      oversight: { review },
    },
    workflows: [
      {
        slug: "bill-invoice",
        name: "Bill an invoice",
        workflow: {
          schemaVersion: 3,
          trigger: {
            id: "trg-bill",
            on: {
              type: "manual",
              input: { type: "object", properties: { note: { type: "string" } } },
            },
          },
          steps: [
            {
              id: "read",
              name: "Read the invoice",
              kind: "skill",
              skill: READ_INVOICE.id,
              input: { note: "{{trigger.note}}" },
            },
            {
              id: "bill",
              name: "Create the bill",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "{{steps.read.output.total}}" },
              approval: { required: "required" },
            },
          ],
        },
      },
    ],
  } satisfies AgentBundleInput);
}

const h = await createApiHarness({ skills: [READ_INVOICE] });
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

  /** A template forked into client A, bound to its testkit connection, live and active. */
  async function install(slug: string, b: AgentBundle) {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", { slug, bundle: b });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: slug,
    });
    const id = j(fork.json).agent.id as string;
    const vid = j(fork.json).version.id as string;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${vid}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Activation (a passing test run first) is tested elsewhere: here the agent just runs.
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return { agentId: id, versionId: vid };
  }

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    ({ agentId, versionId } = await install("overseen-clerk", bundle()));
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

  // ── v0.13 M32: checkpoint reviews ─────────────────────────────────────────────────────────

  /** Starts `bill-invoice` of an agent and runs it, approving each write it proposes. */
  async function billRun(id: string, model: FakeModel) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, {
      workflow: "bill-invoice",
      input: { note: "Invoice 20418: subtotal 100.00, freight 12.50, total 112.50" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    const seen: string[] = [];
    const result = await executeRun(
      deps(model),
      params,
      cloudflareStepRunner(new FakeWorkflowStep(approving(seen))),
    );
    return { params, result, seen };
  }

  it("corrects a wrong total at the checkpoint before the bill is proposed: the approver sees it", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const writes = H.backend.writes.length;
    const { agentId: clerk } = await install("checking-clerk", billBundle("checkpoints"));
    const hint = "The total is the line after freight: 112.50, not the subtotal.";
    const model = new FakeModel([
      // The reading takes the subtotal…
      { toolUse: { name: "finish", input: { total: "100.00" } } },
      // …the agent checks it before the bill and reads again with a hint…
      {
        toolUse: {
          name: "finish",
          input: {
            action: "retry_with",
            input: { note: "Invoice 20418: subtotal 100.00, freight 12.50, total 112.50", hint },
            note: "The total read is the subtotal; the invoice's total includes freight.",
            sources: [],
          },
        },
      },
      { toolUse: { name: "finish", input: { total: "112.50" } } },
      // …and the corrected reading goes on.
      {
        toolUse: {
          name: "finish",
          input: { action: "continue", note: "Now 112.50.", sources: [] },
        },
      },
    ]);
    const { params, result, seen } = await billRun(clerk, model);
    expect(result).toEqual({ status: "succeeded" });
    expect(model.remaining).toBe(0);
    // One proposal, with the corrected total: what the approver signed.
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(actions.map((a) => [a.status, a.input])).toEqual([
      ["done", { id: "r1", amount: "112.50" }],
    ]);
    const [card] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, seen[0] as string));
    expect(card?.payload).toMatchObject({ input: { id: "r1", amount: "112.50" } });
    expect(H.backend.writes.slice(writes).map((w) => w.record.amount)).toEqual(["112.50"]);
    const decisions = await H.t.db
      .select()
      .from(oversightDecision)
      .where(eq(oversightDecision.runId, params.runId));
    expect(decisions.map((d) => [d.nodeId, d.seq, d.cause, d.action])).toEqual([
      ["read", 1, "checkpoint", "retry_with"],
      ["read", 2, "checkpoint", "continue"],
    ]);
    // The portal says what happened in the platform's words.
    const portal = j((await H.call(admin("a"), "GET", `/api/runs/${params.runId}`)).json);
    const read = portal.steps.find((s: { label: string }) => s.label === "Read the invoice");
    expect(read?.oversight).toEqual([
      "Corrected the reading of the invoice and tried again",
      "Checked and went on",
    ]);
    expect(JSON.stringify(portal)).not.toContain("subtotal; the invoice");
  });

  it("makes no oversight call on a clean run under `failures`", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const { agentId: clerk } = await install("failures-clerk", billBundle("failures"));
    const model = new FakeModel([{ toolUse: { name: "finish", input: { total: "112.50" } } }]);
    const { params, result } = await billRun(clerk, model);
    expect(result).toEqual({ status: "succeeded" });
    // The reading's call only.
    expect(model.requests).toHaveLength(1);
    const rows = await H.t.db
      .select()
      .from(oversightDecision)
      .where(eq(oversightDecision.runId, params.runId));
    expect(rows).toEqual([]);
  });
});
