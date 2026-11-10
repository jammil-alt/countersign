// R3 (ARCHITECTURE §10.14; docs/plan.md §1.86, §9): the executor runs v4 processes only. A stored
// v3 workflow is read as v4 at load (`processes.fromWorkflowV3`, every id kept); nothing stored is
// rewritten (invariant 3). Each converted step keeps a pointer to the v3 step it came from (its
// origin), so the ports, which take v3 step shapes (the agents runtime, the reach-out and
// conversation services, the inbox), are called with exactly what they were called with before:
// a converted workflow runs as it always did, and only a step the v3 schema can't say (a native
// v4 step) gets a v3-shaped view built from it.

import {
  type ActionStep,
  type Approval,
  DEFAULT_APPROVAL,
  type PersonStep,
  processes,
  type SkillStep,
  type Step as V3Step,
  type Workflow,
} from "@countersign/core";

/** What the executor runs: a stored v3 workflow or a v4 process. */
export type AnyWorkflow = Workflow | processes.Process;

/**
 * A lookup that knows nothing: tool-wrapper skills stay skill steps. Converted steps run through
 * their origin either way, so the lookup only changes the step kinds a v4 reader sees.
 */
export const NO_LOOKUP: processes.ConvertLookup = {
  wrappedTool: () => null,
  sideEffect: () => null,
};

/** v4 step → the stored v3 step it was converted from (by object). */
export type Origins = WeakMap<object, V3Step>;

/** A process ready to run, with the origins of its converted steps. */
export interface LoadedProcess {
  process: processes.Process;
  origins: Origins;
  /** The stored v3 workflow, when it was one (checkpoints are computed from it as before). */
  v3: Workflow | null;
}

export class ProcessLoadError extends Error {
  override name = "ProcessLoadError";
}

/** Pairs each converted step with its origin. The converter maps steps one to one, in order. */
export function pairOrigins(
  v3: readonly V3Step[],
  v4: readonly processes.Step[],
  origins: Origins,
): void {
  v3.forEach((from, i) => {
    const to = v4[i];
    if (!to || to.id !== from.id) return;
    origins.set(to, from);
    if (from.kind === "fork" && to.kind === "if") {
      from.paths.forEach((p, pi) => {
        const q = to.paths[pi];
        if (q) pairOrigins(p.steps, q.steps, origins);
      });
      pairOrigins(from.otherwise.steps, to.otherwise.steps, origins);
    } else if (from.kind === "for_each" && to.kind === "for_each") {
      pairOrigins(from.steps, to.steps, origins);
    }
  });
}

/** v3 steps read as v4 (an automation's steps, which have no trigger of their own). */
export function stepsFromV3(
  steps: readonly V3Step[],
  lookup: processes.ConvertLookup,
  origins: Origins,
): processes.Step[] {
  const converted = processes.fromWorkflowV3(
    {
      schemaVersion: 3,
      // A placeholder: the converter needs a trigger, an automation has none.
      trigger: { id: "automation", on: { type: "manual", input: {} } },
      steps: [...steps],
    } as Workflow,
    lookup,
  ).steps;
  pairOrigins(steps, converted, origins);
  return converted;
}

/**
 * The workflow as the executor runs it. v3: converted (ids kept, origins paired). v4: parsed, so
 * every default is there (a stored process was parsed when saved; a test's may not be).
 */
// DECISION: a converted v3 workflow is not re-parsed with the v4 schema: its steps are already
// parsed v3 steps, and parsing would only add v4 defaults the converter left out on purpose.
export function loadProcess(
  workflow: AnyWorkflow,
  lookup: processes.ConvertLookup = NO_LOOKUP,
): LoadedProcess {
  const origins: Origins = new WeakMap();
  if (workflow.schemaVersion === 4) {
    const parsed = processes.Process.safeParse(workflow);
    if (!parsed.success) {
      throw new ProcessLoadError(`the process doesn't parse: ${parsed.error.issues[0]?.message}`);
    }
    return { process: parsed.data, origins, v3: null };
  }
  const process = processes.fromWorkflowV3(workflow, lookup);
  pairOrigins(workflow.steps, process.steps, origins);
  return { process, origins, v3: workflow };
}

// ── v4 checks in the v3 shapes the ports take ──────────────────────────────────────────────────

/** The first approver's own clock deadline, as a v3 timeout; null when it has none or isn't. */
function v3Timeout(check: processes.ApprovalCheck): string | undefined {
  const d = check.approvers?.[0]?.deadline;
  return d && d.hours === "clock" ? d.after : undefined;
}

/**
 * A v4 approval as the gate takes it (v3 `Approval`): required or not, the approver asked first,
 * the first approver's clock timeout, and onReject. The converter's `approvalOf` read backwards,
 * so a converted approval comes out exactly as stored. `approver` overrides the first approver
 * (the first one who isn't away).
 */
export function gateApproval(
  check: processes.ApprovalCheck | undefined,
  approver?: string | null,
): Approval | undefined {
  if (!check) return undefined;
  const out: Approval = { required: check.required ?? "required", onReject: check.onReject };
  const who = approver === undefined ? check.approvers?.[0]?.who : approver;
  if (who) out.approver = who;
  const timeout = v3Timeout(check);
  if (timeout) out.timeout = timeout;
  return out;
}

/** v4 deadline → v3 `onTimeout`, for a person step's v3 view. */
function onTimeoutOf(d: processes.Deadline): PersonStep["onTimeout"] {
  if (d.ifNoAnswer === "proceed" || d.ifNoAnswer === "skip") return "continue";
  if (d.tell?.includes("operator")) return "notify_operator";
  return "stop";
}

/** The v3 shape of a v4 work step, for the agent port: its origin, or a view built from it. */
export function workView(
  step: processes.ReadStep | processes.SkillStep | processes.WriteStep,
  origin: V3Step | undefined,
  approval: Approval | undefined,
): SkillStep | ActionStep {
  if (origin && (origin.kind === "skill" || origin.kind === "action")) {
    // The approval the run uses (an automation's override included), as v3's expansion set it.
    if (origin.kind === "action") return { ...origin, approval: approval ?? origin.approval };
    return approval === undefined ? origin : { ...origin, approval };
  }
  const common = {
    id: step.id,
    name: step.name,
    ...(step.client ? { client: step.client } : {}),
    ...(step.review ? { review: step.review } : {}),
  };
  if (step.kind === "skill") {
    return {
      ...common,
      kind: "skill",
      skill: step.skill,
      input: step.input,
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.settings ? { settings: step.settings } : {}),
      ...(step.model ? { model: step.model } : {}),
      ...(approval ? { approval } : {}),
    };
  }
  // Skill model: an action write step is resolved to its tool before it gets here.
  if (step.tool === undefined) throw new Error(`"${step.name}" names no tool`);
  return {
    ...common,
    kind: "action",
    tool: step.tool,
    input: step.input,
    approval: approval ?? DEFAULT_APPROVAL,
  };
}

/** The v3 shape of a v4 person step, for the inbox port (which reads assignee, mode, choices). */
export function personView(step: processes.PersonStep, origin: V3Step | undefined): PersonStep {
  if (origin?.kind === "person") return origin;
  return {
    id: step.id,
    name: step.name,
    ...(step.client ? { client: step.client } : {}),
    kind: "person",
    mode: step.mode,
    assignee: step.assignee,
    title: step.title,
    payload: step.payload,
    timeout: step.deadline.after,
    ...(step.deadline.remind?.[0] ? { remindEvery: step.deadline.remind[0] } : {}),
    channel: step.channel,
    onReject: step.onReject,
    onTimeout: onTimeoutOf(step.deadline),
    ...(step.choices ? { choices: step.choices } : {}),
  };
}

/**
 * A question the run asks someone that isn't a step of its own (a person conferee, the lead asked
 * for help, an escalation), as the inbox port takes it: a v3 `ask` (or `approve`) person step.
 */
export function askView(input: {
  id: string;
  name: string;
  who: string;
  title: string;
  after: string;
  mode?: "ask" | "approve";
  choices?: PersonStep["choices"];
}): PersonStep {
  return {
    id: input.id,
    name: input.name,
    kind: "person",
    mode: input.mode ?? "ask",
    assignee: input.who,
    title: input.title,
    payload: {},
    timeout: input.after,
    channel: "inbox",
    onReject: "stop",
    onTimeout: "stop",
    ...(input.choices ? { choices: input.choices } : {}),
  };
}

/** The kind a step's rows and error keys carry: a converted step keeps its stored kind. */
export function storedKind(step: processes.Step, origin: V3Step | undefined): string {
  return origin?.kind ?? step.kind;
}

/** The tool a step's error key names: a write or read step's, or a v3 action's. */
export function toolOf(step: processes.Step, origin: V3Step | undefined): string | null {
  if (origin) return origin.kind === "action" ? origin.tool : null;
  return step.kind === "read" || step.kind === "write" ? (step.tool ?? null) : null;
}
