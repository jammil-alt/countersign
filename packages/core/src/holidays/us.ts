// Holidays for schedule triggers with `skipHolidays` (ARCHITECTURE §10.8; docs/plan.md §1.48): US
// federal holidays with their observed dates, and the client's own dates (`tenant.settings.holidays`).
// Pure date arithmetic on calendar dates (yyyy-mm-dd), no time zones but the one the caller names.

import { z } from "zod";

// DECISION: US federal holidays only (5 U.S.C. 6103); the owner may add other calendars.

export interface Holiday {
  name: string;
  /** The holiday's own date. */
  date: string;
  /** The weekday it is observed on: Saturday → the Friday before, Sunday → the Monday after. */
  observed: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The `n`th `wd` of the month (n = -1: the last). */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) {
    const first = weekday(y, m, 1);
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekday(y, m, lastDay);
  return lastDay - ((last - wd + 7) % 7);
}

function shiftDays(y: number, m: number, d: number, days: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function fixed(name: string, y: number, m: number, d: number): Holiday {
  const wd = weekday(y, m, d);
  const observed =
    wd === 6 ? shiftDays(y, m, d, -1) : wd === 0 ? shiftDays(y, m, d, 1) : iso(y, m, d);
  return { name, date: iso(y, m, d), observed };
}

function floating(name: string, y: number, m: number, wd: number, n: number): Holiday {
  const date = iso(y, m, nthWeekday(y, m, wd, n));
  return { name, date, observed: date };
}

/** The federal holidays of `year` (Juneteenth from 2021), in calendar order. */
export function usFederalHolidays(year: number): Holiday[] {
  const out: Holiday[] = [
    fixed("New Year's Day", year, 1, 1),
    floating("Birthday of Martin Luther King, Jr.", year, 1, 1, 3),
    floating("Washington's Birthday", year, 2, 1, 3),
    floating("Memorial Day", year, 5, 1, -1),
  ];
  if (year >= 2021) out.push(fixed("Juneteenth National Independence Day", year, 6, 19));
  out.push(
    fixed("Independence Day", year, 7, 4),
    floating("Labor Day", year, 9, 1, 1),
    floating("Columbus Day", year, 10, 1, 2),
    fixed("Veterans Day", year, 11, 11),
    floating("Thanksgiving Day", year, 11, 4, 4),
    fixed("Christmas Day", year, 12, 25),
  );
  return out;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The federal holiday on `date` (yyyy-mm-dd), by its own or its observed date; null otherwise. */
// DECISION: a date is a holiday when it is the holiday itself or the day it is observed, so a
// Saturday schedule skips July 4 and a weekday schedule skips the Friday it is observed on.
export function usFederalHolidayOn(date: string): Holiday | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  // New Year's Day on a Saturday is observed on December 31 of the year before.
  for (const h of [...usFederalHolidays(year), ...usFederalHolidays(year + 1)]) {
    if (h.date === date || h.observed === date) return h;
  }
  return null;
}

/** `tenant.settings.holidays`: the client's own days off, as calendar dates. */
export const ClientHolidays = z.array(z.string().regex(DATE, "a date like 2026-12-24")).max(366);

export function clientHolidays(settings: unknown): string[] {
  const raw = (settings as { holidays?: unknown } | null)?.holidays;
  const parsed = ClientHolidays.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

/** The calendar date of `instant` in `tz` (yyyy-mm-dd). */
export function localDate(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whether a schedule with `skipHolidays` skips `instant` in the client's zone. */
export function isDayOff(instant: Date, tz: string, own: readonly string[] = []): boolean {
  const date = localDate(instant, tz);
  return own.includes(date) || usFederalHolidayOn(date) !== null;
}
