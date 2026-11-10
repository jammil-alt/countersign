// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): how a step ended, in the builder's words. Every
// step of a v4 process records its outcome (`steps.<id>.outcome`, its approval, confer, error, a
// person's quick answer, a loop's counts: core's `processes.stepOutcomeFields`), and an `if` after
// it can route on that like any other field. Here: the plain words the field picker and the rule
// rows show ("Approve the bill: was rejected"), the routes a step offers in its inspector, and
// "Add a route for this", which puts an `if` right after the step. Where a route needs the step to
// go on (an approval's `onReject: continue`, a deadline's `skip`, `onError: continue`), it sets
// that and says so; nothing here loosens an approval (invariant 8: a skipped or failed write
// writes nothing).
import { type PathOption, pickLocalized, processes, type Rule, uuidv7 } from "@countersign/core";
import { insertStep, locate, type NewId, type Process, type Step, updateStep } from "./model";

type OutcomeKind = processes.OutcomeKind;
type DeadlineThen = processes.DeadlineThen;

/** A field the picker offers, with its words where it is how an earlier step ended. */
export interface PickPath extends PathOption {
  /** "Approve the bill: how it ended"; absent for an output or trigger field (its path shows). */
  label?: string;
  /** Each allowed value in words, for the value dropdown ("rejected" → "was rejected"). */
  values?: Record<string, string>;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const WORK = {
  rejected: "was rejected",
  no_answer: "nobody answered",
  skipped: "was skipped",
  needs_help: "needed help nobody gave",
  failed: "failed",
};

/** How a step ended, after its name: "Find the PO: found nothing". */
const OUTCOME_PHRASE: { [K in OutcomeKind]: Record<processes.StepOutcomeOf<K>, string> } = {
  read: { done: "found it", empty: "found nothing", ...WORK },
  skill: { done: "was done", ...WORK },
  write: { done: "was done", ...WORK },
  person: { answered: "was answered", no_answer: "nobody answered" },
  conversation: {
    done: "got what it needed",
    not_found: "didn't find it",
    declined: "was turned down",
    no_answer: "nobody answered",
    failed: "failed",
  },
  notify: {
    sent: "was sent",
    skipped: "wasn't needed",
    not_seen: "wasn't seen in time",
    failed: "couldn't be sent",
  },
  wait: { arrived: "what it waited for came", timed_out: "timed out" },
  for_each: {
    done: "every item was done",
    some_failed: "some items failed",
    all_failed: "every item failed",
  },
  process: { completed: "was completed", stopped: "stopped", failed: "failed" },
};

/** A route's name for the outcome: the path is called this, the `if` "If <name in lower case>". */
const ROUTE_NAME: Record<string, string> = {
  done: "Done",
  empty: "Found nothing",
  rejected: "Rejected",
  no_answer: "No answer",
  skipped: "Skipped",
  needs_help: "Needed help",
  failed: "Failed",
  answered: "Answered",
  not_found: "Not found",
  declined: "Turned down",
  sent: "Sent",
  not_seen: "Not seen",
  arrived: "Arrived",
  timed_out: "Timed out",
  some_failed: "Some failed",
  all_failed: "All failed",
  completed: "Completed",
  stopped: "Stopped",
};

const APPROVAL_PHRASE: Record<processes.ApprovalOutcome, string> = {
  approved: "was approved",
  rejected: "was rejected",
  no_answer: "nobody answered",
  not_needed: "needed no approval",
};

const VERDICT_PHRASE: Record<processes.ConferVerdict, string> = {
  agree: "agreed",
  disagree: "disagreed",
  unsure: "wasn't sure",
  no_answer: "didn't answer",
};

/** "found nothing" for a read's `empty`; the word itself for one this kind doesn't have. */
export function outcomePhrase(kind: string, word: string): string {
  if (!processes.hasOutcome(kind as processes.StepKind)) return word;
  const phrases = OUTCOME_PHRASE[kind as OutcomeKind] as Record<string, string>;
  return phrases[word] ?? word;
}

/** A record field after the step's name: "how it ended", "its approval", "reviewer 2's verdict". */
export function fieldPhrase(field: string): string {
  const reviewer = /^confer\.(\d+)\.(verdict|by)$/.exec(field);
  if (reviewer) {
    const n = Number(reviewer[1]) + 1;
    return reviewer[2] === "verdict" ? `reviewer ${n}'s verdict` : `reviewer ${n}`;
  }
  switch (field) {
    case "outcome":
      return "how it ended";
    case "approval.outcome":
      return "its approval";
    case "approval.by":
      return "who answered its approval";
    case "confer.verdict":
      return "its reviewers' verdict";
    case "choice":
      return "the quick answer picked";
    case "counts.items":
      return "how many items";
    case "counts.failed":
      return "how many items failed";
    case "error.code":
      return "why it failed (a code)";
    case "error.message":
      return "why it failed";
    default:
      return field;
  }
}

/** A record field's allowed values in words, or undefined for a field with none. */
function valuePhrases(step: Step, field: string): Record<string, string> | undefined {
  const words = processes.outcomeVocabulary(step, field.split("."));
  if (!words) return undefined;
  const out: Record<string, string> = {};
  for (const w of words) {
    if (field === "outcome") out[w] = outcomePhrase(step.kind, w);
    else if (field === "approval.outcome") {
      out[w] = APPROVAL_PHRASE[w as processes.ApprovalOutcome] ?? w;
    } else if (field === "choice" && step.kind === "person") {
      const choice = step.choices?.find((c) => c.value === w);
      out[w] = choice ? `“${pickLocalized(choice.label)}”` : w;
    } else out[w] = VERDICT_PHRASE[w as processes.ConferVerdict] ?? w;
  }
  return out;
}

/**
 * The field picker's paths with words for how each earlier step ended: "Approve the bill: how it
 * ended", its values "was rejected", "nobody answered"… Outputs and the trigger keep their paths.
 */
export function labelPaths(process: Pick<Process, "steps">, paths: readonly PathOption[]) {
  return paths.map((p): PickPath => {
    if (!p.stepId) return p;
    const prefix = `steps.${p.stepId}.`;
    if (!p.path.startsWith(prefix)) return p;
    const field = p.path.slice(prefix.length);
    if (field === "output" || field.startsWith("output.")) return p;
    const step = processes.findStep(process, p.stepId)?.step;
    if (!step) return p;
    const values = valuePhrases(step, field);
    // Only what the step can reach as set up (the schema's enum), in words.
    const reachable = Array.isArray(p.schema?.enum)
      ? Object.fromEntries(
          (p.schema.enum as string[]).map((v) => [v, values?.[v] ?? v] as [string, string]),
        )
      : values;
    return {
      ...p,
      label: `${step.name || step.kind}: ${fieldPhrase(field)}`,
      ...(reachable ? { values: reachable } : {}),
    };
  });
}

/** One rule a click adds: "Approve the bill: was rejected". */
export interface QuickRule {
  key: string;
  label: string;
  rule: Rule;
}

/** Every earlier step's reachable outcomes as one-click rules, for an `if` path's conditions. */
export function outcomeRules(paths: readonly PickPath[]): QuickRule[] {
  const out: QuickRule[] = [];
  for (const p of paths) {
    if (!p.stepId || p.path !== `steps.${p.stepId}.outcome` || !p.values) continue;
    const name = p.label?.replace(/: how it ended$/, "") ?? p.stepId;
    for (const [value, phrase] of Object.entries(p.values)) {
      out.push({
        key: `${p.path}=${value}`,
        label: `${name}: ${phrase}`,
        rule: { field: `{{${p.path}}}`, op: "=", value },
      });
    }
  }
  return out;
}

// ── Routes a step offers ─────────────────────────────────────────────────────────────────────────

/** What a route needs the step to do so the run goes on to it. */
export interface RouteChange {
  /** The setting it changes, as the inspector names it. */
  setting: string;
  /** In a sentence: what the step now does. */
  says: string;
}

/** A route a later `if` can take on how this step ended, and what it needs the step to do. */
export interface RouteOption {
  key: string;
  /** "was rejected", "answered “Drop it”". */
  label: string;
  /** The new path's name ("Rejected"); the if is "If rejected". */
  pathName: string;
  rule: Rule;
  /** Null when the run already goes on with this outcome. */
  change: RouteChange | null;
  /** The step as it must be for the route (itself when nothing changes). */
  apply(step: Step): Step;
}

/** The step kinds `onError` may be set on (the validator's `on_error_not_here` refuses the rest). */
export function takesOnError(step: Pick<Step, "kind">): boolean {
  return !["if", "stop", "wait", "person"].includes(step.kind);
}

const FAILURES = new Set(["failed", "needs_help", "some_failed", "all_failed", "stopped"]);

/**
 * A deadline's "nobody answered" that goes on: `stop` becomes `skip` (the step is skipped, nothing
 * written), an escalation's own deadline likewise; `skip` and `proceed` already go on. Null when it
 * already goes on.
 */
// DECISION (wave 5, web): a route on "nobody answered" sets `skip`, never `proceed`: the step is
// skipped and writes nothing, so no approval is loosened (invariant 8; `proceed` on a write stays
// the operator's choice where the connection allows it).
export function goOnWhenNoAnswer(then: DeadlineThen): DeadlineThen | null {
  if (then === "stop") return "skip";
  if (typeof then === "string") return null;
  const inner = goOnWhenNoAnswer(then.escalate.deadline.ifNoAnswer);
  if (inner === null) return null;
  return {
    escalate: {
      ...then.escalate,
      deadline: { ...then.escalate.deadline, ifNoAnswer: inner },
    },
  };
}

const same = (s: Step) => s;

function onErrorContinue(step: Step, word: string): Pick<RouteOption, "change" | "apply"> {
  if (step.onError === "continue") return { change: null, apply: same };
  return {
    change: {
      setting: "If this step fails",
      says:
        word === "needs_help"
          ? "When nobody gives it the help it asks for, the run now carries on to the route."
          : "When it fails, the run now carries on to the route instead of stopping.",
    },
    apply: (s) => ({ ...s, onError: "continue" }),
  };
}

function approvalOnReject(step: Step): Pick<RouteOption, "change" | "apply"> | null {
  const approval = step.checks?.approval;
  if (!approval) return null;
  if (approval.onReject === "continue") return { change: null, apply: same };
  return {
    change: {
      setting: "If rejected",
      says: "When a person rejects it, the step is skipped and the run goes on to the route. Approval stays on.",
    },
    apply: (s) => {
      const a = s.checks?.approval;
      return a ? { ...s, checks: { ...s.checks, approval: { ...a, onReject: "continue" } } } : s;
    },
  };
}

function approvalNoAnswer(step: Step): Pick<RouteOption, "change" | "apply"> | null {
  const approval = step.checks?.approval;
  if (!approval || approval.ifNoAnswer === "proceed") return null;
  const next = goOnWhenNoAnswer(approval.ifNoAnswer);
  if (next === null) return { change: null, apply: same };
  return {
    change: {
      setting: "If nobody answers",
      says: "When nobody approves in time, the step is skipped and the run goes on to the route. Approval stays on.",
    },
    apply: (s) => {
      const a = s.checks?.approval;
      return a ? { ...s, checks: { ...s.checks, approval: { ...a, ifNoAnswer: next } } } : s;
    },
  };
}

function deadlineNoAnswer(
  then: DeadlineThen,
  set: (s: Step, then: DeadlineThen) => Step,
  says: string,
): Pick<RouteOption, "change" | "apply"> {
  const next = goOnWhenNoAnswer(then);
  if (next === null) return { change: null, apply: same };
  return { change: { setting: "If nobody answers", says }, apply: (s) => set(s, next) };
}

/** What a step must do so the run goes on with this outcome; null when it can't end that way. */
function needsFor(step: Step, word: string): Pick<RouteOption, "change" | "apply"> | null {
  if (FAILURES.has(word)) return takesOnError(step) ? onErrorContinue(step, word) : null;
  switch (step.kind) {
    case "read":
    case "skill":
    case "write":
      if (word === "rejected") return approvalOnReject(step);
      if (word === "no_answer") return approvalNoAnswer(step);
      // The owner's skip is theirs to make; a route on it is set in the condition editor.
      if (word === "skipped") return null;
      return { change: null, apply: same };
    case "person":
      if (word === "no_answer") {
        return deadlineNoAnswer(
          step.deadline.ifNoAnswer,
          (s, then) =>
            s.kind === "person" ? { ...s, deadline: { ...s.deadline, ifNoAnswer: then } } : s,
          "When nobody answers in time, the run goes on to the route.",
        );
      }
      return { change: null, apply: same };
    case "conversation":
      if (word === "declined") return approvalOnReject(step);
      if (word === "no_answer") {
        return deadlineNoAnswer(
          step.deadline.ifNoAnswer,
          (s, then) =>
            s.kind === "conversation" ? { ...s, deadline: { ...s.deadline, ifNoAnswer: then } } : s,
          "When they don't answer in time, the step is skipped and the run goes on to the route.",
        );
      }
      return { change: null, apply: same };
    case "notify": {
      const urgent = step.notify.urgent;
      if (word === "not_seen") {
        if (!urgent) return null;
        return deadlineNoAnswer(
          urgent.ifNoAnswer,
          (s, then) =>
            s.kind === "notify" && s.notify.urgent
              ? { ...s, notify: { ...s.notify, urgent: { ...s.notify.urgent, ifNoAnswer: then } } }
              : s,
          "When nobody marks it seen in time, the run goes on to the route.",
        );
      }
      if (word === "skipped" && !step.notify.when) return null;
      return { change: null, apply: same };
    }
    case "wait":
      return word === "arrived" ? null : { change: null, apply: same };
    default:
      return { change: null, apply: same };
  }
}

/**
 * The routes a later `if` can take on how this step ended, each with what it needs the step to do
 * (null: the run already goes on with it). A person's quick answers are routes too, and an
 * approve step's no.
 */
export function routeOptions(step: Step): RouteOption[] {
  if (!processes.hasOutcome(step.kind)) return [];
  const out: RouteOption[] = [];
  for (const word of processes.STEP_OUTCOMES[step.kind] as readonly string[]) {
    const needs = needsFor(step, word);
    if (!needs) continue;
    out.push({
      key: word,
      label: outcomePhrase(step.kind, word),
      pathName: ROUTE_NAME[word] ?? word,
      rule: { field: `{{steps.${step.id}.outcome}}`, op: "=", value: word },
      ...needs,
    });
  }
  if (step.kind === "person") {
    for (const c of step.choices ?? []) {
      const label = pickLocalized(c.label);
      out.push({
        key: `choice:${c.value}`,
        label: `answered “${label}”`,
        pathName: label,
        rule: { field: `{{steps.${step.id}.choice}}`, op: "=", value: c.value },
        change: null,
        apply: same,
      });
    }
    if (step.mode === "approve") {
      out.push({
        key: "said_no",
        label: "said no",
        pathName: "Said no",
        rule: { field: `{{steps.${step.id}.output.approved}}`, op: "is", value: false },
        change:
          step.onReject === "continue"
            ? null
            : {
                setting: "If rejected",
                says: "When they say no, the run goes on to the route instead of stopping.",
              },
        apply: (s) => (s.kind === "person" ? { ...s, onReject: "continue" } : s),
      });
    }
  }
  return out;
}

/**
 * Puts an `if` right after the step, with one path for the route (its condition the step's
 * outcome, no steps yet) and an empty otherwise, and sets on the step what the route needs. The if
 * sits in the step's own list, so it reads only steps before it (the validator's rule).
 */
export function addRouteAfter(
  process: Process,
  stepId: string,
  option: RouteOption,
  newId: NewId = uuidv7,
): { process: Process; ifId: string } | null {
  const loc = locate(process, stepId);
  if (!loc) return null;
  const route: Step = {
    id: newId(),
    kind: "if",
    name: `If ${option.pathName.charAt(0).toLowerCase()}${option.pathName.slice(1)}`,
    paths: [
      {
        id: newId(),
        name: option.pathName,
        when: { match: "all", rules: [option.rule] },
        steps: [],
      },
    ],
    otherwise: { id: newId(), steps: [] },
  };
  const changed = updateStep(process, stepId, option.apply);
  return { process: insertStep(changed, loc.container, loc.index + 1, route), ifId: route.id };
}
