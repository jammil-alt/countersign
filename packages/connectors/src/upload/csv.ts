// A small RFC 4180 CSV reader for purchase exports: quoted fields, doubled quotes, CRLF or LF, a
// UTF-8 BOM. Bank and card exports are a few thousand rows at most, so the whole file is read.

export class CsvError extends Error {
  override name = "CsvError";
}

/** Rows of cells; blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) rows.push(row);
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
