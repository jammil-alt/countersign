// Collect reports (owner, 2026-11-24): a step that waits for several reports, each from its own
// owner, and goes on only once each has come in and passed its checks. Each report says what it
// is, who owns it, how often it comes (which sets the dates it must cover), what file it must be
// (PDF, spreadsheet or image; a spreadsheet's columns), when it is due and when to follow up.
// The step says when to escalate and to whom. The owner sends the file through a "Request info"
// link (forms, docs/plan.md §1.121), so every message goes through reach out (consent, quiet
// hours, approval); the file is checked here, in code, never by a model (invariant 7).
//
// Pure: the schema's item types, the period a report covers, the checks on what came in, and
// what the step's output looks like. The executor runs the step (packages/workflows).

import { z } from "zod";
import { isTableType } from "../documents/tables";
import { Duration, parseDuration } from "../duration";
import { type JsonSchema, NodeId } from "../schemas/common";
import { type TableColumn, TableColumns, TableFieldName } from "../schemas/table";

// ── The schema's parts ───────────────────────────────────────────────────────────────────────

/** What a report's file may be. `spreadsheet` is a .csv or .xlsx file. */
export const REPORT_FORMATS = ["pdf", "spreadsheet", "image"] as const;
export const ReportFormat = z.enum(REPORT_FORMATS);
export type ReportFormat = z.infer<typeof ReportFormat>;

/** How often a report comes: it covers the last whole period before the step starts. */
export const REPORT_FREQUENCIES = [
  "once",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;
export const ReportFrequency = z.enum(REPORT_FREQUENCIES);
export type ReportFrequency = z.infer<typeof ReportFrequency>;

export const COLLECT_HOURS = ["clock", "business"] as const;

/** The most reports one step waits for. */
export const COLLECT_ITEMS_MAX = 20;
/** The most follow-ups after the first request, per report. */
export const COLLECT_FOLLOW_UPS_MAX = 5;
/** Each link stays open at least an hour and at most 30 days (forms' own limits). */
export const COLLECT_WINDOW_MIN = "1 hour";
export const COLLECT_WINDOW_MAX = "30 days";

/**
 * When we follow up on a report that isn't in: `after` the due date the first follow-up goes,
 * then one every `every`, at most `max` of them. A follow-up is a new link to the owner.
 */
export const CollectFollowUp = z.strictObject({
  after: Duration,
  every: Duration,
  max: z.number().int().min(0).max(COLLECT_FOLLOW_UPS_MAX).default(2),
});
export type CollectFollowUp = z.infer<typeof CollectFollowUp>;

/** A spreadsheet's date column, whose dates must all fall in the report's period. */
export const CollectDates = z.strictObject({ field: TableFieldName });

/** A sample the report was described from: its name only, never its contents (invariant 11). */
export const CollectSample = z.strictObject({ filename: z.string().trim().min(1).max(255) });

/** One report the step waits for. */
export const CollectItem = z.strictObject({
  id: NodeId,
  /** "Bank statement", "Tampa sales report". */
  name: z.string().trim().min(1).max(120),
  /** What it is, in plain words, for the owner: shown on the link's page. */
  describe: z.string().trim().max(500).optional(),
  /** Who sends it: `seat:<role>` (each client binds its people) or a contact id. */
  owner: z.string().min(1).max(200),
  /** A report that isn't required doesn't hold the step up once its follow-ups are done. */
  required: z.boolean().default(true),
  frequency: ReportFrequency.default("monthly"),
  formats: z.array(ReportFormat).min(1).max(REPORT_FORMATS.length).default(["pdf", "spreadsheet"]),
  /** A spreadsheet's expected columns (Read table's): a required one missing fails the check. */
  columns: TableColumns.optional(),
  /** A spreadsheet's date column: every dated row must fall in the period. */
  dates: CollectDates.optional(),
  /** A spreadsheet must have at least this many rows. */
  minRows: z.number().int().min(1).max(100_000).optional(),
  sample: CollectSample.optional(),
  /** When it is due, counted from when the step starts (the trigger: month end, say). */
  due: Duration,
  hours: z.enum(COLLECT_HOURS).default("business"),
  followUp: CollectFollowUp,
});
export type CollectItem = z.infer<typeof CollectItem>;
export type CollectItemInput = z.input<typeof CollectItem>;

/** What the person escalated to may answer. */
export const COLLECT_ESCALATION_CHOICES = ["keep_asking", "go_on", "stop"] as const;
export type CollectEscalationChoice = (typeof COLLECT_ESCALATION_CHOICES)[number];

export const COLLECT_CHOICE_LABELS: Record<CollectEscalationChoice, string> = {
  keep_asking: "Keep asking",
  go_on: "Go on without it",
  stop: "Stop the run",
};

/** The most times one report is escalated: the second time, "Keep asking" isn't offered. */
export const COLLECT_ESCALATIONS_MAX = 2;

// ── The period a report covers ───────────────────────────────────────────────────────────────

export interface ReportPeriod {
  /** ISO dates, both included. */
  from: string;
  to: string;
  /** "October 2026", "Q3 2026", "2026", "the week of 2026-11-16", "2026-11-23". */
  label: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The calendar date `at` falls on in `timeZone`, as a UTC midnight. */
function localDate(at: Date, timeZone: string): Date {
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    text = at.toISOString().slice(0, 10);
  }
  return new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/**
 * The last whole period before `at` (in the client's zone) that a report of this frequency
 * covers; null for a one-off report, which has no dates to check.
 */
// DECISION: a report covers the period that ended before the step started ("monthly" run on
// 1 December collects November's), the usual close: no field says otherwise yet.
export function reportPeriod(
  frequency: ReportFrequency,
  at: Date,
  timeZone = "UTC",
): ReportPeriod | null {
  const today = localDate(at, timeZone);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  switch (frequency) {
    case "once":
      return null;
    case "daily": {
      const day = utc(y, m, d - 1);
      return { from: iso(day), to: iso(day), label: iso(day) };
    }
    case "weekly": {
      // Weeks run Monday to Sunday.
      const sinceMonday = (today.getUTCDay() + 6) % 7;
      const from = utc(y, m, d - sinceMonday - 7);
      const to = utc(y, m, d - sinceMonday - 1);
      return { from: iso(from), to: iso(to), label: `the week of ${iso(from)}` };
    }
    case "monthly": {
      const from = utc(y, m - 1, 1);
      const to = utc(y, m, 0);
      return {
        from: iso(from),
        to: iso(to),
        label: `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`,
      };
    }
    case "quarterly": {
      const q = Math.floor(m / 3);
      const from = utc(y, (q - 1) * 3, 1);
      const to = utc(y, q * 3, 0);
      return {
        from: iso(from),
        to: iso(to),
        label: `Q${Math.floor(from.getUTCMonth() / 3) + 1} ${from.getUTCFullYear()}`,
      };
    }
    case "yearly":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) };
  }
}

// ── Follow-ups ───────────────────────────────────────────────────────────────────────────────

/**
 * How long a link may stay open: at least an hour, at most 30 days (forms refuse anything else),
 * in whole minutes, as a duration forms take.
 */
export function linkWindow(ms: number): Duration {
  const min = parseDuration(COLLECT_WINDOW_MIN);
  const max = parseDuration(COLLECT_WINDOW_MAX);
  const clamped = Math.min(max, Math.max(min, ms));
  return `${Math.ceil(clamped / 60_000)} minutes` as Duration;
}

/**
 * When a report's link closes: the first link at the due date plus `followUp.after` (when the
 * first follow-up goes), a follow-up's after `followUp.every`; never later than the escalation,
 * which then takes its turn.
 */
// DECISION: a link stays open until the next follow-up would go, so there is never a gap in
// which the owner holds a closed link; the page and the message show that closing date.
export function linkClosesAt(p: {
  now: Date;
  dueAt: Date;
  followUp: Pick<CollectFollowUp, "after" | "every">;
  first: boolean;
  escalateAt: Date | null;
}): Date {
  const at = p.first
    ? p.dueAt.getTime() + parseDuration(p.followUp.after)
    : p.now.getTime() + parseDuration(p.followUp.every);
  const capped = p.escalateAt ? Math.min(at, p.escalateAt.getTime()) : at;
  return new Date(Math.max(capped, p.now.getTime()));
}

// ── Checks on what came in ───────────────────────────────────────────────────────────────────

/** A file the owner sent, as the API read it for the checks. */
export interface ReportFile {
  documentId: string;
  filename: string;
  mimeType: string;
  /** A spreadsheet read by the item's columns (Read table's reader); absent for other files. */
  table?:
    | {
        /** Why it can't be read by the columns (a required column missing); null when it can. */
        failure: string | null;
        rows: readonly Record<string, unknown>[];
      }
    | { error: string };
}

export interface ReportCheck {
  ok: boolean;
  /** In plain words, for the owner and the timeline; empty when `ok`. */
  problems: string[];
  /** The documents that passed. */
  documents: string[];
  /**
   * The rows of the spreadsheets that passed, read by the report's columns (Read table's rows),
   * one file after another; empty for a PDF or an image, and when it didn't pass.
   */
  rows: Record<string, unknown>[];
  /**
   * How it came in, set by the API: `true` or `false` when it was emailed to the step (whether
   * DMARC proved the sender), absent or null when it was uploaded through the link.
   */
  senderProven?: boolean | null;
}

/** A file's format, or null for one no report takes. */
export function reportFormatOf(mimeType: string): ReportFormat | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  if (isTableType(mimeType) && mimeType !== "application/json") return "spreadsheet";
  return null;
}

const FORMAT_WORDS: Record<ReportFormat, string> = {
  pdf: "a PDF",
  spreadsheet: "a spreadsheet (.csv or .xlsx)",
  image: "an image",
};

/** "a PDF or a spreadsheet (.csv or .xlsx)". */
export function formatWords(formats: readonly ReportFormat[]): string {
  const words = formats.map((f) => FORMAT_WORDS[f]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/** The most problems kept per check. */
const PROBLEMS_MAX = 10;

/**
 * Whether what the owner sent is the report: every file in a format it takes, and each
 * spreadsheet with its required columns, enough rows and every dated row in the period. Code
 * only (invariant 7): the same files always give the same answer.
 */
export function checkReport(
  item: Pick<CollectItem, "formats" | "columns" | "dates" | "minRows" | "name">,
  period: ReportPeriod | null,
  files: readonly ReportFile[],
): ReportCheck {
  const problems: string[] = [];
  if (files.length === 0) {
    return {
      ok: false,
      problems: [`No file came with the ${item.name}.`],
      documents: [],
      rows: [],
    };
  }
  for (const f of files) {
    const format = reportFormatOf(f.mimeType);
    if (!format || !item.formats.includes(format)) {
      problems.push(`${f.filename} isn't ${formatWords(item.formats)}.`);
      continue;
    }
    if (format !== "spreadsheet" || !f.table) continue;
    if ("error" in f.table) {
      problems.push(`${f.filename} couldn't be read: ${f.table.error}`);
      continue;
    }
    if (f.table.failure) {
      problems.push(`${f.filename}: ${f.table.failure}`);
      continue;
    }
    const rows = f.table.rows;
    if (item.minRows !== undefined && rows.length < item.minRows) {
      problems.push(
        `${f.filename} has ${rows.length} ${rows.length === 1 ? "row" : "rows"}; we need at least ${item.minRows}.`,
      );
    }
    if (item.dates && period) {
      const field = item.dates.field;
      const column = columnLabelOf(item.columns, field);
      const dated = rows
        .map((r) => r[field])
        .filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v));
      if (dated.length === 0) {
        problems.push(`${f.filename} has no dates in ${column}.`);
      } else {
        const outside = dated.filter((v) => {
          const day = v.slice(0, 10);
          return day < period.from || day > period.to;
        });
        if (outside.length > 0) {
          problems.push(
            `${f.filename} has ${outside.length} ${outside.length === 1 ? "row" : "rows"} dated outside ${period.label} (${period.from} to ${period.to}), the first ${outside[0]?.slice(0, 10)}.`,
          );
        }
      }
    }
  }
  const shown = problems.slice(0, PROBLEMS_MAX);
  if (problems.length > PROBLEMS_MAX) shown.push(`and ${problems.length - PROBLEMS_MAX} more.`);
  const ok = problems.length === 0;
  // Collect reports (owner, 2026-11-24): the rows are handed on, so the next step reads the
  // report's data without reading its file again.
  const rows = ok
    ? files.flatMap((f) => (f.table && !("error" in f.table) ? [...f.table.rows] : []))
    : [];
  return {
    ok,
    problems: shown,
    documents: ok ? files.map((f) => f.documentId) : [],
    rows,
  };
}

function columnLabelOf(columns: readonly TableColumn[] | undefined, field: string): string {
  const c = columns?.find((x) => x.field === field);
  return c?.headers[0] ?? field;
}

/** The files a report's spreadsheets must be read by: its columns, or every header. */
export function readParameters(item: Pick<CollectItem, "columns">): Record<string, unknown> {
  return item.columns && item.columns.length > 0 ? { columns: item.columns } : {};
}

// ── What the step asks the owner ─────────────────────────────────────────────────────────────

/** The files question's id on every request a collect step sends. */
export const COLLECT_FILE_QUESTION = "report";

/**
 * The purpose of one request, in plain words: what we need and for which dates; a follow-up says
 * so, and one after a file that didn't pass says why. Fixed text built from the operator's own
 * (invariant 9): nothing a model wrote and nothing the owner sent goes into it.
 */
/** The most a request's purpose says (forms' own limit). */
const PURPOSE_MAX = 500;

export function requestPurpose(p: {
  item: Pick<CollectItem, "name" | "describe" | "formats" | "columns">;
  period: ReportPeriod | null;
  send: number;
  problems?: readonly string[];
  /** The step's address (`agentStepAddress`), when owners may email the file too. */
  email?: string | null;
}): string {
  const what = p.period ? `the ${p.item.name} for ${p.period.label}` : `the ${p.item.name}`;
  const lead =
    p.problems && p.problems.length > 0
      ? `The file we got for ${what} didn't pass our checks: ${p.problems.join(" ")} Please send it again.`
      : p.send > 1
        ? `A reminder: we still need ${what}.`
        : `Please send us ${what}.`;
  const format = ` Send ${formatWords(p.item.formats)}`;
  const required = (p.item.columns ?? []).filter((c) => c.required);
  const cols =
    required.length > 0
      ? ` with the columns ${required.map((c) => c.headers[0] ?? c.field).join(", ")}.`
      : ".";
  const email = p.email ? ` You can also email it to ${p.email}.` : "";
  // The format and the address are never cut: a long list of problems is, then the description.
  const tail = `${format}${cols}${email}`;
  const room = PURPOSE_MAX - tail.length;
  const head = lead.length > room ? `${lead.slice(0, Math.max(0, room - 1))}…` : lead;
  const describe = p.item.describe ? ` ${p.item.describe}` : "";
  return `${head}${tail}${describe}`.slice(0, PURPOSE_MAX);
}

// ── The step's output ────────────────────────────────────────────────────────────────────────

export const COLLECT_ITEM_STATUSES = [
  "received",
  "missing",
  "skipped",
  "not_sent",
  "declined",
] as const;
export type CollectItemStatus = (typeof COLLECT_ITEM_STATUSES)[number];

export interface CollectItemResult {
  id: string;
  name: string;
  owner: string;
  required: boolean;
  /** `received`: in and checked. `skipped`: a person said go on without it. */
  status: CollectItemStatus;
  period: ReportPeriod | null;
  dueAt: string;
  /** The documents that passed (`received`). */
  documents: string[];
  /** The last check's problems, when a file came and didn't pass. */
  problems: string[];
  /** How many links went out (the first request and its follow-ups). */
  sends: number;
  escalations: number;
  /** A received spreadsheet's rows (`ReportCheck.rows`); the output keeps them under `reports`. */
  rows?: Record<string, unknown>[];
  /** Emailed to the step: whether DMARC proved the sender; null when uploaded through the link. */
  senderProven?: boolean | null;
}

/** One report as the next step reads it: `steps.<id>.output.reports.<report id>`. */
export interface CollectReport {
  status: CollectItemStatus;
  documents: string[];
  /** A spreadsheet's rows, by the report's columns; empty for a PDF or an image. */
  rows: Record<string, unknown>[];
  rowCount: number;
  /**
   * Emailed to the step: whether DMARC proved the sender (false: the From address claimed to be
   * the owner's, unproven); null when uploaded through the link or not received.
   */
  senderProven: boolean | null;
}

export interface CollectOutput {
  /** Every required report is in and passed. */
  complete: boolean;
  items: Omit<CollectItemResult, "rows">[];
  /**
   * Each report by its id, with what came in: its documents and, for a spreadsheet, its rows,
   * which the next step (a reconciliation) reads as it would a Read table step's.
   */
  reports: Record<string, CollectReport>;
  /** Every document that passed, for the next step (a reconciliation). */
  documents: string[];
  received: number;
  missing: number;
  summary: string;
  sources: string[];
}

/**
 * The step's output schema. With the step, `reports` is typed report by report: each one's rows
 * by its columns (as Read table's are, through `valueSchema`), so a later step's template that
 * reads a column the report doesn't have is caught.
 */
export function collectOutputSchema(
  step?: { items: readonly Pick<CollectItem, "id" | "columns" | "formats">[] },
  valueSchema?: (type: TableColumn["type"]) => JsonSchema,
): JsonSchema {
  const rowOf = (columns: readonly TableColumn[] | undefined): JsonSchema =>
    !columns?.length || !valueSchema
      ? { type: "object", additionalProperties: true }
      : {
          type: "object",
          properties: Object.fromEntries(columns.map((c) => [c.field, valueSchema(c.type)])),
          required: columns.filter((c) => c.required === true).map((c) => c.field),
          additionalProperties: false,
        };
  const reportOf = (rows: JsonSchema): JsonSchema => ({
    type: "object",
    properties: {
      status: { type: "string", enum: [...COLLECT_ITEM_STATUSES] },
      documents: { type: "array", items: { type: "string" } },
      rows: { type: "array", items: rows },
      rowCount: { type: "integer" },
      senderProven: { type: ["boolean", "null"] },
    },
    required: ["status", "documents", "rows", "rowCount", "senderProven"],
  });
  const reports: JsonSchema = step
    ? {
        type: "object",
        properties: Object.fromEntries(
          step.items.map((i) => [
            i.id,
            reportOf(i.formats.includes("spreadsheet") ? rowOf(i.columns) : rowOf(undefined)),
          ]),
        ),
        required: step.items.map((i) => i.id),
      }
    : { type: "object", additionalProperties: reportOf(rowOf(undefined)) };
  return withReports(baseOutputSchema(), reports);
}

function withReports(base: JsonSchema, reports: JsonSchema): JsonSchema {
  const b = base as { properties: Record<string, JsonSchema>; required: string[] };
  return {
    ...base,
    properties: { ...b.properties, reports },
    required: [...b.required, "reports"],
  } as JsonSchema;
}

function baseOutputSchema(): JsonSchema {
  const period: JsonSchema = {
    type: ["object", "null"],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      label: { type: "string" },
    },
  };
  return {
    type: "object",
    properties: {
      complete: { type: "boolean" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            owner: { type: "string" },
            required: { type: "boolean" },
            status: { type: "string", enum: [...COLLECT_ITEM_STATUSES] },
            period,
            dueAt: { type: "string" },
            documents: { type: "array", items: { type: "string" } },
            problems: { type: "array", items: { type: "string" } },
            sends: { type: "integer" },
            escalations: { type: "integer" },
          },
          required: ["id", "name", "status", "documents"],
        },
      },
      documents: { type: "array", items: { type: "string" } },
      received: { type: "integer" },
      missing: { type: "integer" },
      summary: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["complete", "items", "documents", "received", "missing", "summary"],
  };
}

/** The step's output from each report's end. */
export function collectOutput(items: readonly CollectItemResult[]): CollectOutput {
  const received = items.filter((i) => i.status === "received");
  const documents = [...new Set(received.flatMap((i) => i.documents))];
  const missingRequired = items.filter((i) => i.required && i.status !== "received");
  const missing = items.length - received.length;
  const summary =
    missing === 0
      ? `All ${items.length} ${items.length === 1 ? "report" : "reports"} in and checked`
      : `${received.length} of ${items.length} reports in; missing: ${items
          .filter((i) => i.status !== "received")
          .map((i) => i.name)
          .join(", ")}`;
  const reports: Record<string, CollectReport> = {};
  for (const i of items) {
    const rows = i.status === "received" ? (i.rows ?? []) : [];
    reports[i.id] = {
      status: i.status,
      documents: i.status === "received" ? i.documents : [],
      rows,
      rowCount: rows.length,
      senderProven: i.status === "received" ? (i.senderProven ?? null) : null,
    };
  }
  return {
    complete: missingRequired.length === 0,
    items: items.map(({ rows: _rows, ...rest }) => rest),
    reports,
    documents,
    received: received.length,
    missing,
    summary,
    sources: documents,
  };
}

// ── What the validator checks ────────────────────────────────────────────────────────────────

export type CollectProblemCode =
  | "collect_item_ids"
  | "collect_columns_format"
  | "collect_dates_column"
  | "collect_dates_once"
  | "collect_window";

export interface CollectProblem {
  code: CollectProblemCode;
  field: string;
  message: string;
}

/** What the schema can't say about a collect step's reports. */
export function collectProblems(step: { items: readonly CollectItem[] }): CollectProblem[] {
  const out: CollectProblem[] = [];
  const seen = new Set<string>();
  const min = parseDuration(COLLECT_WINDOW_MIN);
  const max = parseDuration(COLLECT_WINDOW_MAX);
  step.items.forEach((item, i) => {
    const at = `items.${i}`;
    if (seen.has(item.id)) {
      out.push({
        code: "collect_item_ids",
        field: `${at}.id`,
        message: `two reports have the id "${item.id}"`,
      });
    }
    seen.add(item.id);
    const sheet = item.formats.includes("spreadsheet");
    if (!sheet && (item.columns?.length || item.dates || item.minRows !== undefined)) {
      out.push({
        code: "collect_columns_format",
        field: `${at}.columns`,
        message: `"${item.name}": columns, dates and rows are checked only in a spreadsheet; allow spreadsheets or clear them`,
      });
    }
    if (item.dates) {
      const c = item.columns?.find((x) => x.field === item.dates?.field);
      if (c?.type !== "date") {
        out.push({
          code: "collect_dates_column",
          field: `${at}.dates.field`,
          message: `"${item.name}": the dates are checked in a date column of its own; add "${item.dates.field}" as a date column`,
        });
      }
      if (item.frequency === "once") {
        out.push({
          code: "collect_dates_once",
          field: `${at}.dates`,
          message: `"${item.name}" comes once, so it has no period to check its dates against`,
        });
      }
    }
    for (const [k, d] of [
      ["after", item.followUp.after],
      ["every", item.followUp.every],
    ] as const) {
      const ms = parseDuration(d);
      if (ms < min || ms > max) {
        out.push({
          code: "collect_window",
          field: `${at}.followUp.${k}`,
          message: `"${item.name}": follow-ups are between ${COLLECT_WINDOW_MIN} and ${COLLECT_WINDOW_MAX} apart`,
        });
      }
    }
  });
  return out;
}

/** Durable steps one link takes at most (send, approval, wait, check): for the size estimate. */
export const COLLECT_STEPS_PER_SEND = 12;

/** About how many durable steps a collect step can take, at its most follow-ups. */
export function collectDurableEstimate(step: { items: readonly CollectItem[] }): number {
  let n = 2;
  for (const item of step.items) {
    const sends = (1 + item.followUp.max) * COLLECT_ESCALATIONS_MAX;
    n += sends * COLLECT_STEPS_PER_SEND + COLLECT_ESCALATIONS_MAX * 6;
  }
  return n;
}

// ── A sample file (the builder's "Add a sample") ────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/;
const MONEY = /^-?\(?[$€£]?\s?-?[\d,]*\.\d{2}\)?$/;
const NUMBER = /^-?[\d,]*\.?\d+$/;

/** A header as a field name, for a column added by hand: "Posted date" → "posted_date". */
export function fieldFromHeader(header: string, taken: Iterable<string> = []): string {
  return fieldOf(header, 0, new Set(taken));
}

/** A header as a field name: "Posted date" → "posted_date"; "#" → "column_3". */
function fieldOf(header: string, i: number, taken: Set<string>): string {
  let f = header
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  if (!/^[a-z]/.test(f)) f = f ? `c_${f}` : `column_${i + 1}`;
  let out = f;
  for (let n = 2; taken.has(out); n++) out = `${f}_${n}`;
  taken.add(out);
  return out;
}

/** A column's type from its values: date (and how it is written), money, number, else text. */
function guessType(values: readonly unknown[]): Pick<TableColumn, "type" | "dateStyle"> {
  const cells = values
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map((v) => (v instanceof Date ? v.toISOString() : v));
  if (cells.length === 0) return { type: "text" };
  const text = cells.map((v) => String(v).trim());
  if (text.every((v) => ISO_DATE.test(v))) return { type: "date", dateStyle: "iso" };
  if (text.every((v) => SLASH_DATE.test(v))) {
    // Day first when a first part is over 12 anywhere; else month first, as most US files are.
    const dayFirst = text.some((v) => Number(SLASH_DATE.exec(v)?.[1]) > 12);
    return { type: "date", dateStyle: dayFirst ? "dmy" : "mdy" };
  }
  if (cells.every((v) => typeof v === "number")) return { type: "number" };
  if (text.every((v) => MONEY.test(v))) return { type: "money" };
  if (text.every((v) => NUMBER.test(v))) return { type: "number" };
  return { type: "text" };
}

/**
 * The expected columns a sample spreadsheet suggests: one per header, typed from its first rows,
 * each required. The operator edits them after; the sample itself is never kept (invariant 11).
 */
export function columnsFromSample(
  headers: readonly { field: string; header: string | null }[],
  rows: readonly Record<string, unknown>[],
): TableColumn[] {
  const taken = new Set<string>();
  const out: TableColumn[] = [];
  headers.forEach((h, i) => {
    const header = (h.header ?? h.field).trim();
    if (!header) return;
    const field = fieldOf(header, i, taken);
    const guess = guessType(rows.slice(0, 50).map((r) => r[h.field]));
    out.push({ field, headers: [header.slice(0, 200)], ...guess, required: true });
  });
  return out.slice(0, 200);
}
