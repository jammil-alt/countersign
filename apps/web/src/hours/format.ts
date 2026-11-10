// Business hours in words (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "Business hours"): a week
// as a few lines ("Mon to Fri · 8:00 AM to 6:00 PM"), dates and away ranges, all through Intl in
// the reader's locale. Pure: the editors and summaries in ./HoursParts.tsx use these, and so do the
// back office's read-only views.
import { processes } from "@countersign/core";
import type { I18n } from "../i18n/i18n";

export type Week = processes.BusinessHours["week"];
export type Weekday = processes.Weekday;
export type Stretch = processes.OpenHours;
export type AwayRange = processes.PersonHours["away"][number];

export const WEEKDAYS = processes.WEEKDAYS;

/** 2026-01-05 was a Monday: the weekday names come from that week, in UTC. */
const MONDAY = Date.UTC(2026, 0, 5);

/** A weekday's name in the reader's language: "Mon" (`short`) or "Monday" (`long`). */
export function dayName(day: Weekday, intl: string, width: "short" | "long" = "short"): string {
  const offset = WEEKDAYS.indexOf(day);
  return new Intl.DateTimeFormat(intl, { weekday: width, timeZone: "UTC" }).format(
    new Date(MONDAY + offset * 86_400_000),
  );
}

/** "08:00" as the reader reads a time: "8:00 AM", "08:00". */
export function clockText(hhmm: string, intl: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return new Intl.DateTimeFormat(intl, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 5, h, m)));
}

/** "2026-12-24" as a date, without the reader's zone moving it a day: "Dec 24, 2026". */
export function dateText(iso: string, intl: string): string {
  const [y = 1970, mo = 1, d = 1] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(intl, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/** Today in the reader's own calendar, `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** One line of a week: the days it covers and their hours (or "Closed"). */
export interface WeekLine {
  days: string;
  hours: string;
  closed: boolean;
}

function stretchesKey(stretches: readonly Stretch[] | undefined): string {
  return (stretches ?? []).map((s) => `${s.from}-${s.to}`).join(",");
}

/** A week as lines, days with the same hours side by side run together: "Mon to Fri". */
export function weekLines(week: Week, { t, intl }: Pick<I18n, "t" | "intl">): WeekLine[] {
  const lines: WeekLine[] = [];
  let i = 0;
  while (i < WEEKDAYS.length) {
    const first = WEEKDAYS[i] as Weekday;
    const key = stretchesKey(week[first]);
    let j = i;
    while (j + 1 < WEEKDAYS.length && stretchesKey(week[WEEKDAYS[j + 1] as Weekday]) === key) j++;
    const last = WEEKDAYS[j] as Weekday;
    const days =
      i === j
        ? dayName(first, intl)
        : t("hours.dayRange", { from: dayName(first, intl), to: dayName(last, intl) });
    const stretches = week[first] ?? [];
    lines.push({
      days,
      closed: stretches.length === 0,
      hours:
        stretches.length === 0
          ? t("hours.closed")
          : stretches
              .map((s) =>
                t("hours.stretch", { from: clockText(s.from, intl), to: clockText(s.to, intl) }),
              )
              .join(", "),
    });
    i = j + 1;
  }
  return lines;
}

/** An away range in words: one day, or "Dec 22, 2026 to Jan 2, 2027". */
export function awayText(range: AwayRange, { t, intl }: Pick<I18n, "t" | "intl">): string {
  return range.from === range.to
    ? dateText(range.from, intl)
    : t("hours.awayRange", { from: dateText(range.from, intl), to: dateText(range.to, intl) });
}

/** The away range that covers `today`, if any (the person is away now). */
export function awayNow(away: readonly AwayRange[], today: string = todayIso()) {
  return away.find((r) => r.from <= today && today <= r.to) ?? null;
}

/** Whether two weeks have the same open stretches on every day. */
export function sameWeek(a: Week, b: Week): boolean {
  return WEEKDAYS.every((d) => stretchesKey(a[d]) === stretchesKey(b[d]));
}

/** What is wrong with a week, as a translated sentence, or null: an end before its start, overlaps. */
export function weekProblem(week: Week, { t, intl }: Pick<I18n, "t" | "intl">): string | null {
  for (const day of WEEKDAYS) {
    const stretches = [...(week[day] ?? [])];
    if (stretches.some((s) => !s.from || !s.to || s.from >= s.to)) {
      return t("hours.problem.order", { day: dayName(day, intl, "long") });
    }
    stretches.sort((a, b) => a.from.localeCompare(b.from));
    for (let k = 1; k < stretches.length; k++) {
      if ((stretches[k] as Stretch).from < (stretches[k - 1] as Stretch).to) {
        return t("hours.problem.overlap", { day: dayName(day, intl, "long") });
      }
    }
  }
  return null;
}

/** A week as it is saved: days in order, each day's stretches sorted, closed days left out. */
export function cleanWeek(week: Week): Week {
  const out: Week = {};
  for (const day of WEEKDAYS) {
    const stretches = [...(week[day] ?? [])].sort((a, b) => a.from.localeCompare(b.from));
    if (stretches.length > 0) out[day] = stretches;
  }
  return out;
}
