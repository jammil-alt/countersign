// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): how a step ended, in the builder's words. Every
// step of a v4 process records its outcome (`steps.<id>.outcome`, its approval, confer, error, a
// person's quick answer, a loop's counts: core's `processes.stepOutcomeFields`), and an `if` after
// it can route on that like any other field. Here: the plain words the field picker and the rule
// rows show ("Approve the bill: was rejected"), the routes a step offers in its inspector, and
// "Add a route for this", which puts an `if` right after the step. Where a route needs the step to
// go on (an approval's `onReject: continue`, a deadline's `skip`, `onError: continue`), it sets
// that and says so; nothing here loosens an approval (invariant 8: a skipped or failed write
// writes nothing).
import {
  type PathOption,
  pickLocalized,
  processes,
  type Rule,
  singleRef,
  uuidv7,
} from "@countersign/core";
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
  repeat: { done: "was done", limit: "reached its most passes" },
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

const STOP_STATUS_PHRASE: Record<processes.StopStatus, string> = {
  succeeded: "would have ended the run as done",
  failed: "would have ended the run as failed",
  cancelled: "would have ended the run as cancelled",
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
    case "stopStatus":
      return "how the stop inside it ended";
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
    } else if (field === "stopStatus") {
      out[w] = STOP_STATUS_PHRASE[w as processes.StopStatus] ?? w;
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
  /**
   * How the new route's stop step ends the run, where the run used to stop with this outcome
   * (`change` set): a no ends it `cancelled`, nobody answering or a failure `failed`, as before;
   * a process's `stopped` (`as_inside`) as the stop inside it would have (its `stopStatus`). Null:
   * the route ends with nothing and the run carries on below it.
   */
  stop: RouteStop | null;
  /**
   * The step's other failures the change opens beside this one (`onError: continue` opens them
   * all): a second path on them ends the run as before, so none goes on to the steps below.
   */
  others: string[];
  /** The step as it must be for the route (itself when nothing changes). */
  apply(step: Step): Step;
}

/** What the inspector says of a route that ends with a stop step (`RouteOption.stop`). */
export const ROUTE_STOP_SAYS =
  "The route ends with a stop step, so nothing below it runs, as before. Remove that stop to carry on below.";

/** How a route's stop ends the run (`RouteOption.stop`). */
export type RouteStop = "cancelled" | "failed" | "as_inside";

/**
 * The run's end a route's stop step keeps: a no is `cancelled`, a process's `stopped` as the stop
 * inside it would have (`as_inside`), anything else `failed`.
 */
function stopFor(step: Pick<Step, "kind">, word: string): RouteStop {
  if (step.kind === "process" && word === "stopped") return "as_inside";
  return word === "rejected" || word === "declined" || word === "said_no" ? "cancelled" : "failed";
}

/** The step kinds `onError` may be set on (the validator's `on_error_not_here` refuses the rest). */
export function takesOnError(step: Pick<Step, "kind">): boolean {
  return !["if", "stop", "wait", "person", "handoff"].includes(step.kind);
}

const FAILURES = new Set(["failed", "needs_help", "some_failed", "all_failed", "stopped"]);

/**
 * The step's other failure words that setting `onError: continue` for a route on `word` opens:
 * a process's `stopped` beside its `failed`, a skill's `needs_help` beside its `failed`, a loop's
 * `all_failed` beside its `some_failed`. None when the step already goes on past a failure.
 */
export function alsoOpens(step: Step, word: string): string[] {
  if (!FAILURES.has(word) || step.onError === "continue" || !takesOnError(step)) return [];
  if (!processes.hasOutcome(step.kind)) return [];
  const words = processes.STEP_OUTCOMES[step.kind] as readonly string[];
  return words.filter((w) => w !== word && FAILURES.has(w));
}

/** The second path's name for the other failures a route opens: "Needed help", "All failed". */
function otherPathName(words: readonly string[]): string {
  const names = words.map((w) => ROUTE_NAME[w] ?? w);
  if (names.length < 2) return names[0] ?? "Other failures";
  return `${names.slice(0, -1).join(", ")} or ${(names.at(-1) ?? "").toLowerCase()}`;
}

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
  const others = alsoOpens(step, word);
  const lead =
    word === "needs_help"
      ? "When nobody gives it the help it asks for, the run now carries on to the route."
      : word === "stopped"
        ? "When a stop inside it ends it, the run now carries on to the route."
        : "When it fails, the run now carries on to the route instead of stopping.";
  const also =
    others.length > 0
      ? ` That also lets it carry on when it ${others.map((w) => outcomePhrase(step.kind, w)).join(" or ")}, so a second path, “${otherPathName(others)}”, stops the run there, as before.`
      : "";
  return {
    change: { setting: "If this step fails", says: `${lead}${also}` },
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
      // DECISION (wave 5, web): no one-click route on the owner's skip: it is theirs to make, and
      // a route on it can still be written in the condition editor.
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
      stop: needs.change ? stopFor(step, word) : null,
      others: needs.change ? alsoOpens(step, word) : [],
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
        stop: null,
        others: [],
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
        stop: step.onReject === "continue" ? null : stopFor(step, "said_no"),
        others: [],
        apply: (s) => (s.kind === "person" ? { ...s, onReject: "continue" } : s),
      });
    }
  }
  return out;
}

type IfPath = Extract<Step, { kind: "if" }>["paths"][number];

/**
 * The steps that end the run as it used to end: a stop step with the route's status, or for a
 * process's `stopped` an if on how the stop inside it ended (`steps.<id>.stopStatus`), each path
 * a stop with that status (otherwise `failed`, as for a run stored before the detail was kept).
 */
// DECISION (wave 5 re-review): a stop step's status is fixed, so a stopped process keeps how its
// inner stop would have ended the run as a record detail (`stopStatus`) and the route ends in an
// if on it: an inner "cancelled" or "succeeded" stop ends the run the same way, as before.
function endSteps(stepId: string, stop: RouteStop, newId: NewId): Step[] {
  const stopStep = (status: processes.StopStatus): Step => ({
    id: newId(),
    kind: "stop",
    name: "Stop the run",
    status,
  });
  if (stop !== "as_inside") return [stopStep(stop)];
  const on = (status: processes.StopStatus, name: string): IfPath => ({
    id: newId(),
    name,
    when: {
      match: "all",
      rules: [{ field: `{{steps.${stepId}.stopStatus}}`, op: "=", value: status }],
    },
    steps: [stopStep(status)],
  });
  return [
    {
      id: newId(),
      kind: "if",
      name: "End as the stop inside it",
      paths: [on("cancelled", "Cancelled"), on("succeeded", "Done")],
      otherwise: { id: newId(), steps: [stopStep("failed")] },
    },
  ];
}

/**
 * Puts an `if` right after the step, with one path for the route (its condition the step's
 * outcome) and an empty otherwise, and sets on the step what the route needs. The if sits in the
 * step's own list, so it reads only steps before it (the validator's rule). Where the run used to
 * stop with this outcome, the path ends the run the same way (`option.stop`), and the other
 * failures the change opens (`option.others`) get a second path that ends it too.
 */
// DECISION (wave 5 review): paths rejoin after an `if`, so a route that turns a stop into "go on"
// (a no, nobody answering, a failure) would otherwise let every later step run after it: a
// person's "no" to "OK to pay?" would go on to pay. The new path ends with a stop step instead,
// so nothing below runs unless the operator removes it, and the inspector says so.
export function addRouteAfter(
  process: Process,
  stepId: string,
  option: RouteOption,
  newId: NewId = uuidv7,
): { process: Process; ifId: string } | null {
  const loc = locate(process, stepId);
  if (!loc) return null;
  const ifId = newId();
  const paths: IfPath[] = [
    {
      id: newId(),
      name: option.pathName,
      when: { match: "all", rules: [option.rule] },
      steps: option.stop ? endSteps(stepId, option.stop, newId) : [],
    },
  ];
  // DECISION (wave 5 re-review): `onError: continue` opens every failure of the step, not only
  // the routed one (a process's `stopped` with its `failed`, a skill's `needs_help`, a loop's
  // `all_failed`), and paths rejoin after the if: one more path, on the step's outcome in the
  // others, ends the run as it used to end, so none of them goes on to a write below.
  if (option.others.length > 0) {
    paths.push({
      id: newId(),
      name: otherPathName(option.others),
      when: {
        match: "all",
        rules: [{ field: `{{steps.${stepId}.outcome}}`, op: "in", value: [...option.others] }],
      },
      steps: endSteps(
        stepId,
        option.others.includes("stopped") ? stopFor(loc.step, "stopped") : "failed",
        newId,
      ),
    });
  }
  const route: Step = {
    id: ifId,
    kind: "if",
    name: `If ${option.pathName.charAt(0).toLowerCase()}${option.pathName.slice(1)}`,
    paths,
    otherwise: { id: newId(), steps: [] },
  };
  const changed = updateStep(process, stepId, option.apply);
  return { process: insertStep(changed, loc.container, loc.index + 1, route), ifId };
}

// ── Test runs ────────────────────────────────────────────────────────────────────────────────────

/**
 * The ifs (by name) whose routes read a step's approval (`steps.<id>.approval…`). A test run signs
 * nothing: every write's approval reads `not_needed` there, so such a route goes the way it would
 * with no approval, and the test-run panel says so.
 */
// DECISION (wave 5 review): the simplest honest option: the run records what happened (nobody was
// asked) and the builder's test-run panel names the routes that read it, rather than recording a
// pretend answer a test run never had.
export function approvalRouteNames(process: Pick<Process, "steps">): string[] {
  const names: string[] = [];
  processes.walkSteps(process, ({ step }) => {
    if (step.kind !== "if") return;
    const reads = step.paths.some((p) =>
      p.when.rules.some((r) => {
        let ref: string[] | null = null;
        try {
          ref = typeof r.field === "string" ? singleRef(r.field) : null;
        } catch {
          ref = null;
        }
        return ref?.[0] === "steps" && ref[2] === "approval";
      }),
    );
    if (reads) names.push(step.name || "An if");
  });
  return names;
}

/** What the test-run panel says when routes read an approval (`approvalRouteNames`). */
export function testRunApprovalNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.map((n) => `“${n}”`).join(", ");
  return `${list} ${names.length === 1 ? "routes" : "route"} on an approval. In a test run nobody signs, so each write's approval reads “needed no approval” and the route goes the way it would with none.`;
}

// ── The validator's outcome problems, in words ───────────────────────────────────────────────────

/** An if path or a step by id, as a validation problem names it. */
function nodeById(process: Pick<Process, "steps">, id: string | null): unknown {
  if (!id) return undefined;
  let found: unknown;
  processes.walkSteps(process, ({ step }) => {
    if (found) return;
    if (step.id === id) found = step;
    else if (step.kind === "if") found = step.paths.find((p) => p.id === id);
  });
  return found;
}

function valueAt(value: unknown, path: string): unknown {
  let v = value;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/**
 * The validator's outcome problems in the builder's words (its messages name raw words): a
 * compared word the step's kind never ends with (`outcome_unknown`), and one the step can't reach
 * as set up (`outcome_unreachable`, advice). Any other problem keeps its message.
 */
export function plainOutcomeProblem(
  process: Pick<Process, "steps">,
  p: { stepId: string | null; field: string; code: string; message: string },
): string {
  if (p.code !== "outcome_unknown" && p.code !== "outcome_unreachable") return p.message;
  const rule = valueAt(nodeById(process, p.stepId), p.field.replace(/\.value$/, "")) as
    | Rule
    | undefined;
  let ref: string[] | null = null;
  try {
    ref = rule && typeof rule.field === "string" ? singleRef(rule.field) : null;
  } catch {
    ref = null;
  }
  if (!rule || !ref || ref[0] !== "steps" || !ref[1]) return p.message;
  const step = processes.findStep(process, ref[1])?.step;
  if (!step) return p.message;
  const field = ref.slice(2).join(".");
  const all = valuePhrases(step, field) ?? {};
  const words = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(String);
  const name = `“${step.name || step.kind}”`;
  if (p.code === "outcome_unknown") {
    const bad = words.find((w) => !(w in all)) ?? words[0] ?? "";
    return `“${bad}” isn't a way ${name} can end. Pick one of: ${Object.values(all).join(", ")}.`;
  }
  const reachable = new Set(field === "outcome" ? processes.stepOutcomes(step) : Object.keys(all));
  const word = words.find((w) => !reachable.has(w)) ?? words[0] ?? "";
  const hint =
    FAILURES.has(word) && takesOnError(step) ? ": set “If this step fails” to carry on" : "";
  return `As set up, ${name} never ends “${all[word] ?? word}”, so this condition never holds${hint}.`;
}
