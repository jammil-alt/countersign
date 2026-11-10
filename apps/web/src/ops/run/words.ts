// Words and times the back office's command center, runs list and run page share (English only).

import {
  type NobodyToAct,
  type OversightDecisionView,
  type RunState,
  type RunStateFields,
  type RunWait,
  runState,
} from "@countersign/core";
import { qualifiedToolLabel } from "../../runs/labels";
import { type ChipState, runChipState } from "../../ui/status";

/** "under an hour", "14 h", "3 days": how long since `iso`, at `now`. */
export function age(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const hours = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
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
  const first = parts.reason?.split("\n")[0]?.trim() ?? "";
  const reason = first
    ? (ERROR_REASON_WORDS[first] ?? (first.length > 120 ? `${first.slice(0, 119)}…` : first))
    : "Failed without a reason";
  return stepName ? `${reason} · at ${stepName}` : reason;
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
