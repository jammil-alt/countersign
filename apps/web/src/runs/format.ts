// Shared words, tones and times for runs and steps (back office run view, portal timeline).
import { formatAmount } from "@countersign/core";
import type { Tone } from "../ui/primitives";

/** A run that may still change: its screens poll (plan §1.2 "Live updates"). */
export function isRunGoing(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

const RUN_WORDS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function runStatusLabel(status: string): string {
  return RUN_WORDS[status] ?? status;
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

const STEP_WORDS: Record<string, string> = {
  pending: "Not started",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function stepStatusLabel(status: string): string {
  return STEP_WORDS[status] ?? status.replace(/_/g, " ");
}

/** "7:02" today, "Nov 3, 7:02" otherwise; in the viewer's time zone. */
export function shortTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/** "4 s", "3 min", "2 h 5 min". */
export function duration(from: string | null, to: string | null, now: Date = new Date()): string {
  if (!from) return "";
  const ms = (to ? new Date(to) : now).getTime() - new Date(from).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return m % 60 === 0 ? `${hrs} h` : `${hrs} h ${m % 60} min`;
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
