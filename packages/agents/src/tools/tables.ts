// Read table and Write table (owner, 2026-11-20; docs/plan.md §1.164): two built-in deterministic
// skills beside Reshape data. Read table reads a client's .csv, .xlsx or .json document into rows
// typed by the expected columns its `columns` parameter names (the agent's, or the step's own);
// Write table writes rows to a new .csv or .xlsx document, by the columns its parameters name. No
// model reads or writes either file: the reading and writing are code (connectors'
// `readTableFile` and `writeTableFile`, core's rules), the same every time.
//
// DECISION: unlike Reshape, neither handler is `pure`. Read table's input is a document id and the
// file's bytes come through the documents port (as `docs.*` tools reach theirs, `port(ctx)`):
// putting up to 5 MB of a file into the tool's input would log it with every call. So Read table
// doesn't run on the test bench (a case would need a client's document); everything after the
// bytes are read is pure code, tested on its own. Write table makes a document: an internal write
// (`sideEffect: internal`, logged, no approval). Sending the file anywhere is a write step of its
// own, with approval on (invariant 8).

import { readTableFile, TableFileError, writeTableFile } from "@countersign/connectors";
import {
  isoToday,
  lazy,
  lazyObject,
  processes,
  type SkillDefinition,
  TableColumns,
} from "@countersign/core";
import { z } from "zod";
import { defineInternalTool, type InternalTool, type ToolInvocation } from "./types";

export const READ_TABLE_SKILL = processes.READ_TABLE_SKILL;
export const READ_TABLE_TOOL = processes.READ_TABLE_TOOL;
export const WRITE_TABLE_SKILL = processes.WRITE_TABLE_SKILL;
export const WRITE_TABLE_TOOL = processes.WRITE_TABLE_TOOL;

/** At most this many problems are kept in a step's output; the rest are counted. */
const PROBLEMS_SHOWN = 200;

function port(ctx: ToolInvocation) {
  if (!ctx.documents) throw new Error("the documents capability is not available here");
  return ctx.documents;
}

const Problem = z.object({
  row: z.number().int().nullable(),
  field: z.string().nullable(),
  message: z.string(),
});

const ReadTableOutput = z.object({
  columns: z.array(
    z.object({
      field: z.string(),
      header: z.string().nullable(),
      column: z.string().nullable(),
      type: z.enum(["text", "number", "money", "date", "boolean"]).nullable(),
      required: z.boolean(),
    }),
  ),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  sheet: z.string().nullable(),
  problems: z.array(Problem),
  sources: z.array(z.string()),
});
export type ReadTableOutput = z.infer<typeof ReadTableOutput>;

/**
 * A table file read as a Read table step reads it, from its bytes and the step's parameter
 * values: what the tool runs and what tests and the sample check call. Throws with the reason the
 * step fails (too large, not a table, a required column missing, too many rows).
 */
export function readTable(
  file: { documentId: string; filename: string; mimeType: string; bytes: Uint8Array },
  parameters: Readonly<Record<string, unknown>>,
): ReadTableOutput {
  const options = processes.readTableOptions(parameters);
  if (!options.ok) throw new Error(`Read table's parameters: ${options.error}`);
  let read: processes.TableRead;
  try {
    read = readTableFile(file, options.options).read;
  } catch (error) {
    if (error instanceof TableFileError) throw new Error(error.message);
    throw error;
  }
  if (read.failure) throw new Error(`${file.filename}: ${read.failure}`);
  const problems = read.problems.slice(0, PROBLEMS_SHOWN);
  if (read.problems.length > PROBLEMS_SHOWN) {
    problems.push({
      row: null,
      field: null,
      message: `and ${read.problems.length - PROBLEMS_SHOWN} more problems`,
    });
  }
  return {
    columns: read.columns,
    rows: read.rows,
    rowCount: read.rows.length,
    sheet: read.sheet,
    problems,
    sources: [file.documentId],
  };
}

export const readTableTool: InternalTool = defineInternalTool({
  id: READ_TABLE_TOOL,
  description:
    "Reads one of the client's .csv, .xlsx or .json documents into rows, each a set of typed fields named by the step's expected columns (text, numbers, amounts as decimals, dates as YYYY-MM-DD, yes or no). Headers are matched by the names each column accepts; a file missing a required column fails. Reads the file in code; no model.",
  sideEffect: "none",
  entity: "document",
  area: "shared",
  summary: "Read {{rowCount}} rows",
  input: z.object({ documentId: z.uuid().describe("The .csv, .xlsx or .json document to read") }),
  output: ReadTableOutput,
  async run(input, ctx) {
    const docs = port(ctx);
    if (!docs.table) throw new Error("reading a table file is not available here");
    const file = await docs.table(ctx.tenantId, input.documentId);
    return readTable(file, ctx.settings ?? {});
  },
});

const WriteTableOutput = z.object({
  documentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  rowCount: z.number().int(),
  created: z.boolean(),
  sources: z.array(z.string()),
});
export type WriteTableOutput = z.infer<typeof WriteTableOutput>;

/** A file name without what a file system or a mail client refuses, and its extension. */
function fileName(base: string, extension: string): string {
  const clean = base
    .replace(/\.(csv|xlsx|json)$/i, "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${clean || "table"}.${extension}`;
}

/**
 * Rows written as a .csv or .xlsx file by Write table's parameter values: the bytes and their
 * name, before anything is stored. Throws with the reason the step fails.
 */
export function writeTable(
  rows: readonly Record<string, unknown>[],
  parameters: Readonly<Record<string, unknown>>,
  options: { filename?: string | undefined; today: string },
) {
  const columns = TableColumns.safeParse(parameters.columns ?? []);
  if (!columns.success) throw new Error("Write table's columns aren't a list of columns");
  const format =
    typeof parameters.format === "string" ? parameters.format.trim().toLowerCase() : "csv";
  if (format !== "csv" && format !== "xlsx") {
    throw new Error(`Write table's file type is csv or xlsx, not ${format}`);
  }
  const sheet = typeof parameters.sheet === "string" ? parameters.sheet : null;
  let written: ReturnType<typeof writeTableFile>;
  try {
    written = writeTableFile(rows, columns.data, format, { sheet });
  } catch (error) {
    if (error instanceof TableFileError) throw new Error(error.message);
    throw error;
  }
  const named =
    options.filename?.trim() ||
    (typeof parameters.filename === "string" ? parameters.filename.trim() : "") ||
    `table-${options.today}`;
  return { ...written, filename: fileName(named, written.extension) };
}

export const writeTableTool: InternalTool = defineInternalTool({
  id: WRITE_TABLE_TOOL,
  description:
    "Writes rows to a new .csv or .xlsx document in the client's documents, by the step's columns (their order, headers and types). The new document names the documents it was made from. Makes the file only; sending it anywhere is a step of its own. No model.",
  sideEffect: "internal",
  verb: "create",
  entity: "document",
  area: "shared",
  summary: "Wrote {{rowCount}} rows to {{filename}}",
  input: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .max(processes.TABLE_MAX_ROWS)
      .describe("The rows: each an object of fields"),
    sources: z
      .array(z.uuid())
      .max(50)
      .default([])
      .describe("The documents the rows came from (Read table's sources)"),
    filename: z.string().max(120).optional().describe("The file's name, without its extension"),
  }),
  output: WriteTableOutput,
  async run(input, ctx) {
    const docs = port(ctx);
    if (!docs.storeTable) throw new Error("storing a file is not available here");
    const file = writeTable(input.rows, ctx.settings ?? {}, {
      filename: input.filename,
      today: isoToday(ctx.now?.() ?? new Date()),
    });
    const stored = await docs.storeTable(ctx.tenantId, {
      bytes: file.bytes,
      filename: file.filename,
      mimeType: file.mimeType,
      sources: input.sources,
      agentVersionId: ctx.agentVersionId,
      runId: ctx.runId,
      testRun: ctx.mode === "test",
    });
    return {
      documentId: stored.documentId,
      filename: file.filename,
      mimeType: file.mimeType,
      rowCount: file.rowCount,
      created: stored.created,
      sources: [stored.documentId, ...input.sources],
    };
  },
});

export const TABLE_TOOLS: readonly InternalTool[] = [readTableTool, writeTableTool];

// Worker startup (2026-11-11): the JSON Schemas are made on first read, as the docs skills' are.
const json = (tool: InternalTool, key: "input" | "output") =>
  lazy(() => tool.spec[key] as Record<string, unknown>);

export const READ_TABLE_SKILL_DEF: SkillDefinition = lazyObject({
  schemaVersion: 1,
  id: READ_TABLE_SKILL,
  name: "Read table",
  description:
    "Reads a spreadsheet, CSV or JSON file the client sent into rows of the fields you expect: each column found by the headers it may have (Vendor, Payee, Supplier), typed as text, a number, an amount, a date or yes or no. A file without a required column stops the step and names it. Skips blank and total rows. The same every time; no model.",
  category: "data",
  mode: "tool",
  handler: READ_TABLE_TOOL,
  tools: [READ_TABLE_TOOL],
  input: json(readTableTool, "input"),
  // The step's columns type its rows (`processes.readTableOutputSchema`); the skill's is open.
  output: json(readTableTool, "output"),
  parameters: [...processes.READ_TABLE_PARAMETERS],
  settings: [],
  summary: "Read {{rowCount}} rows",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
});

export const WRITE_TABLE_SKILL_DEF: SkillDefinition = lazyObject({
  schemaVersion: 1,
  id: WRITE_TABLE_SKILL,
  name: "Write table",
  description:
    "Writes rows to a new .csv or .xlsx file in the client's documents, with the columns, headers and types you set, naming the files it was made from. It makes the file; sending it is a step of its own. The same every time; no model.",
  category: "data",
  mode: "tool",
  handler: WRITE_TABLE_TOOL,
  tools: [WRITE_TABLE_TOOL],
  input: json(writeTableTool, "input"),
  output: json(writeTableTool, "output"),
  parameters: [...processes.WRITE_TABLE_PARAMETERS],
  settings: [],
  summary: "Wrote {{rowCount}} rows to {{filename}}",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
});

export const TABLE_SKILLS: readonly SkillDefinition[] = [
  READ_TABLE_SKILL_DEF,
  WRITE_TABLE_SKILL_DEF,
];
