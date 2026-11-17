// Where an item stands (docs/plan.md §1.123): needs you, Reggie on it, waiting on the client,
// stuck or held, or done; and the list filters over it (the prototype's `st` and FILTERS).

import { z } from "zod";
import type { WorkWaitingOn } from "./pipelines";

export const STANDINGS = ["you", "agent", "client", "stalled", "done"] as const;
export const Standing = z.enum(STANDINGS);
export type Standing = z.infer<typeof Standing>;

export function standingOf(input: {
  doneish: boolean;
  waitingOn: WorkWaitingOn;
  stuck: boolean;
  held?: boolean;
}): Standing {
  if (input.doneish) return "done";
  if (input.stuck || input.held) return "stalled";
  if (input.waitingOn === "reggie") return "agent";
  if (input.waitingOn === "client") return "client";
  return "you";
}

/** The sort order of standings in a list: what needs you first. */
export const STANDING_ORDER: Readonly<Record<Standing, number>> = {
  you: 0,
  stalled: 1,
  agent: 2,
  client: 3,
  done: 4,
};

/** True when the due date (ISO date or instant) is before today (ISO date) and it isn't done. */
export function isLate(due: string | null | undefined, standing: Standing, today: string): boolean {
  return !!due && standing !== "done" && due.slice(0, 10) < today;
}

export const WORK_FILTER_KEYS = [
  "open",
  "you",
  "agent",
  "client",
  "stuck",
  "late",
  "critical",
  "done",
] as const;
export type WorkFilterKey = (typeof WORK_FILTER_KEYS)[number];

/** The filter chips over every list; "Critical and high" only where issues are listed. */
export const WORK_FILTERS: readonly { key: WorkFilterKey; label: string; issuesOnly?: true }[] = [
  { key: "open", label: "Open" },
  { key: "you", label: "Needs you" },
  { key: "agent", label: "Reggie on it" },
  { key: "client", label: "Waiting on the client" },
  { key: "stuck", label: "Stuck or held" },
  { key: "late", label: "Late" },
  { key: "critical", label: "Critical and high", issuesOnly: true },
  { key: "done", label: "Done" },
];

/** Whether an item passes a filter. */
export function passesFilter(
  key: WorkFilterKey,
  item: { standing: Standing; due: string | null; urgency?: string | null },
  today: string,
): boolean {
  switch (key) {
    case "open":
      return item.standing !== "done";
    case "you":
      return item.standing === "you";
    case "agent":
      return item.standing === "agent";
    case "client":
      return item.standing === "client";
    case "stuck":
      return item.standing === "stalled";
    case "late":
      return isLate(item.due, item.standing, today);
    case "critical":
      return item.urgency === "critical" || item.urgency === "high";
    case "done":
      return item.standing === "done";
  }
}
