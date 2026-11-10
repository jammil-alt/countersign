// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): how a step ended, for an `if` to route on. Every
// step of a native v4 process records its outcome in the run scope beside its output:
// `steps.<id>.outcome`, plus per-check detail (`steps.<id>.approval`, `steps.<id>.confer`,
// `steps.<id>.error`, a person's `steps.<id>.choice`, a loop's `steps.<id>.counts`). One closed
// vocabulary per step kind, typed here for the validator and the builder's field picker
// (`processPathsAt` lists them for earlier steps). Conditions stay plain rules over the run: an
// outcome is data the executor derived from what it already stored, never a model's say.

import { runErrorCode } from "../api/run-controls";
import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";
import type { CONVERSATION_STATUSES } from "./conversation";
import { CONFER_VERDICTS, type ConferVerdict, type Step, type StepKind } from "./schema";

// ── The vocabulary ───────────────────────────────────────────────────────────────────────────

/**
 * A read: `done`, or `empty` when it found nothing (`isEmptyOutput`). `rejected` and `no_answer`
 * come from its sign-off (`checks.approval`), `skipped` from the owner (a person declined its ask
 * with `onReject: continue`), `needs_help` (nobody helped) and `failed` only with
 * `onError: continue`.
 */
export const READ_OUTCOMES = [
  "done",
  "empty",
  "rejected",
  "no_answer",
  "skipped",
  "needs_help",
  "failed",
] as const;

/**
 * A skill: `done`; `rejected` or `no_answer` when a write it proposed, or its sign-off, was turned
 * down or nobody answered and the run went on; `skipped` by the owner; `needs_help` and `failed`
 * with `onError: continue`.
 */
export const SKILL_OUTCOMES = [
  "done",
  "rejected",
  "no_answer",
  "skipped",
  "needs_help",
  "failed",
] as const;

/**
 * A write: `done` (written, or signed with `ifNoAnswer: proceed`: then `approval.outcome` is
 * `no_answer`); `rejected` (a person said no, `onReject: continue`); `no_answer` (nobody signed
 * in time and the run went on: `ifNoAnswer: skip`, or `stop` with `onReject: continue`);
 * `skipped` by the owner; `needs_help` and `failed` with `onError: continue` (nothing written).
 */
export const WRITE_OUTCOMES = [
  "done",
  "rejected",
  "no_answer",
  "skipped",
  "needs_help",
  "failed",
] as const;

/**
 * A person: `answered` (an approve step's yes or no is its output's `approved`; a question's
 * quick answer `steps.<id>.choice`), or `no_answer` (its deadline passed with `skip` or
 * `proceed`).
 */
// DECISION (wave 5): a person step has no `skipped` and no `failed`: nothing skips one but its
// deadline, and that is `no_answer` whatever `ifNoAnswer` did (`proceed` on a native step still
// reads as a yes in its output, as before); its only failures are the platform's own (the inbox
// can't be written), which end the run, so `onError` is refused on it.
export const PERSON_OUTCOMES = ["answered", "no_answer"] as const;

/**
 * A conversation: its output's status (`done`, `not_found`, `no_answer`), `declined` (a message
 * not approved or a person ended it, `onReject: continue`), `failed` with `onError: continue`.
 */
export const CONVERSATION_OUTCOMES = [
  "done",
  "not_found",
  "declined",
  "no_answer",
  "failed",
] as const satisfies readonly ((typeof CONVERSATION_STATUSES)[number] | "declined" | "failed")[];

/**
 * A notify step: `sent` (a test run's too, so it takes the live run's path), `skipped` (its `when`
 * didn't apply), `not_seen` (urgent, no "Seen" in time and its `ifNoAnswer` went on), `failed`
 * with `onError: continue`.
 */
export const NOTIFY_OUTCOMES = ["sent", "skipped", "not_seen", "failed"] as const;

/**
 * A wait: `timed_out` (its time ran out) or `arrived` (what it waited for came).
 */
// DECISION (wave 5): a v4 wait waits for a duration only, so it always ends `timed_out`; `arrived`
// is the word for a wait on an event, kept in the vocabulary (the validator accepts it) but never
// offered by the field picker until a wait can say what it waits for.
export const WAIT_OUTCOMES = ["arrived", "timed_out"] as const;

/**
 * A for each: `done`, or with `onError: continue`, `some_failed` / `all_failed` (an item whose
 * steps failed doesn't stop the others), with `steps.<id>.counts` `{ items, failed }`.
 */
export const FOR_EACH_OUTCOMES = ["done", "some_failed", "all_failed"] as const;

/**
 * A process step: `completed`, or with `onError: continue`, `stopped` (a stop step inside ended the
 * sub-process alone; `steps.<id>.stopStatus` is how that stop would have ended the run) or
 * `failed` (a step inside failed).
 */
export const PROCESS_OUTCOMES = ["completed", "stopped", "failed"] as const;

/** How a stop step ends the run (its `status`), and a stopped process's `stopStatus`. */
export const STOP_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

/** Every kind's vocabulary. `if` and `stop` have none (an `if`'s output says its path). */
export const STEP_OUTCOMES = {
  read: READ_OUTCOMES,
  skill: SKILL_OUTCOMES,
  write: WRITE_OUTCOMES,
  person: PERSON_OUTCOMES,
  conversation: CONVERSATION_OUTCOMES,
  notify: NOTIFY_OUTCOMES,
  wait: WAIT_OUTCOMES,
  for_each: FOR_EACH_OUTCOMES,
  process: PROCESS_OUTCOMES,
} as const satisfies Partial<Record<StepKind, readonly string[]>>;

export type OutcomeKind = keyof typeof STEP_OUTCOMES;
export type StepOutcomeOf<K extends OutcomeKind> = (typeof STEP_OUTCOMES)[K][number];
export type StepOutcomeWord = StepOutcomeOf<OutcomeKind>;

/**
 * A read's, skill's or write's approval: signed (`approved`), turned down (`rejected`), nobody
 * answered in time (`no_answer`, whatever `ifNoAnswer` then did), or nobody was asked
 * (`not_needed`: the gate let it run, or it proposed nothing).
 */
export const APPROVAL_OUTCOMES = ["approved", "rejected", "no_answer", "not_needed"] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** How a step ended, as the run scope holds it beside the step's `output`. */
export interface StepRecord {
  outcome?: string;
  approval?: { outcome: ApprovalOutcome; by?: string | null };
  /** `verdict` (all reviewers together) and each reviewer by place: `"0"`, `"1"`… */
  confer?: Record<string, unknown>;
  /** A failure the run went on past (`onError: continue`): a code and a plain reason. */
  error?: { code: string; message: string };
  /** A person step's quick answer (one of its `choices`' values). */
  choice?: string;
  /** A for each's items and how many failed. */
  counts?: { items: number; failed: number };
  /**
   * A process that `stopped`: the status the stop step inside had, which would have ended the run
   * that way without `onError: continue` (a route keeps it: `succeeded`, `failed`, `cancelled`).
   */
  stopStatus?: StopStatus;
}

/** Whether a step kind records an outcome. */
export function hasOutcome(kind: StepKind): kind is OutcomeKind {
  return Object.hasOwn(STEP_OUTCOMES, kind);
}

/** The kinds that carry an approval (`steps.<id>.approval`) and a confer (`steps.<id>.confer`). */
const WORK_KINDS = new Set<StepKind>(["read", "skill", "write"]);

// ── What a step can end with ─────────────────────────────────────────────────────────────────

/**
 * The outcomes a step can end with and a later step still sees, given how it is set up: `failed`
 * (and `needs_help`, a loop's or a process's failures) only with `onError: continue`; a read's
 * `rejected` and `no_answer` only with an approval; a notify's `skipped` only with a `when`, its
 * `not_seen` only when urgent. The field picker offers these; the validator accepts any word of
 * the kind's vocabulary and warns on the rest (`outcome_unreachable`).
 */
export function stepOutcomes(step: Step): readonly string[] {
  if (!hasOutcome(step.kind)) return [];
  const continues = step.onError === "continue";
  const drop = new Set<string>();
  if (!continues) {
    for (const w of ["failed", "needs_help", "some_failed", "all_failed", "stopped"]) drop.add(w);
  }
  switch (step.kind) {
    case "read":
      if (!step.checks?.approval) {
        drop.add("rejected");
        drop.add("no_answer");
      }
      break;
    case "notify":
      if (!step.notify.when) drop.add("skipped");
      if (!step.notify.urgent) drop.add("not_seen");
      break;
    case "wait":
      drop.add("arrived");
      break;
    default:
      break;
  }
  return STEP_OUTCOMES[step.kind].filter((w) => !drop.has(w));
}

// ── Typing (the validator and the field picker) ──────────────────────────────────────────────

const VERDICT: JsonSchema = { type: "string", enum: [...CONFER_VERDICTS] };

/**
 * The JSON schema of what a step records beside its output (`steps.<id>.<field>`), its enums the
 * step's reachable values. Undefined for a step that records nothing (`if`, `stop`).
 */
export function stepRecordSchema(step: Step): JsonSchema | undefined {
  if (!hasOutcome(step.kind)) return undefined;
  const properties: Record<string, JsonSchema> = {
    outcome: { type: "string", enum: [...stepOutcomes(step)] },
  };
  if (WORK_KINDS.has(step.kind)) {
    properties.approval = {
      type: "object",
      properties: {
        outcome: { type: "string", enum: [...APPROVAL_OUTCOMES] },
        // The user id of who answered; null when nobody did.
        by: { type: ["string", "null"] },
      },
      required: ["outcome"],
      additionalProperties: false,
    };
    const reviewers = step.checks?.confer?.with.length ?? 0;
    if (reviewers > 0) {
      const confer: Record<string, JsonSchema> = { verdict: VERDICT };
      for (let n = 0; n < reviewers; n += 1) {
        confer[String(n)] = {
          type: "object",
          properties: { verdict: VERDICT, by: { type: "string" } },
          required: ["verdict"],
          additionalProperties: false,
        };
      }
      properties.confer = { type: "object", properties: confer, additionalProperties: false };
    }
  }
  if (step.kind === "person" && step.choices && step.choices.length > 0) {
    properties.choice = { type: "string", enum: step.choices.map((c) => c.value) };
  }
  if (step.kind === "for_each") {
    properties.counts = {
      type: "object",
      properties: { items: { type: "integer" }, failed: { type: "integer" } },
      required: ["items", "failed"],
      additionalProperties: false,
    };
  }
  if (step.kind === "process" && step.onError === "continue") {
    properties.stopStatus = { type: "string", enum: [...STOP_STATUSES] };
  }
  if (step.onError === "continue") {
    properties.error = {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties,
    required: ["outcome"],
    additionalProperties: false,
  };
}

/** The top-level fields a step records beside its output (`outcome`, `approval`, …). */
export function stepRecordFields(step: Step): string[] {
  const schema = stepRecordSchema(step);
  return schema && isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
}

/** One routable field of a step, relative to `steps.<id>.` (e.g. `approval.outcome`). */
export interface OutcomeField {
  path: string;
  schema: JsonSchema;
}

/**
 * The routable fields a step records, leaves only, relative to `steps.<id>.`, with their types:
 * `outcome`, `approval.outcome`, `approval.by`, `confer.verdict`, `confer.<n>.verdict`,
 * `confer.<n>.by`, `choice`, `counts.items`, `counts.failed`, `stopStatus`, `error.code`,
 * `error.message`. The
 * builder's field picker lists them for earlier steps (`processPathsAt`) as `steps.<id>.<path>`.
 */
export function stepOutcomeFields(step: Step): OutcomeField[] {
  const schema = stepRecordSchema(step);
  if (!schema) return [];
  const out: OutcomeField[] = [];
  const walk = (s: JsonSchema, prefix: string) => {
    const props = isPlainObject(s.properties) ? (s.properties as Record<string, JsonSchema>) : {};
    // Named fields before reviewers by place (an object lists number-like keys first).
    const keys = Object.keys(props);
    const ordered = [
      ...keys.filter((k) => !/^\d+$/.test(k)),
      ...keys.filter((k) => /^\d+$/.test(k)),
    ];
    for (const k of ordered) {
      const v = props[k] as JsonSchema;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v.type === "object") walk(v, path);
      else out.push({ path, schema: v });
    }
  };
  walk(schema, "");
  return out;
}

/**
 * The whole vocabulary a record field may hold for the step's kind (wider than `stepRecordSchema`,
 * which holds what the step can reach): the validator's check of a compared value. Null for a
 * field with no closed vocabulary.
 */
export function outcomeVocabulary(step: Step, field: readonly string[]): readonly string[] | null {
  const [head, second, third] = field;
  if (head === "outcome" && second === undefined) {
    return hasOutcome(step.kind) ? STEP_OUTCOMES[step.kind] : null;
  }
  if (head === "approval" && second === "outcome" && third === undefined) return APPROVAL_OUTCOMES;
  if (head === "confer" && second === "verdict" && third === undefined) return CONFER_VERDICTS;
  if (head === "confer" && second !== undefined && /^\d+$/.test(second) && third === "verdict") {
    return CONFER_VERDICTS;
  }
  if (head === "choice" && second === undefined && step.kind === "person") {
    return step.choices?.map((c) => c.value) ?? null;
  }
  if (head === "stopStatus" && second === undefined && step.kind === "process") {
    return STOP_STATUSES;
  }
  return null;
}

// ── Deriving an outcome (the executor; replay-stable inputs only) ─────────────────────────────

/**
 * Whether a read found nothing: no output, `null`, `""`, `[]`, `{}`, or an object whose every
 * field is `null` or an empty list (`{ items: [], next: null }`, a list tool that found none).
 */
// DECISION (wave 5): "empty" is decided on the output's shape alone, the same for every tool: a
// count of 0 or `found: false` is a value, not emptiness (route on the output field for those).
export function isEmptyOutput(output: unknown): boolean {
  if (output === undefined || output === null || output === "") return true;
  if (Array.isArray(output)) return output.length === 0;
  if (isPlainObject(output)) {
    return Object.values(output).every(
      (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0),
    );
  }
  return false;
}

/**
 * All of a confer's reviewers together: `disagree` if any disagreed, else `unsure` if any was
 * unsure, else `agree` if any agreed, else `no_answer` (nobody answered, or none was asked).
 */
// DECISION (wave 5): the combined verdict is the most cautious one given, so a route on
// `confer.verdict = agree` never hides a reviewer's "no".
export function combinedVerdict(verdicts: readonly (ConferVerdict | null)[]): ConferVerdict {
  const given = verdicts.filter((v): v is ConferVerdict => v !== null);
  for (const v of ["disagree", "unsure", "agree"] as const) if (given.includes(v)) return v;
  return "no_answer";
}

/** The confer record: the combined verdict and each reviewer by place (null: not asked). */
export function conferRecord(
  entries: readonly ({ verdict: ConferVerdict; by: string } | null)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    verdict: combinedVerdict(entries.map((e) => e?.verdict ?? null)),
  };
  entries.forEach((e, n) => {
    if (e) out[String(n)] = { verdict: e.verdict, by: e.by };
  });
  return out;
}

/**
 * Several approvals of one step (a skill's several proposals) as one: `rejected` if any was turned
 * down, else `no_answer` if any went unanswered, else `approved` (by the last who signed), else
 * `not_needed`.
 */
export function combinedApproval(
  decisions: readonly { outcome: ApprovalOutcome; by?: string | null }[],
): { outcome: ApprovalOutcome; by?: string | null } {
  for (const o of ["rejected", "no_answer", "approved"] as const) {
    const found = decisions.filter((d) => d.outcome === o).at(-1);
    if (found) return found;
  }
  return { outcome: "not_needed" };
}

/** Error text whose write may have happened (`UnconfirmedWriteError`, `runErrorCode`). */
export function writeMayHaveHappened(error: string): boolean {
  return runErrorCode(error) === "unconfirmed" || /check before trying again/i.test(error);
}

const ERROR_MESSAGE_MAX = 200;

/**
 * A failure as a later step reads it (`steps.<id>.error`): a short stable code (`runErrorCode`:
 * `unauthorized`, `rate_limited`, `refused`, `escalated`, `needs_help`, `failed`…) and the step's
 * own error line, cut short, with anything that looks like a key or token hidden.
 */
// DECISION (wave 5): the message is the error the step's row already shows (the run view), first
// line only, at most 200 characters, with runs of 24 or more key-like characters (tokens, keys,
// long ids) replaced by `[hidden]`; never a document's text beyond that line.
export function plainError(error: string, code?: string): { code: string; message: string } {
  const line = (error.split("\n")[0] ?? "").trim();
  const hidden = line.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "[hidden]");
  const message =
    hidden.length > ERROR_MESSAGE_MAX ? `${hidden.slice(0, ERROR_MESSAGE_MAX - 1)}…` : hidden;
  return { code: code ?? runErrorCode(error), message };
}

// ── Reading an outcome back from a step's row (the run view, a retry's reused steps) ─────────

/** A row's node type (or a step's kind) as the outcome vocabulary knows it. */
const KIND_OF_NODE: Record<string, OutcomeKind> = {
  read: "read",
  skill: "skill",
  write: "write",
  action: "write",
  person: "person",
  conversation: "conversation",
  notify: "notify",
  wait: "wait",
  for_each: "for_each",
  process: "process",
  use_automation: "process",
};

const ENDED = new Set(["succeeded", "failed", "skipped", "cancelled"]);

/** What a step's `step_run` row says, and what its checks did, for `outcomeOfRow`. */
export interface RowOutcomeInput {
  /** The row's node type, or the step's kind. */
  kind: string;
  status: string;
  output?: unknown;
  /** The row's error, where it is kept apart from its output. */
  error?: string | null;
  /** The states of the approvers asked on the step (`ApproverView.state`). */
  approvers?: readonly string[];
  /** An urgent notice's "Seen" (`UrgentView.state`). */
  urgent?: string | null;
}

/**
 * How a step ended, read back from its `step_run` row as the executor left it: the same word the
 * run recorded in `steps.<id>.outcome` (the run view's `outcome`; a retry's reused steps). Null
 * while it hasn't ended, or for a kind with no outcome (`if`, `stop`, a check's own row).
 */
export function outcomeOfRow(row: RowOutcomeInput): StepOutcomeWord | null {
  const kind = KIND_OF_NODE[row.kind];
  if (!kind || !ENDED.has(row.status)) return null;
  const out = isPlainObject(row.output) ? row.output : {};
  const error = row.error ?? (typeof out.error === "string" ? out.error : "");
  const approvers = row.approvers ?? [];
  switch (kind) {
    case "read":
    case "skill":
    case "write": {
      if (row.status === "failed") {
        if (/^needs help/i.test(error)) return "needs_help";
        if (/^no answer/i.test(error)) return "no_answer";
        return "failed";
      }
      if (row.status !== "succeeded") {
        if (approvers.includes("rejected")) return "rejected";
        if (approvers.includes("no_answer")) return "no_answer";
        return "skipped";
      }
      return kind === "read" && isEmptyOutput(row.output) ? "empty" : "done";
    }
    case "person":
      if (row.status === "succeeded") return out.proceeded === true ? "no_answer" : "answered";
      return "no_answer";
    case "conversation": {
      if (out.status === "no_answer") return "no_answer";
      if (row.status === "failed") return "failed";
      if (row.status !== "succeeded") return "declined";
      return out.status === "not_found" ? "not_found" : "done";
    }
    case "notify":
      if (row.status === "failed") return "failed";
      if (row.status === "skipped") return "skipped";
      return row.urgent === "not_seen" ? "not_seen" : "sent";
    case "wait":
      return row.status === "succeeded" ? "timed_out" : null;
    case "for_each": {
      if (row.status !== "succeeded") return null;
      const failed = typeof out.failed === "number" ? out.failed : 0;
      if (failed === 0) return "done";
      return typeof out.count === "number" && failed >= out.count ? "all_failed" : "some_failed";
    }
    case "process":
      if (row.status === "succeeded") return "completed";
      return row.status === "failed" ? "failed" : "stopped";
  }
}

/**
 * A retry's reused step, as its stored row reads, when nothing else was kept of it: its outcome
 * word alone (`reusedStepOf` in `api/run-checks` rebuilds the whole record from the run's rows and
 * inbox items, which apps/api hands the executor).
 */
export function outcomeOfStoredRow(
  step: Pick<Step, "kind">,
  row: { status: string; output: unknown },
): StepOutcomeWord | null {
  return outcomeOfRow({ kind: step.kind, status: row.status, output: row.output });
}

/**
 * What a later step reads as `steps.<id>.output` of a reused row: the row's output, except a
 * failed row's, which the step log stored with its error merged in (`{ ..., error }`): that
 * error is the record's `error`, not output, so it is taken out, and nothing left reads as null,
 * as the run that failed recorded it. A stopped process's row (`skipped`) keeps only how the stop
 * inside it ended (`{ stopStatus }`, the record's): its output reads as null, as recorded.
 */
export function scopeOutputOfRow(status: string, output: unknown, kind?: string): unknown {
  if (kind === "process" && status === "skipped") return null;
  if (status !== "failed" || !isPlainObject(output)) return output ?? null;
  const { error: _error, ...rest } = output;
  return Object.keys(rest).length === 0 ? null : rest;
}
