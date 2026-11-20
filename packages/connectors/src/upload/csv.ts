// A small RFC 4180 CSV reader for purchase exports: quoted fields, doubled quotes, CRLF or LF, a
// UTF-8 BOM. Bank and card exports are a few thousand rows at most, so the whole file is read.

export class CsvError extends Error {
  override name = "CsvError";
}

/**
 * Rows of cells; blank lines are dropped, unless `keepBlankLines` (Read table, docs/plan.md
 * §1.164), so a row's place is the file's line number (a quoted line break aside).
 */
export function parseCsv(text: string, options: { keepBlankLines?: boolean } = {}): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (options.keepBlankLines || row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (quoted) throw new CsvError("a quoted field is never closed");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** A cell as CSV: quoted when it holds a comma, a quote or a line break. */
function csvField(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Rows of cells as RFC 4180 CSV, CRLF line ends. `text` marks the cells written from text: one
 * that starts as a formula would (`=`, `+`, `-`, `@`) gets a leading `'`, so a spreadsheet opening
 * the file never runs it.
 */
// DECISION (§1.164): the guard is on text cells only; numbers and amounts are written as they are.
export function writeCsv(rows: readonly (readonly { value: string; text: boolean }[])[]): string {
  return rows
    .map((row) =>
      row
        .map((c) => csvField(c.text && /^[=+\-@\t\r]/.test(c.value) ? `'${c.value}` : c.value))
        .join(","),
    )
    .map((line) => `${line}\r\n`)
    .join("");
}
