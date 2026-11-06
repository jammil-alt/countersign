// Words and times the back office's command center, runs list and run page share (English only).
import type { OversightDecisionView } from "@countersign/core";
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
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A run's status as a chip: its state and its words. */
export function runChip(status: string): { state: ChipState; words: string } {
  return { state: runChipState(status), words: RUN_STATUS_WORDS[status] ?? status };
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
