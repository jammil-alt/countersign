// The Weekly Table's calendar (ARCHITECTURE §11.4, docs/plan.md §1.37): weeks run Monday to Sunday
// in the client's time zone; a draft is made Friday 17:00 and the table is sent Monday 7:00, both
// local. The cron checks these every minute.

const DAY_MS = 86_400_000;

export const WEEKLY_DRAFT = { weekday: 5, hour: 17 } as const; // Friday 17:00
export const WEEKLY_SEND = { weekday: 1, hour: 7 } as const; // Monday 7:00

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function formatter(timezone: string): Intl.DateTimeFormat {
  const make = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
  try {
    return make(timezone);
  } catch {
    return make("UTC");
  }
}

/** A moment's wall-clock parts in a time zone (UTC when the zone is unknown). */
export function zonedParts(at: Date, timezone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Mon"] ?? 1,
  };
}

const isoDay = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** `YYYY-MM-DD` plus `days` (calendar arithmetic, no zone). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant a local wall-clock time happens in a time zone (the first, on a DST overlap). */
export function zonedTimeToUtc(day: string, hour: number, minute: number, timezone: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000;
  // Two passes of "guess, see what the zone says, correct" settle every real zone.
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timezone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wall - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** The Monday (`YYYY-MM-DD`) of the local week `at` falls in. */
export function weekStartOf(at: Date, timezone: string): string {
  const p = zonedParts(at, timezone);
  return addDays(isoDay(p.year, p.month, p.day), 1 - p.weekday);
}

/** A week's bounds: local Monday 00:00 to the next local Monday 00:00. */
export function weekBounds(weekStart: string, timezone: string): { from: Date; to: Date } {
  return {
    from: zonedTimeToUtc(weekStart, 0, 0, timezone),
    to: zonedTimeToUtc(addDays(weekStart, 7), 0, 0, timezone),
  };
}

/** True when `day` is a Monday. */
export function isMonday(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
}

/** When the draft of a week is made, and when it is sent. */
export function weeklySchedule(
  weekStart: string,
  timezone: string,
): { draftAt: Date; sendAt: Date } {
  return {
    draftAt: zonedTimeToUtc(
      addDays(weekStart, WEEKLY_DRAFT.weekday - 1),
      WEEKLY_DRAFT.hour,
      0,
      timezone,
    ),
    sendAt: zonedTimeToUtc(
      addDays(weekStart, 7 + WEEKLY_SEND.weekday - 1),
      WEEKLY_SEND.hour,
      0,
      timezone,
    ),
  };
}

/** The week whose draft is due at `at` (this week, from Friday 17:00 on), or null. */
export function draftDueWeek(at: Date, timezone: string): string | null {
  const week = weekStartOf(at, timezone);
  return at.getTime() >= weeklySchedule(week, timezone).draftAt.getTime() ? week : null;
}

/** The week whose table is due to send at `at` (last week, from Monday 7:00 on), or null. */
// DECISION: only the week just ended is ever sent; a week the cron missed entirely (more than a
// week down) is not sent late. A Monday before 7:00 sends nothing: last week's table waits.
export function sendDueWeek(at: Date, timezone: string): string | null {
  const last = addDays(weekStartOf(at, timezone), -7);
  return at.getTime() >= weeklySchedule(last, timezone).sendAt.getTime() ? last : null;
}
