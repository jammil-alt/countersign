// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): Read table and Write table,
// two built-in deterministic skills beside Reshape data. Read table turns a .csv, .xlsx or .json
// document into rows of typed fields by the expected columns its `columns` parameter names; Write
// table turns rows back into a .csv or .xlsx document. Reshape data maps between them and the
// steps around them. This file holds what the builder needs too: the skills' ids, parameters and
// limits, and the output schema the columns give. Reading and writing rows (cells' typing, header
// matching, row skips, rows laid out for writing) is `tableFiles` (../tables/files.ts), outside
// this namespace so the web app's first load doesn't carry it. The file formats
// themselves (CSV and XLSX bytes) are packages/connectors' (`upload/xlsx.ts`, `upload/tables.ts`).
// No model ever reads these files: CSV, XLSX and JSON are read in code (invariant 9).

import { type JsonSchema, parseSkillRef } from "../schemas/common";
import type { SkillParameter } from "../schemas/skill-model";
import { TableColumns, type TableColumnType } from "../schemas/table";
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
