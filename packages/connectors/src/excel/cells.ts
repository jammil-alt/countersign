// Excel's grid, worksheet names, OneDrive item ids and cell values for the excel connector
// (docs/plan.md §1.97). A1 notation and the formula escape are Google Sheets' (../gsheets/a1.ts);
// what differs for Excel is here. Every check walks the text with index loops: nothing a model or
// a workbook supplies goes through a regular expression.

import { type A1Range, type Cell, sameCell, writtenCell } from "../gsheets/a1";

/** Excel's grid: columns A to XFD, rows 1 to 1,048,576. */
export const EXCEL_MAX_COLUMN = 16_384;
export const EXCEL_MAX_ROW = 1_048_576;
/** Excel's limit on one cell's text. */
export const EXCEL_MAX_CELL_LENGTH = 32_767;
export const EXCEL_MAX_WORKSHEET_NAME_LENGTH = 31;

/** Why a range doesn't fit Excel's grid, or null. */
export function excelGridProblem(r: A1Range): string | null {
  if (r.endCol > EXCEL_MAX_COLUMN) return "Excel's columns run from A to XFD";
  if ((r.startRow ?? 1) > EXCEL_MAX_ROW || (r.endRow ?? 1) > EXCEL_MAX_ROW) {
    return "Excel's rows run from 1 to 1048576";
  }
  return null;
}

/** The characters Excel doesn't allow in a worksheet's name. */
const NOT_IN_NAME = new Set([":", "\\", "/", "?", "*", "[", "]"]);

/** Why a worksheet name can't be one of Excel's, or null. */
export function worksheetNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > EXCEL_MAX_WORKSHEET_NAME_LENGTH) {
    return `a worksheet's name is 1 to ${EXCEL_MAX_WORKSHEET_NAME_LENGTH} characters`;
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "a worksheet's name can't have control characters";
    if (NOT_IN_NAME.has(name.charAt(i))) return "a worksheet's name can't have : \\ / ? * [ or ]";
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    return "a worksheet's name can't start or end with '";
  }
  return null;
}

const isAlnum = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * A OneDrive item id: letters, digits, `!`, `.`, `-` and `_`, 3 to 200 of them (work accounts:
 * `01BYE5RZ…`; personal accounts: `D4648F06C91D9D3D!54927`).
 */
export function isExcelItemId(s: string): boolean {
  if (s.length < 3 || s.length > 200) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isAlnum(c) || c === 33 || c === 45 || c === 46 || c === 95)) return false;
  }
  return true;
}

export const EXCEL_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** An Excel workbook the workbook API opens: an `.xlsx` name, and the type when Microsoft says it. */
// DECISION: the `.xlsx` extension is required and the MIME type, when given, must be .xlsx's: the
// workbook API opens only Office Open XML workbooks (not .xls, .xlsm or .csv; NOTES.md).
export function isExcelWorkbookFile(name: string, mimeType: string | null | undefined): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.slice(dot + 1).toLowerCase() !== "xlsx") return false;
  return mimeType === null || mimeType === undefined || mimeType === EXCEL_XLSX_MIME;
}

/**
 * A cell as Graph's range PATCH takes it in `values`. Excel reads `values` as if a person typed
 * them (text starting with `=`, `+` or `-` becomes a formula, "1/2" a date), so every text gets
 * Excel's quote prefix `'`, which stores what follows as text exactly. Text that could start a
 * formula also keeps a visible `'` (Sheets' `writtenCell`), so it stays text when the workbook is
 * exported to CSV and opened elsewhere. Numbers and true/false go as JSON; null keeps the cell.
 */
// DECISION: the quote prefix on every text, not `numberFormat: "@"` and not `formulas`. A text
// format changes the cell's format for good and Graph doesn't say whether it applies before the
// value in one PATCH; `formulas` takes the same typed-input path. Whether Graph keeps the prefix
// as Excel's (not as a character of the text) is to verify (NOTES.md); either way nothing runs.
export function excelValue(v: Cell): Cell {
  if (typeof v !== "string" || v.length === 0) return v;
  return `'${writtenCell(v)}`;
}

/** What the cell holds once we wrote `v`: the text as given, formula-looking text with its `'`. */
export function excelStored(v: Cell): Cell {
  return writtenCell(v);
}

/**
 * Whether a cell read back from Excel holds what we wrote. A null target keeps the cell as it is,
 * so anything matches. Strict: a formula whose text equals ours doesn't match our escaped text.
 */
export function excelHolds(read: unknown, target: Cell): boolean {
  if (target === null) return true;
  return sameCell(read, excelStored(target));
}

/** A cell for the model: what Graph gives back, as text, number, true/false or null. */
export function excelCellOut(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.slice(0, EXCEL_MAX_CELL_LENGTH);
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v).slice(0, EXCEL_MAX_CELL_LENGTH);
}

const isBlank = (v: Cell) => v === null || v === "";

/** Graph's grid as Google answers one: trailing empty cells and rows removed, `width` at most. */
export function trimmedGrid(grid: readonly (readonly unknown[])[], width: number): Cell[][] {
  const rows = grid.map((row) => {
    const cells = row.slice(0, width).map(excelCellOut);
    let n = cells.length;
    while (n > 0 && isBlank(cells[n - 1] ?? null)) n--;
    return cells.slice(0, n);
  });
  let n = rows.length;
  while (n > 0 && (rows[n - 1]?.length ?? 0) === 0) n--;
  return rows.slice(0, n);
}

/** Characters of text in a grid of cells. */
export function textLength(rows: readonly (readonly Cell[])[]): number {
  let n = 0;
  for (const row of rows) for (const v of row) if (typeof v === "string") n += v.length;
  return n;
}

/** An OData string literal's inside: `'` doubled. */
export function odataString(s: string): string {
  return s.split("'").join("''");
}
