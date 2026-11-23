// Words and times the back office's command center, runs list and run page share (English only).

import {
  approvalExpired,
  escalationWords,
  type NobodyToAct,
  type OversightDecisionView,
  type RunState,
  type RunStateFields,
  type RunWait,
  runState,
} from "@countersign/core";
import { shortTime } from "../../runs/format";
import { qualifiedToolLabel } from "../../runs/labels";
import type { Tone } from "../../ui/primitives";
import { type ChipState, runChipState } from "../../ui/status";

/** "under an hour", "14 h", "3 days": how long since `iso`, at `now`. */
export function age(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  return hoursWords((now.getTime() - new Date(iso).getTime()) / 3_600_000);
}

/** A number of hours as "under an hour", "14 h" (under 2 days) or "10 days". */
export function hoursWords(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return "under an hour";
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** Seconds as "26 h", "3 days", "under an hour". */
export function ageSeconds(seconds: number | null): string {
  if (seconds === null) return "";
  return age(new Date(Date.now() - seconds * 1000).toISOString());
}

/** 0.982 → "98.2%"; null → null. */
export function percent(share: number | null): string | null {
  if (share === null) return null;
  const p = Math.round(share * 1000) / 10;
  return `${p}%`;
}

/** "1 client", "8 clients". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const RUN_STATUS_WORDS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for approval",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATE_WORDS: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for approval",
  done: "Done",
  failed: "Failed",
  stopped: "Cancelled",
};

const STATE_CHIP: Record<RunState, ChipState> = {
  queued: "idle",
  running: "running",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  stopped: "idle",
};

/** Who a run waits on, in a few words: "client admin", "Ana Ruiz", "us". */
export function waitOnWords(w: Pick<RunWait, "on" | "person">): string {
  switch (w.on) {
    case "client_admin":
      return "client admin";
    case "client_team":
      return "client's team";
    case "person":
      return w.person ?? "a named person";
    case "operator":
      return "us";
  }
}

/** Why nobody can act on an approval, as a sentence. */
export const NOBODY_TO_ACT_WORDS: Record<NobodyToAct, string> = {
  no_approver: "Nobody at the client may approve it.",
  not_signed_in: "Everyone who may approve it is still invited and hasn't signed in.",
  no_email: "We aren't sending emails, so nobody was told.",
};

/** The same, for several items at once. */
export const NOBODY_TO_ACT_MANY_WORDS: Record<NobodyToAct, string> = {
  no_approver: "Nobody at the client may approve them.",
  not_signed_in: "Everyone who may approve them is still invited and hasn't signed in.",
  no_email: "We aren't sending emails, so nobody was told.",
};

/**
 * A run's status as a chip (UI cleanup, stream A): its state and its words, from the run itself so a
 * run waiting on a person reads "Waiting for approval · client admin", never "Running". Takes any
 * back-office run shape (`status` and `waiting`); a bare status still works.
 */
export function runChip(run: string | RunStateFields): { state: ChipState; words: string } {
  if (typeof run === "string") {
    return { state: runChipState(run), words: RUN_STATUS_WORDS[run] ?? run };
  }
  const state = runState(run);
  const wait = typeof run.waiting === "object" && run.waiting ? run.waiting : null;
  const words =
    state === "waiting" && wait
      ? `${STATE_WORDS.waiting} · ${waitOnWords(wait)}`
      : STATE_WORDS[state];
  return { state: STATE_CHIP[state], words };
}

/** "Waiting for approval · client admin · 39 h", with why nobody can act when that's so. */
export function waitLine(w: RunWait, now: Date = new Date()): string {
  return `${STATE_WORDS.waiting} · ${waitOnWords(w)} · ${age(w.since, now)}`;
}

const ERROR_REASON_WORDS: Record<string, string> = {
  timeout: "Timed out waiting",
  rejected: "Turned down",
  stop: "Stopped by the workflow",
};

/**
 * A failed run's error in plain words: its reason's first line (a known code in words), then the
 * step it failed at by name: "QuickBooks said 401 · at Match the bill".
 */
export function runErrorLine(error: unknown, stepName?: string | null): string {
  const parts = runErrorParts(error);
  const plain = parts.reason ? checkFailureWords(parts.reason) : null;
  const first = parts.reason?.split("\n")[0]?.trim() ?? "";
  const reason =
    plain ??
    escalationWords(first) ??
    (first
      ? (ERROR_REASON_WORDS[first] ?? (first.length > 120 ? `${first.slice(0, 119)}…` : first))
      : "Failed without a reason");
  return stepName ? `${reason} · at ${stepName}` : reason;
}

/** A failed check's message (Zod's) in a few plain words: what was wrong with the value. */
const CHECK_WORDS: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^invalid uuid$/i, "an id isn't in the right form"],
  [/^invalid email/i, "an email address isn't in the right form"],
  [/^invalid (url|uri)/i, "a link isn't in the right form"],
  [/^invalid (iso )?(date|datetime)/i, "a date isn't in the right form"],
  [/^required$/i, "a value is missing"],
  [/^(?:invalid input: )?expected \w+, received (?:undefined|null)$/i, "a value is missing"],
  [/^invalid input: expected (\w+)/i, (m) => `a value isn't ${article(m[1] ?? "")}`],
  [/^invalid (option|enum value)/i, "a value isn't one of the choices"],
  [/^too (small|big)/i, "a value is out of range"],
  [/^unrecognized key/i, "it has a field it shouldn't"],
];

const KIND_WORDS: Record<string, string> = {
  string: "text",
  number: "a number",
  int: "a whole number",
  boolean: "yes or no",
  array: "a list",
  object: "a set of fields",
  date: "a date",
};

function article(kind: string): string {
  return KIND_WORDS[kind.toLowerCase()] ?? kind;
}

/** One failed check: its message and, when given, the field it is about. */
interface CheckIssue {
  message: string;
  path: string | null;
}

/**
 * The failed checks in a reason, when the reason is a validation report rather than words: Zod's
 * pretty form ("✖ Invalid UUID\n  → at trigger.documentId") or its issues as JSON.
 */
function checkIssues(reason: string): CheckIssue[] | null {
  const text = reason.trim();
  if (text.startsWith("✖")) {
    const issues: CheckIssue[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("✖")) issues.push({ message: t.slice(1).trim(), path: null });
      else if (t.startsWith("→ at ")) {
        const last = issues[issues.length - 1];
        if (last) last.path = t.slice(5).trim();
      }
    }
    return issues.length ? issues : null;
  }
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      const issues = parsed.flatMap((i): CheckIssue[] => {
        if (!i || typeof i !== "object" || typeof i.message !== "string") return [];
        const path = Array.isArray(i.path) && i.path.length ? i.path.join(".") : null;
        return [{ message: i.message, path }];
      });
      return issues.length ? issues : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A validation report as one plain sentence for a list row: "The input wasn't valid: an id isn't
 * in the right form (documentId)", "… and 2 more". Null when the reason is not one; the run page
 * keeps the raw text.
 */
// DECISION (QA, runs and dates): the runs list shows a failed check in words, from Zod's own
// report; the field is its path's last part. The report itself stays on the run page.
export function checkFailureWords(reason: string): string | null {
  const issues = checkIssues(reason);
  const first = issues?.[0];
  if (!issues || !first) return null;
  let what = "a value isn't in the right form";
  for (const [pattern, words] of CHECK_WORDS) {
    const m = pattern.exec(first.message);
    if (m) {
      what = typeof words === "string" ? words : words(m);
      break;
    }
  }
  const field = first.path?.split(".").filter(Boolean).pop();
  const more = issues.length > 1 ? `, and ${plural(issues.length - 1, "more", "more")}` : "";
  return `The input wasn't valid: ${what}${field ? ` (${field})` : ""}${more}`;
}

/**
 * The runs a list row stands for: one run, or several failed runs alike (`sameFailure`) folded
 * into one row that opens to show them.
 */
export type RunListItem<R> = { kind: "run"; run: R } | { kind: "same"; key: string; runs: R[] };

/** The fewest alike failures folded into one row. */
export const FOLD_AT = 3;

/**
 * What makes failed runs alike enough to fold: the same client, agent, mode, step and error in
 * words. Null for a run that isn't failed.
 */
export function sameFailureKey(r: {
  status: string;
  tenantId: string;
  agentId: string;
  mode: string;
  error: unknown;
  errorStep?: string | null | undefined;
}): string | null {
  if (r.status !== "failed") return null;
  return [r.tenantId, r.agentId, r.mode, runErrorLine(r.error, r.errorStep)].join("|");
}

/**
 * The list's rows in its order: failed runs alike, `FOLD_AT` or more, become one row where the
 * first of them is; the rest stay as they are.
 */
// DECISION (QA, runs and dates): repeated identical failures fold into one row ("32 failed test
// runs, same error") that opens in place, rather than test runs being hidden by default: the same
// failure repeated is the noise whatever the mode, and a hidden test run would hide the failure.
export function foldSameFailures<R extends Parameters<typeof sameFailureKey>[0] & { id: string }>(
  runs: readonly R[],
): RunListItem<R>[] {
  const byKey = new Map<string, R[]>();
  for (const r of runs) {
    const key = sameFailureKey(r);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const out: RunListItem<R>[] = [];
  const placed = new Set<string>();
  for (const r of runs) {
    const key = sameFailureKey(r);
    const alike = key ? byKey.get(key) : undefined;
    if (!key || !alike || alike.length < FOLD_AT) {
      out.push({ kind: "run", run: r });
    } else if (!placed.has(key)) {
      placed.add(key);
      out.push({ kind: "same", key, runs: alike });
    }
  }
  return out;
}

/** "32 failed test runs, same error". */
export function sameFailureWords(runs: readonly { mode: string }[]): string {
  const test = runs.every((r) => r.mode === "test");
  return `${runs.length} failed ${test ? "test runs" : "runs"}, same error`;
}

// ── Run oversight (ARCHITECTURE §10.11) ──

export const OVERSIGHT_ACTION_WORDS: Record<OversightDecisionView["action"], string> = {
  continue: "Continued",
  retry: "Retried the step",
  retry_with: "Retried with a corrected input",
  ask: "Asked a person",
  stop: "Stopped the run",
};

export const OVERSIGHT_CAUSE_WORDS: Record<OversightDecisionView["cause"], string> = {
  failed: "after a failed step",
  checkpoint: "at a checkpoint",
};

/** "Retried the step after a failed step". */
export function oversightLine(d: Pick<OversightDecisionView, "action" | "cause">): string {
  return `${OVERSIGHT_ACTION_WORDS[d.action]} ${OVERSIGHT_CAUSE_WORDS[d.cause]}`;
}

// R6/R8 (ARCHITECTURE §10.14 "Agents and their owner"): the oversight is the agent's owner, the AI
// that watches every step and fixes within limits; the run view says what it did in its words.
export const OWNER_ACTION_WORDS: Record<OversightDecisionView["action"], string> = {
  continue: "Let it go on",
  retry: "Tried the step again",
  retry_with: "Corrected the input and tried again",
  ask: "Asked the lead",
  stop: "Stopped the run",
};

/** "The owner corrected the input and tried again after a failed step". */
export function ownerLine(d: Pick<OversightDecisionView, "action" | "cause">): string {
  const what = OWNER_ACTION_WORDS[d.action];
  return `The owner ${what.charAt(0).toLowerCase()}${what.slice(1)} ${OVERSIGHT_CAUSE_WORDS[d.cause]}`;
}

/** The run's error object's parts (`{ reason, nodeId, key }`, older runs `{ code, message }`). */
export function runErrorParts(error: unknown): {
  reason: string | null;
  nodeId: string | null;
  key: string | null;
} {
  if (typeof error === "string") return { reason: error, nodeId: null, key: null };
  if (!error || typeof error !== "object") return { reason: null, nodeId: null, key: null };
  const e = error as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    reason: text(e.reason) ?? text(e.message),
    nodeId: text(e.nodeId),
    key: text(e.key) ?? text(e.code),
  };
}

const ERROR_WHERE_WORDS: Record<string, string> = {
  skill: "A skill step",
  person: "A person step",
  logic: "A logic step",
  run: "Before any step",
  action: "A change to a tool",
};

/**
 * A failed-runs group's key in words (`<tool id or step kind>:<code>`): "testkit.record.update:
 * unauthorized" → "Testkit · Update a record · unauthorized", "person:timeout" → "A person step ·
 * timeout", "unknown" → "No reason given".
 */
export function errorGroupLabel(key: string): string {
  const at = key.lastIndexOf(":");
  if (at < 0)
    return key === "unknown" || key === "failed" ? "No reason given" : key.replace(/_/g, " ");
  const where = key.slice(0, at);
  const code = key.slice(at + 1).replace(/_/g, " ");
  const place = where.includes(".")
    ? qualifiedToolLabel(where)
    : (ERROR_WHERE_WORDS[where] ?? where.replace(/[_-]/g, " "));
  return `${place} · ${code}`;
}

/** A change to a client's tool, by its state: "Needs approval", "Approved", "Done · 9:02". */
export function actionBadge(
  a: { status: string; executedAt: string | null; error?: unknown },
  testRun: boolean,
): { label: string; tone: Tone } {
  // S4.5: nobody answered its approval in time: not made, and no person's no.
  if (approvalExpired({ status: a.status, error: a.error ?? null })) {
    return { label: "Not made: no answer in time", tone: "neutral" };
  }
  switch (a.status) {
    case "proposed":
      return testRun
        ? { label: "Would have done", tone: "neutral" }
        : { label: "Needs approval", tone: "warning" };
    case "approved":
    case "executing":
      // A person signed it: copper marks a person's touch.
      return { label: "Approved", tone: "person" };
    case "done":
      return {
        label: a.executedAt ? `Done · ${shortTime(a.executedAt)}` : "Done",
        tone: "positive",
      };
    case "rejected":
      return { label: "Rejected", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "risk" };
    default:
      return { label: a.status, tone: "neutral" };
  }
}
