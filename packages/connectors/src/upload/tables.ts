// Table files in and out (docs/plan.md §1.164): a .csv, .xlsx or .json document's bytes read as a
// table by core's rules (`tableFiles.tableFromGrid`, `tableFromJson`), and rows written as a .csv
// or .xlsx file. Read table, Write table and the builder's sample-file check all come here, so a
// file reads the same way in a run and in the builder. Code only: no model reads these files.

import {
  CSV_MIME_TYPE,
  processes,
  type TableColumns,
  type TableFileKind,
  tableFileKind,
  tableFiles,
  tableMimeType,
  XLSX_MIME_TYPE,
} from "@countersign/core";
import { strFromU8, strToU8 } from "fflate";
import { CsvError, parseCsv, writeCsv } from "./csv";
import { readXlsx, writeXlsx, XlsxError } from "./xlsx";

/** Why a table file can't be read or written: the step fails with this, in plain words. */
export class TableFileError extends Error {
  override name = "TableFileError";
}

export interface TableFileRead {
  kind: TableFileKind;
  /** An .xlsx file's worksheets; empty for CSV and JSON. */
  sheets: string[];
  read: tableFiles.TableRead;
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** UTF-8 text, a byte-order mark dropped. */
function text(bytes: Uint8Array): string {
  return strFromU8(bytes).replace(/^\uFEFF/, "");
}

/**
 * A table file read with a Read table step's options. Throws TableFileError for a file that is
 * too large, isn't a table, or can't be read; a file read with a `failure` (a required column
 * missing, too many rows) is returned as read, for the caller to fail on or show.
 */
export function readTableFile(
  file: { bytes: Uint8Array; mimeType: string; filename: string },
  options: tableFiles.ReadTableOptions,
): TableFileRead {
  if (file.bytes.length > processes.TABLE_MAX_BYTES) {
    throw new TableFileError(
      `${file.filename} is over ${MB(processes.TABLE_MAX_BYTES)}; we read files of at most ${MB(processes.TABLE_MAX_BYTES)}`,
    );
  }
  const mime = tableMimeType(file.mimeType, file.filename);
  const kind = mime ? tableFileKind(mime) : null;
  if (!kind) {
    throw new TableFileError(
      `${file.filename} isn't a table: Read table reads .csv, .xlsx and .json files`,
    );
  }
  switch (kind) {
    case "csv": {
      let grid: string[][];
      try {
        grid = parseCsv(text(file.bytes), { keepBlankLines: true });
      } catch (error) {
        throw new TableFileError(
          `${file.filename} isn't a CSV we can read: ${error instanceof CsvError ? error.message : "unreadable"}`,
        );
      }
      return { kind, sheets: [], read: tableFiles.tableFromGrid(grid, options) };
    }
    case "xlsx": {
      try {
        const sheet = readXlsx(file.bytes, { sheet: options.sheet });
        return {
          kind,
          sheets: sheet.sheets,
          read: tableFiles.tableFromGrid(sheet.grid, options, sheet.sheet),
        };
      } catch (error) {
        if (error instanceof XlsxError)
          throw new TableFileError(`${file.filename}: ${error.message}`);
        throw error;
      }
    }
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(text(file.bytes));
      } catch {
        throw new TableFileError(`${file.filename} isn't JSON we can read`);
      }
      return { kind, sheets: [], read: tableFiles.tableFromJson(value, options) };
    }
  }
}

export interface TableFileWritten {
  bytes: Uint8Array;
  mimeType: string;
  extension: "csv" | "xlsx";
  rowCount: number;
}

/** A written cell as CSV text: dates in their style, amounts as decimals, true or false. */
function csvCell(cell: tableFiles.WriteCell): { value: string; text: boolean } {
  if (cell === null) return { value: "", text: false };
  switch (cell.kind) {
    case "text":
      return { value: cell.value, text: true };
    case "number":
      return { value: String(cell.value), text: false };
    case "money":
      return { value: cell.value, text: false };
    case "date":
      return { value: tableFiles.formatTableDate(cell.value, cell.style), text: false };
    case "boolean":
      return { value: cell.value ? "true" : "false", text: false };
  }
}

/**
 * Rows written as a .csv or .xlsx file by the columns (in their order; none: every field of the
 * rows). Throws TableFileError for a value that isn't its column's type, too many rows, or a file
 * over the size limit.
 */
export function writeTableFile(
  rows: readonly Record<string, unknown>[],
  columns: TableColumns,
  format: "csv" | "xlsx",
  options: { sheet?: string | null } = {},
): TableFileWritten {
  const laid = tableFiles.tableForWriting(rows, columns);
  if (!laid.ok) throw new TableFileError(laid.error);
  const { grid } = laid;
  let bytes: Uint8Array;
  if (format === "xlsx") {
    bytes = writeXlsx(grid, options);
  } else {
    const all = [
      grid.headers.map((h) => ({ value: h, text: true })),
      ...grid.rows.map((r) => r.map(csvCell)),
    ];
    // DECISION: a byte-order mark first, so Excel opens the UTF-8 file with its accents intact.
    bytes = strToU8(`\uFEFF${writeCsv(all)}`);
  }
  if (bytes.length > processes.TABLE_MAX_BYTES) {
    throw new TableFileError(
      `the file would be over ${MB(processes.TABLE_MAX_BYTES)}; we write files of at most ${MB(processes.TABLE_MAX_BYTES)}`,
    );
  }
  return {
    bytes,
    mimeType: format === "xlsx" ? XLSX_MIME_TYPE : CSV_MIME_TYPE,
    extension: format,
    rowCount: grid.rows.length,
  };
}
