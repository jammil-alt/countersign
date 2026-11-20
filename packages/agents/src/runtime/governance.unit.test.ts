// B6 (docs/builder-plan.md §8), in the runtime with no database: a model step's system prompt
// starts with the Mezonas guardrails, then the client's confirmed charter under its own heading,
// then the policies whose tags match what the step can do (ours before the client's); a task skill
// reads the guardrails only; a reach-out reads contacting people. Each model call records the ids
// and versions it read.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  type AgentBundle,
  CHARTER_HEADING,
  type ClientGovernance,
  MEZONAS_GUARDRAILS,
  POLICIES_HEADING,
  type SkillDefinition,
  type ToolSpec,
} from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import type { ModelCallInput } from "../log/model-calls";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import type { RuntimeDeps, StepContext } from "./context";
import { readGovernance, stepProfile } from "./governance";
import { composeReachMessage } from "./planned";
import type { PinnedAgent, RunLog, RuntimeStore } from "./ports";
import { runAgent } from "./run-agent";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "0193f000-0000-7000-8000-0000000000a1";
const STEP_RUN = "0193f000-0000-7000-8000-0000000000a2";
const CHARTER_ID = "0193f000-0000-7000-8000-0000000000c1";

const base: Omit<SkillDefinition, "id" | "name" | "mode" | "tools"> = {
  schemaVersion: 1,
  description: "",
  category: "purchasing",
  instructions: "Do the task.",
  input: { type: "object" },
  output: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const FIX: SkillDefinition = {
  ...base,
  id: "custom:fix-amount",
  name: "Fix an amount",
  mode: "agent",
  tools: [TESTKIT_UPDATE_TOOL],
};
const READ: SkillDefinition = {
  ...base,
  id: "custom:read-total",
  name: "Read the total",
  mode: "task",
  tools: [],
};

const CLIENT: ClientGovernance = {
  charter: {
    entryId: CHARTER_ID,
    version: 4,
    title: "Our charter",
    body: "Who we are\nA family lumber yard.",
  },
  policies: [
    {
      entryId: "0193f000-0000-7000-8000-0000000000d1",
      version: 2,
      title: "Big changes",
      body: "Amounts over $500 need the yard manager.",
      tags: ["money"],
    },
    {
      entryId: "0193f000-0000-7000-8000-0000000000d2",
      version: 1,
      title: "Calling customers",
      body: "Never call after 6pm.",
      tags: ["contacting-people"],
    },
  ],
};

function setUp() {
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
        identity: { name: "Clerk", role: "purchasing clerk", mission: "Keep bills right." },
        kind: "functional",
        model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
        instructions: "Work carefully.",
        skills: [
          { skill: FIX.id, settings: {} },
          { skill: READ.id, settings: {} },
        ],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "suggest_only" },
        budgets: { maxSteps: 5, maxCostUsd: "1" },
        memory: { enabled: false },
      },
      workflows: [],
    } as AgentBundle,
    bindings: {},
    approver: null,
    area: "purchasing",
  };
  let governanceReads = 0;
  const store = {
    loadAgentVersion: async () => pinned,
    resolveCustomSkill: async (_t: string, ref: string) => ({
      ref,
      definition: ref.startsWith(FIX.id) ? FIX : READ,
      source: "client",
      versionId: null,
      version: null,
    }),
    memoryNotes: async () => [],
    run: async () => ({ mode: "test", agentId: "a1" }),
    governance: async () => {
      governanceReads += 1;
      return CLIENT;
    },
  } as unknown as RuntimeStore;
  const log = {
    startStepRun: async () => STEP_RUN,
    finishStepRun: async () => undefined,
    addUsage: async () => undefined,
    startToolCall: async () => "tc",
    finishToolCall: async () => undefined,
  } as unknown as RunLog;
  const calls: ModelCallInput[] = [];
  const tools = new ToolRegistry({
    platform: PLATFORM_TOOLS,
    connectors: new ConnectorRegistry([createTestkitConnector()]),
  });
  const deps = (model: FakeModel): RuntimeDeps => ({
    ports: {
      store,
      log,
      modelCalls: { record: async (_t: string, c: ModelCallInput) => void calls.push(c) },
    } as never,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: model,
  });
  return { deps, calls, pinned, reads: () => governanceReads, tools };
}

const finish = { toolUse: { name: "finish", input: { done: true } } };

describe("governance in a model step", () => {
  it("a write step with amounts: guardrails, the charter, then ours and the client's money policies", async () => {
    const { deps, calls } = setUp();
    const model = new FakeModel([finish]);
    const result = await runAgent(deps(model), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: FIX.id,
      input: {},
      runId: RUN,
      stepId: "fix",
    });
    expect(result.status).toBe("succeeded");
    const system = String(model.requests[0]?.system);
    expect(system.startsWith(MEZONAS_GUARDRAILS.text)).toBe(true);
    const at = (s: string) => system.indexOf(s);
    expect(at(CHARTER_HEADING)).toBeGreaterThan(0);
    expect(at("A family lumber yard.")).toBeGreaterThan(at(CHARTER_HEADING));
    expect(at(POLICIES_HEADING)).toBeGreaterThan(at("A family lumber yard."));
    expect(at("### Writing into tools (Mezonas)")).toBeGreaterThan(at(POLICIES_HEADING));
    expect(at("### Money (Mezonas)")).toBeGreaterThan(at(POLICIES_HEADING));
    expect(at("### Big changes (the client's)")).toBeGreaterThan(at("### Money (Mezonas)"));
    // The agent's own words come after governance.
    expect(at("## Who you are")).toBeGreaterThan(at("### Big changes (the client's)"));
    // Not a message step.
    expect(system).not.toContain("Never call after 6pm.");
    expect(system).not.toContain("### Contacting people (Mezonas)");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.governance?.map((r) => r.id)).toEqual([
      MEZONAS_GUARDRAILS.id,
      CHARTER_ID,
      "mezonas.policy.security",
      "mezonas.policy.writing_into_tools",
      "mezonas.policy.money",
      "mezonas.policy.data_handling",
      "0193f000-0000-7000-8000-0000000000d1",
    ]);
    expect(calls[0]?.governance?.[1]).toEqual({
      tier: "charter",
      source: "client",
      id: CHARTER_ID,
      version: "4",
    });
  });

  it("the same step sends the same system prompt each time (cache-friendly)", async () => {
    const { deps } = setUp();
    const a = new FakeModel([finish]);
    const b = new FakeModel([finish]);
    const input = {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: FIX.id,
      input: {},
      runId: RUN,
      stepId: "fix",
    };
    await runAgent(deps(a), input);
    await runAgent(deps(b), input);
    expect(a.requests[0]?.system).toEqual(b.requests[0]?.system);
  });

  it("a task skill reads the guardrails only, and not the client's part", async () => {
    const { deps, calls, reads } = setUp();
    const model = new FakeModel([finish]);
    await runAgent(deps(model), {
      tenantId: TENANT,
      agentVersionId: "v1",
      skill: READ.id,
      input: {},
      runId: RUN,
      stepId: "read",
    });
    const system = String(model.requests[0]?.system);
    expect(system.startsWith(MEZONAS_GUARDRAILS.text)).toBe(true);
    expect(system).not.toContain(CHARTER_HEADING);
    expect(system).not.toContain(POLICIES_HEADING);
    expect(reads()).toBe(0);
    expect(calls[0]?.governance?.map((r) => r.tier)).toEqual(["guardrails"]);
  });

  it("a reach-out reads contacting people, ours and the client's", async () => {
    const { deps, calls, pinned } = setUp();
    const model = new FakeModel([{ toolUse: { name: "message", input: { text: "Hello" } } }]);
    const step = {
      tenantId: TENANT,
      runId: RUN,
      stepRunId: STEP_RUN,
      stepId: "reach",
      mode: "live",
      agent: pinned,
      externalIndex: { next: 0 },
    } as unknown as StepContext;
    await composeReachMessage(deps(model), step, {
      purpose: "Confirm Friday's delivery",
      data: {},
      language: "en",
      channel: "sms",
      contactName: "Pat",
      clientName: "Acme",
      maxChars: 320,
    });
    // callTool sends the system as text blocks; the first is ours.
    const blocks = model.requests[0]?.system as { text: string }[];
    const system = blocks[0]?.text ?? "";
    expect(system.startsWith(MEZONAS_GUARDRAILS.text)).toBe(true);
    expect(system).toContain("### Contacting people (Mezonas)");
    expect(system).toContain("### People and roles (Mezonas)");
    expect(system).toContain("Never call after 6pm.");
    expect(system).not.toContain("Amounts over $500");
    expect(calls[0]?.governance?.map((r) => r.id)).toContain("mezonas.policy.contacting_people");
  });
});

describe("a step's profile", () => {
  const spec = (s: Partial<ToolSpec>): ToolSpec =>
    ({
      id: "x.y",
      description: "",
      input: {},
      output: {},
      sideEffect: "none",
      verb: "read",
      source: "platform",
      ...s,
    }) as ToolSpec;
  const tools = (specs: Record<string, ToolSpec>) =>
    ({ get: (id: string) => (specs[id] ? { spec: specs[id] } : undefined) }) as never;

  it("reads writes, amounts, recipients, connections and areas from the tools", () => {
    const { pinned } = setUp();
    const p = stepProfile(
      {
        tools: tools({
          "a.write": spec({
            sideEffect: "external",
            verb: "update",
            connector: "qbo",
            amount: { path: "total" } as never,
          }),
          "a.send": spec({
            sideEffect: "external",
            verb: "create",
            connector: "twilio",
            recipient: { channel: "sms", path: "to" } as never,
          }),
          "a.read": spec({ area: "bookkeeping" }),
          "a.shared": spec({ area: "shared" }),
        }),
      },
      pinned,
      { tools: ["a.write", "a.send", "a.read", "a.shared", "missing"] },
    );
    expect(p).toEqual({
      writes: true,
      money: true,
      contacts: true,
      connected: true,
      areas: ["bookkeeping", "purchasing"],
    });
  });

  it("a step that only thinks reads its agent's area; the operator's area wins over the definition's", () => {
    const { pinned } = setUp();
    const p = stepProfile({ tools: tools({}) }, { ...pinned, area: "sales" }, { tools: [] });
    expect(p).toEqual({
      writes: false,
      money: false,
      contacts: false,
      connected: false,
      areas: ["sales"],
    });
  });

  it("a store with no governance reads the guardrails and our policies only", async () => {
    const g = await readGovernance({ ports: { store: {} } as never }, TENANT, {
      writes: true,
      money: false,
      contacts: false,
      connected: false,
      areas: [],
    });
    expect(g.read.every((r) => r.source === "mezonas")).toBe(true);
    expect(g.text).toContain("### Writing into tools (Mezonas)");
  });
});
