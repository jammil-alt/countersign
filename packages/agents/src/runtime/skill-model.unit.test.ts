// Skill model (2026-11-10), in the runtime with no database: a deterministic rule skill runs its
// rule rows (no tool, no model) with the agent's parameters and the run's day; an AI skill runs
// on the model most specific to it (step, then the agent's setting for the skill, then the
// skill's recommended) and reads its parameters as the operator's settings.

import type { AgentBundle, SkillDefinition } from "@countersign/core";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import type { RuntimeDeps } from "./context";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent } from "./run-agent";

const TENANT = "11111111-1111-4111-8111-111111111111";

const AGING = [
  { from: 0, to: 15, label: "Current" },
  { from: 16, to: 30, label: "Due" },
  { from: 31, label: "Past due" },
];

const AGE: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:age-receivable",
  name: "Age a receivable",
  description: "Days overdue, in the agent's buckets",
  category: "receivables",
  mode: "tool",
  method: "rules",
  tools: [],
  input: {
    type: "object",
    properties: { dueDate: { type: "string" }, amount: { type: "string" } },
    required: ["dueDate", "amount"],
  },
  output: {
    type: "object",
    properties: {
      daysOverdue: { type: "integer" },
      bucket: { type: "string" },
      amount: { type: "string" },
    },
    required: ["daysOverdue", "bucket", "amount"],
  },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
  parameters: [{ name: "aging", label: "Aging buckets", type: "buckets", default: AGING }],
  rules: [
    {
      id: "not_due",
      name: "Not due yet",
      conditions: [{ left: { input: "dueDate" }, op: ">", right: { today: true } }],
      set: { bucket: "Not due", daysOverdue: 0 },
      compute: { amount: { input: "amount" } },
    },
    {
      id: "aged",
      name: "Aged",
      compute: {
        daysOverdue: { daysBetween: { from: { input: "dueDate" }, to: { today: true } } },
        bucket: {
          bucket: {
            value: { daysBetween: { from: { input: "dueDate" }, to: { today: true } } },
            by: "aging",
          },
        },
        amount: { input: "amount" },
      },
    },
  ],
};

const READ: SkillDefinition = {
  ...AGE,
  id: "custom:read-total",
  name: "Read the total",
  mode: "task",
  method: undefined,
  model: { id: "claude-haiku-4-5" },
  instructions: "Read the total.",
  input: { type: "object" },
  output: { type: "object", properties: { total: { type: "string" } }, required: ["total"] },
  parameters: [{ name: "currency", label: "Currency", type: "text" }],
  rules: undefined,
};

function setUp(agentSkills: AgentBundle["definition"]["skills"]) {
  const steps: { status: string; output?: unknown; summary?: unknown; error?: unknown }[] = [];
  const pinned: PinnedAgent = {
    agentId: "a1",
    agentVersionId: "v1",
    tenantId: TENANT,
    slug: "clerk",
    version: 1,
    bundle: {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Clerk", role: "receivables clerk", mission: "Keep receivables tidy." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills: agentSkills,
        extraTools: [],
        canCommand: [],
        permissions: { mode: "suggest_only" },
        budgets: { maxSteps: 5, maxCostUsd: "1" },
        memory: { enabled: false },
      },
      workflows: [],
    },
    bindings: {},
    approver: null,
  };
  const store = {
    loadAgentVersion: async () => pinned,
    resolveCustomSkill: async (_t: string, ref: string) => ({
      ref,
      definition: ref.startsWith(AGE.id) ? AGE : READ,
      source: "client",
      versionId: null,
      version: null,
    }),
    memoryNotes: async () => [],
    run: async () => ({ mode: "live", agentId: "a1" }),
  } as unknown as RuntimeStore;
  const log = {
    startStepRun: async () => `step-${steps.length + 1}`,
    finishStepRun: async (_t: string, _id: string, done: (typeof steps)[number]) => {
      steps.push(done);
    },
    addUsage: async () => undefined,
    startToolCall: async () => "tc",
    finishToolCall: async () => undefined,
  } as unknown as RunLog;
  const tools = new ToolRegistry({ platform: PLATFORM_TOOLS });
  const deps = (model: FakeModel, now: Date): RuntimeDeps => ({
    ports: { store, log, modelCalls: { record: async () => undefined } } as never,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
    now: () => now,
  });
  return { deps, steps };
}

const finish = (input: unknown): FakeTurn => ({ toolUse: { name: "finish", input } });

describe("a deterministic rule skill in a run", () => {
  it("runs its rows with the agent's buckets as of the run's day, with no model", async () => {
    const { deps, steps } = setUp([
      {
        skill: AGE.id,
        settings: {},
        parameters: {
          aging: [
            { from: 0, to: 30, label: "Fine" },
            { from: 31, label: "Late" },
          ],
        },
      },
    ]);
    const model = new FakeModel([]);
    const result = await runAgent(deps(model, new Date("2026-11-10T12:00:00Z")), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: AGE.id,
      input: { dueDate: "2026-10-01", amount: "1250.00" },
      runId: "r1",
      stepId: "age",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { daysOverdue: 40, bucket: "Late", amount: "1250.00" },
      summary: "Rule: Aged",
      modelCalls: 0,
    });
    expect(model.requests).toHaveLength(0);
    expect(steps.at(-1)?.status).toBe("succeeded");
  });

  it("takes a step's own parameters over the agent's, and its rule rows too", async () => {
    const { deps } = setUp([{ skill: AGE.id, settings: {} }]);
    const result = await runAgent(deps(new FakeModel([]), new Date("2026-11-10T12:00:00Z")), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: AGE.id,
      input: { dueDate: "2026-11-01", amount: "10.00" },
      runId: "r1",
      stepId: "age",
      customize: {
        parameters: { aging: [{ from: 0, label: "Any" }] },
        rules: { edit: [{ id: "aged", name: "Aged, one bucket" }] },
      },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { daysOverdue: 9, bucket: "Any" },
      summary: "Rule: Aged, one bucket",
    });
  });

  it("fails in plain words when the input matches no row", async () => {
    const { deps } = setUp([{ skill: AGE.id, settings: {} }]);
    const result = await runAgent(deps(new FakeModel([]), new Date("2026-11-10T12:00:00Z")), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: AGE.id,
      input: { dueDate: "not a date", amount: "10.00" },
      runId: "r1",
      stepId: "age",
    });
    // A row's calculation gives null for a bad date: the output no longer fits its schema.
    expect(result).toMatchObject({ status: "failed" });
  });
});

describe("an AI skill in a run", () => {
  const run = async (
    skills: AgentBundle["definition"]["skills"],
    step?: { id: string },
  ): Promise<FakeModel> => {
    const { deps } = setUp(skills);
    const model = new FakeModel([finish({ total: "12.00" })]);
    const result = await runAgent(deps(model, new Date("2026-11-10T12:00:00Z")), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: READ.id,
      input: {},
      runId: "r1",
      stepId: "read",
      ...(step ? { model: step } : {}),
    });
    expect(result.status).toBe("succeeded");
    return model;
  };

  it("runs on the step's model, else the agent's for the skill, else the skill's recommended", async () => {
    const params = { currency: "USD" };
    expect(
      (await run([{ skill: READ.id, settings: {}, parameters: params }])).requests[0]?.model,
    ).toBe("claude-haiku-4-5");
    const agentSet = [
      { skill: READ.id, settings: {}, parameters: params, model: { id: "claude-sonnet-5-5" } },
    ];
    expect((await run(agentSet)).requests[0]?.model).toBe("claude-sonnet-5-5");
    expect((await run(agentSet, { id: "claude-opus-5-5" })).requests[0]?.model).toBe(
      "claude-opus-5-5",
    );
  });

  it("reads its parameters as the operator's settings, and refuses to run without a required one", async () => {
    const model = await run([{ skill: READ.id, settings: {}, parameters: { currency: "EUR" } }]);
    expect(String(model.requests[0]?.system)).toContain('"currency": "EUR"');
    const { deps } = setUp([{ skill: READ.id, settings: {} }]);
    const result = await runAgent(deps(new FakeModel([]), new Date()), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: READ.id,
      input: {},
      runId: "r1",
      stepId: "read",
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" && result.error).toMatch(/set Currency/);
  });
});
