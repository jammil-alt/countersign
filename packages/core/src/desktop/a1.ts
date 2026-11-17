// A1 cell references for workbooks on a client's computer (docs/plan.md §1.151). The desktop app
// imports only core, so it can't use the connectors' Sheets helpers (packages/connectors/src/gsheets
// /a1.ts); this is the part it needs, with Excel's limits. Index loops, no regular expressions:
// what a model or a workbook supplies never goes through one.

/** Excel's grid: 16,384 columns (XFD) and 1,048,576 rows. */
export const XLSX_MAX_COLUMN = 16_384;
export const XLSX_MAX_ROW = 1_048_576;

/** A cell as jobs take and give it: text, a number, true/false, or nothing. */
export type XlsxCell = string | number | boolean | null;

/** A block of cells; rows and columns 1-based and inclusive. `endRow` null: to the last row. */
export interface XlsxRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number | null;
}

const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** `A` → 1, `XFD` → 16384; null when it isn't 1–3 letters within Excel's columns. */
export function xlsxColumnNumber(letters: string): number | null {
  if (letters.length < 1 || letters.length > 3) return null;
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    const v = isUpper(c) ? c - 64 : isLower(c) ? c - 96 : 0;
    if (v === 0) return null;
    n = n * 26 + v;
  }
  return n <= XLSX_MAX_COLUMN ? n : null;
}

/** 1 → `A`, 27 → `AA`. */
export function xlsxColumnLetters(n: number): string {
  let out = "";
  let rest = Math.max(1, Math.min(XLSX_MAX_COLUMN, Math.floor(n)));
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** `B12` → {col: 2, row: 12}; `B` → {col: 2, row: null}; null when it is neither. */
export function parseXlsxCell(ref: string): { col: number; row: number | null } | null {
  let i = 0;
  while (i < ref.length && (isUpper(ref.charCodeAt(i)) || isLower(ref.charCodeAt(i)))) i++;
  const col = xlsxColumnNumber(ref.slice(0, i));
  if (col === null) return null;
  const digits = ref.slice(i);
  if (digits.length === 0) return { col, row: null };
  if (digits.length > 7 || digits.charCodeAt(0) === 48) return null;
  for (let j = 0; j < digits.length; j++) {
    if (!isDigit(digits.charCodeAt(j))) return null;
  }
  const row = Number(digits);
  return row <= XLSX_MAX_ROW ? { col, row } : null;
}

/**
 * `A1:C10`, `A2:C` (to the last row), `A:C` (whole columns) or one cell `B4`. Corners in any order
 * are put in order. Null when it is none of these.
 */
export function parseXlsxRange(text: string): XlsxRange | null {
  const parts = text.split(":");
  if (parts.length > 2) return null;
  const a = parseXlsxCell(parts[0] ?? "");
  const b = parts.length === 2 ? parseXlsxCell(parts[1] ?? "") : a;
  if (!a || !b) return null;
  if (parts.length === 1 && a.row === null) return null;
  // A start row is needed whenever an end row is given (`A:C5` means nothing).
  if (a.row === null && b.row !== null) return null;
  const startRow = a.row === null ? 1 : Math.min(a.row, b.row ?? a.row);
  const endRow = b.row === null ? null : Math.max(a.row ?? b.row, b.row);
  return {
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
    startRow,
    endRow,
  };
}

/** The range as text: `A1:C10`, `A2:C` when it runs to the last row. */
export function formatXlsxRange(r: XlsxRange): string {
  const start = `${xlsxColumnLetters(r.startCol)}${r.startRow}`;
  const end = `${xlsxColumnLetters(r.endCol)}${r.endRow ?? ""}`;
  return `${start}:${end}`;
}
