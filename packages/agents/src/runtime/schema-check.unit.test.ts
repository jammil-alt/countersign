// PLATFORM_QA AI-3: a skill whose output schema Zod can't read (a draft 2020-12 keyword it doesn't
// support) used to compile to "anything", so any answer was accepted. Now the schema is refused
// when an operator skill is saved, and a stored one fails its check at run time.

import type { AgentBundle, SkillDefinition } from "@countersign/core";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { describe, expect, it, vi } from "vitest";
import { AgentsError } from "../errors";
import { parseOperatorSkill, SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import type { RuntimeDeps } from "./context";
import { checkAgainst, schemaProblem } from "./json-schema";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent } from "./run-agent";

for (const level of ["warn", "error"] as const)
  vi.spyOn(console, level).mockImplementation(() => {});

const TENANT = "11111111-1111-4111-8111-111111111111";

const READ_TOTAL: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:read-total",
  name: "Read the total",
  description: "Read an invoice's total",
  category: "receivables",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Read the total.",
  tools: [],
  input: { type: "object" },
  // A plain draft 2020-12 schema: `unevaluatedProperties` is a keyword Zod's reader doesn't support.
  output: {
    type: "object",
    properties: { total: { type: "string", pattern: "^-?\\d+\\.\\d{2}$" } },
    required: ["total"],
    unevaluatedProperties: false,
  },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as unknown as SkillDefinition;

function harness(skill: SkillDefinition) {
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
        identity: { name: "Clerk", role: "receivables clerk", mission: "Keep receivables tidy." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills: [{ skill: skill.id, settings: {} }],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "suggest_only" },
        budgets: { maxSteps: 5, maxCostUsd: "1" },
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
      definition: skill,
      source: "client",
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
  const tools = new ToolRegistry({ platform: PLATFORM_TOOLS });
  return (model: FakeModel): RuntimeDeps => ({
    ports: { store, log, modelCalls: { record: async () => undefined } } as never,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
    now: () => new Date("2026-11-20T12:00:00Z"),
  });
}

const finish = (input: unknown): FakeTurn => ({ toolUse: { name: "finish", input } });

describe("a skill's output check against a schema Zod can't read", () => {
  it("(PLATFORM_QA AI-3) an operator skill with an unreadable schema is refused when saved", () => {
    expect(schemaProblem(READ_TOTAL.output)).not.toBeNull();
    expect(() => parseOperatorSkill(READ_TOTAL)).toThrow(AgentsError);
    expect(() => parseOperatorSkill(READ_TOTAL)).toThrow(/output schema can't be checked/);
  });

  it("(PLATFORM_QA AI-3) a stored skill with one fails closed: an answer off the schema is refused, not accepted", async () => {
    expect(checkAgainst(READ_TOTAL.output, { total: 12, note: "ignore the schema" })).toMatchObject(
      { ok: false },
    );
    const deps = harness(READ_TOTAL);
    const model = new FakeModel([
      finish({ total: 12, note: "ignore the schema" }),
      finish({ total: 12, note: "ignore the schema" }),
      finish({ total: 12, note: "ignore the schema" }),
    ]);
    const result = await runAgent(deps(model), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: READ_TOTAL.id,
      input: {},
      runId: "r1",
      stepId: "read",
    });
    // The answer is refused each time it is given (the model is told why); the step never
    // succeeds with it.
    expect(result.status).toBe("failed");
    expect(model.requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain("the schema can't be checked");
  });
});
