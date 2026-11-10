// The workflow builder's model (ARCHITECTURE §10.5, §10.14; docs/plan.md §1.2 "Builder", §1.86):
// pure functions over the bundle the builder edits. Since R8 the builder edits v4 processes: a
// stored v3 workflow is read as one (`readProcessBundle`, every id kept), and the next save writes
// schemaVersion 4 as a new version (invariant 3: the stored one is never edited). The builder's
// state *is* the bundle, so edits copy only what they change the shape of. A step lives in a
// container: the process's top-level list, an if path, an if's otherwise, or a for-each block.
// New step and path ids are generated once (core's uuidv7) and never regenerated, so merges can
// line them up (CLAUDE.md invariant 3).

import {
  type AgentBundle,
  type AnyAgentBundle,
  canonicalJson,
  defaultWriteApproval,
  isToolWrapper,
  type JsonObject,
  levelFor,
  type PermissionMatrix,
  type ProcessAgentBundle,
  type ProcessBundleWorkflow,
  parseSkillRef,
  processes,
  readConverted,
  type SkillDefinition,
  type SkillKind,
  skillTools,
  type ToolSpec,
  type Trigger,
  type TriggerOn,
  type TypingContext,
  uuidv7,
  type Verb,
} from "@countersign/core";
import { toolLabel } from "../workflow/labels";

export type Step = processes.Step;
export type Process = processes.Process;
export type IfPath = processes.IfPath;
export type ApprovalCheck = processes.ApprovalCheck;
export type Deadline = processes.Deadline;

/** `root`, `path:<path id>`, `otherwise:<otherwise id>` or `loop:<for-each step id>`. */
export type ContainerId = string;
export const ROOT: ContainerId = "root";

export type NewId = () => string;

// ── Reading a stored version ─────────────────────────────────────────────────────────────────────

/** What converting a v3 workflow needs from the catalog (core's `processes.ConvertLookup`). */
export function convertLookup(ctx: TypingContext): processes.ConvertLookup {
  return {
    wrappedTool(skillId) {
      const def =
        ctx.skills?.[skillId] ??
        Object.values(ctx.skills ?? {}).find((d) => parseSkillRef(d.id).id === skillId);
      return def && isToolWrapper(def) ? (def.handler ?? null) : null;
    },
    sideEffect: (toolId) => ctx.tools?.[toolId]?.sideEffect ?? null,
  };
}

/**
 * A stored bundle as the builder edits it: every v3 workflow read as a v4 process with
 * `fromWorkflowV3` and `readConverted` (every step, path and trigger id kept; nothing stored
 * changes), every v4 process as it is.
 */
// DECISION: the conversion is the builder's starting point, not an edit: opening a v3 version shows
// it converted with nothing unsaved, and publishing it unchanged publishes the stored version as
// it is. The first save after an edit writes the whole bundle as v4, a new version.
export function readProcessBundle(
  bundle: AnyAgentBundle | AgentBundle,
  ctx: TypingContext,
): ProcessAgentBundle {
  const lookup = convertLookup(ctx);
  return {
    ...bundle,
    workflows: bundle.workflows.map(
      (w): ProcessBundleWorkflow => ({
        ...w,
        workflow:
          w.workflow.schemaVersion === 4
            ? w.workflow
            : readConverted(processes.fromWorkflowV3(w.workflow, lookup)),
      }),
    ),
  };
}

/** Whether any workflow of the stored bundle is still v3 (it opens converted). */
export function holdsV3(bundle: AnyAgentBundle | AgentBundle): boolean {
  return bundle.workflows.some((w) => w.workflow.schemaVersion !== 4);
}

// ── Containers ───────────────────────────────────────────────────────────────────────────────────

/** The containers directly inside a step (an if's paths and otherwise, a for-each's block). */
export function childContainers(step: Step): { id: ContainerId; steps: Step[] }[] {
  if (step.kind === "if") {
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

export function getContainer(process: Pick<Process, "steps">, id: ContainerId): Step[] | null {
  if (id === ROOT) return process.steps;
  let found: Step[] | null = null;
  processes.walkSteps(process, ({ step }) => {
    if (found) return;
    for (const c of childContainers(step)) if (c.id === id) found = c.steps;
  });
  return found;
}

function withChildren(step: Step, map: (id: ContainerId, steps: Step[]) => Step[]): Step {
  if (step.kind === "if") {
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
  process: Process,
  id: ContainerId,
  fn: (steps: Step[]) => Step[],
): Process {
  const visit = (cid: ContainerId, steps: Step[]): Step[] => {
    const list = cid === id ? fn(steps) : steps;
    return list.map((s) => withChildren(s, visit));
  };
  return { ...process, steps: visit(ROOT, process.steps) };
}

export interface Located {
  step: Step;
  container: ContainerId;
  index: number;
}

export function locate(process: Pick<Process, "steps">, id: string): Located | null {
  let found: Located | null = null;
  const visit = (cid: ContainerId, steps: Step[]) => {
    steps.forEach((s, index) => {
      if (found) return;
      if (s.id === id) found = { step: s, container: cid, index };
      for (const c of childContainers(s)) visit(c.id, c.steps);
    });
  };
  visit(ROOT, process.steps);
  return found;
}

/** The if a path or otherwise id belongs to (validation names paths by their own id). */
export function ifOfBranch(process: Pick<Process, "steps">, branchId: string): Step | null {
  let found: Step | null = null;
  processes.walkSteps(process, ({ step }) => {
    if (
      !found &&
      step.kind === "if" &&
      (step.otherwise.id === branchId || step.paths.some((p) => p.id === branchId))
    ) {
      found = step;
    }
  });
  return found;
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────────

export function insertStep(
  process: Process,
  container: ContainerId,
  index: number,
  step: Step,
): Process {
  return updateContainer(process, container, (steps) => {
    const at = Math.max(0, Math.min(index, steps.length));
    return [...steps.slice(0, at), step, ...steps.slice(at)];
  });
}

export function removeStep(process: Process, id: string): Process {
  const loc = locate(process, id);
  if (!loc) return process;
  return updateContainer(process, loc.container, (steps) => steps.filter((s) => s.id !== id));
}

/**
 * Moves a step (with whatever it holds) to `index` of `container`, the index counted after the
 * step has left its place: the same rule as arrayMove within one list. A step can't move into
 * itself; that move changes nothing.
 */
export function moveStep(
  process: Process,
  id: string,
  container: ContainerId,
  index: number,
): Process {
  const loc = locate(process, id);
  if (!loc) return process;
  if (containersWithin(loc.step).has(container)) return process;
  if (loc.container === container && loc.index === index) return process;
  return insertStep(removeStep(process, id), container, index, loc.step);
}

/** Changes one step wherever it sits. */
export function updateStep(process: Process, id: string, fn: (step: Step) => Step): Process {
  const loc = locate(process, id);
  if (!loc) return process;
  return updateContainer(process, loc.container, (steps) =>
    steps.map((s) => (s.id === id ? fn(s) : s)),
  );
}

export function editWorkflow(
  bundle: ProcessAgentBundle,
  slug: string,
  fn: (process: Process) => Process,
): ProcessAgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((w) =>
      w.slug === slug ? { ...w, workflow: fn(w.workflow) } : w,
    ),
  };
}

/** A trigger keeps its id when what starts the process changes. */
export function setTrigger(process: Process, on: TriggerOn, triggerId?: string): Process {
  const id = triggerId ?? process.triggers[0]?.id;
  return {
    ...process,
    triggers: process.triggers.map((t) => (t.id === id ? { ...t, on } : t)),
  };
}

/** One more way to start the process (at most 10). */
export function addTrigger(process: Process, on: TriggerOn, newId: NewId = uuidv7): Process {
  if (process.triggers.length >= 10) return process;
  const trigger: Trigger = { id: newId(), on };
  return { ...process, triggers: [...process.triggers, trigger] };
}

/** Removes a trigger; the last one stays (a process starts somehow). */
export function removeTrigger(process: Process, id: string): Process {
  if (process.triggers.length <= 1) return process;
  return { ...process, triggers: process.triggers.filter((t) => t.id !== id) };
}

export function addWorkflow(
  bundle: ProcessAgentBundle,
  input: { slug: string; name: string; on: TriggerOn },
  newId: NewId = uuidv7,
): ProcessAgentBundle {
  const entry: ProcessBundleWorkflow = {
    slug: input.slug,
    name: input.name,
    enabled: true,
    workflow: { schemaVersion: 4, triggers: [{ id: newId(), on: input.on }], steps: [] },
  };
  return { ...bundle, workflows: [...bundle.workflows, entry] };
}

// ── New steps ────────────────────────────────────────────────────────────────────────────────────

export type LogicKind = "if" | "for_each" | "wait" | "stop";

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
      /** Skill model (2026-11-10): Deterministic or AI, shown on the item. */
      kind?: SkillKind | undefined;
    }
  | {
      type: "read" | "write";
      key: string;
      title: string;
      detail: string;
      tool: ToolSpec;
      group: string;
      /** Wave 4: the step's input as placed (a client's recorded script names itself). */
      input?: JsonObject;
    }
  // A process (today's automation, a pinned `slug@version`), placed as one step.
  | { type: "process"; key: string; title: string; detail: string; ref: string }
  | { type: "person"; key: string; title: string; detail: string; mode: "approve" | "ask" }
  | { type: "conversation"; key: string; title: string; detail: string }
  | { type: "notify"; key: string; title: string; detail: string }
  | { type: "logic"; key: string; title: string; detail: string; logic: LogicKind };

/** "testkit.record.update" → "Update a record": the tool's label (workflow/labels.ts). */
export function toolTitle(tool: Pick<ToolSpec, "id">): string {
  return toolLabel(tool.id);
}

export function newPath(n: number, newId: NewId = uuidv7): IfPath {
  return { id: newId(), name: `Path ${n}`, when: { match: "all", rules: [] }, steps: [] };
}

/**
 * Approval as every new check starts (invariant 8): required, one approver at a time, the default
 * approver, and stop when nobody answers.
 */
export function defaultApproval(): ApprovalCheck {
  return { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" };
}

/** A deadline as new ones start: on the clock, stop when nobody answers. */
export function defaultDeadline(after = "1 day"): Deadline {
  return { after, hours: "clock", ifNoAnswer: "stop" };
}

/**
 * A new step for a palette item. Every step that can change a client's tool, or reach a person
 * outside the team, starts with approval on (invariant 8).
 */
// DECISION: a write step starts with an approval check when its tool is external (a client's
// tool), as v3's action did; a write to a platform record (an alert, a price) runs as the skill
// that wrote it did. The operator can add approval to any write in the checks panel.
export function createStep(item: PaletteItem, ctx: TypingContext, newId: NewId = uuidv7): Step {
  const id = newId();
  switch (item.type) {
    case "skill": {
      const step: Step = { id, kind: "skill", name: item.skill.name, skill: item.ref, input: {} };
      const writes = processes.stepWrites(step, ctx);
      // Core's rule, as the validator reads it: a skill that reaches people (a reach-out).
      const reaches = processes.stepReaches(step, ctx);
      return (writes && writes.length > 0) || reaches
        ? { ...step, checks: { approval: defaultApproval() } }
        : step;
    }
    case "read":
      return { id, kind: "read", name: item.title, tool: item.tool.id, input: item.input ?? {} };
    case "write":
      return {
        id,
        kind: "write",
        name: item.title,
        tool: item.tool.id,
        input: item.input ?? {},
        // Skill model (2026-11-10): "Change in <tool>" starts with approval on, "Save to records"
        // off (core's `defaultWriteApproval`; the operator may turn it on in the inspector).
        ...(defaultWriteApproval(item.tool) ? { checks: { approval: defaultApproval() } } : {}),
      };
    case "process":
      // Its inner steps keep their own approvals (on by default); the step overrides none.
      return { id, kind: "process", name: item.title, process: item.ref, input: {} };
    case "person":
      return {
        id,
        kind: "person",
        name: item.mode === "approve" ? "Approve" : "Ask a person",
        mode: item.mode,
        assignee: "client_admin",
        title: item.mode === "approve" ? "Please approve" : "A question",
        payload: {},
        // v3's default (tell the operator when nobody answers), in the v4 shape.
        deadline: { ...defaultDeadline("3 days"), tell: ["operator"] },
        channel: "inbox",
        onReject: "stop",
      };
    case "conversation":
      // The first message (the plan) always waits for a person's yes to start with (§10.12).
      return {
        id,
        kind: "conversation",
        name: "Talk with a person",
        with: "",
        channel: "whatsapp",
        goal: "",
        mayShare: [],
        find: { answer: "text" },
        maxTurns: 4,
        messages: { first: "required", later: "required" },
        deadline: defaultDeadline("3 days"),
      };
    case "notify":
      return {
        id,
        kind: "notify",
        name: "Notify",
        notify: { to: ["client_admin"], channel: "inbox", message: "" },
      };
    case "logic":
      switch (item.logic) {
        case "if":
          return {
            id,
            kind: "if",
            name: "If",
            paths: [newPath(1, newId)],
            otherwise: { id: newId(), steps: [] },
          };
        case "for_each":
          return { id, kind: "for_each", name: "For each", over: "", concurrency: 10, steps: [] };
        case "wait":
          return { id, kind: "wait", name: "Wait", for: "1 day" };
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
export function allowedTools(
  bundle: Pick<AnyAgentBundle, "definition">,
  ctx: TypingContext,
): Set<string> {
  const ids = new Set(bundle.definition.extraTools);
  for (const s of bundle.definition.skills) {
    const def = ctx.skills?.[s.skill] ?? ctx.skills?.[parseSkillRef(s.skill).id];
    if (def) for (const t of skillTools(def)) ids.add(t);
  }
  return ids;
}

/**
 * The definition changes a new step needs to be allowed: a library skill joins the agent's skills,
 * a read or write step's tool its extra tools.
 */
// DECISION: placing a library skill or a tool the agent can't use yet adds it to the agent's
// skills or extra tools in the same edit (one undo), instead of leaving an error to fix elsewhere.
export function allowStep(
  bundle: ProcessAgentBundle,
  step: Step,
  ctx: TypingContext,
): ProcessAgentBundle {
  const def = bundle.definition;
  if (step.kind === "skill" && step.agent === undefined) {
    const id = parseSkillRef(step.skill).id;
    if (def.skills.some((s) => parseSkillRef(s.skill).id === id)) return bundle;
    return {
      ...bundle,
      definition: { ...def, skills: [...def.skills, { skill: step.skill, settings: {} }] },
    };
  }
  if (
    (step.kind === "read" || step.kind === "write") &&
    !allowedTools(bundle, ctx).has(step.tool)
  ) {
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
  /** Whether loosening (run without approval, go ahead with no answer) may be offered. */
  canSkip: boolean;
  /** Why not, in a sentence. */
  reason: string | null;
  /** The step will run without waiting for a person. */
  automatic: boolean;
  required: boolean;
}

/**
 * Whether the operator may loosen a write's approval (invariant 8; docs/plan.md §1.2 "Step
 * approvals", ARCHITECTURE §10.14 "Deadlines"): only on a client agent whose bound connection
 * allows `auto` for every verb the step writes and whose mode is `act`. Null when no reason stops
 * it. Templates keep approval on.
 */
export function looseningBlocked(writes: readonly ToolSpec[], env: ApprovalEnv): string | null {
  if (env.agentKind === "template") {
    // DECISION: templates keep approval on for every write step; loosening is a client agent's
    // choice, where that client's connection can allow it (invariant 8).
    return "Templates keep approval on. Switch it off in a client's agent, where that client's connection allows it.";
  }
  for (const tool of writes) {
    const connector = tool.connector ?? tool.source;
    const matrix = env.matrices[connector];
    const name = env.connectorName(connector);
    if (matrix === undefined) {
      return `Bind a ${name} connection first: its permissions decide whether this step may skip approval.`;
    }
    const level = levelFor(matrix, tool.verb);
    if (level === "off") return `The ${name} connection doesn't allow ${VERB_NOUN[tool.verb]}.`;
    if (level !== "auto")
      return `The ${name} connection requires approval for ${VERB_NOUN[tool.verb]}.`;
  }
  if (env.mode !== "act") {
    return "The agent's mode is suggest only, so every change waits for a person. Switch it to act in Settings.";
  }
  return null;
}

/** Whether the approval lets a write through without a person's yes on some runs. */
export function isLoosened(approval: ApprovalCheck | undefined): boolean {
  return processes.approvalLoosenings(approval, "a").length > 0;
}

/**
 * The approval rules of a step that changes a client's tool: it waits for a person unless the
 * operator loosened its approval where that may be done. Null when the step changes no client
 * tool.
 */
export function approvalOption(step: Step, env: ApprovalEnv): ApprovalOption | null {
  const writes = processes.stepWrites(step, env.ctx);
  if (!writes || writes.length === 0) return null;
  const approval = step.checks?.approval;
  const required = approval?.required !== "not_required";
  const reason = looseningBlocked(writes, env);
  const canSkip = reason === null;
  return { writes, canSkip, reason, automatic: canSkip && !required, required };
}

export interface WorkflowCounts {
  steps: number;
  ifs: number;
  /** Steps that change a client's tool. */
  writes: number;
  /** Of those, the ones that will wait for a person. */
  needApproval: number;
}

export function workflowCounts(process: Process, env: ApprovalEnv): WorkflowCounts {
  const out: WorkflowCounts = { steps: 0, ifs: 0, writes: 0, needApproval: 0 };
  processes.walkSteps(process, ({ step }) => {
    out.steps += 1;
    if (step.kind === "if") out.ifs += 1;
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
  if (step.kind === "if") {
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
 * Steps of a client agent's process that differ from its base template version: `added` (not in
 * the template) or `changed` (its own settings differ; moves and nested edits are the nested
 * steps' own).
 */
export function customizedSteps(
  process: Process,
  template: Process | undefined,
): Map<string, "added" | "changed"> {
  const out = new Map<string, "added" | "changed">();
  if (!template) return out;
  const before = new Map<string, string>();
  processes.walkSteps(template, ({ step }) => before.set(step.id, canonicalJson(shallow(step))));
  processes.walkSteps(process, ({ step }) => {
    const was = before.get(step.id);
    if (was === undefined) out.set(step.id, "added");
    else if (was !== canonicalJson(shallow(step))) out.set(step.id, "changed");
  });
  return out;
}

export function findTemplateStep(template: Process | undefined, id: string): Step | undefined {
  if (!template) return undefined;
  return locate(template, id)?.step;
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────

export interface History {
  past: ProcessAgentBundle[];
  present: ProcessAgentBundle;
  future: ProcessAgentBundle[];
  /** Edits with the same key in quick succession (typing in one field) are one undo step. */
  lastKey: string | null;
  lastAt: number;
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1000;

export function startHistory(bundle: ProcessAgentBundle): History {
  return { past: [], present: bundle, future: [], lastKey: null, lastAt: 0 };
}

export function commit(
  h: History,
  next: ProcessAgentBundle,
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
