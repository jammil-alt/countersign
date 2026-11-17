// An issue's targets (docs/plan.md §1.124; docs/cases-plan.md §3.2): when we reply and when we fix
// it, from its urgency and the client's business hours. Pure, over the platform's clock
// (process/clock.ts).

import { dueAt } from "../process/clock";
import type { BusinessHours } from "../process/hours";
import type { WorkUrgency } from "./pipelines";

export interface IssueTargets {
  replyBy: Date;
  fixBy: Date;
}

/** The instant the client's local day of `at` ends (one millisecond before local midnight). */
function endOfLocalDay(at: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const into = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
  return new Date(at.getTime() - (at.getTime() % 1000) + (86_400_000 - into) - 1);
}

/**
 * The targets for an issue raised at `createdAt` with this urgency.
 *
 * - critical: reply within 1 clock hour, any day; fix by the end of the client's local day.
 * - high: reply within 4 business hours; fix within 2 business days.
 * - normal: 1 business day for both.
 * - low: reply within 1 business day; fix within 2.
 */
// DECISION: targets run on the client's business hours (apps/api `clientBusinessHours`), and a
// business day is the platform clock's own (same clock time on the next open day, process/clock.ts)
// rather than the end of that day, so every deadline in the product counts days one way.
export function issueTargets(
  urgency: WorkUrgency,
  createdAt: Date,
  hours: BusinessHours,
): IssueTargets {
  const business = (after: string) =>
    dueAt(createdAt, after, { hours: "business", businessHours: hours });
  switch (urgency) {
    case "critical":
      return {
        replyBy: dueAt(createdAt, "1 hour", { hours: "clock", businessHours: hours }),
        fixBy: endOfLocalDay(createdAt, hours.tz),
      };
    case "high":
      return { replyBy: business("4 hours"), fixBy: business("2 days") };
    case "normal":
      return { replyBy: business("1 day"), fixBy: business("1 day") };
    case "low":
      return { replyBy: business("1 day"), fixBy: business("2 days") };
  }
}

/** The targets in words, for Autopilot's Targets panel and the issue's details. */
export const TARGET_WORDS: Readonly<Record<WorkUrgency, { reply: string; fix: string }>> = {
  critical: { reply: "Within 1 hour, any day", fix: "The same day" },
  high: { reply: "Within 4 business hours", fix: "Within 2 business days" },
  normal: { reply: "Within 1 business day", fix: "Within 1 business day" },
  low: { reply: "Within 1 business day", fix: "Within 2 business days" },
};
