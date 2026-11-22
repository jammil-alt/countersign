// File and email intake (docs/plan.md §1.213): the pure rules a report file is checked by. Which
// profile a file is (its name and sender; its columns are read by the caller), the control
// total, when a scheduled report was due, and a first profile proposed from a file's headers.
// Code only; no model reads these files.

import { Decimal } from "../money";
import type { ReportExpected, ReportProfile } from "../schemas/report-profile";
import type { TableColumn } from "../schemas/table";
import { addDays, zonedParts, zonedTimeToUtc } from "../weekly/week";
import { isEmptyCell, type TableRead } from "./files";

/** Whether a file name fits a pattern: `*` for any run of characters, in any case. */
export function filenameMatches(pattern: string, filename: string): boolean {
  const re = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "i").test(filename.trim());
}

/** Whether a sender is one a profile names (an address, or its domain); any when it names none. */
export function senderMatches(senders: readonly string[], from: string | null): boolean {
  if (senders.length === 0) return true;
  if (!from) return false;
  const address = from.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return senders.some((s) =>
    s.includes("@") ? s === address : domain === s || domain.endsWith(`.${s}`),
  );
}

/** Whether a profile's name and sender rules let a file be its report (its columns aside). */
export function profileMayMatch(
  profile: Pick<ReportProfile, "match">,
  file: { filename: string; from: string | null },
): boolean {
  if (profile.match.filename && !filenameMatches(profile.match.filename, file.filename)) {
    return false;
  }
  return senderMatches(profile.match.senders, file.from);
}

export type ControlTotalCheck =
  | { status: "none" }
  | { status: "ok"; field: string; expected: string; found: string; totalRow: number }
  | { status: "mismatch"; field: string; expected: string; found: string; totalRow: number };

function decimalOf(v: unknown): Decimal | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Decimal(v);
  if (typeof v === "string" && v.trim() !== "") {
    try {
      return new Decimal(v.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The control total: the sum of a column over the rows read against the file's own total row
 * (its last, the grand total, when there are subtotals). `none` when the file has no total for
 * the column: the check runs only when the report has one.
 */
// DECISION: the last total row is the control total; amounts compare exactly, as decimals.
export function checkControlTotal(read: TableRead, field: string): ControlTotalCheck {
  const total = [...read.totals].reverse().find((t) => decimalOf(t.values[field]) !== null);
  if (!total) return { status: "none" };
  const expected = decimalOf(total.values[field]) as Decimal;
  let found = new Decimal(0);
  for (const row of read.rows) {
    const v = decimalOf(row[field]);
    if (v) found = found.plus(v);
  }
  return {
    status: found.equals(expected) ? "ok" : "mismatch",
    field,
    expected: expected.toFixed(),
    found: found.toFixed(),
    totalRow: total.row,
  };
}

const isoDay = (p: { year: number; month: number; day: number }) =>
  `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

function monthDay(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toISOString().slice(0, 10);
}

/**
 * The last time a scheduled report was due at or before `now` and the one before it, as
 * instants: a report that lands in between is that period's. Days and hours are the client's.
 */
export function lastDue(
  expected: ReportExpected,
  now: Date,
  timezone: string,
): { due: Date; previous: Date } {
  const p = zonedParts(now, timezone);
  const today = isoDay(p);
  const at = (day: string) => zonedTimeToUtc(day, expected.byHour, 0, timezone);
  switch (expected.every) {
    case "day": {
      const due = at(today) <= now ? today : addDays(today, -1);
      return { due: at(due), previous: at(addDays(due, -1)) };
    }
    case "week": {
      const back = (p.weekday - (expected.weekday ?? 1) + 7) % 7;
      let day = addDays(today, -back);
      if (at(day) > now) day = addDays(day, -7);
      return { due: at(day), previous: at(addDays(day, -7)) };
    }
    case "month": {
      const dom = expected.day ?? 1;
      let y = p.year;
      let m = p.month;
      if (at(monthDay(y, m, dom)) > now) {
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      const due = monthDay(y, m, dom);
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { due: at(due), previous: at(monthDay(py, pm, dom)) };
    }
  }
}

/**
 * Whether a scheduled report is missing at `now`: its last due time and grace have passed, it
 * was due after the profile was made, and no file of it landed since the period began.
 */
export function reportMissing(
  expected: ReportExpected,
  input: { now: Date; timezone: string; since: Date | null; lastLandedAt: Date | null },
): { missing: false } | { missing: true; due: Date } {
  const { due, previous } = lastDue(expected, input.now, input.timezone);
  if (input.now.getTime() < due.getTime() + expected.graceHours * 3_600_000) {
    return { missing: false };
  }
  if (input.since && due < input.since) return { missing: false };
  if (input.lastLandedAt && input.lastLandedAt > previous) return { missing: false };
  return { missing: true, due };
}

/**
 * A first profile's columns from a file read with none: each header a column, typed by its
 * values (money for amounts with two decimals, number, date when the reader made ISO dates,
 * text otherwise), required when no row leaves it empty. The operator checks it before saving.
 */
export function proposeColumns(read: TableRead): TableColumn[] {
  return read.columns.map((c): TableColumn => {
    const values = read.rows.map((r) => r[c.field]);
    const filled = values.filter((v) => !isEmptyCell(v));
    const all = (test: (v: unknown) => boolean) => filled.length > 0 && filled.every(test);
    const text = (v: unknown) => String(v).trim();
    let type: TableColumn["type"] = "text";
    let dateStyle: TableColumn["dateStyle"];
    if (all((v) => /^\d{4}-\d{2}-\d{2}$/.test(text(v)))) type = "date";
    else if (all((v) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text(v)))) {
      // DECISION: a slashed date is proposed month first (US systems such as CR2 and Great
      // Plains); the operator switches it to day first before saving when it isn't.
      type = "date";
      dateStyle = "mdy";
    } else if (all((v) => /^-?\$?\(?[\d,]*\.\d{2}\)?$/.test(text(v)))) type = "money";
    else if (all((v) => /^-?[\d,]+(\.\d+)?$/.test(text(v)))) type = "number";
    return {
      field: c.field,
      headers: c.header ? [c.header] : [],
      type,
      ...(dateStyle ? { dateStyle } : {}),
      required: filled.length === values.length && values.length > 0,
    };
  });
}
