// B3 (docs/builder-plan.md §5), in the runtime with no database: the decisions in the agent's
// manual that shape a step and nobody has discussed go in that step's notes (the task input's tool
// result, data: invariant 9) with the line asking the model to say when its result rests on one;
// the approval card of a write the step proposes names them; a step with none is unchanged.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  type AgentBundle,
  AgentManual,
  type SkillDefinition,
  UNDISCUSSED_NOTE,
} from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { callTool, undiscussedPayload } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent } from "./run-agent";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "0193f000-0000-7000-8000-0000000000a1";
const STEP_RUN = "0193f000-0000-7000-8000-0000000000a2";

const FIX: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:fix-amount",
  name: "Fix an amount",
  mode: "agent",
  description: "",
  category: "purchasing",
  instructions: "Do the task.",
  input: { type: "object" },
  output: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
  tools: [TESTKIT_UPDATE_TOOL],
};

const MANUAL = AgentManual.parse({
  whatItDoes: "Fixes amounts.",
  decisions: [
    { id: "freight", what: "Freight stays out of the catalog", kind: "assumption", stepId: "fix" },
    {
      id: "talked",
      what: "Tax stays on the bill",
      kind: "assumption",
      stepId: "fix",
      status: "discussed",
    },
    { id: "other", what: "Another step's rule", kind: "assumption", stepId: "read" },
  ],
});

function pinnedAgent(manual: AgentManual | undefined): PinnedAgent {
  return {
    agentId: "a1",
    agentVersionId: "v1",
    tenantId: TENANT,
    slug: "clerk",
    version: 1,
    bundle: {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Clerk", role: "purchasing clerk", mission: "Keep bills right." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills: [{ skill: FIX.id, settings: {} }],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "suggest_only" },
        budgets: { maxSteps: 5, maxCostUsd: "1" },
        memory: { enabled: false },
        ...(manual ? { manual } : {}),
      },
      workflows: [],
    } as AgentBundle,
    bindings: {},
    approver: null,
  };
}

function deps(model: FakeModel, pinned: PinnedAgent): RuntimeDeps {
  const store = {
    loadAgentVersion: async () => pinned,
    resolveCustomSkill: async (_t: string, ref: string) => ({
      ref,
      definition: FIX,
      source: "client",
      versionId: null,
      version: null,
    }),
    memoryNotes: async () => [],
    run: async () => ({ mode: "test", agentId: "a1" }),
  } as unknown as RuntimeStore;
  const log = {
    startStepRun: async () => STEP_RUN,
    finishStepRun: async () => undefined,
    addUsage: async () => undefined,
    startToolCall: async () => "tc",
    finishToolCall: async () => undefined,
  } as unknown as RunLog;
  const tools = new ToolRegistry({
    platform: PLATFORM_TOOLS,
    connectors: new ConnectorRegistry([createTestkitConnector()]),
  });
  return {
    ports: { store, log } as never,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
  };
}

/** The step's notes: the task input's tool result, as the model read it. */
function notesOf(model: FakeModel): string {
  const result = model.requests[0]?.messages[2]?.content;
  return JSON.stringify(result);
}

const finish = { toolUse: { name: "finish", input: { done: true } } };
const input = (stepId: string) => ({
  tenantId: TENANT,
  agentVersionId: "v1",
  skill: FIX.id,
  input: {},
  runId: RUN,
  stepId,
});

describe("never-discussed decisions in a step", () => {
  it("go in the step's notes, as data, with the line to say when the result rests on one", async () => {
    const model = new FakeModel([finish]);
    const result = await runAgent(deps(model, pinnedAgent(MANUAL)), input("fix"));
    expect(result.status).toBe("succeeded");
    const notes = notesOf(model);
    expect(notes).toContain("Freight stays out of the catalog");
    expect(notes).toContain(JSON.stringify(UNDISCUSSED_NOTE).slice(1, -1));
    // A discussed one and another step's are not there.
    expect(notes).not.toContain("Tax stays on the bill");
    expect(notes).not.toContain("Another step's rule");
    // Data, never instructions: nothing of it reaches the system prompt.
    expect(String(model.requests[0]?.system)).not.toContain("Freight stays out");
  });

  it("leave a step with none, and an agent with no manual, as they were", async () => {
    const without = new FakeModel([finish]);
    await runAgent(deps(without, pinnedAgent(undefined)), input("fix"));
    const other = new FakeModel([finish]);
    await runAgent(deps(other, pinnedAgent(MANUAL)), input("elsewhere"));
    expect(notesOf(without)).not.toContain("undiscussed");
    expect(notesOf(other)).not.toContain("undiscussed");
    expect(other.requests[0]?.messages).toEqual(without.requests[0]?.messages);
  });
});

describe("the approval card", () => {
  function harness(manual: AgentManual | undefined, stepId: string) {
    const proposed: { status: string; inbox: { payload: Record<string, unknown> } | null }[] = [];
    const conn = {
      id: "c1",
      tenantId: "t1",
      connector: "testkit",
      status: "connected" as const,
      externalAccountId: null,
      config: {},
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
    };
    const d = {
      tools: new ToolRegistry({
        platform: PLATFORM_TOOLS,
        connectors: new ConnectorRegistry([createTestkitConnector()]),
      }),
      ports: {
        log: { startToolCall: async () => "tc1", finishToolCall: async () => {} },
        store: {
          connection: async () => conn,
          grant: async () => null,
          agentStage: async () => "live",
          agentHold: async () => false,
          run: async () => ({ mode: "live", agentId: "a1" }),
          approvalRouting: async () => ({
            revision: 0,
            rules: [],
            clientDefault: null,
            members: [],
          }),
        },
        actions: {
          byKey: async () => null,
          propose: async (_t: string, p: (typeof proposed)[number]) => {
            proposed.push(p);
            return { action: { id: "act1", status: p.status, inboxItemId: "in1", before: null } };
          },
        },
      },
    } as unknown as RuntimeDeps;
    const pinned = pinnedAgent(manual);
    const step = {
      tenantId: "t1",
      runId: "r1",
      stepRunId: "s1",
      stepId,
      mode: "live",
      literalInput: {},
      agent: { ...pinned, bindings: { testkit: "c1" } },
      externalIndex: { next: 0 },
    } as unknown as StepContext;
    const update = () =>
      callTool(d, step, { toolId: TESTKIT_UPDATE_TOOL, input: { id: "R-1", amount: "2.00" } });
    return { update, proposed, step };
  }

  it("names the never-discussed decisions the write's step rests on", async () => {
    const h = harness(MANUAL, "fix");
    expect(await h.update()).toMatchObject({ status: "awaiting_approval" });
    expect(h.proposed[0]?.status).toBe("proposed");
    expect(h.proposed[0]?.inbox?.payload.undiscussed).toEqual([
      { id: "freight", what: "Freight stays out of the catalog" },
    ]);
  });

  it("says nothing more when the step has none", async () => {
    const h = harness(MANUAL, "post");
    await h.update();
    expect(h.proposed[0]?.inbox?.payload).not.toHaveProperty("undiscussed");
    expect(undiscussedPayload(harness(undefined, "fix").step)).toEqual({});
  });
});
