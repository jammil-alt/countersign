// File and email intake (owner, 2026-11-22; docs/plan.md §1.213): a client's systems with no open
// API (CR2, Great Plains) send their reports by email or export them. A report profile says how
// one kind of report reads, once, so the second file of that kind needs no setup: how to know it
// (a file name pattern, its senders), how to read it (Read table's own parameter values, the
// `columns` parameter first: no second mapping system), the control total to check, and when it
// is expected. Profiles are the client's upload connection's settings (`config.reports`), set in
// the back office. Data only: nothing a model writes.

import { z } from "zod";
import { TableFieldName } from "./table";

export const ReportProfileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");

/**
 * When a report is expected: every day, every week on a weekday (1 Monday … 7 Sunday) or every
 * month on a day (1–28), by an hour of the client's day. A report not in by then, with the grace
 * hours on top, raises a missing-report alert.
 */
export const ReportExpected = z.strictObject({
  every: z.enum(["day", "week", "month"]),
  weekday: z.number().int().min(1).max(7).optional(),
  day: z.number().int().min(1).max(28).optional(),
  /** The hour of the client's day (its time zone) the report should be in by, 0–23. */
  byHour: z.number().int().min(0).max(23).default(9),
  /** Hours past `byHour` before it counts as missing. */
  graceHours: z.number().int().min(0).max(72).default(2),
});
export type ReportExpected = z.infer<typeof ReportExpected>;

export const ReportProfile = z.strictObject({
  id: ReportProfileId,
  /** As people say it: "CR2 daily sales", "Great Plains open payables". */
  name: z.string().trim().min(1).max(120),
  match: z
    .strictObject({
      /** The file's name, `*` for any run of characters, any case (`daily_sales_*.csv`). */
      filename: z.string().trim().min(1).max(200).optional(),
      /** Addresses (`reports@shop.com`) or domains (`shop.com`) it comes from; none: any sender. */
      senders: z.array(z.string().trim().toLowerCase().min(1).max(200)).max(20).default([]),
    })
    .default({ senders: [] }),
  /**
   * Read table's parameter values (`columns`, `sheet`, `header_row`, `skip_rows`, `range`,
   * `skip_total_rows`, …), checked by core's `tableFiles.readTableOptions`. A file is this
   * report when every required column is found.
   */
  read: z.record(z.string(), z.unknown()),
  /** The money or number column whose sum must equal the file's own total row, when it has one. */
  controlTotal: z.strictObject({ field: TableFieldName }).nullable().default(null),
  expected: ReportExpected.nullable().default(null),
  /** When the profile was saved first: no report is missing for a time before it. */
  createdAt: z.iso.datetime().optional(),
});
export type ReportProfile = z.infer<typeof ReportProfile>;
export type ReportProfileInput = z.input<typeof ReportProfile>;

export const ReportProfiles = z
  .array(ReportProfile)
  .max(50)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
    message: "each report is named once",
  });
export type ReportProfiles = z.infer<typeof ReportProfiles>;

/** The raw_record entity types intake lands: one per report file, one per row. */
export const REPORT_FILE_ENTITY = "report_file";
export const reportRowEntity = (profileId: string) => `report:${profileId}`;

/** The alert kinds intake raises (invariant 10: each with its sources). */
export const REPORT_MISSING_ALERT = "intake.report_missing";
export const REPORT_CONTROL_TOTAL_ALERT = "intake.control_total";
