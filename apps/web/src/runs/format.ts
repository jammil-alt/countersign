// Shared words, tones and times for runs and steps (back office run view, portal timeline), in the
// reader's language: the portal passes its I18n, the back office reads English (EN).
import { formatAmount, type RunStateFields, runState } from "@countersign/core";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n } from "../i18n/i18n";
import type { Tone } from "../ui/primitives";

/** A run that may still change: its screens poll (plan §1.2 "Live updates"). */
export function isRunGoing(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

/** How often a screen asks again about a run that waits on a person (docs/audit-plan.md 2.2). */
export const WAITING_POLL_MS = 30_000;

/**
 * How often a run's screen asks again: every `fast` ms while it is queued or running, every 30 s
 * while it waits on a person (an approval or an answer moves it, and a person takes minutes), and
 * never once it has finished (null). Only the polling reads this; what a run is shown as still
 * comes from `isRunGoing`, `runState` and the chips.
 */
// DECISION: a waiting run is polled every 30 s, not at the working rate (docs/audit-plan.md 2.2):
// a run page left open on a run waiting for approval asked 30 times a minute for no change. A
// decision made on the same page reloads it at once, so only a decision made elsewhere waits for
// the next tick.
export function runPollMs(run: RunStateFields, fast: number): number | null {
  switch (runState(run)) {
    case "queued":
    case "running":
      return fast;
    case "waiting":
      return WAITING_POLL_MS;
    default:
      return null;
  }
}

/** A list's poll: the fastest any of its runs needs (`runPollMs`), or null when none is open. */
export function runsPollMs(runs: readonly RunStateFields[], fast: number): number | null {
  let ms: number | null = null;
  for (const r of runs) {
    const each = runPollMs(r, fast);
    if (each !== null && (ms === null || each < ms)) ms = each;
  }
  return ms;
}

const RUN_WORDS: Record<string, PlainKey> = {
  queued: "run.status.queued",
  running: "run.status.running",
  waiting: "run.status.waiting",
  succeeded: "run.status.succeeded",
  failed: "run.status.failed",
  cancelled: "run.status.cancelled",
};

export function runStatusLabel(status: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = RUN_WORDS[status];
  return key ? t(key) : status;
}

export function runStatusTone(status: string): Tone {
  switch (status) {
    case "succeeded":
      return "positive";
    case "failed":
      return "risk";
    case "waiting":
      // Waiting on a person: an approval or an answer.
      return "warning";
    case "running":
    case "queued":
      return "accent";
    default:
      return "neutral";
  }
}

const STEP_WORDS: Record<string, PlainKey> = {
  pending: "step.status.pending",
  running: "step.status.running",
  waiting: "step.status.waiting",
  succeeded: "step.status.succeeded",
  failed: "step.status.failed",
  skipped: "step.status.skipped",
  cancelled: "step.status.cancelled",
};

export function stepStatusLabel(status: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = STEP_WORDS[status];
  return key ? t(key) : status.replace(/_/g, " ");
}

/** "7:02" today, "Nov 3, 7:02" otherwise; in the viewer's time zone and locale. */
export function shortTime(
  iso: string | null,
  now: Date = new Date(),
  { fmt }: Pick<I18n, "fmt"> = EN,
): string {
  return fmt.time(iso, now);
}

/** "4 s", "3 min", "2 h 5 min". */
export function duration(
  from: string | null,
  to: string | null,
  now: Date = new Date(),
  { t }: Pick<I18n, "t"> = EN,
): string {
  if (!from) return "";
  const ms = (to ? new Date(to) : now).getTime() - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("duration.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("duration.minutes", { n: m });
  const hrs = Math.floor(m / 60);
  return m % 60 === 0
    ? t("duration.hours", { n: hrs })
    : t("duration.hoursMinutes", { h: hrs, m: m % 60 });
}

/**
 * An amount with its currency, in the reader's locale: "9742.3500" USD → "$9,742.35". The one
 * money formatter for runs and changes on both sides; from the decimal string, never a float.
 */
export function money(
  amount: string | null | undefined,
  currency = "USD",
  { fmt }: Pick<I18n, "fmt"> = EN,
): string {
  return fmt.money(amount, currency);
}

/** `{ amount: "9742.3500", currency: "USD" }`, the shape money takes in payloads and records. */
export function moneyShape(v: unknown): { amount: string; currency: string } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || typeof o.amount !== "string" || typeof o.currency !== "string") {
    return null;
  }
  return /^-?\d+(\.\d+)?$/.test(o.amount) && /^[A-Z]{3}$/.test(o.currency)
    ? { amount: o.amount, currency: o.currency }
    : null;
}

/** Model cost (operator only): "$0.09", from the decimal string, never a float. */
export function usd(amount: string | null | undefined): string {
  if (!amount) return "$0.00";
  try {
    return `$${formatAmount(amount, 2)}`;
  } catch {
    return `$${amount}`;
  }
}
