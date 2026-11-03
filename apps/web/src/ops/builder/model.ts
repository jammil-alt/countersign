// The workflow builder's model (ARCHITECTURE §10.5, docs/plan.md §1.2 "Builder"): pure functions
// over the bundle the builder edits. The builder's state *is* the bundle, so turning a bundle into
// builder state and back keeps every step, path and id as it was; edits copy only what they change
// the shape of. A step lives in a container: the workflow's top-level list, a fork path, a fork's
// otherwise, or a for-each block. New step and path ids are generated once (core's uuidv7) and
// never regenerated, so merges can line them up (CLAUDE.md invariant 3).

import {
  type AgentBundle,
  type BundleWorkflow,
  canonicalJson,
  DEFAULT_APPROVAL,
  type ForkPath,
  levelFor,
  type PermissionMatrix,
  parseSkillRef,
  type SkillDefinition,
  type Step,
  skillTools,
  stepWrites,
  type ToolSpec,
  type TriggerOn,
  type TypingContext,
  uuidv7,
  type Verb,
  type Workflow,
  walkSteps,
} from "@countersign/core";

/** `root`, `path:<path id>`, `otherwise:<otherwise id>` or `loop:<for-each step id>`. */
export type ContainerId = string;
export const ROOT: ContainerId = "root";

export type NewId = () => string;

// ── Containers ───────────────────────────────────────────────────────────────────────────────────

/** The containers directly inside a step (a fork's paths and otherwise, a for-each's block). */
export function childContainers(step: Step): { id: ContainerId; steps: Step[] }[] {
  if (step.kind === "fork") {
    return [
      ...step.paths.map((p) => ({ id: `path:${p.id}`, steps: p.steps })),
      { id: `otherwise:${step.otherwise.id}`, steps: step.otherwise.steps },
    ];
  }
  if (step.kind === "for_each") return [{ id: `loop:${step.id}`, steps: step.steps }];
  return [];
}

/** Every container inside a step, at any depth: where the step itself can't be moved to. */
export function containersWithin(step: Step): Set<ContainerId> {
  const out = new Set<ContainerId>();
  const visit = (s: Step) => {
    for (const c of childContainers(s)) {
      out.add(c.id);
      for (const inner of c.steps) visit(inner);
    }
  };
  visit(step);
  return out;
}

export function getContainer(workflow: Pick<Workflow, "steps">, id: ContainerId): Step[] | null {
  if (id === ROOT) return workflow.steps;
  let found: Step[] | null = null;
  walkSteps(workflow, ({ step }) => {
    if (found) return;
    for (const c of childContainers(step)) if (c.id === id) found = c.steps;
  });
  return found;
}

function withChildren(step: Step, map: (id: ContainerId, steps: Step[]) => Step[]): Step {
  if (step.kind === "fork") {
    return {
      ...step,
      paths: step.paths.map((p) => ({ ...p, steps: map(`path:${p.id}`, p.steps) })),
      otherwise: {
        ...step.otherwise,
        steps: map(`otherwise:${step.otherwise.id}`, step.otherwise.steps),
      },
    };
  }
  if (step.kind === "for_each") return { ...step, steps: map(`loop:${step.id}`, step.steps) };
  return step;
}

/** Replaces one container's list; every other list is kept as it is. */
export function updateContainer(
  workflow: Workflow,
  id: ContainerId,
  fn: (steps: Step[]) => Step[],
): Workflow {
  const visit = (cid: ContainerId, steps: Step[]): Step[] => {
    const list = cid === id ? fn(steps) : steps;
    return list.map((s) => withChildren(s, visit));
  };
  return { ...workflow, steps: visit(ROOT, workflow.steps) };
}

export interface Located {
  step: Step;
  container: ContainerId;
  index: number;
}

export function locate(workflow: Pick<Workflow, "steps">, id: string): Located | null {
  let found: Located | null = null;
  const visit = (cid: ContainerId, steps: Step[]) => {
    steps.forEach((s, index) => {
      if (found) return;
      if (s.id === id) found = { step: s, container: cid, index };
      for (const c of childContainers(s)) visit(c.id, c.steps);
    });
  };
  visit(ROOT, workflow.steps);
  return found;
}

/** The fork a path or otherwise id belongs to (validation names paths by their own id). */
export function forkOfBranch(workflow: Pick<Workflow, "steps">, branchId: string): Step | null {
  let found: Step | null = null;
  walkSteps(workflow, ({ step }) => {
    if (
      !found &&
      step.kind === "fork" &&
      (step.otherwise.id === branchId || step.paths.some((p) => p.id === branchId))
    ) {
      found = step;
    }
  });
  return found;
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────────

export function insertStep(
  workflow: Workflow,
  container: ContainerId,
  index: number,
  step: Step,
): Workflow {
  return updateContainer(workflow, container, (steps) => {
    const at = Math.max(0, Math.min(index, steps.length));
    return [...steps.slice(0, at), step, ...steps.slice(at)];
  });
}

export function removeStep(workflow: Workflow, id: string): Workflow {
  const loc = locate(workflow, id);
  if (!loc) return workflow;
  return updateContainer(workflow, loc.container, (steps) => steps.filter((s) => s.id !== id));
}

/**
 * Moves a step (with whatever it holds) to `index` of `container`, the index counted after the
 * step has left its place: the same rule as arrayMove within one list. A step can't move into
 * itself; that move changes nothing.
 */
export function moveStep(
  workflow: Workflow,
  id: string,
  container: ContainerId,
  index: number,
): Workflow {
  const loc = locate(workflow, id);
  if (!loc) return workflow;
  if (containersWithin(loc.step).has(container)) return workflow;
  if (loc.container === container && loc.index === index) return workflow;
  return insertStep(removeStep(workflow, id), container, index, loc.step);
}

/** Changes one step wherever it sits. */
export function updateStep(workflow: Workflow, id: string, fn: (step: Step) => Step): Workflow {
  const loc = locate(workflow, id);
  if (!loc) return workflow;
  return updateContainer(workflow, loc.container, (steps) =>
    steps.map((s) => (s.id === id ? fn(s) : s)),
  );
}

export function editWorkflow(
  bundle: AgentBundle,
  slug: string,
  fn: (workflow: Workflow) => Workflow,
): AgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((w) =>
      w.slug === slug ? { ...w, workflow: fn(w.workflow) } : w,
    ),
  };
}

/** A trigger keeps its id when what starts the workflow changes. */
export function setTrigger(workflow: Workflow, on: TriggerOn): Workflow {
  return { ...workflow, trigger: { ...workflow.trigger, on } };
}

export function addWorkflow(
  bundle: AgentBundle,
  input: { slug: string; name: string; on: TriggerOn },
  newId: NewId = uuidv7,
): AgentBundle {
  const entry: BundleWorkflow = {
    slug: input.slug,
    name: input.name,
    enabled: true,
    workflow: { schemaVersion: 3, trigger: { id: newId(), on: input.on }, steps: [] },
  };
  return { ...bundle, workflows: [...bundle.workflows, entry] };
}

// ── New steps ────────────────────────────────────────────────────────────────────────────────────

export type LogicKind = "fork" | "for_each" | "wait" | "notify" | "stop";

/** What the palette offers; each item makes one new step (or, for a trigger, a new start). */
export type PaletteItem =
  | { type: "trigger"; key: string; title: string; detail: string; on: TriggerOn }
  | {
      type: "skill";
      key: string;
      title: string;
      detail: string;
      ref: string;
      skill: SkillDefinition;
      /** One of the agent's own skills (listed first). */
      own: boolean;
    }
  | { type: "action"; key: string; title: string; detail: string; tool: ToolSpec; group: string }
  | { type: "person"; key: string; title: string; detail: string; mode: "approve" | "ask" }
  | { type: "logic"; key: string; title: string; detail: string; logic: LogicKind };

/** "testkit.record.update" → "Update record". */
export function toolTitle(tool: Pick<ToolSpec, "id">): string {
  const parts = tool.id.split(".");
  const verb = parts.at(-1) ?? tool.id;
  const thing = parts.slice(1, -1).join(" ").replace(/[_-]/g, " ");
  const words = `${verb.replace(/[_-]/g, " ")}${thing ? ` ${thing}` : ""}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function newPath(n: number, newId: NewId = uuidv7): ForkPath {
  return { id: newId(), name: `Path ${n}`, when: { match: "all", rules: [] }, steps: [] };
}

/** A new step for a palette item. Every step that can change a client's tool starts with approval on. */
export function createStep(item: PaletteItem, ctx: TypingContext, newId: NewId = uuidv7): Step {
  const id = newId();
  switch (item.type) {
    case "skill": {
      const step: Step = { id, kind: "skill", name: item.skill.name, skill: item.ref, input: {} };
      const writes = stepWrites(step, ctx);
      return writes && writes.length > 0 ? { ...step, approval: { ...DEFAULT_APPROVAL } } : step;
    }
    case "action":
      return {
        id,
        kind: "action",
        name: item.title,
        tool: item.tool.id,
        input: {},
        approval: { ...DEFAULT_APPROVAL },
      };
    case "person":
      return {
        id,
        kind: "person",
        name: item.mode === "approve" ? "Approve" : "Ask a person",
        mode: item.mode,
        assignee: "client_admin",
        title: item.mode === "approve" ? "Please approve" : "A question",
        payload: {},
        timeout: "3 days",
        channel: "inbox",
        onReject: "stop",
        onTimeout: "notify_operator",
      };
    case "logic":
      switch (item.logic) {
        case "fork":
          return {
            id,
            kind: "fork",
            name: "Fork",
            paths: [newPath(1, newId)],
            otherwise: { id: newId(), steps: [] },
          };
        case "for_each":
          return { id, kind: "for_each", name: "For each", over: "", concurrency: 10, steps: [] };
        case "wait":
          return { id, kind: "wait", name: "Wait", for: "1 day" };
        case "notify":
          return { id, kind: "notify", name: "Notify", channel: "thread", message: "" };
        case "stop":
          return { id, kind: "stop", name: "Stop", status: "succeeded" };
      }
      break;
    case "trigger":
      break;
  }
  throw new Error(`a ${item.type} item doesn't make a step`);
}

/** The tools the agent may use: its extra tools and every tool its skills bring. */
export function allowedTools(bundle: AgentBundle, ctx: TypingContext): Set<string> {
  const ids = new Set(bundle.definition.extraTools);
  for (const s of bundle.definition.skills) {
    const def = ctx.skills?.[s.skill] ?? ctx.skills?.[parseSkillRef(s.skill).id];
    if (def) for (const t of skillTools(def)) ids.add(t);
  }
  return ids;
}

/**
 * The definition changes a new step needs to be allowed: a library skill joins the agent's skills,
 * an action's tool its extra tools.
 */
// DECISION: placing a library skill or an action the agent can't use yet adds it to the agent's
// skills or extra tools in the same edit (one undo), instead of leaving an error to fix elsewhere.
export function allowStep(bundle: AgentBundle, step: Step, ctx: TypingContext): AgentBundle {
  const def = bundle.definition;
  if (step.kind === "skill" && step.agent === undefined) {
    const id = parseSkillRef(step.skill).id;
    if (def.skills.some((s) => parseSkillRef(s.skill).id === id)) return bundle;
    return {
      ...bundle,
      definition: { ...def, skills: [...def.skills, { skill: step.skill, settings: {} }] },
    };
  }
  if (step.kind === "action" && !allowedTools(bundle, ctx).has(step.tool)) {
    return { ...bundle, definition: { ...def, extraTools: [...def.extraTools, step.tool] } };
  }
  return bundle;
}

// ── Approvals ────────────────────────────────────────────────────────────────────────────────────

const VERB_NOUN: Record<Verb, string> = {
  read: "reads",
  create: "creating records",
  update: "updates",
  delete: "deleting records",
};

export interface ApprovalEnv {
  ctx: TypingContext;
  agentKind: "template" | "client";
  mode: "suggest_only" | "act";
  /** A client agent's bound connections' matrices by connector id. */
  matrices: Record<string, Partial<PermissionMatrix> | undefined>;
  connectorName(id: string): string;
}

export interface ApprovalOption {
  /** The client tools the step can change. */
  writes: ToolSpec[];
  /** Whether "run without approval" may be offered. */
  canSkip: boolean;
  /** Why not, in a sentence. */
  reason: string | null;
  /** The step will run without waiting for a person. */
  automatic: boolean;
  required: boolean;
}

/**
 * The Approval control's rules (docs/plan.md §1.2 "Step approvals"): a step that changes a client's
 * tool waits for a person unless the operator switches its approval off, which is offered only on
 * a client agent whose bound connection allows `auto` for every verb the step writes and whose mode
 * is `act`. Null when the step changes no client tool.
 */
export function approvalOption(step: Step, env: ApprovalEnv): ApprovalOption | null {
  if (step.kind !== "skill" && step.kind !== "action") return null;
  const writes = stepWrites(step, env.ctx);
  if (!writes || writes.length === 0) return null;
  const required = step.approval?.required !== "not_required";
  let reason: string | null = null;
  if (env.agentKind === "template") {
    // DECISION: templates keep approval on for every write step; switching it off is a client
    // agent's choice, where that client's connection can allow it (invariant 8).
    reason =
      "Templates keep approval on. Switch it off in a client's agent, where that client's connection allows it.";
  } else {
    for (const tool of writes) {
      const connector = tool.connector ?? tool.source;
      const matrix = env.matrices[connector];
      const name = env.connectorName(connector);
      if (matrix === undefined) {
        reason = `Bind a ${name} connection first: its permissions decide whether this step may skip approval.`;
        break;
      }
      const level = levelFor(matrix, tool.verb);
      if (level === "off") {
        reason = `The ${name} connection doesn't allow ${VERB_NOUN[tool.verb]}.`;
        break;
      }
      if (level !== "auto") {
        reason = `The ${name} connection requires approval for ${VERB_NOUN[tool.verb]}.`;
        break;
      }
    }
    if (!reason && env.mode !== "act") {
      reason =
        "The agent's mode is suggest only, so every change waits for a person. Switch it to act in Settings.";
    }
  }
  const canSkip = reason === null;
  return { writes, canSkip, reason, automatic: canSkip && !required, required };
}

export interface WorkflowCounts {
  steps: number;
  forks: number;
  /** Steps that change a client's tool. */
  writes: number;
  /** Of those, the ones that will wait for a person. */
  needApproval: number;
}

export function workflowCounts(workflow: Workflow, env: ApprovalEnv): WorkflowCounts {
  const out: WorkflowCounts = { steps: 0, forks: 0, writes: 0, needApproval: 0 };
  walkSteps(workflow, ({ step }) => {
    out.steps += 1;
    if (step.kind === "fork") out.forks += 1;
    const option = approvalOption(step, env);
    if (option) {
      out.writes += 1;
      if (!option.automatic) out.needApproval += 1;
    }
  });
  return out;
}

// ── Against the template (client agents) ─────────────────────────────────────────────────────────

/** A step with its nested steps replaced by their ids: what the step itself says. */
function shallow(step: Step): unknown {
  if (step.kind === "fork") {
    return {
      ...step,
      paths: step.paths.map((p) => ({ ...p, steps: p.steps.map((s) => s.id) })),
      otherwise: { ...step.otherwise, steps: step.otherwise.steps.map((s) => s.id) },
    };
  }
  if (step.kind === "for_each") return { ...step, steps: step.steps.map((s) => s.id) };
  return step;
}

/**
 * Steps of a client agent's workflow that differ from its base template version: `added` (not in
 * the template) or `changed` (its own settings differ; moves and nested edits are the nested
 * steps' own).
 */
export function customizedSteps(
  workflow: Workflow,
  template: Workflow | undefined,
): Map<string, "added" | "changed"> {
  const out = new Map<string, "added" | "changed">();
  if (!template) return out;
  const before = new Map<string, string>();
  walkSteps(template, ({ step }) => before.set(step.id, canonicalJson(shallow(step))));
  walkSteps(workflow, ({ step }) => {
    const was = before.get(step.id);
    if (was === undefined) out.set(step.id, "added");
    else if (was !== canonicalJson(shallow(step))) out.set(step.id, "changed");
  });
  return out;
}

export function findTemplateStep(template: Workflow | undefined, id: string): Step | undefined {
  if (!template) return undefined;
  return locate(template, id)?.step;
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────

export interface History {
  past: AgentBundle[];
  present: AgentBundle;
  future: AgentBundle[];
  /** Edits with the same key in quick succession (typing in one field) are one undo step. */
  lastKey: string | null;
  lastAt: number;
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1000;

export function startHistory(bundle: AgentBundle): History {
  return { past: [], present: bundle, future: [], lastKey: null, lastAt: 0 };
}

export function commit(
  h: History,
  next: AgentBundle,
  key: string | null = null,
  now: number = Date.now(),
): History {
  if (next === h.present) return h;
  if (key !== null && key === h.lastKey && now - h.lastAt < COALESCE_MS) {
    return { ...h, present: next, future: [], lastAt: now };
  }
  return {
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastKey: key,
    lastAt: now,
  };
}

export function undo(h: History): History {
  const prev = h.past.at(-1);
  if (!prev) return h;
  return {
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo(h: History): History {
  const [next, ...rest] = h.future;
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: rest, lastKey: null, lastAt: 0 };
}
