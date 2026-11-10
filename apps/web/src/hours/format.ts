// Business hours in words (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "Business hours"): a week
// as a few lines ("Mon to Fri · 8:00 AM to 6:00 PM"), dates and away ranges, all through Intl in
// the reader's locale. Pure: the editors and summaries in ./HoursParts.tsx use these, and so do the
// back office's read-only views.
import {
  PEOPLE_HOURS_MAX_CONTACTS,
  type PeopleHours,
  type PersonHoursView,
  processes,
} from "@countersign/core";
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

/**
 * What is wrong with a week, as a translated sentence, or null: no open hours on any day (the
 * server refuses that week, 422 `invalid_hours`), an end before its start, overlaps.
 */
export function weekProblem(week: Week, { t, intl }: Pick<I18n, "t" | "intl">): string | null {
  if (WEEKDAYS.every((day) => (week[day]?.length ?? 0) === 0)) return t("hours.problem.none");
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

/**
 * A person's hours as the People hours list gives them: theirs (null: the business's, never away),
 * or undefined when a contact isn't on a list that may have left contacts out (it carries at most
 * PEOPLE_HOURS_MAX_CONTACTS), so their hours aren't known here.
 */
// DECISION (web, wave 3b): a contact past the list's cap gets no editor (saving would erase the
// week we never read); a list under the cap is complete, so a contact missing from it has none.
export function listedHours(
  list: Pick<PeopleHours, "people">,
  kind: PersonHoursView["kind"],
  id: string,
): processes.PersonHours | null | undefined {
  const found = list.people.find((p) => p.kind === kind && p.id === id);
  if (found) return found.hours;
  const contacts = list.people.filter((p) => p.kind === "contact").length;
  return kind === "contact" && contacts >= PEOPLE_HOURS_MAX_CONTACTS ? undefined : null;
}

/** The latest a stretch may end: a day's hours stay within the day. */
export const LAST_MINUTE = "23:59";

/** "HH:MM" plus whole hours, capped at 23:59. */
export function addHours(hhmm: string, hours: number): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const total = Math.min(h * 60 + m + hours * 60, 23 * 60 + 59);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * The stretch "Add hours" adds after a day's last one: an hour after it ends and two hours long,
 * else (late in the day) from where it ends to 23:59. Null when the day has no room left after
 * its last stretch, so Add hours is off rather than adding 23:59 to 23:59.
 */
// DECISION (web, wave 3b): near midnight the new stretch starts where the last one ends (touching
// is not overlapping) and stops at 23:59; a day whose last stretch ends at 23:59 offers no Add.
export function nextStretch(stretches: readonly Stretch[], first: Stretch): Stretch | null {
  if (stretches.length === 0) return first;
  const end = stretches.reduce((latest, s) => (s.to > latest ? s.to : latest), "00:00");
  if (end >= LAST_MINUTE) return null;
  const gap = addHours(end, 1);
  const from = gap < LAST_MINUTE ? gap : end;
  return { from, to: addHours(from, 2) };
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
