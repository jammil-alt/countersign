// The step model (docs/step-model-plan.md §8): a Loop runs as the runtime's agent loop, with only
// its Get tools, at most its turns, and never a write; at the limit it stops or hands back.

import type { AgentBundle } from "@countersign/core";
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
        skills: [],
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

const LOOP: StepLoopInput = {
  goal: "Find why the line doesn't match",
  instructions: "Look before you answer.",
  reads: ["testkit.look", "testkit.write"],
  maxTurns: 2,
  atLimit: "stop",
  output: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
};

const call = (name: string, input: unknown): FakeTurn => ({ toolUse: { name, input } });
const run = (model: FakeModel, loop: StepLoopInput) =>
  runAgent(deps(model), {
    tenantId: TENANT,
    agentVersionId: "v1",
    input: { line: "Bolt 6mm" },
    runId: "r1",
    stepId: "s_loop",
    loop,
  });

describe("a Loop in a run", () => {
  it("offers only its Get tools, and finishes with its output", async () => {
    const model = new FakeModel([
      call("testkit__look", { line: "Bolt 6mm" }),
      call("finish", { why: "no SKU" }),
    ]);
    const result = await run(model, LOOP);
    expect(result).toMatchObject({ status: "succeeded", output: { why: "no SKU" } });
    const offered = (model.requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain("testkit__look");
    expect(offered).not.toContain("testkit__write");
    expect(JSON.stringify(model.requests[0]?.system)).toContain(
      "Your goal: Find why the line doesn't match",
    );
  });

  it("is refused a write it asks for anyway", async () => {
    const model = new FakeModel([
      call("testkit__write", { text: "x" }),
      call("finish", { why: "gave up writing" }),
    ]);
    const result = await run(model, LOOP);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(model.requests[1]?.messages)).toContain("refused");
  });

  it("stops at its most turns when told to stop", async () => {
    const model = new FakeModel([
      call("testkit__look", { line: "a" }),
      call("testkit__look", { line: "b" }),
      call("testkit__look", { line: "c" }),
    ]);
    const result = await run(model, LOOP);
    expect(result).toMatchObject({
      status: "failed",
      error: "the Loop reached its limit of 2 turns",
    });
    expect(model.requests).toHaveLength(2);
  });

  it("hands back what it has at the limit, offered only its finish", async () => {
    const model = new FakeModel([
      call("testkit__look", { line: "a" }),
      call("testkit__look", { line: "b" }),
      call("finish", { why: "still looking: probably a new item" }),
    ]);
    const result = await run(model, { ...LOOP, atLimit: "hand_back" });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { why: "still looking: probably a new item" },
    });
    expect(model.requests).toHaveLength(3);
    expect((model.requests[2]?.tools ?? []).map((t) => t.name)).toEqual(["finish"]);
  });
});
