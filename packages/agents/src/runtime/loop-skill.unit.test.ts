// Step model §8: a saved Loop skill is the ceiling on what its step may read and how long it runs,
// and a Loop skill never runs outside a Loop step.

import type { AgentBundle, SkillDefinition } from "@countersign/core";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { defineInternalTool } from "../tools/types";
import type { RuntimeDeps } from "./context";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent, type StepLoopInput } from "./run-agent";

const TENANT = "11111111-1111-4111-8111-111111111111";

const lookUp = defineInternalTool({
  id: "testkit.look",
  description: "Look a line up",
  sideEffect: "none",
  verb: "read",
  input: z.object({ line: z.string() }),
  output: z.object({ found: z.boolean() }),
  async run() {
    return { found: false };
  },
});
const writeDown = defineInternalTool({
  id: "testkit.write",
  description: "Write a note down",
  sideEffect: "internal",
  verb: "create",
  input: z.object({ text: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async run() {
    throw new Error("a Loop must never reach a write");
  },
});

function deps(model: FakeModel): RuntimeDeps {
  const pinned = {
    agentId: "a1",
    agentVersionId: "v1",
    tenantId: TENANT,
    slug: "clerk",
    version: 1,
    bundle: {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Clerk", role: "clerk", mission: "Keep things tidy." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills: [{ skill: "custom:look-up", settings: {} }],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "act" },
        budgets: { maxSteps: 10, maxCostUsd: "1" },
        memory: { enabled: false },
      },
      workflows: [],
    } as unknown as AgentBundle,
    bindings: {},
    approver: null,
  } as PinnedAgent;
  const store = {
    loadAgentVersion: async () => pinned,
    resolveCustomSkill: async (_t: string, ref: string) => ({
      ref,
      definition: LOOP_SKILL,
      source: "shared",
      versionId: null,
      version: null,
    }),
    memoryNotes: async () => [],
    run: async () => ({ mode: "live", agentId: "a1" }),
  } as unknown as RuntimeStore;
  const log = {
    startStepRun: async () => "step-1",
    finishStepRun: async () => undefined,
    addUsage: async () => undefined,
    startToolCall: async () => "tc",
    finishToolCall: async () => undefined,
  } as unknown as RunLog;
  const tools = new ToolRegistry({ platform: [...PLATFORM_TOOLS, lookUp, writeDown] });
  return {
    ports: { store, log, modelCalls: { record: async () => undefined } } as never,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
    now: () => new Date("2026-11-25T12:00:00Z"),
  };
}

const LOOP_SKILL = {
  schemaVersion: 1,
  id: "custom:look-up",
  name: "Look up",
  description: "",
  category: "test",
  mode: "agent",
  instructions: "Look before you answer.",
  tools: [],
  // The write is listed to prove the ceiling: it is neither offered nor callable.
  reads: ["testkit.look", "testkit.write"],
  loop: { goal: "Find why", maxTurns: 2, atLimit: "stop" },
  input: { type: "object" },
  output: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as unknown as SkillDefinition;

const call = (name: string, input: unknown): FakeTurn => ({ toolUse: { name, input } });
const STEP: StepLoopInput = {
  goal: "Find why",
  instructions: "",
  // The step asks for more than the skill allows: a read the skill doesn't list, and 9 turns.
  reads: ["testkit.look", "testkit.write", "memory.write"],
  maxTurns: 9,
  atLimit: "stop",
};
const run = (model: FakeModel, loop: StepLoopInput | undefined) =>
  runAgent(deps(model), {
    tenantId: TENANT,
    agentVersionId: "v1",
    skill: "custom:look-up",
    input: { line: "Bolt 6mm" },
    runId: "r1",
    stepId: "s_loop",
    ...(loop ? { loop } : {}),
  });

describe("a saved Loop skill in a run", () => {
  it("caps the step's reads and turns at the skill's own, and never offers a write", async () => {
    const model = new FakeModel([
      call("testkit__look", { line: "a" }),
      call("testkit__look", { line: "b" }),
      call("testkit__look", { line: "c" }),
    ]);
    const result = await run(model, STEP);
    expect(result).toMatchObject({
      status: "failed",
      error: "the Loop reached its limit of 2 turns",
    });
    const offered = (model.requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain("testkit__look");
    expect(offered).not.toContain("testkit__write");
    expect(offered).not.toContain("memory__write");
  });

  it("runs only in a Loop step", async () => {
    const result = await run(new FakeModel([]), undefined);
    expect(result).toMatchObject({
      status: "failed",
      error: "custom:look-up is a Loop skill: it runs in a Loop step",
    });
  });
});
