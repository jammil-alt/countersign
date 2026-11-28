// The executor runs engine steps (`processes.Step`): a v5 workflow is loaded into them
// (`./step-model`). The ports (the agents runtime, the reach-out and conversation services, the
// inbox) take the step shapes below, built from an engine step: a skill or action to run, a person
// to ask, a notice to send.

import {
  type Approval,
  DEFAULT_APPROVAL,
  type Duration,
  type ModelChoice,
  type processes,
  type StepReview,
} from "@countersign/core";

/** Where a step shows in the client's run timeline. */
export interface ClientVisibility {
  visible: boolean;
  label?: string | undefined;
}

interface PortStepBase {
  id: string;
  name: string;
  client?: ClientVisibility | undefined;
}

/** A skill step as the agent port takes it. */
export interface SkillStep extends PortStepBase {
  kind: "skill";
  skill: string;
  agent?: string | undefined;
  input: Record<string, unknown>;
  settings?: Record<string, unknown> | undefined;
  approval?: Approval | undefined;
  model?: ModelChoice | undefined;
  review?: StepReview | undefined;
}

/** A tool write as the agent port takes it. */
export interface ActionStep extends PortStepBase {
  kind: "action";
  tool: string;
  input: Record<string, unknown>;
  approval: Approval;
  review?: StepReview | undefined;
}

/** A quick answer to a person step's question. */
export type PersonChoice = NonNullable<processes.PersonStep["choices"]>[number];
export type PersonField = NonNullable<processes.PersonStep["fields"]>[number];

/** A person step as the inbox port takes it (assignee, mode, choices). */
export interface PersonStep extends PortStepBase {
  kind: "person";
  mode: "approve" | "ask";
  assignee: string;
  title: string;
  payload: Record<string, unknown>;
  timeout: Duration;
  remindEvery?: Duration | undefined;
  channel: "inbox" | "email";
  onReject: "stop" | "continue";
  onTimeout: "stop" | "continue" | "notify_operator";
  choices?: PersonChoice[] | undefined;
  /** What the person is asked for, each handed on by its name (the step model's output fields). */
  fields?: PersonField[] | undefined;
}

/** A notice as the notify port takes it. */
export interface NotifyStep extends PortStepBase {
  kind: "notify";
  channel: "thread" | "email" | "digest";
  to?: string | undefined;
  message: string;
  sources?: string[] | undefined;
}

/** What a step shows people: its client label, else its name. */
export function clientLabel(step: { client?: ClientVisibility | undefined; name: string }): string {
  return step.client?.label ?? step.name;
}

/**
 * A step's name for people that follows its state. The client label says what was done
 * ("Itemized the bill"), so it is used once the step has run; until then (waiting for approval,
 * turned down, failed) the step's own name says what it does ("Itemize the bill"). A person step
 * asks someone, so it keeps its label in every state.
 */
// DECISION: the step's operator-written name stands for "not done yet" rather than a generated
// tense: names are imperative by convention ("Find the bill"), and test runs already show it
// ("Would itemize the bill").
export function stepStateLabel(
  step: { client?: ClientVisibility | undefined; name: string; kind: string },
  ran: boolean,
): string {
  return ran || step.kind === "person" ? clientLabel(step) : step.name;
}

/** An engine step that runs through the executor (the loaded steps of a workflow). */
export interface LoadedProcess {
  process: processes.Process;
}

export class ProcessLoadError extends Error {
  override name = "ProcessLoadError";
}

// ── engine checks in the shapes the ports take ─────────────────────────────────────────────────

/** The first approver's own clock deadline, as a timeout; null when it has none or isn't. */
function clockTimeout(check: processes.ApprovalCheck): string | undefined {
  const d = check.approvers?.[0]?.deadline;
  return d && d.hours === "clock" ? d.after : undefined;
}

/**
 * An approval check as the gate takes it (`Approval`): required or not, the approver asked first,
 * the first approver's clock timeout, and onReject. `approver` overrides the first approver (the
 * first one who isn't away).
 */
export function gateApproval(
  check: processes.ApprovalCheck | undefined,
  approver?: string | null,
): Approval | undefined {
  if (!check) return undefined;
  const out: Approval = { required: check.required ?? "required", onReject: check.onReject };
  const who = approver === undefined ? check.approvers?.[0]?.who : approver;
  if (who) out.approver = who;
  const timeout = clockTimeout(check);
  if (timeout) out.timeout = timeout;
  return out;
}

/** deadline → `onTimeout`, for a person step's port view. */
function onTimeoutOf(d: processes.Deadline): PersonStep["onTimeout"] {
  if (d.ifNoAnswer === "proceed" || d.ifNoAnswer === "skip") return "continue";
  if (d.tell?.includes("operator")) return "notify_operator";
  return "stop";
}

/** The port shape of an engine work step. */
export function workView(
  step: processes.ReadStep | processes.SkillStep | processes.WriteStep,
  approval: Approval | undefined,
): SkillStep | ActionStep {
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
  // An action write step is resolved to its tool before it gets here.
  if (step.tool === undefined) throw new Error(`"${step.name}" names no tool`);
  return {
    ...common,
    kind: "action",
    tool: step.tool,
    input: step.input,
    approval: approval ?? DEFAULT_APPROVAL,
  };
}

/** The port shape of an engine person step, for the inbox port (which reads assignee, mode, choices). */
export function personView(step: processes.PersonStep): PersonStep {
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
    ...(step.fields ? { fields: step.fields } : {}),
  };
}

/**
 * A question the run asks someone that isn't a step of its own (a person conferee, the lead asked
 * for help, an escalation), as the inbox port takes it: an `ask` (or `approve`) person step.
 */
export function askView(input: {
  id: string;
  name: string;
  who: string;
  title: string;
  after: string;
  mode?: "ask" | "approve";
  choices?: PersonStep["choices"];
  fields?: PersonStep["fields"];
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
    ...(input.fields ? { fields: input.fields } : {}),
  };
}

/** The kind a step's rows and error keys carry. */
export function storedKind(step: processes.Step): string {
  return step.kind;
}

/** The tool a step's error key names: a write or read step's. */
export function toolOf(step: processes.Step): string | null {
  return step.kind === "read" || step.kind === "write" ? (step.tool ?? null) : null;
}
