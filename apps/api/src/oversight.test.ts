// v0.13 W2-I: run oversight through the real ports and database as cs_worker (ARCHITECTURE §10.11;
// docs/plan.md §1.54, M31). A write step's corrected input is a new change: the gate decides it
// again under its own key and asks for approval again; a write that reached the client's tool is
// never retried; a test run oversees and writes nothing; `run.failed` carries the diagnosis.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput, type SkillDefinition } from "@countersign/core";
import {
  agent,
  areaOwner,
  areaOwnerVersion,
  type Db,
  event,
  externalAction,
  inboxItem,
  memoryNote,
  oversightDecision,
  run,
  withTenant,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { ensureAreaOwner } from "./owners/store";
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

  // v0.17 O3 (ARCHITECTURE §10.15): the process's area owner reviews it, on its own model.
  it("has the area owner review a Purchasing failure on its model, with its notes and memory", async () => {
    await H.t.db.update(agent).set({ area: "purchasing" }).where(eq(agent.id, agentId));
    const owner = await withTenant(H.t.db, H.A.tenantId, (tx) =>
      ensureAreaOwner(tx, H.A.tenantId, "purchasing"),
    );
    const [last] = await H.t.db
      .select({ version: areaOwnerVersion.version })
      .from(areaOwnerVersion)
      .where(eq(areaOwnerVersion.ownerId, owner.ownerId))
      .orderBy(desc(areaOwnerVersion.version))
      .limit(1);
    const [v] = await H.t.db
      .insert(areaOwnerVersion)
      .values({
        tenantId: H.A.tenantId,
        ownerId: owner.ownerId,
        version: (last?.version ?? 0) + 1,
        definition: { model: { id: "xai:grok-4.7", maxTokens: 2048 }, notes: "Amounts use a dot." },
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await H.t.db
      .update(areaOwner)
      .set({ liveVersionId: v.id })
      .where(eq(areaOwner.id, owner.ownerId));
    await H.t.db.insert(memoryNote).values({
      tenantId: H.A.tenantId,
      ownerId: owner.ownerId,
      note: "Oak boards cost about $10",
    });

    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const params = await start({ id: "r1", amount: "15,00" });
    const model = decide({
      action: "retry_with",
      input: { id: "r1", amount: "15.00" },
      note: "A comma for the decimal point again.",
      sources: [],
      remember: [{ note: "This client types amounts with a comma" }],
    });
    const step = new FakeWorkflowStep(approving([]));
    expect(await executeRun(deps(model), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });

    // Pinned on the run, reviewed on the owner's model, with its notes and its memory as data.
    const [pinned] = await H.t.db
      .select({ ownerVersionId: run.ownerVersionId })
      .from(run)
      .where(eq(run.id, params.runId));
    expect(pinned?.ownerVersionId).toBe(v.id);
    const review = model.requests[0];
    expect(review?.model).toBe("xai:grok-4.7");
    expect(JSON.stringify(review?.system)).toContain(`You are ${owner.name}, who owns purchasing`);
    expect(JSON.stringify(review?.system)).toContain("Amounts use a dot.");
    expect(JSON.stringify(review?.messages)).toContain("Oak boards cost about $10");
    expect(JSON.stringify(review?.tools)).toContain("remember");

    // What it chose to remember is its memory now; the portal says what it did, by name.
    const notes = await H.t.db
      .select({ note: memoryNote.note })
      .from(memoryNote)
      .where(eq(memoryNote.ownerId, owner.ownerId));
    expect(notes.map((n) => n.note).sort()).toEqual([
      "Oak boards cost about $10",
      "This client types amounts with a comma",
    ]);
    const portal = j((await H.call(admin("a"), "GET", `/api/runs/${params.runId}`)).json);
    expect(JSON.stringify(portal)).toContain(`${owner.name} corrected`);
    expect(JSON.stringify(portal)).not.toContain("Amounts use a dot");
    expect(JSON.stringify(portal)).not.toContain("grok");
    await H.t.db.update(agent).set({ area: null }).where(eq(agent.id, agentId));
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
    // v0.17: in the words of the area owner that watched the run, by name.
    const owner = await ownerNameOf(H.t.db, params.runId);
    expect(read?.oversight).toEqual([
      `${owner} corrected the reading of the invoice and tried again`,
      `${owner} checked and went on`,
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

/** v0.17: the name of the area owner that watched a run (its name now). */
async function ownerNameOf(db: Db, runId: string): Promise<string> {
  const [row] = await db.$client<{ name: string }[]>`
    select o.name from run r
    join area_owner_version v on v.id = r.owner_version_id
    join area_owner o on o.id = v.owner_id
    where r.id = ${runId}`;
  if (!row) throw new Error(`run ${runId} has no owner`);
  return row.name;
}
