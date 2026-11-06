// v0.12 W2-C: one skill test case (ARCHITECTURE §9.10, docs/plan.md §1.46). The skill's definition
// at the version under test runs through `runAgent`, as a run's step would, but every port is in
// memory and every tool answers from the case's fixtures:
// - read tools answer with the first fixture for that tool whose input matches; a call no fixture
//   answers is refused;
// - every write (internal or to a client's tool) is refused, whatever the fixtures say;
// - no connector, connection, credential, database or inbox is reached: nothing is written
//   anywhere, so a case "never touches a client's tools" (invariant 8: test runs never write).
// Model calls go to `transport`: live in the Worker, replayed or faked in tests. Cost and tokens are
// counted here and never reach a client's usage.

import {
  type AgentBundle,
  type Fixture,
  fixtureFor,
  type SkillDefinition,
  type ToolSpec,
} from "@countersign/core";
import { DEFAULT_MODELS, type LlmTransport } from "@countersign/llm";
import { z } from "zod";
import { SkillCatalog } from "../registry/skills";
import { type RegisteredTool, ToolRegistry } from "../registry/tools";
import type { RuntimeDeps } from "../runtime/context";
import type {
  ExternalActionStore,
  PinnedAgent,
  RunLog,
  RuntimeStore,
  ToolCallStatus,
} from "../runtime/ports";
import { runAgent } from "../runtime/run-agent";
import type { InternalTool, PlatformStore } from "../tools/types";

/** A uuid that names no row: the bench's agent, version and run ids. */
const BENCH_ID = "00000000-0000-4000-8000-00000000be0c";

export const BENCH_REFUSED_WRITE = "the test bench refuses every write";

export class BenchNeverWritesError extends Error {
  override name = "BenchNeverWritesError";
  constructor(what: string) {
    super(`the test bench never writes (${what})`);
  }
}

export interface SkillCaseInput {
  /** The skill's definition at the version under test. */
  definition: SkillDefinition;
  /** The case's client, or null for a shared case. Only ever passed to in-memory ports. */
  tenantId: string | null;
  input: unknown;
  fixtures: readonly Fixture[];
}

export interface SkillCaseDeps {
  /** The platform's tool registry: specs only (handlers run only when pure). */
  tools: ToolRegistry;
  transport: LlmTransport;
  now?: () => Date;
  /** The bench agent's model for agent-mode skills; default the platform's reasoning model. */
  model?: { id: string; maxTokens?: number };
}

export interface BenchToolCall {
  tool: string;
  status: ToolCallStatus;
  /** Why it was refused or failed; null when it answered. */
  reason: string | null;
}

export interface SkillCaseRun {
  status: "succeeded" | "failed";
  /** The skill's output (what the case compares); null when it produced none. */
  output: unknown;
  error: string | null;
  costUsd: string;
  tokensIn: number;
  tokensOut: number;
  modelCalls: number;
  toolCalls: BenchToolCall[];
}

/** Every tool answers from the fixtures; a pure handler runs as itself. */
class FixtureToolRegistry extends ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly fixtures: readonly Fixture[],
  ) {
    super({});
  }

  override has(id: string): boolean {
    return this.base.has(id);
  }

  override get(id: string): RegisteredTool | undefined {
    const real = this.base.get(id);
    if (!real) return undefined;
    if (real.kind === "internal" && real.tool.pure === true) return real;
    return { kind: "internal", spec: real.spec, tool: fixtureTool(real.spec, this.fixtures) };
  }

  override list(): RegisteredTool[] {
    return this.base.list().flatMap((t) => this.get(t.spec.id) ?? []);
  }

  override specs(): Record<string, ToolSpec> {
    return this.base.specs();
  }
}

function fixtureTool(spec: ToolSpec, fixtures: readonly Fixture[]): InternalTool {
  return {
    spec,
    input: z.unknown(),
    output: z.unknown(),
    async run(input) {
      // Writes never get here (the policy refuses them first); this is the second lock.
      if (spec.sideEffect !== "none") throw new BenchNeverWritesError(spec.id);
      const f = fixtureFor(fixtures, spec.id, input);
      if (!f) throw new Error(`refused: no fixture answers ${spec.id} with this input`);
      return f.output ?? null;
    },
  };
}

/** The bench's agent: neutral words, the platform's model, no memory, no bindings. */
function benchAgent(def: SkillDefinition, model: { id: string; maxTokens?: number }): AgentBundle {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: {
        name: "Test bench",
        role: "runs one skill on a saved example",
        mission: "Do the task as written, from the tool results you get.",
      },
      kind: "functional",
      model: { id: model.id, maxTokens: model.maxTokens ?? 4096 },
      instructions: "Do the task as written. Use only the tools you are given.",
      skills: [{ skill: def.id, settings: {} }],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 12, maxCostUsd: "0.50" },
      memory: { enabled: false },
    },
    workflows: [],
  };
}

const refuse = (what: string) => () => Promise.reject(new BenchNeverWritesError(what));

/** Runs one skill case. Never throws for the skill's own failures: they come back as `failed`. */
export async function runSkillCase(
  deps: SkillCaseDeps,
  input: SkillCaseInput,
): Promise<SkillCaseRun> {
  const def = input.definition;
  const tenantId = input.tenantId ?? BENCH_ID;
  const calls: BenchToolCall[] = [];
  const empty = (): SkillCaseRun => ({
    status: "failed",
    output: null,
    error: null,
    costUsd: "0.000000",
    tokensIn: 0,
    tokensOut: 0,
    modelCalls: 0,
    toolCalls: calls,
  });

  // DECISION: a tool-mode skill runs on the bench only when its handler is marked `pure` (reads
  // only its input); any other handler reads a client's data, so its case is an error, not a pass.
  if (def.mode === "tool") {
    const handler = def.handler ? deps.tools.get(def.handler) : undefined;
    if (handler?.kind !== "internal" || handler.tool.pure !== true) {
      return {
        ...empty(),
        error: `${def.id} runs ${def.handler ?? "no handler"}, which reads more than its input: tool skills run on the bench only with a pure handler`,
      };
    }
  }

  const pinned: PinnedAgent = {
    agentId: BENCH_ID,
    agentVersionId: BENCH_ID,
    tenantId,
    slug: "test-bench",
    version: 1,
    bundle: benchAgent(def, deps.model ?? { id: DEFAULT_MODELS.reasoning }),
    bindings: {},
    approver: null,
  };
  const store: RuntimeStore = {
    loadAgentVersion: async () => pinned,
    resolveCustomSkill: async (_tenant, ref) => ({
      ref,
      definition: def,
      source: input.tenantId ? "client" : "shared",
      versionId: null,
      version: null,
    }),
    memoryNotes: async () => [],
    connection: async () => null,
    grant: async () => null,
    agentStage: async () => null,
    approvalRouting: async () => ({
      rules: [],
      revision: 0,
      clientDefault: null,
      members: new Set(),
    }),
    run: async () => ({ mode: "test", agentId: BENCH_ID }),
    askTarget: async () => null,
  };
  const toolCalls = new Map<string, number>();
  let seq = 0;
  const log: RunLog = {
    startAskRun: refuse("ask run"),
    finishAskRun: refuse("ask run"),
    startStepRun: async () => BENCH_ID,
    finishStepRun: async () => undefined,
    addUsage: async () => undefined,
    async startToolCall(_tenant, call) {
      seq += 1;
      const id = `call-${seq}`;
      toolCalls.set(id, calls.length);
      calls.push({ tool: call.tool, status: "running", reason: null });
      return id;
    },
    async finishToolCall(_tenant, id, result) {
      const at = toolCalls.get(id);
      const entry = at === undefined ? undefined : calls[at];
      if (!entry) return;
      entry.status = result.status;
      const out = result.output as { refused?: unknown; error?: unknown } | null | undefined;
      const why = out?.refused ?? out?.error;
      entry.reason = typeof why === "string" ? why.slice(0, 300) : null;
    },
  };
  const actions: ExternalActionStore = {
    propose: refuse("external action"),
    get: async () => null,
    byKey: async () => null,
    claim: refuse("external action"),
    complete: refuse("external action"),
    fail: refuse("external action"),
  };
  // An escalation (a budget hit) opens no inbox item: the case just fails.
  const platform: PlatformStore = {
    createInboxItem: async () => ({ id: BENCH_ID }),
    postMessage: refuse("message"),
    writeMemory: refuse("memory note"),
  };
  const tools = new FixtureToolRegistry(deps.tools, input.fixtures);
  const runtime: RuntimeDeps = {
    ports: { store, log, actions, platform },
    tools,
    // Every skill reference resolves through `store` to the version under test, built-ins too.
    catalog: new SkillCatalog([]),
    transport: deps.transport,
    ...(deps.now ? { now: deps.now } : {}),
    policy: {
      refuseTool: ({ toolId }) =>
        tools.get(toolId)?.spec.sideEffect === "none" ? null : BENCH_REFUSED_WRITE,
    },
  };

  try {
    const result = await runAgent(runtime, {
      tenantId,
      agentVersionId: BENCH_ID,
      skill: def.id,
      input: input.input,
      runId: BENCH_ID,
      stepId: "test-case",
      mode: "test",
    });
    const base = {
      costUsd: result.costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      modelCalls: result.modelCalls,
      toolCalls: calls,
    };
    if (result.status === "succeeded" || result.status === "awaiting_approval") {
      return { ...base, status: "succeeded", output: result.output ?? null, error: null };
    }
    const error =
      result.status === "failed"
        ? result.error
        : result.status === "escalated"
          ? `budget reached: ${result.reason}`
          : `stopped: ${result.status}`;
    return { ...base, status: "failed", output: null, error };
  } catch (error) {
    return { ...empty(), error: error instanceof Error ? error.message : String(error) };
  }
}
