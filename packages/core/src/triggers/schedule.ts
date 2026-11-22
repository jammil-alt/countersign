// A schedule trigger in words (feedback, 2026-11-10: "human readable date and time, and add the
// time zone"): "Weekdays at 7:00 AM, Central Time". Common crons read as words; anything else
// stays its cron, which the builder's field explains. Shared by the back office and the API.
// Owner, 2026-11-21 ("schedule times should use human readable time and days and should include
// things like the first Monday of the month, or every other Monday or the third Thursday"): a
// schedule is also read as a plan (every so many hours, on days of the week every so many weeks,
// on a day of the month or its first to last weekday) that the schedule picker shows and writes
// back as the same cron. "Every other week" is not something cron can say, so the trigger carries
// it beside its cron as `every` (docs/plan.md §1.177).

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "7:00 AM", "6:30 PM", "12:00 PM". */
function clock(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Mondays", "Mondays and Thursdays", "Mondays, Wednesdays and Fridays". */
function dayList(days: readonly number[]): string {
  const names = days.map((d) => `${DAYS[d]}s`);
  return names.length === 1
    ? (names[0] as string)
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The days of a cron's day-of-week field, or null when it is not a plain list or range. */
function daysOf(dow: string): number[] | null {
  const out = new Set<number>();
  for (const part of dow.split(",")) {
    const range = /^([0-7])(?:-([0-7]))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (to < from) return null;
    for (let d = from; d <= to; d++) out.add(d % 7);
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs only every Nth week: whole weeks counted from `from`, a date in the schedule's zone. */
export interface ScheduleEvery {
  weeks: number;
  from: string;
}

/** Which weekday of the month: the first to the fourth, or the last. */
export type MonthWeek = 1 | 2 | 3 | 4 | "last";

/**
 * A schedule as a person says it. `days` are days of the week (0 is Sunday), all seven for every
 * day; `weeks` above 1 runs them only every so many weeks, counted from the week of `from`.
 */
export type SchedulePlan =
  | { kind: "hours"; every: number; minute: number }
  | { kind: "days"; days: number[]; hour: number; minute: number; weeks: number; from?: string }
  | {
      kind: "month";
      on: { day: number | "last" } | { week: MonthWeek; weekday: number };
      hour: number;
      minute: number;
    }
  | { kind: "custom"; cron: string; every?: ScheduleEvery };

/** The hour steps the picker offers: each divides the day, so the times are the same every day. */
export const SCHEDULE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

function intIn(text: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
}

/**
 * A schedule's plan, where its cron is one the picker can show; anything else is `custom` and
 * keeps its cron as written.
 */
export function planOfSchedule(on: {
  cron: string;
  every?: ScheduleEvery | undefined;
}): SchedulePlan {
  const custom: SchedulePlan = {
    kind: "custom",
    cron: on.cron,
    ...(on.every ? { every: on.every } : {}),
  };
  const parts = on.cron.trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = intIn(min, 0, 59);
  if (minute === null || mon !== "*") return custom;
  if (dom === "*" && dow === "*" && !on.every) {
    const step = hour === "*" ? 1 : Number(/^\*\/(\d+)$/.exec(hour)?.[1] ?? Number.NaN);
    if ((SCHEDULE_HOUR_STEPS as readonly number[]).includes(step)) {
      return { kind: "hours", every: step, minute };
    }
  }
  const h = intIn(hour, 0, 23);
  if (h === null) return custom;
  if (dom === "*") {
    const days = dow === "*" ? ALL_DAYS : daysOf(dow);
    if (days && days.length > 0) {
      return {
        kind: "days",
        days,
        hour: h,
        minute,
        weeks: on.every?.weeks ?? 1,
        ...(on.every ? { from: on.every.from } : {}),
      };
    }
    if (on.every) return custom;
    const nth = /^([0-7])#([1-4])$/.exec(dow);
    if (nth) {
      return {
        kind: "month",
        on: { week: Number(nth[2]) as MonthWeek, weekday: Number(nth[1]) % 7 },
        hour: h,
        minute,
      };
    }
    const last = /^([0-7])L$/.exec(dow);
    if (last) {
      return {
        kind: "month",
        on: { week: "last", weekday: Number(last[1]) % 7 },
        hour: h,
        minute,
      };
    }
    return custom;
  }
  if (dow !== "*" || on.every) return custom;
  const day = dom === "L" ? "last" : intIn(dom, 1, 31);
  return day === null ? custom : { kind: "month", on: { day }, hour: h, minute };
}

/** The Sunday on or before `date` ("2026-11-25" gives "2026-11-22"): the start of its week. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** A plan as the trigger stores it: its cron, and `every` when it skips weeks. */
export function scheduleOfPlan(plan: SchedulePlan): {
  cron: string;
  every?: ScheduleEvery;
} {
  switch (plan.kind) {
    case "custom":
      return { cron: plan.cron, ...(plan.every ? { every: plan.every } : {}) };
    case "hours":
      return { cron: `${plan.minute} ${plan.every === 1 ? "*" : `*/${plan.every}`} * * *` };
    case "days": {
      const days = [...new Set(plan.days)].sort((a, b) => a - b);
      const dow =
        days.length === 7 ? "*" : days.join() === WEEKDAYS.join() ? "1-5" : days.join(",");
      const cron = `${plan.minute} ${plan.hour} * * ${dow}`;
      return plan.weeks > 1 && plan.from
        ? { cron, every: { weeks: plan.weeks, from: weekStart(plan.from) } }
        : { cron };
    }
    case "month": {
      const at = `${plan.minute} ${plan.hour}`;
      if ("day" in plan.on)
        return { cron: `${at} ${plan.on.day === "last" ? "L" : plan.on.day} * *` };
      const { week, weekday } = plan.on;
      return { cron: `${at} * * ${weekday}${week === "last" ? "L" : `#${week}`}` };
    }
  }
}

/**
 * Whether a run on `date` (the tick's date in the schedule's zone) is in a week the schedule
 * runs: every `weeks`th week, in whole weeks of seven days counted from `from`.
 */
export function inWeekCycle(date: string, every: ScheduleEvery): boolean {
  const days =
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${every.from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || every.weeks < 2) return true;
  const week = Math.floor(days / 7);
  return ((week % every.weeks) + every.weeks) % every.weeks === 0;
}

const ORDINAL = ["", "first", "second", "third", "fourth"];

/** "1st", "2nd", "3rd", "15th", "22nd". */
function nth(n: number): string {
  const tens = n % 100;
  const end = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${end}`;
}

/** "Every other week", "Every 3 weeks". */
function everyWeeks(weeks: number): string {
  return weeks === 2 ? "Every other week" : `Every ${weeks} weeks`;
}

/** A plan in words: "Weekdays at 7:00 AM", "The first Monday of every month at 9:00 AM". */
export function planText(plan: SchedulePlan): string {
  switch (plan.kind) {
    case "custom":
      return plan.every ? `${plan.cron}, ${everyWeeks(plan.every.weeks).toLowerCase()}` : plan.cron;
    case "hours": {
      const each = plan.every === 1 ? "Every hour" : `Every ${plan.every} hours`;
      return plan.minute === 0
        ? `${each}, on the hour`
        : `${each}, ${plan.minute} ${plan.minute === 1 ? "minute" : "minutes"} past`;
    }
    case "days": {
      const at = clock(plan.hour, plan.minute);
      const days = [...new Set(plan.days)].sort((a, b) => a - b);
      const which =
        days.length === 7
          ? "Every day"
          : days.join() === WEEKDAYS.join()
            ? "Weekdays"
            : days.join() === "0,6"
              ? "Weekends"
              : dayList(days);
      if (plan.weeks <= 1) return `${which} at ${at}`;
      if (plan.weeks === 2 && days.length === 1)
        return `Every other ${DAYS[days[0] as number]} at ${at}`;
      return `${everyWeeks(plan.weeks)} on ${days.length === 7 ? "every day" : which.replace(/^W/, "w")} at ${at}`;
    }
    case "month": {
      const at = clock(plan.hour, plan.minute);
      if ("day" in plan.on) {
        return plan.on.day === "last"
          ? `The last day of every month at ${at}`
          : `The ${nth(plan.on.day)} of every month at ${at}`;
      }
      const which = plan.on.week === "last" ? "last" : ORDINAL[plan.on.week];
      return `The ${which} ${DAYS[plan.on.weekday]} of every month at ${at}`;
    }
  }
}

/**
 * A cron schedule in words where it is a common one: "Weekdays at 7:00 AM", "Every day at
 * 6:30 PM", "Mondays and Thursdays at 9:00 AM", "The third Thursday of every month at 9:00 AM",
 * "Every hour, on the hour"; anything else as its cron.
 */
export function cronText(cron: string, every?: ScheduleEvery | undefined): string {
  return planText(planOfSchedule({ cron, every }));
}

/**
 * An IANA zone in words: "Central Time" for America/Chicago, "Coordinated Universal Time" for
 * UTC; the zone's id where the runtime has no name for it.
 */
export function zoneText(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" })
      .formatToParts(new Date(0))
      .find((p) => p.type === "timeZoneName")?.value;
    return name && !/^GMT[+-]/.test(name) ? name : tz;
  } catch {
    return tz;
  }
}

/**
 * A schedule in words with its zone: "Weekdays at 7:00 AM, Central Time", or "…, in the
 * client's time zone" when the trigger names none (it runs in the client's zone).
 */
export function scheduleText(on: {
  cron: string;
  tz?: string | null | undefined;
  every?: ScheduleEvery | undefined;
}): string {
  return `${cronText(on.cron, on.every)}, ${on.tz ? zoneText(on.tz) : "in the client's time zone"}`;
}
