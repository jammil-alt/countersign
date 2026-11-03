// In-memory ports for executor tests: step_run rows, an agent that answers per step id, an inbox
// and notifications. Each records what it was asked so tests can assert on it.

import type { SkillDefinition, ToolSpec, Workflow } from "@countersign/core";
import { Workflow as WorkflowSchema } from "@countersign/core";
import type { ExecutorContext } from "./executor";
import type {
  ActionStepRequest,
  AgentPort,
  CreatePersonItem,
  InboxPort,
  InboxResolution,
  NotifyPort,
  ResumeRequest,
  RunInfo,
  SkillStepRequest,
  StepLog,
  StepOutcome,
  StepRunStart,
  StepRunUpdate,
} from "./ports";

export const RUN: RunInfo = {
  id: "0192f7a0-0000-7000-8000-00000000a001",
  tenantId: "0192f7a0-0000-7000-8000-00000000c001",
  agentId: "0192f7a0-0000-7000-8000-00000000b001",
  agentVersionId: "0192f7a0-0000-7000-8000-00000000b002",
  workflowSlug: "wf",
  mode: "live",
};

export interface StepRow extends StepRunStart {
  id: string;
  status: string;
  output?: unknown;
  summary?: string | null;
  error?: string;
  updates: StepRunUpdate[];
}

type Handler = (req: SkillStepRequest | ActionStepRequest) => StepOutcome | Promise<StepOutcome>;
type ResumeHandler = (req: ResumeRequest) => StepOutcome | Promise<StepOutcome>;

export class Harness {
  rows = new Map<string, StepRow>();
  agentCalls: (SkillStepRequest | ActionStepRequest)[] = [];
  resumeCalls: ResumeRequest[] = [];
  handlers: Record<string, Handler> = {};
  resumeHandler: ResumeHandler = (req) => ({
    kind: "done",
    output: { written: req.resolution.approved === true },
  });
  items = new Map<
    string,
    {
      item: CreatePersonItem | null;
      resolution: InboxResolution | null;
      expired: boolean;
      received: number;
    }
  >();
  sent: Parameters<NotifyPort["send"]>[0][] = [];
  operatorNotices: Parameters<NotifyPort["notifyOperator"]>[0][] = [];
  #n = 0;

  constructor(readonly run: RunInfo = RUN) {}

  row(nodeId: string): StepRow | undefined {
    return [...this.rows.values()].find((r) => r.nodeId === nodeId);
  }

  /** Registers an inbox item the agent port "created" for a write approval. */
  approvalItem(resolution: InboxResolution | null = null): string {
    const id = `0192f7a0-0000-7000-8000-${String(++this.#n).padStart(12, "0")}`;
    this.items.set(id, { item: null, resolution, expired: false, received: 0 });
    return id;
  }

  log: StepLog = {
    start: async (entry) => {
      const existing = this.row(entry.nodeId);
      if (existing) return existing.id;
      const id = `sr-${this.rows.size + 1}`;
      this.rows.set(id, { ...entry, id, status: "running", updates: [] });
      return id;
    },
    update: async (id, update) => {
      const row = this.rows.get(id);
      if (!row) throw new Error(`no step_run ${id}`);
      row.updates.push(update);
      Object.assign(row, update);
    },
  };

  agent: AgentPort = {
    runSkill: async (req) => this.#handle(req),
    runAction: async (req) => this.#handle(req),
    resume: async (req) => {
      this.resumeCalls.push(req);
      return this.resumeHandler(req);
    },
  };

  async #handle(req: SkillStepRequest | ActionStepRequest): Promise<StepOutcome> {
    this.agentCalls.push(req);
    const h = this.handlers[req.step.id];
    return h ? h(req) : { kind: "done", output: { echo: req.input } };
  }

  inbox: InboxPort = {
    createForPerson: async (item) => {
      const existing = [...this.items.entries()].find(([, v]) => v.item?.nodeId === item.nodeId);
      if (existing) return { id: existing[0] };
      const id = this.approvalItem();
      const entry = this.items.get(id);
      if (entry) entry.item = item;
      return { id };
    },
    resolution: async (id) => this.items.get(id)?.resolution ?? null,
    expire: async (id) => {
      const entry = this.items.get(id);
      if (entry) entry.expired = true;
    },
    received: async (id) => {
      const entry = this.items.get(id);
      if (entry) entry.received += 1;
    },
  };

  notify: NotifyPort = {
    send: async (m) => {
      this.sent.push(m);
    },
    notifyOperator: async (n) => {
      this.operatorNotices.push(n);
    },
  };

  context(extra: Partial<ExecutorContext> = {}): ExecutorContext {
    return {
      run: this.run,
      agent: this.agent,
      inbox: this.inbox,
      notify: this.notify,
      log: this.log,
      ...extra,
    };
  }

  itemFor(nodeId: string): string {
    const found = [...this.items.entries()].find(([, v]) => v.item?.nodeId === nodeId);
    if (!found) throw new Error(`no inbox item for ${nodeId}`);
    return found[0];
  }
}

/** A parsed workflow (defaults applied), with a manual trigger unless given one. */
export function wf(steps: unknown[], trigger?: unknown): Workflow {
  return WorkflowSchema.parse({
    schemaVersion: 3,
    trigger: trigger ?? { id: "t", on: { type: "manual", input: {} } },
    steps,
  });
}

export const SKILL: SkillDefinition = {
  schemaVersion: 1,
  id: "test.summarize",
  name: "Summarize",
  description: "",
  category: "test",
  mode: "agent",
  tools: [],
  input: {},
  output: {},
  settings: [],
  summary: "Read {{lines}} lines from {{vendor}}",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

export const WRITE_TOOL: ToolSpec = {
  id: "testkit.thing.update",
  description: "",
  input: {},
  output: {},
  sideEffect: "external",
  verb: "update",
  source: "testkit",
  connector: "testkit",
  summary: "Updated {{name}}",
};
