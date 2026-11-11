// R6 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14): the owner reviews v4 steps through v0.13's
// `overseeStep`, on the fake model, without a database. The DB-backed review and its record are
// tested in src/log/oversight.test.ts, unchanged.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  ActionStep,
  type AnomalySignal,
  OversightSettings,
  type OwnerWatchedStep,
  processes,
} from "@countersign/core";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import type { RuntimeDeps } from "./context";
import {
  CHECKPOINT_PREAMBLE,
  type DecisionRecord,
  OVERSIGHT_PREAMBLE,
  type OverseeRequest,
  type OversightStore,
  overseeStep,
  ownerHistory,
  WATCH_PREAMBLE,
} from "./oversee";

const NOW = new Date("2026-11-10T12:00:00Z");

const tools = new ToolRegistry({
  platform: PLATFORM_TOOLS,
  connectors: new ConnectorRegistry([createTestkitConnector()]),
  packs: [],
});

const v4 = processes.Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    { id: "find", kind: "read", name: "Find it", tool: TESTKIT_QUERY_TOOL, input: { q: "x" } },
    {
      id: "fix",
      kind: "write",
      name: "Fix the amount",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "{{trigger.id}}", amount: "1.00" },
      checks: {
        approval: { approvers: [{ who: "lead", deadline: { after: "2 hours" } }] },
      },
    },
    {
      id: "talk",
      kind: "conversation",
      name: "Ask the vendor",
      with: "{{trigger.vendor}}",
      channel: "email",
      goal: "Get the price",
      deadline: { after: "1 day" },
    },
  ],
}).steps as OwnerWatchedStep[];
const [find, fix, talk] = v4 as [OwnerWatchedStep, OwnerWatchedStep, OwnerWatchedStep];

function deps(model: FakeModel): RuntimeDeps {
  const definition = {
    identity: { name: "Tester", role: "checks records", mission: "Keep records right." },
    model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
    instructions: "Check records carefully.",
  };
  return {
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
    now: () => NOW,
    ports: {
      store: {
        loadAgentVersion: async () => ({ bundle: { definition } }),
        resolveCustomSkill: async () => null,
      },
      log: { addUsage: async () => {} },
    },
  } as unknown as RuntimeDeps;
}

function store(actions: { id: string; status: string; error: unknown }[] = []) {
  const records: DecisionRecord[] = [];
  const s: OversightStore = {
    existing: async () => null,
    runTotals: async () => ({ count: 0, costUsd: "0" }),
    stepActions: async () => actions,
    context: async () => ({ earlier: [], history: [] }),
    record: async (_t, d) => {
      records.push(d);
      return {
        id: `dec-${records.length}`,
        action: d.action,
        note: d.note,
        inputAfter: d.inputAfter,
        inboxItemId: d.ask ? "item-1" : null,
      };
    },
  };
  return { s, records };
}

function request(step: OwnerWatchedStep, over: Partial<OverseeRequest> = {}): OverseeRequest {
  return {
    tenantId: "t1",
    runId: "r1",
    agentId: "a1",
    agentVersionId: "v1",
    workflowSlug: "wf",
    mode: "live",
    step,
    nodeId: step.id,
    stepRunId: "sr1",
    seq: 1,
    cause: "failed",
    input: { id: "rec-1 ", amount: "1.00" },
    error: "record rec-1  not found",
    errorKey: `${TESTKIT_UPDATE_TOOL}:not_found`,
    attempts: 1,
    settings: OversightSettings.parse({ review: "failures" }),
    ...over,
  };
}

const finish = (input: Record<string, unknown>) => ({ toolUse: { name: "finish", input } });

function finishEnum(req: LlmRequest | undefined): unknown {
  const tool = req?.tools?.find((t) => "name" in t && t.name === "finish") as
    | { input_schema: { properties: { action: { enum: string[] } } } }
    | undefined;
  return tool?.input_schema.properties.action.enum;
}

function readStep(req: LlmRequest | undefined): Record<string, unknown> {
  const msg = req?.messages[2];
  const block = Array.isArray(msg?.content) ? msg.content[0] : undefined;
  const text = block && "content" in block ? block.content : "{}";
  return JSON.parse(typeof text === "string" ? text : "{}");
}

describe("the owner reviews v4 steps", () => {
  it("corrects a v4 write's input, checked against its tool's schema", async () => {
    const model = new FakeModel([
      finish({
        action: "retry_with",
        input: { id: "rec-1", amount: "1.00" },
        note: "A trailing space in the id.",
        sources: [],
      }),
    ]);
    const { s, records } = store();
    const verdict = await overseeStep(deps(model), s, request(fix));
    expect(verdict).toEqual({
      action: "retry_with",
      input: { id: "rec-1", amount: "1.00" },
      note: "A trailing space in the id.",
    });
    const sent = model.requests[0];
    expect(String(sent?.system)).toContain(OVERSIGHT_PREAMBLE);
    expect(String(sent?.system)).toContain(`calls the tool ${TESTKIT_UPDATE_TOOL}`);
    expect(finishEnum(sent)).toEqual(["retry", "retry_with", "ask", "stop"]);
    expect(records[0]).toMatchObject({
      action: "retry_with",
      inputAfter: { id: "rec-1", amount: "1.00" },
    });
  });

  it("stops a v4 write whose change reached the client's tool, without asking the model", async () => {
    const model = new FakeModel([]);
    const { s, records } = store([{ id: "ea-1", status: "done", error: null }]);
    const verdict = await overseeStep(deps(model), s, request(fix));
    expect(verdict).toMatchObject({ action: "stop" });
    expect(model.requests).toHaveLength(0);
    expect(records[0]).toMatchObject({ model: "none", sources: ["ea-1"] });
  });

  it("never offers a conversation a corrected input, and refuses one", async () => {
    const model = new FakeModel([
      finish({ action: "retry_with", input: {}, note: "Start over.", sources: [] }),
    ]);
    const { s, records } = store();
    const verdict = await overseeStep(
      deps(model),
      s,
      request(talk, { input: { with: "Acme", goal: "Get the price" } }),
    );
    expect(verdict.action).toBe("none");
    expect(finishEnum(model.requests[0])).toEqual(["retry", "ask", "stop"]);
    expect(String(model.requests[0]?.system)).toContain("holds a conversation by email");
    expect(records).toHaveLength(0);
  });

  it("asks a v4 step's first approver, on that approver's deadline", async () => {
    const model = new FakeModel([
      finish({ action: "ask", question: "Which record?", note: "Two match.", sources: [] }),
    ]);
    const { s, records } = store();
    const verdict = await overseeStep(deps(model), s, request(fix));
    expect(verdict).toEqual({ action: "ask", inboxItemId: "item-1", note: "Two match." });
    expect(records[0]?.ask).toMatchObject({
      approver: "lead",
      stepLabel: "Fix the amount",
      dueAt: new Date(NOW.getTime() + 2 * 3_600_000),
    });
  });

  it("reviews a watched result with the watch's words and its signals as data", async () => {
    const signals: AnomalySignal[] = [{ kind: "empty_output" }];
    const model = new FakeModel([
      finish({ action: "continue", note: "Nothing matched; that is the answer.", sources: [] }),
    ]);
    const { s } = store();
    const verdict = await overseeStep(
      deps(model),
      s,
      request(find, { cause: "checkpoint", error: "", errorKey: "", output: [], signals }),
    );
    expect(verdict.action).toBe("continue");
    const sent = model.requests[0];
    expect(String(sent?.system)).toContain(WATCH_PREAMBLE);
    expect(readStep(sent)).toMatchObject({ output: [], signals });
    expect(finishEnum(sent)).toEqual(["continue", "retry_with", "ask", "stop"]);
  });

  it("reviews a v3 checkpoint as v0.13 did: its words, no signals in the data", async () => {
    const step = ActionStep.parse({
      id: "upd",
      kind: "action",
      name: "Update it",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "{{trigger.id}}", amount: "1.00" },
    });
    const model = new FakeModel([finish({ action: "continue", note: "Right.", sources: [] })]);
    const { s } = store();
    await overseeStep(
      deps(model),
      s,
      request(step, { cause: "checkpoint", error: "", errorKey: "", output: { ok: true } }),
    );
    const sent = model.requests[0];
    expect(String(sent?.system)).toContain(CHECKPOINT_PREAMBLE);
    expect(String(sent?.system)).not.toContain(WATCH_PREAMBLE);
    expect(readStep(sent)).not.toHaveProperty("signals");
  });
});

describe("the watch's history", () => {
  it("is each step's earlier totals by step path, or nothing while the store can't read it", async () => {
    expect(await ownerHistory({}, "t1", { agentId: "a1", workflowSlug: "wf" })).toEqual({});
    const asked: unknown[] = [];
    const history = await ownerHistory(
      {
        recentOutputs: async (_t, input) => {
          asked.push(input);
          return [
            { nodeId: "each:3:put", output: { total: "10" } },
            { nodeId: "each:2:put", output: { total: "12" } },
            { nodeId: "find", output: { items: [] } },
          ];
        },
      },
      "t1",
      { agentId: "a1", workflowSlug: "wf" },
    );
    expect(history).toEqual({
      "each:put": [
        { amount: "10", currency: null },
        { amount: "12", currency: null },
      ],
    });
    expect(asked).toEqual([{ agentId: "a1", workflowSlug: "wf", limit: 500 }]);
  });
});
