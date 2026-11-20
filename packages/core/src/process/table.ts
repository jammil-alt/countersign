// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): Read table and Write table,
// two built-in deterministic skills beside Reshape data. Read table turns a .csv, .xlsx or .json
// document into rows of typed fields by the expected columns its `columns` parameter names; Write
// table turns rows back into a .csv or .xlsx document. Reshape data maps between them and the
// steps around them. This file holds what is pure and shared by the runtime, the server and the
// builder: the skills' ids and parameters, the cells' typing, header matching, row skips and
// limits, the output schema the columns give, and rows laid out for writing. The file formats
// themselves (CSV and XLSX bytes) are packages/connectors' (`upload/xlsx.ts`, `upload/tables.ts`).
// No model ever reads these files: CSV, XLSX and JSON are read in code (invariant 9).

import { z } from "zod";
import { parseXlsxRange, type XlsxCell, type XlsxRange, xlsxColumnLetters } from "../desktop/a1";
import { isPlainObject } from "../json";
import { Decimal } from "../money";
import { type JsonSchema, parseSkillRef } from "../schemas/common";
import type { SkillParameter } from "../schemas/skill-model";
import {
  headerKey,
  type TableColumn,
  TableColumns,
  type TableColumnType,
  type TableDateStyle,
} from "../schemas/table";
import { lookupSkill, type TypingContext } from "../template/typer";
import type { Step } from "./schema";

// ── The skills ──────────────────────────────────────────────────────────────────────────────

export const READ_TABLE_SKILL = "data.read-table";
export const READ_TABLE_TOOL = "data.table.read";
export const WRITE_TABLE_SKILL = "data.write-table";
export const WRITE_TABLE_TOOL = "data.table.write";

// DECISION (§1.164 "Limits"): at most 10,000 rows and 5 MB per file, read or written, for the
// Worker's memory; past either the step fails saying so, never a part of the file.
export const TABLE_MAX_ROWS = 10_000;
export const TABLE_MAX_BYTES = 5 * 1024 * 1024;

/** Read table's parameters: the agent sets them once, a step may set its own. */
export const READ_TABLE_PARAMETERS: readonly SkillParameter[] = [
  {
    name: "columns",
    label: "Expected columns",
    type: "columns",
    description:
      "Each column's field name, the headers a file may give it, its type and whether it is required. Empty: every header is read as it is, untyped.",
    default: [],
  },
  {
    name: "sheet",
    label: "Sheet",
    type: "text",
    description: "The worksheet of an .xlsx file, by name. Empty: the first visible sheet.",
    default: "",
  },
  {
    name: "header_row",
    label: "Header row",
    type: "number",
    description: "The row the headers are on, as the file numbers it (1 is the first).",
    default: 1,
  },
  {
    name: "skip_rows",
    label: "Rows to skip",
    type: "number",
    description: "Rows right after the header row that aren't data (units, notes).",
    default: 0,
  },
  {
    name: "range",
    label: "Range",
    type: "text",
    description:
      "Only these cells, as A1:F200 or A:F. Empty: the whole sheet. Rows count as the file numbers them.",
    default: "",
  },
  {
    name: "max_rows",
    label: "Most rows",
    type: "number",
    description: `A file with more data rows than this fails the step (at most ${TABLE_MAX_ROWS.toLocaleString("en-US")}).`,
    default: TABLE_MAX_ROWS,
  },
  {
    name: "skip_blank_rows",
    label: "Skip blank rows",
    type: "boolean",
    default: true,
  },
  {
    name: "skip_total_rows",
    label: "Skip total rows",
    type: "boolean",
    description: 'Rows with a cell that reads "Total", "Subtotal" or "Grand total".',
    default: true,
  },
  {
    name: "skip_if_empty",
    label: "Skip rows without",
    type: "text",
    description: "A field name: rows where it is empty are left out. Empty: none are.",
    default: "",
  },
  {
    name: "shape",
    label: "Expected shape (JSON)",
    type: "json_schema",
    description:
      "For a .json file: the JSON Schema the whole file must fit, else the step fails. Empty checks nothing.",
    default: {},
  },
];

export const WRITE_TABLE_FORMATS = ["csv", "xlsx"] as const;
export type WriteTableFormat = (typeof WRITE_TABLE_FORMATS)[number];

/** Write table's parameters. */
export const WRITE_TABLE_PARAMETERS: readonly SkillParameter[] = [
  {
    name: "columns",
    label: "Columns",
    type: "columns",
    description:
      "The file's columns in order: each one's field, its header (the first header name), its type and whether every row must have it. Empty: every field of the rows, in the order they first appear.",
    default: [],
  },
  {
    name: "format",
    label: "File type",
    type: "text",
    description: "csv or xlsx.",
    default: "csv",
  },
  {
    name: "filename",
    label: "File name",
    type: "text",
    description: "Without its extension. Empty: the step's name and the day.",
    default: "",
  },
  {
    name: "sheet",
    label: "Sheet name",
    type: "text",
    description: "For an .xlsx file. Empty: Sheet1.",
    default: "",
  },
];

/** Whether a step is a Read table step. */
export function isReadTableStep(step: Step): boolean {
  return step.kind === "skill" && parseSkillRef(step.skill).id === READ_TABLE_SKILL;
}

/** Whether a step is a Write table step. */
export function isWriteTableStep(step: Step): boolean {
  return step.kind === "skill" && parseSkillRef(step.skill).id === WRITE_TABLE_SKILL;
}

/**
 * The columns a Read table step reads with: the step's own, else the agent's, else the skill's
 * default (none). Malformed values count as none (validation names them).
 */
export function readTableColumnsFor(
  step: Extract<Step, { kind: "skill" }>,
  ctx: TypingContext,
): TableColumns {
  const own = step.customize?.parameters?.columns;
  const id = parseSkillRef(step.skill).id;
  // A process's validation context names the agent (`ProcessValidationContext.agent`).
  const skills =
    ctx.agentSkills ??
    (ctx as { agent?: { skills?: TypingContext["agentSkills"] } | undefined }).agent?.skills;
  const agent = skills?.find((s) => parseSkillRef(s.skill).id === id)?.parameters?.columns;
  const def = lookupSkill(step.skill, ctx)?.parameters?.find((p) => p.name === "columns")?.default;
  const value = own ?? agent ?? def;
  const parsed = TableColumns.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

// ── The output ─────────────────────────────────────────────────────────────────────────────

const DECIMAL_PATTERN = "^-?\\d+(\\.\\d+)?$";

/** The schema of one typed field. */
export function columnValueSchema(type: TableColumnType): JsonSchema {
  switch (type) {
    case "text":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "money":
      return { type: "string", pattern: DECIMAL_PATTERN, description: "An amount, as a decimal" };
    case "date":
      return { type: "string", format: "date" };
    case "boolean":
      return { type: "boolean" };
  }
}

const COLUMN_READ: JsonSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    header: { type: ["string", "null"], description: "The file's header it was read from" },
    column: { type: ["string", "null"], description: "Its column (C) or a JSON file's key" },
    type: { type: ["string", "null"] },
    required: { type: "boolean" },
  },
  required: ["field", "header", "column", "type", "required"],
  additionalProperties: false,
};

const PROBLEM: JsonSchema = {
  type: "object",
  properties: {
    row: { type: ["integer", "null"], description: "The file's row number" },
    field: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["row", "field", "message"],
  additionalProperties: false,
};

/**
 * What a Read table step outputs: its rows typed by its columns (each required column's field
 * required; additional fields refused), or, with no columns, rows any path reads.
 */
export function readTableOutputSchema(columns: TableColumns | undefined): JsonSchema {
  const list = columns ?? [];
  const row: JsonSchema =
    list.length === 0
      ? { type: "object", additionalProperties: true }
      : {
          type: "object",
          properties: Object.fromEntries(list.map((c) => [c.field, columnValueSchema(c.type)])),
          required: list.filter((c) => c.required === true).map((c) => c.field),
          additionalProperties: false,
        };
  return {
    type: "object",
    properties: {
      columns: { type: "array", items: COLUMN_READ },
      rows: { type: "array", items: row },
      rowCount: { type: "integer" },
      sheet: { type: ["string", "null"] },
      problems: { type: "array", items: PROBLEM },
      sources: { type: "array", items: { type: "string" }, description: "The document read" },
    },
    required: ["columns", "rows", "rowCount", "sheet", "problems", "sources"],
    additionalProperties: false,
  };
}

/** What a Write table step outputs: the document it made. */
export const WRITE_TABLE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    documentId: { type: "string", description: "The new document" },
    filename: { type: "string" },
    mimeType: { type: "string" },
    rowCount: { type: "integer" },
    created: { type: "boolean", description: "False when the same file was stored before" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["documentId", "filename", "mimeType", "rowCount", "created", "sources"],
  additionalProperties: false,
};

// ── Reading: options ───────────────────────────────────────────────────────────────────────

export interface ReadTableOptions {
  columns: TableColumns;
  sheet: string | null;
  headerRow: number;
  skipRows: number;
  range: XlsxRange | null;
  maxRows: number;
  skipBlankRows: boolean;
  skipTotalRows: boolean;
  skipIfEmpty: string | null;
  shape: JsonSchema | null;
}

const wholeAtLeast = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min;

/** The options a step's parameter values give (defaults for any left out), or why they can't. */
export function readTableOptions(
  params: Readonly<Record<string, unknown>>,
): { ok: true; options: ReadTableOptions } | { ok: false; error: string } {
  const columns = TableColumns.safeParse(params.columns ?? []);
  if (!columns.success)
    return { ok: false, error: "the expected columns aren't a list of columns" };
  const text = (k: string) => (typeof params[k] === "string" ? (params[k] as string).trim() : "");
  const headerRow = params.header_row ?? 1;
  if (!wholeAtLeast(headerRow, 1)) return { ok: false, error: "the header row is 1 or more" };
  const skipRows = params.skip_rows ?? 0;
  if (!wholeAtLeast(skipRows, 0)) return { ok: false, error: "rows to skip is 0 or more" };
  const maxRows = params.max_rows ?? TABLE_MAX_ROWS;
  if (!wholeAtLeast(maxRows, 1) || maxRows > TABLE_MAX_ROWS) {
    return {
      ok: false,
      error: `most rows is from 1 to ${TABLE_MAX_ROWS.toLocaleString("en-US")}`,
    };
  }
  let range: XlsxRange | null = null;
  if (text("range") !== "") {
    range = parseXlsxRange(text("range").toUpperCase().replaceAll("$", ""));
    if (!range) return { ok: false, error: `the range ${text("range")} isn't like A1:F200 or A:F` };
  }
  const shape = params.shape;
  return {
    ok: true,
    options: {
      columns: columns.data,
      sheet: text("sheet") || null,
      headerRow,
      skipRows,
      range,
      maxRows,
      skipBlankRows: params.skip_blank_rows !== false,
      skipTotalRows: params.skip_total_rows !== false,
      skipIfEmpty: text("skip_if_empty") || null,
      shape: isPlainObject(shape) && Object.keys(shape).length > 0 ? (shape as JsonSchema) : null,
    },
  };
}

// ── Reading: cells ─────────────────────────────────────────────────────────────────────────

/** A cell with nothing in it: no value, or only spaces. */
export function isEmptyCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const t = Date.UTC(y, m - 1, d);
  const date = new Date(t);
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// DECISION: a two-digit year is in this century (26 → 2026): the files are business records.
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** The largest Excel serial date (9999-12-31). */
const MAX_SERIAL = 2_958_465;

/** An Excel serial date (the 1900 system) as ISO 8601: the date only. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round(serial * 86_400_000);
  return new Date(Date.UTC(1899, 11, 30) + ms).toISOString().slice(0, 10);
}

/** An ISO date as an Excel serial date (the 1900 system). */
export function isoToExcelSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function monthOf(word: string): number | null {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
  return i < 0 ? null : i + 1;
}

/** A date as the file writes it, in ISO 8601; null when it isn't one in that style. */
export function parseTableDate(value: XlsxCell, style: TableDateStyle = "iso"): string | null {
  if (typeof value === "number") {
    return value >= 1 && value <= MAX_SERIAL ? excelSerialToIso(value) : null;
  }
  if (typeof value !== "string") return null;
  const t = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) {
    // DECISION: 11/20/2026 is read only by the column's style (mdy or dmy); an ISO column takes
    // only 2026-11-20 and dates with month names, so a day and a month are never swapped by guess.
    if (style === "iso") return null;
    const [a, b] = [Number(m[1]), Number(m[2])];
    const y = fullYear(m[3] as string);
    return style === "mdy" ? isoDate(y, a, b) : isoDate(y, b, a);
  }
  // Month names are never ambiguous: "Nov 20, 2026", "20 November 2026", "20-Nov-2026".
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (m) {
    const month = monthOf(m[1] as string);
    return month ? isoDate(Number(m[3]), month, Number(m[2])) : null;
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const month = monthOf(m[2] as string);
    return month ? isoDate(fullYear(m[3] as string), month, Number(m[1])) : null;
  }
  return null;
}

const CURRENCY_SIGNS = /[$€£¥₹]/g;

/** A number as a file writes it ("1,250.50", "$1,250.50", "(12.00)"), as decimal text. */
export function decimalText(value: XlsxCell): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // DECISION: a number cell's binary value is read as its shortest decimal and kept to four
    // places, the money columns' scale (numeric(14,4)), so 0.1 + 0.2 reads as 0.3.
    return new Decimal(String(value)).toDecimalPlaces(4).toFixed();
  }
  if (typeof value !== "string") return null;
  let t = value.replace(/[\s\u00a0]/g, "").replace(CURRENCY_SIGNS, "");
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith("-") && !t.startsWith("-")) {
    negative = true;
    t = t.slice(0, -1);
  }
  t = t.replace(CURRENCY_SIGNS, "").replace(/^\+/, "");
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replaceAll(",", "");
  if (/^\.\d+$/.test(t)) t = `0${t}`;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const out = negative && !/^0+(\.0+)?$/.test(t) ? `-${t}` : t;
  return out;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

/** One cell as its column's type; a problem in plain words when it can't be. */
export function typeCell(
  value: XlsxCell,
  column: Pick<TableColumn, "type" | "dateStyle">,
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  const shown = JSON.stringify(typeof value === "string" ? value.trim().slice(0, 40) : value);
  switch (column.type) {
    case "text":
      return { ok: true, value: typeof value === "string" ? value.trim() : String(value) };
    case "number": {
      const d = decimalText(value);
      return d === null
        ? { ok: false, message: `${shown} is not a number` }
        : { ok: true, value: Number(d) };
    }
    case "money": {
      const d = decimalText(value);
      return d === null
        ? { ok: false, message: `${shown} is not an amount` }
        : { ok: true, value: d };
    }
    case "date": {
      const d = parseTableDate(value, column.dateStyle ?? "iso");
      return d === null
        ? {
            ok: false,
            message: `${shown} is not a date${column.dateStyle && column.dateStyle !== "iso" ? ` written ${column.dateStyle === "mdy" ? "month first" : "day first"}` : ""}`,
          }
        : { ok: true, value: d };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      const w = String(value).trim().toLowerCase();
      if (TRUE_WORDS.has(w)) return { ok: true, value: true };
      if (FALSE_WORDS.has(w)) return { ok: true, value: false };
      return { ok: false, message: `${shown} is not yes or no` };
    }
  }
}

// ── Reading: the table ─────────────────────────────────────────────────────────────────────

/** One expected column as the file gave it (or didn't). */
export interface TableColumnRead {
  field: string;
  /** The file's header it was read from; null when the file has none for it. */
  header: string | null;
  /** Its column (`C`), or a JSON file's key; null when missing. */
  column: string | null;
  /** Its type; null for a column read untyped (no expected columns). */
  type: TableColumnType | null;
  required: boolean;
}

/** A row left out, a cell that couldn't be read, or a note about the file. */
export interface TableProblem {
  row: number | null;
  field: string | null;
  message: string;
}

export interface TableRead {
  columns: TableColumnRead[];
  rows: Record<string, unknown>[];
  sheet: string | null;
  problems: TableProblem[];
  /** The file's headers no expected column took (`C: Notes`). */
  unmatched: { header: string; column: string }[];
  /** Why the step fails (a required column missing, too many rows); null when it can go on. */
  failure: string | null;
}

/** A field name from a header: `Vendor name` → `vendorName`; `columnC` when it has no letters. */
export function fieldFromHeader(header: string, fallback: string, taken: Set<string>): string {
  const words = header
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let key = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : `${w[0]?.toUpperCase()}${w.slice(1).toLowerCase()}`,
    )
    .join("")
    .slice(0, 60);
  if (!/^[A-Za-z_]/.test(key)) key = key ? `f${key}` : fallback;
  let out = key;
  for (let n = 2; taken.has(out); n++) out = `${key}${n}`;
  taken.add(out);
  return out;
}

const TOTAL_WORDS = new Set(["total", "totals", "subtotal", "subtotals", "grandtotal"]);

/** A row with a cell that reads "Total", "Subtotal" or "Grand total" (with or without a colon). */
function isTotalRow(cells: readonly XlsxCell[]): boolean {
  return cells.some((c) => typeof c === "string" && TOTAL_WORDS.has(headerKey(c)));
}

/** Which header each expected column takes: by its field name or a header name it accepts. */
function matchHeaders(
  headers: readonly string[],
  columns: TableColumns,
): { at: Map<string, number>; missing: TableColumn[] } {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const at = new Map<string, number>();
  const missing: TableColumn[] = [];
  for (const c of columns) {
    // DECISION: a column's own header names come first, in its order, then its field name; each
    // file header is taken once, by the first column (in the columns' order) that names it.
    const wanted = [...c.headers, c.field].map(headerKey).filter(Boolean);
    let found = -1;
    for (const w of wanted) {
      found = keys.findIndex((k, i) => k === w && !used.has(i));
      if (found >= 0) break;
    }
    if (found < 0) missing.push(c);
    else {
      used.add(found);
      at.set(c.field, found);
    }
  }
  return { at, missing };
}

function missingFailure(missing: readonly TableColumn[]): string | null {
  const required = missing.filter((c) => c.required === true);
  if (required.length === 0) return null;
  const names = required.map((c) => {
    const also = c.headers.filter((h) => headerKey(h) !== headerKey(c.field));
    return also.length > 0 ? `${c.field} (or ${also.map((h) => `"${h}"`).join(", ")})` : c.field;
  });
  return `the file has no column for ${names.join(", ")}`;
}

const tooMany = (max: number) =>
  `the file has more than ${max.toLocaleString("en-US")} rows of data; we read at most ${max.toLocaleString("en-US")}`;

/** Types one row's cells by the columns; drops it (with why) when a required value is missing. */
function typedRow(
  get: (field: string) => XlsxCell | undefined,
  columns: TableColumns,
  rowNumber: number | null,
  problems: TableProblem[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const c of columns) {
    const raw = get(c.field);
    if (raw === undefined || isEmptyCell(raw)) {
      if (c.required === true) {
        problems.push({ row: rowNumber, field: c.field, message: `left out: ${c.field} is empty` });
        dropped = true;
      }
      continue;
    }
    const typed = typeCell(raw, c);
    if (typed.ok) {
      out[c.field] = typed.value;
      continue;
    }
    // DECISION: a value that can't be read as its type is never guessed: in a required column the
    // row is left out, in another the field is left empty; either way it is listed in problems.
    problems.push({
      row: rowNumber,
      field: c.field,
      message: c.required === true ? `left out: ${typed.message}` : typed.message,
    });
    if (c.required === true) dropped = true;
  }
  return dropped ? null : out;
}

/**
 * A sheet or a CSV file's cells, read as a table: the header row matched to the expected columns,
 * the data rows below it (skips and range applied) typed by them. `grid[0]` is the file's row 1.
 */
export function tableFromGrid(
  grid: readonly (readonly XlsxCell[])[],
  options: ReadTableOptions,
  sheet: string | null = null,
): TableRead {
  const width = grid.reduce((n, r) => Math.max(n, r.length), 0);
  const range = options.range ?? { startCol: 1, startRow: 1, endCol: width, endRow: null };
  const lastRow = Math.min(range.endRow ?? grid.length, grid.length);
  const headerRow = Math.max(options.headerRow, range.startRow);
  const read: TableRead = {
    columns: [],
    rows: [],
    sheet,
    problems: [],
    unmatched: [],
    failure: null,
  };
  if (headerRow > lastRow) {
    read.failure =
      grid.length === 0
        ? "the file is empty"
        : `the file has no row ${headerRow} for its headers (it has ${lastRow})`;
    return read;
  }
  const cols: number[] = [];
  for (let c = range.startCol; c <= Math.min(range.endCol, Math.max(width, range.startCol)); c++) {
    cols.push(c);
  }
  const cellAt = (row: readonly XlsxCell[] | undefined, col: number): XlsxCell =>
    row?.[col - 1] ?? null;
  const headerCells = grid[headerRow - 1];
  const headers = cols.map((c) => {
    const v = cellAt(headerCells, c);
    return v === null ? "" : String(v).trim();
  });
  const letter = (i: number) => xlsxColumnLetters(cols[i] as number);

  // The fields and where each is read from.
  let columns: TableColumns;
  let at: Map<string, number>;
  if (options.columns.length > 0) {
    columns = options.columns;
    const m = matchHeaders(headers, columns);
    at = m.at;
    read.failure = missingFailure(m.missing);
    read.unmatched = headers.flatMap((h, i) =>
      h !== "" && ![...at.values()].includes(i) ? [{ header: h, column: letter(i) }] : [],
    );
  } else {
    // No expected columns: every header is a field, read as it is.
    const taken = new Set<string>();
    at = new Map();
    columns = [];
    headers.forEach((h, i) => {
      if (h === "") return;
      const field = fieldFromHeader(h, `column${letter(i)}`, taken);
      at.set(field, i);
      columns.push({ field, headers: [h], type: "text" });
    });
  }
  read.columns = columns.map((c) => {
    const i = at.get(c.field);
    return {
      field: c.field,
      header: i === undefined ? null : (headers[i] ?? null),
      column: i === undefined ? null : letter(i),
      type: options.columns.length > 0 ? c.type : null,
      required: c.required === true,
    };
  });
  if (read.failure) return read;
  if (options.skipIfEmpty && !at.has(options.skipIfEmpty)) {
    read.failure = `"Skip rows without" names ${options.skipIfEmpty}, which no column reads`;
    return read;
  }

  const max = Math.min(options.maxRows, TABLE_MAX_ROWS);
  const typed = options.columns.length > 0;
  for (let r = headerRow + 1 + options.skipRows; r <= lastRow; r++) {
    const row = grid[r - 1];
    const cells = cols.map((c) => cellAt(row, c));
    if (cells.every(isEmptyCell)) {
      if (options.skipBlankRows) continue;
    } else if (options.skipTotalRows && isTotalRow(cells)) {
      continue;
    }
    const get = (field: string) => {
      const i = at.get(field);
      return i === undefined ? undefined : cells[i];
    };
    if (options.skipIfEmpty && isEmptyCell(get(options.skipIfEmpty))) continue;
    if (read.rows.length >= max) {
      read.failure = tooMany(max);
      read.rows = [];
      return read;
    }
    if (typed) {
      const out = typedRow(get, columns, r, read.problems);
      if (out) read.rows.push(out);
    } else {
      const out: Record<string, unknown> = {};
      for (const c of columns) {
        const v = get(c.field);
        if (v !== undefined && !isEmptyCell(v)) out[c.field] = typeof v === "string" ? v.trim() : v;
      }
      read.rows.push(out);
    }
  }
  return read;
}

/** Why a value doesn't fit a JSON Schema, in plain words; null when it does. */
export function jsonShapeProblem(schema: JsonSchema, value: unknown): string | null {
  let compiled: z.ZodType;
  try {
    compiled = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    return `the expected shape can't be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  const r = compiled.safeParse(value);
  return r.success ? null : z.prettifyError(r.error);
}

/** The rows a JSON file holds: a list of objects, one under a top-level key, or one object. */
function jsonRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return null;
  // DECISION: an object's rows are its first top-level list of objects (`{ "items": [...] }`);
  // an object with none is one row.
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.some(isPlainObject)) return v;
  }
  return [value];
}

/** A JSON value as a cell: scalars as they are, anything else as its JSON text. */
function jsonCell(v: unknown): XlsxCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/**
 * A JSON file read as a table: checked against the expected shape when there is one, then its
 * rows' keys matched to the expected columns as a sheet's headers are, and typed by them. With no
 * expected columns the rows are given as they are. Sheet, header row, rows to skip and range
 * don't apply; blank and total rows are never skipped in JSON.
 */
export function tableFromJson(value: unknown, options: ReadTableOptions): TableRead {
  const read: TableRead = {
    columns: [],
    rows: [],
    sheet: null,
    problems: [],
    unmatched: [],
    failure: null,
  };
  if (options.shape) {
    const problem = jsonShapeProblem(options.shape, value);
    if (problem) {
      read.failure = `the file doesn't have the expected shape: ${problem}`;
      return read;
    }
  }
  const list = jsonRows(value);
  if (!list) {
    read.failure = "the file holds no rows: a list of objects, or an object";
    return read;
  }
  const keys: string[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
  }
  const typed = options.columns.length > 0;
  let at = new Map<string, number>();
  if (typed) {
    const m = matchHeaders(keys, options.columns);
    at = m.at;
    read.failure = missingFailure(m.missing);
    read.unmatched = keys.flatMap((k, i) =>
      ![...at.values()].includes(i) ? [{ header: k, column: k }] : [],
    );
    read.columns = options.columns.map((c) => {
      const i = at.get(c.field);
      const key = i === undefined ? null : (keys[i] ?? null);
      return {
        field: c.field,
        header: key,
        column: key,
        type: c.type,
        required: c.required === true,
      };
    });
  } else {
    read.columns = keys.map((k) => ({
      field: k,
      header: k,
      column: k,
      type: null,
      required: false,
    }));
  }
  if (read.failure) return read;
  if (options.skipIfEmpty && typed && !at.has(options.skipIfEmpty)) {
    read.failure = `"Skip rows without" names ${options.skipIfEmpty}, which no column reads`;
    return read;
  }
  const max = Math.min(options.maxRows, TABLE_MAX_ROWS);
  list.forEach((item, index) => {
    if (read.failure) return;
    const rowNumber = index + 1;
    if (!isPlainObject(item)) {
      read.problems.push({ row: rowNumber, field: null, message: "left out: not an object" });
      return;
    }
    const get = (field: string) => {
      if (!typed) return jsonCell(item[field]);
      const i = at.get(field);
      return i === undefined ? undefined : jsonCell(item[keys[i] as string]);
    };
    if (options.skipIfEmpty && isEmptyCell(get(options.skipIfEmpty))) return;
    if (read.rows.length >= max) {
      read.failure = tooMany(max);
      return;
    }
    if (!typed) {
      read.rows.push(item);
      return;
    }
    const out = typedRow(get, options.columns, rowNumber, read.problems);
    if (out) read.rows.push(out);
  });
  if (read.failure) read.rows = [];
  return read;
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────

/** A cell to write: text, a number, true or false, empty, a decimal amount or an ISO date. */
export type WriteCell =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "money"; value: string }
  | { kind: "date"; value: string; style: TableDateStyle }
  | { kind: "boolean"; value: boolean }
  | null;

/** Rows laid out for a file: the header labels and each row's cells, in the columns' order. */
export interface WriteGrid {
  headers: string[];
  rows: WriteCell[][];
}

/** The columns a file is written with when none are set: every field, typed by its values. */
export function columnsFromRows(rows: readonly Record<string, unknown>[]): TableColumns {
  const out: TableColumn[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (seen.has(k) || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(k)) continue;
      if (v === null || v === undefined) continue;
      seen.add(k);
      out.push({
        field: k,
        headers: [],
        type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text",
      });
    }
  }
  return out;
}

/** A date as a file writes it in a style. */
export function formatTableDate(iso: string, style: TableDateStyle): string {
  const [y, m, d] = iso.split("-");
  if (style === "mdy") return `${m}/${d}/${y}`;
  if (style === "dmy") return `${d}/${m}/${y}`;
  return iso;
}

/** One value as a cell of its column's type; a problem when it isn't one. */
function writeCell(
  value: unknown,
  column: TableColumn,
): { ok: true; cell: WriteCell } | { ok: false; message: string } {
  if (value === null || value === undefined || value === "") return { ok: true, cell: null };
  if (column.type === "text") {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
    return { ok: true, cell: { kind: "text", value: text } };
  }
  if (typeof value === "object") {
    // A money value `{ amount, currency }` writes its amount.
    const amount = (value as { amount?: unknown }).amount;
    if (column.type === "money" && (typeof amount === "string" || typeof amount === "number")) {
      return writeCell(amount, column);
    }
    return { ok: false, message: `${JSON.stringify(value).slice(0, 40)} is not a single value` };
  }
  const typed = typeCell(value as XlsxCell, {
    type: column.type,
    // A row's date is ISO (Read table and Reshape give ISO); the style is how it is written.
    dateStyle: "iso",
  });
  if (!typed.ok) return typed;
  switch (column.type) {
    case "number":
      return { ok: true, cell: { kind: "number", value: typed.value as number } };
    case "money":
      return { ok: true, cell: { kind: "money", value: typed.value as string } };
    case "date":
      return {
        ok: true,
        cell: { kind: "date", value: typed.value as string, style: column.dateStyle ?? "iso" },
      };
    default:
      return { ok: true, cell: { kind: "boolean", value: typed.value as boolean } };
  }
}

/**
 * Rows laid out to write by the columns, in their order. A value that isn't its column's type,
 * or a required column left empty, fails the whole file naming the row and field: a file is never
 * written with some values dropped.
 */
export function tableForWriting(
  rows: readonly Record<string, unknown>[],
  columns: TableColumns,
): { ok: true; grid: WriteGrid } | { ok: false; error: string } {
  if (rows.length > TABLE_MAX_ROWS) return { ok: false, error: tooMany(TABLE_MAX_ROWS) };
  const list = columns.length > 0 ? columns : columnsFromRows(rows);
  if (list.length === 0) return { ok: false, error: "there are no columns to write" };
  const problems: string[] = [];
  const out: WriteCell[][] = [];
  rows.forEach((row, i) => {
    const cells: WriteCell[] = [];
    for (const c of list) {
      const v = isPlainObject(row) ? row[c.field] : undefined;
      const r = writeCell(v, c);
      if (!r.ok) {
        problems.push(`row ${i + 1}: ${c.field}: ${r.message}`);
        cells.push(null);
      } else if (r.cell === null && c.required === true) {
        problems.push(`row ${i + 1}: ${c.field} is empty`);
        cells.push(null);
      } else {
        cells.push(r.cell);
      }
    }
    out.push(cells);
  });
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join("; ");
    const more = problems.length > 5 ? ` and ${problems.length - 5} more` : "";
    return { ok: false, error: `${shown}${more}` };
  }
  return {
    ok: true,
    grid: { headers: list.map((c) => c.headers[0] ?? c.field), rows: out },
  };
}
