// R4 (docs/plan.md §1.86, §9): the business-hours clock. When a deadline in business time is due,
// whether someone is working now, and the same for a role (several people: the clock runs while any
// one of them is working). Pure: the zone arithmetic is Intl.DateTimeFormat, the holidays are core's
// `holidays/us`.

import { type Duration, parseDuration } from "../duration";
import { localDate, usFederalHolidays } from "../holidays/us";
import { type BusinessHours, type PersonHours, WEEKDAYS } from "./hours";

/** A person's away dates, inclusive, as calendar dates in their own hours' zone. */
export interface AwayRange {
  from: string;
  to: string;
}

/** Whose hours a clock runs on: a working week, and the days the person is away. */
export interface Schedule {
  businessHours: BusinessHours;
  away?: readonly AwayRange[] | undefined;
}

export interface DueAtOptions {
  /** `clock`: real time. `business`: only while the hours are open. */
  hours: "clock" | "business";
  businessHours: BusinessHours;
  /** Away dates of the person asked; in business time they count as closed days. */
  away?: readonly AwayRange[] | undefined;
}

export interface DueAtForManyOptions {
  hours: "clock" | "business";
  /** The people asked; the clock runs while any one of them is working. */
  people: readonly Schedule[];
}

const MINUTE = 60_000;
const DAY = 86_400_000;
// The longest run of days with no open time the clock crosses before it gives up (hours with no
// open day at all, or years of closed or away dates): five years. It limits a run of closed days,
// never the deadline's own length (a deadline of 300 business days runs as long as it needs).
const MAX_DAYS = 5 * 366;
const WINDOW = 7 * DAY;

// ── Zones ────────────────────────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  return f;
}

/** The wall-clock time of `instant` in `tz`, read as if it were UTC (ms). */
function wallAsUtc(instant: number, tz: string): number {
  const parts = format(tz).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const ms = ((instant % 1000) + 1000) % 1000;
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
    ms,
  );
}

/** The zone's offset from UTC at `instant`, in ms (Chicago in winter: -6 hours). */
function offsetAt(instant: number, tz: string): number {
  return wallAsUtc(instant, tz) - instant;
}

/**
 * The instant at wall-clock `msOfDay` on calendar `date` in `tz`.
 */
// DECISION: a wall time that happens twice (fall-back) is its first occurrence; one that never
// happens (spring-forward) is pushed forward by the gap (02:30 → 03:30), as calendars do.
function zoned(date: string, msOfDay: number, tz: string): number {
  const guess = dateUtc(date) + msOfDay;
  const candidates = [offsetAt(guess - DAY, tz), offsetAt(guess + DAY, tz)].map((o) => guess - o);
  const real = candidates.filter((c) => offsetAt(c, tz) === guess - c);
  return real.length > 0 ? Math.min(...real) : Math.max(...candidates);
}

// ── Calendar dates ───────────────────────────────────────────────────────────────────────────

function dateUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function nextDate(date: string): string {
  return new Date(dateUtc(date) + DAY).toISOString().slice(0, 10);
}

function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  // getUTCDay: 0 = Sunday; WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(dateUtc(date)).getUTCDay() + 6) % 7] as (typeof WEEKDAYS)[number];
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function awayOn(date: string, away: readonly AwayRange[] | undefined): boolean {
  return (away ?? []).some((r) => r.from <= date && date <= r.to);
}

/** Whether `date` is the day a US federal holiday is observed (its own date on a weekday). */
// DECISION: business hours close only on a holiday's observed date, as federal offices do: July 4
// on a Saturday closes Friday July 3, and a business open on Saturdays stays open on the 4th (a
// schedule trigger's `skipHolidays` skips both dates; `holidays/us` usFederalHolidayOn).
function observedHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  // New Year's Day on a Saturday is observed on December 31 of the year before.
  return [...usFederalHolidays(year), ...usFederalHolidays(year + 1)].some(
    (h) => h.observed === date,
  );
}

/** Whether `date` is a day off: a closed date, an observed US federal holiday, or away. */
function dayOff(hours: BusinessHours, date: string, away?: readonly AwayRange[]): boolean {
  if ((hours.closed ?? []).includes(date)) return true;
  if (hours.usHolidays !== false && observedHoliday(date)) return true;
  return awayOn(date, away);
}

/** The open stretches of `date` as instants, in order; none on a day off. */
function stretchesOn(schedule: Schedule, date: string): [number, number][] {
  const { businessHours: hours, away } = schedule;
  if (dayOff(hours, date, away)) return [];
  return (hours.week[weekdayOf(date)] ?? [])
    .map((s): [number, number] => [
      zoned(date, minutesOf(s.from) * MINUTE, hours.tz),
      zoned(date, minutesOf(s.to) * MINUTE, hours.tz),
    ])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
}

/** The open intervals of `schedule` within [from, to), in order. */
function openWithin(schedule: Schedule, from: number, to: number): [number, number][] {
  const tz = schedule.businessHours.tz;
  const last = localDate(new Date(to), tz);
  const out: [number, number][] = [];
  for (let date = localDate(new Date(from), tz); date <= last; date = nextDate(date)) {
    for (const [a, b] of stretchesOn(schedule, date)) {
      const s = Math.max(a, from);
      const e = Math.min(b, to);
      if (s < e) out.push([s, e]);
    }
  }
  return out;
}

/** The union of several schedules' open intervals within [from, to), merged and in order. */
function unionWithin(schedules: readonly Schedule[], from: number, to: number): [number, number][] {
  const all = schedules.flatMap((s) => openWithin(s, from, to)).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of all) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The hours (or every person of a role) have no open time for five years running. */
export class NoOpenTimeError extends Error {
  override name = "NoOpenTimeError";
  constructor() {
    super("These business hours have no open time for five years running");
  }
}

function noOpenTime(): Error {
  return new NoOpenTimeError();
}

/** `ms` of open time from `start`, counting only while any schedule is open. */
function addOpenTime(start: number, ms: number, schedules: readonly Schedule[]): number {
  let remaining = ms;
  // The end of the last open time seen: the clock gives up only after MAX_DAYS with none.
  let lastOpen = start;
  for (let from = start; from - lastOpen <= MAX_DAYS * DAY; from += WINDOW) {
    for (const [a, b] of unionWithin(schedules, from, from + WINDOW)) {
      if (remaining <= b - a) return a + remaining;
      remaining -= b - a;
      lastOpen = b;
    }
  }
  throw noOpenTime();
}

/** The first open moment at or after `start`. */
function nextOpen(start: number, schedules: readonly Schedule[]): number {
  for (let from = start; from < start + MAX_DAYS * DAY; from += WINDOW) {
    const first = unionWithin(schedules, from, from + WINDOW)[0];
    if (first) return first[0];
  }
  throw noOpenTime();
}

// DECISION: a business day counts as the same clock time on the next open day, not an open day's
// worth of minutes (days differ in length, a person has their own). Tuesday 10:00 + 1 day is
// Wednesday 10:00; Friday 10:00 is Monday 10:00; a start outside the hours first moves to the next
// opening. On the target day the time is held inside its hours: before the first opening it is the
// opening, in a break it is the next stretch, after the close it is the close. A business week is
// as many open days as the week has open weekdays (Monday to Friday: 5). Seconds, minutes and hours
// count open minutes.
function addOpenDays(start: number, days: number, schedule: Schedule): number {
  const tz = schedule.businessHours.tz;
  const from = nextOpen(start, [schedule]);
  let date = localDate(new Date(from), tz);
  const msOfDay = wallAsUtc(from, tz) - dateUtc(date);
  let counted = 0;
  // Days in a row with no open time; only a run longer than MAX_DAYS gives up.
  let closedRun = 0;
  while (counted < days) {
    if (closedRun > MAX_DAYS) throw noOpenTime();
    date = nextDate(date);
    if (stretchesOn(schedule, date).length > 0) {
      counted++;
      closedRun = 0;
    } else closedRun++;
  }
  const stretches = stretchesOn(schedule, date);
  const target = zoned(date, msOfDay, tz);
  for (const [a, b] of stretches) {
    if (target < a) return a;
    if (target <= b) return target;
  }
  return (stretches[stretches.length - 1] as [number, number])[1];
}

function openWeekdays(hours: BusinessHours): number {
  return WEEKDAYS.filter((d) => (hours.week[d] ?? []).length > 0).length;
}

const UNIT_RE = /^(\d+)\s*(second|minute|hour|day|week)s?$/;

function businessDue(start: Date, after: Duration, schedule: Schedule): number {
  const m = UNIT_RE.exec(after.trim());
  if (!m) throw new Error(`Invalid duration: ${after}`);
  const n = Number(m[1]);
  if (n === 0) return start.getTime();
  if (m[2] === "day") return addOpenDays(start.getTime(), n, schedule);
  if (m[2] === "week") {
    const perWeek = openWeekdays(schedule.businessHours);
    if (perWeek === 0) throw noOpenTime();
    return addOpenDays(start.getTime(), n * perWeek, schedule);
  }
  return addOpenTime(start.getTime(), parseDuration(after), [schedule]);
}

// ── The clock ────────────────────────────────────────────────────────────────────────────────

/** Whether the hours are open at `at` (closed dates and US holidays count as closed). */
export function isOpen(at: Date, hours: BusinessHours): boolean {
  const t = at.getTime();
  return openWithin({ businessHours: hours }, t, t + 1).length > 0;
}

/**
 * The hours a person's clock runs on: their own when they have them, else the client's.
 */
// DECISION: a person's own hours replace the client's week, zone and US-holiday setting, but the
// client's closed dates still apply to them (an office closure is everyone's day off), read as
// calendar dates in the person's zone.
export function effectiveHours(client: BusinessHours, person?: PersonHours): BusinessHours {
  const own = person?.hours;
  if (!own) return client;
  const closed = [...new Set([...(own.closed ?? []), ...(client.closed ?? [])])].sort();
  return { ...own, closed };
}

/** The schedule a person's clock runs on: their effective hours and their away dates. */
export function scheduleFor(client: BusinessHours, person?: PersonHours): Schedule {
  return { businessHours: effectiveHours(client, person), away: person?.away ?? [] };
}

/**
 * Whether the person is away at `at`: its calendar date, in their hours' zone (their own, else the
 * client's), is in one of their away ranges (inclusive). The client's hours are required: a person
 * with no hours of their own works on the client's, so their dates are the client's dates.
 */
export function isAway(at: Date, person: PersonHours, client: BusinessHours): boolean {
  const tz = person.hours?.tz ?? client.tz;
  return awayOn(localDate(at, tz), person.away);
}

/** Whether the person is working at `at`: their hours are open and they are not away. */
export function isWorking(at: Date, client: BusinessHours, person?: PersonHours): boolean {
  const t = at.getTime();
  return openWithin(scheduleFor(client, person), t, t + 1).length > 0;
}

/** Whether any one of several people (a role) is working at `at`. */
export function anyOpen(at: Date, people: readonly Schedule[]): boolean {
  const t = at.getTime();
  return unionWithin(people, t, t + 1).length > 0;
}

/**
 * When a deadline of `after` from `start` is due. `clock`: `start + after`. `business`: only open
 * time counts, in the hours' zone, skipping closed weekdays, closed dates, US federal holidays
 * (when `usHolidays`) and away dates. A duration of zero is due at `start`.
 */
// DECISION: away dates only matter in business time; a clock deadline runs through them (an away
// person is skipped at once by an `in_turn` approval or a confer, not by the clock).
export function dueAt(start: Date, after: Duration, opts: DueAtOptions): Date {
  if (opts.hours === "clock") return new Date(start.getTime() + parseDuration(after));
  return new Date(
    businessDue(start, after, { businessHours: opts.businessHours, away: opts.away }),
  );
}

/**
 * When a deadline asked of several people (a role) is due. In business time the clock runs while
 * any one of them is working: open minutes are counted over the union of their hours.
 */
// DECISION: for days and weeks, each person counts open days on their own hours and the earliest
// wins (the role has had its days once any one person has); minutes count over the union. A person
// with no open time at all (no open weekday, or away for years) is skipped: the role's deadline
// runs on the others, and only a role where nobody has any open time is refused.
export function dueAtForMany(start: Date, after: Duration, opts: DueAtForManyOptions): Date {
  if (opts.hours === "clock") return new Date(start.getTime() + parseDuration(after));
  if (opts.people.length === 0) throw new Error("A role's deadline needs at least one person");
  const m = UNIT_RE.exec(after.trim());
  if (m && Number(m[1]) === 0) return new Date(start.getTime());
  if (m && (m[2] === "day" || m[2] === "week")) {
    const due = opts.people.flatMap((p) => {
      try {
        return [businessDue(start, after, p)];
      } catch (e) {
        if (e instanceof NoOpenTimeError) return [];
        throw e;
      }
    });
    if (due.length === 0) throw noOpenTime();
    return new Date(Math.min(...due));
  }
  return new Date(addOpenTime(start.getTime(), parseDuration(after), opts.people));
}
