// A skill's sample file (owner, 2026-11-24: "allow the upload of a file like excel or csv or pdf,
// jpeg etc ... then with words specify the input and the output"). The operator adds a sample of
// what a skill gets when describing it. A spreadsheet (.xlsx, .csv, .json) is read here in code,
// as Read table reads one: its columns suggested from the headers (Collect reports' rule), then
// read again with those columns so its rows are keyed as a Read table step would give them. A PDF
// or an image is passed on as a content block for the Builder's model call. Nothing is stored: the
// sample never becomes a client's document. Operator only, audited by `mount`.

import type { SkillSample } from "@countersign/agents";
import { documentMimeType, readTableFile, TableFileError } from "@countersign/connectors";
import {
  type BuilderSampleFile,
  isExtractable,
  isTableType,
  processes,
  routes,
  type SkillSampleView,
  tableFiles,
} from "@countersign/core";
import { documentBlock } from "@countersign/documents";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount } from "../http";

/** The first rows shown in a sample's preview. */
const PREVIEW_ROWS = 5;
/** The first rows the Builder sees (and a test case holds). */
const BUILDER_ROWS = 10;

function bytesOf(base64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, "invalid_request", "the file isn't base64");
  }
}

interface SampleRead {
  view: SkillSampleView;
  /** For the Builder: the table's first rows, or the document to attach; null for neither. */
  forBuilder: SkillSample | null;
  /** A table's rows, all of them, keyed as Read table keys them (a try runs on them). */
  rows: Record<string, unknown>[];
  /** A PDF's or an image's bytes (a try reads them from memory); null for anything else. */
  document: { mimeType: string; bytes: Uint8Array } | null;
}

/** Reads a sample file: a table in code, a PDF or an image as a block for the model. */
export function readSkillSample(file: BuilderSampleFile): SampleRead {
  const { filename } = file;
  const mimeType = documentMimeType(file.mimeType, filename);
  const none = { filename, mimeType, table: null, failure: null };
  if (isTableType(mimeType)) {
    const bytes = bytesOf(file.base64);
    try {
      const first = tableFiles.readTableOptions({});
      if (!first.ok) throw new HttpError(500, "internal", first.error);
      const raw = readTableFile({ bytes, mimeType, filename }, first.options);
      const columns = processes.columnsFromSample(raw.read.columns, raw.read.rows);
      // Read again with the suggested columns, so the rows are keyed as Read table keys them.
      const second = tableFiles.readTableOptions({
        columns: columns.map((c) => ({ ...c, required: false })),
      });
      if (!second.ok) throw new HttpError(500, "internal", second.error);
      const typed = readTableFile({ bytes, mimeType, filename }, second.options);
      const rows = typed.read.rows;
      const table = {
        sheet: typed.read.sheet,
        sheets: typed.sheets,
        columns,
        rows: rows.slice(0, PREVIEW_ROWS),
        rowCount: rows.length,
        failure: raw.read.failure ?? typed.read.failure,
      };
      return {
        view: { ...none, kind: "table", table },
        rows,
        document: null,
        forBuilder: {
          filename,
          table: {
            sheet: table.sheet,
            columns,
            rows: rows.slice(0, BUILDER_ROWS),
            rowCount: rows.length,
          },
        },
      };
    } catch (error) {
      if (error instanceof TableFileError) {
        return {
          view: { ...none, kind: "table", failure: error.message },
          forBuilder: null,
          rows: [],
          document: null,
        };
      }
      throw error;
    }
  }
  if (isExtractable(mimeType)) {
    return {
      view: { ...none, kind: "document" },
      forBuilder: { filename, attach: documentBlock(mimeType, file.base64.replace(/\s/g, "")) },
      rows: [],
      document: { mimeType, bytes: bytesOf(file.base64) },
    };
  }
  return {
    view: {
      ...none,
      kind: "other",
      failure: `${filename} isn't a file we read: use a spreadsheet (.xlsx, .csv, .json), a PDF or an image`,
    },
    forBuilder: null,
    rows: [],
    document: null,
  };
}

export function opsSkillSampleRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsSkillSample, async (ctx): Promise<SkillSampleView> => {
    return readSkillSample(ctx.body.file).view;
  });
}
