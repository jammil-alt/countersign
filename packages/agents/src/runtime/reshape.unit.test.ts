// Reshape data (2026-11-11) in the runtime, with no database: the step's mapping runs through the
// skill's pure handler (logged as a tool call), with no model, and a field it can't fill fails the
// step naming the field.

import type { AgentBundle, processes } from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { RESHAPE_SKILL, RESHAPE_SKILL_DEF } from "../tools/reshape";
import type { RuntimeDeps } from "./context";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent } from "./run-agent";

const TENANT = "11111111-1111-4111-8111-111111111111";

function setUp(skills: AgentBundle["definition"]["skills"]) {
  const steps: { status: string; output?: unknown; summary?: unknown; error?: unknown }[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
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
        identity: { name: "Clerk", role: "bill clerk", mission: "Enter bills." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills,
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
    memoryNotes: async () => [],
    run: async () => ({ mode: "live", agentId: "a1" }),
  } as unknown as RuntimeStore;
  const log = {
    startStepRun: async () => `step-${steps.length + 1}`,
    finishStepRun: async (_t: string, _id: string, done: (typeof steps)[number]) => {
      steps.push(done);
    },
    addUsage: async () => undefined,
    startToolCall: async (_t: string, call: { tool: string; input: unknown }) => {
      toolCalls.push(call);
      return "tc";
    },
    finishToolCall: async () => undefined,
  } as unknown as RunLog;
  const tools = new ToolRegistry({ platform: PLATFORM_TOOLS });
  const model = new FakeModel([]);
  const deps: RuntimeDeps = {
    ports: { store, log, modelCalls: { record: async () => undefined } } as never,
    tools,
    catalog: new SkillCatalog([RESHAPE_SKILL_DEF], tools),
    transport: model,
    now: () => new Date("2026-11-11T12:00:00Z"),
  };
  return { deps, steps, toolCalls, model };
}

const MAPPING: processes.ReshapeMapping = {
  fields: [
    { name: "vendorName", schema: { type: "string" }, from: { input: "doc.header.vendorName" } },
    {
      name: "total",
      schema: { type: "string" },
      from: { formatMoney: { value: { input: "doc.total" } } },
    },
    {
      name: "dueDate",
      schema: { type: "string" },
      required: false,
      from: { input: "doc.header.dueDate" },
    },
    {
      name: "ageDays",
      schema: { type: "integer" },
      from: { daysBetween: { from: { input: "doc.header.invoiceDate" }, to: { today: true } } },
    },
  ],
};

const DOC = {
  header: { vendorName: "Cascade Lumber", invoiceDate: "2026-10-28", dueDate: null },
  total: "1691.6",
};

describe("Reshape data in a run", () => {
  it("runs the step's mapping through its pure handler, with no model", async () => {
    const { deps, steps, toolCalls, model } = setUp([{ skill: RESHAPE_SKILL, settings: {} }]);
    const result = await runAgent(deps, {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: RESHAPE_SKILL,
      input: { doc: DOC },
      reshape: MAPPING,
      runId: "r1",
      stepId: "shape",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { vendorName: "Cascade Lumber", total: "1691.60", ageDays: 14 },
      summary: "Reshaped into 3 fields",
      modelCalls: 0,
    });
    expect(result.status === "succeeded" && "dueDate" in (result.output as object)).toBe(false);
    expect(model.requests).toHaveLength(0);
    expect(toolCalls.map((c) => c.tool)).toEqual(["data.reshape"]);
    expect(steps.at(-1)?.status).toBe("succeeded");
  });

  it("fails naming the field it can't fill", async () => {
    const { deps } = setUp([{ skill: RESHAPE_SKILL, settings: {} }]);
    const result = await runAgent(deps, {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: RESHAPE_SKILL,
      input: { doc: { ...DOC, total: "a lot" } },
      reshape: MAPPING,
      runId: "r1",
      stepId: "shape",
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" && result.error).toMatch(
      /total: input\.doc\.total isn't an amount/,
    );
  });

  it("fails in plain words without a mapping", async () => {
    const { deps } = setUp([{ skill: RESHAPE_SKILL, settings: {} }]);
    const result = await runAgent(deps, {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: RESHAPE_SKILL,
      input: {},
      runId: "r1",
      stepId: "shape",
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "Reshape data has no mapping: map its fields in the builder",
    });
  });
});
