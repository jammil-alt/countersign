// R1 (docs/plan.md §1.86): business hours. A client's working week, and optionally a
// person's own, so a deadline in business time ("30 minutes, business hours") only runs while the
// person being asked is working.

import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

/** A wall-clock time in the hours' own zone, `HH:MM`, 24-hour. */
export const ClockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time such as 08:00 or 18:30");

/** One open stretch of a day; `to` is after `from` (no stretch past midnight). */
export const OpenHours = z
  .strictObject({ from: ClockTime, to: ClockTime })
  .refine((h) => h.from < h.to, { message: "the end must be after the start", path: ["to"] });
export type OpenHours = z.infer<typeof OpenHours>;

/** An ISO date, `YYYY-MM-DD`. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-24");

/**
 * A working week: open stretches per weekday (a day left out, or with none, is closed), in an IANA
 * zone, plus closed dates. US federal holidays apply when `usHolidays` is on (core `holidays/us`).
 */
export const BusinessHours = z.strictObject({
  tz: z.string().min(1),
  week: z.partialRecord(Weekday, z.array(OpenHours).max(4)),
  usHolidays: z.boolean().default(true),
  closed: z.array(IsoDate).max(366).default([]),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

const NINE_TO_SIX: OpenHours[] = [{ from: "08:00", to: "18:00" }];

// DECISION: the default week is Monday to Friday, 8am to 6pm, weekends closed (owner, 2026-11-10).
// The zone has no default here: it is the client's, filled in where the client's settings are read.
export function defaultBusinessHours(tz: string): BusinessHours {
  return {
    tz,
    week: {
      mon: NINE_TO_SIX,
      tue: NINE_TO_SIX,
      wed: NINE_TO_SIX,
      thu: NINE_TO_SIX,
      fri: NINE_TO_SIX,
    },
    usHolidays: true,
    closed: [],
  };
}

/**
 * A person's own hours and away dates. Hours absent: the client's. Away dates make an `in_turn`
 * approval or a confer skip the person at once.
 */
export const PersonHours = z.strictObject({
  hours: BusinessHours.optional(),
  away: z
    .array(z.strictObject({ from: IsoDate, to: IsoDate }))
    .max(50)
    .default([]),
});
export type PersonHours = z.infer<typeof PersonHours>;
