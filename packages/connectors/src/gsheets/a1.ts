// A1 notation, sheet titles and cell values for the gsheets connector (docs/plan.md §1.52). Every
// parser here walks the text with index loops: nothing a model or a sheet supplies goes through a
// regular expression.

/** Google's grid limits: 18,278 columns (ZZZ) and 10 million cells (so at most 10M rows). */
export const MAX_COLUMN = 18_278;
export const MAX_ROW = 10_000_000;
/** Google's limit on one cell's text. */
export const MAX_CELL_LENGTH = 50_000;
export const MAX_SHEET_TITLE_LENGTH = 100;

/** A cell as tools take and give it: text, a number, true/false, or nothing. */
export type Cell = string | number | boolean | null;

/** A range on one tab: columns 1-based; rows 1-based or null for "to the end". */
export interface A1Range {
  startCol: number;
  startRow: number | null;
  endCol: number;
  endRow: number | null;
}

const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** `A` → 1, `Z` → 26, `AA` → 27, `ZZZ` → 18278; null when it isn't 1–3 letters. */
export function columnNumber(letters: string): number | null {
  if (letters.length < 1 || letters.length > 3) return null;
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    const v = isUpper(c) ? c - 64 : isLower(c) ? c - 96 : 0;
    if (v === 0) return null;
    n = n * 26 + v;
  }
  return n;
}

/** 1 → `A`, 27 → `AA`. */
export function columnLetters(n: number): string {
  let out = "";
  let rest = Math.max(1, Math.min(MAX_COLUMN, Math.floor(n)));
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** One corner: letters then optional digits (`B`, `B12`). */
function corner(s: string): { col: number; row: number | null } | null {
  let i = 0;
  while (i < s.length && (isUpper(s.charCodeAt(i)) || isLower(s.charCodeAt(i)))) i++;
  const col = columnNumber(s.slice(0, i));
  if (col === null) return null;
  const digits = s.slice(i);
  if (digits.length === 0) return { col, row: null };
  if (digits.length > 8 || digits.charCodeAt(0) === 48) return null;
  for (let j = 0; j < digits.length; j++) if (!isDigit(digits.charCodeAt(j))) return null;
  const row = Number(digits);
  return row >= 1 && row <= MAX_ROW ? { col, row } : null;
}

/**
 * Cells on one tab in A1 notation, without the tab: `B3`, `A1:C10`, `A2:C` (to the last row) or
 * `A:C` (whole columns). Whole rows (`2:5`) and ranges named by a tab are not taken: the tab is
 * its own field.
 */
export function parseA1(
  input: string,
): { ok: true; range: A1Range } | { ok: false; problem: string } {
  const s = input.trim();
  if (s.length === 0 || s.length > 24)
    return { ok: false, problem: "the range is empty or too long" };
  const colon = s.indexOf(":");
  if (colon !== s.lastIndexOf(":")) return { ok: false, problem: "a range has one : at most" };
  const a = corner(colon < 0 ? s : s.slice(0, colon));
  const b = colon < 0 ? a : corner(s.slice(colon + 1));
  if (!a || !b) {
    return { ok: false, problem: `"${s}" is not a range like A1:C10, A2:C or A:C` };
  }
  if (colon < 0 && a.row === null) {
    return { ok: false, problem: `"${s}" names a column; write it as ${s}:${s}` };
  }
  if (a.row === null && b.row !== null) {
    return { ok: false, problem: `"${s}" has a last row but no first row` };
  }
  if (b.col < a.col || (a.row !== null && b.row !== null && b.row < a.row)) {
    return { ok: false, problem: `"${s}" ends before it starts` };
  }
  return { ok: true, range: { startCol: a.col, startRow: a.row, endCol: b.col, endRow: b.row } };
}

/** The range back in A1 notation (`B2:C3`, `A2:C`, `A:C`). */
export function formatA1(r: A1Range): string {
  const start = `${columnLetters(r.startCol)}${r.startRow ?? ""}`;
  const end = `${columnLetters(r.endCol)}${r.endRow ?? ""}`;
  return `${start}:${end}`;
}

/** Rows and columns of a range with both rows given; null when it runs to the end. */
export function rangeShape(r: A1Range): { rows: number; cols: number } | null {
  if (r.startRow === null || r.endRow === null) return null;
  return { rows: r.endRow - r.startRow + 1, cols: r.endCol - r.startCol + 1 };
}

/** Why a tab's title can't be used, or null. */
export function sheetTitleProblem(title: string): string | null {
  if (title.length === 0 || title.length > MAX_SHEET_TITLE_LENGTH) {
    return `a tab's name is 1 to ${MAX_SHEET_TITLE_LENGTH} characters`;
  }
  for (let i = 0; i < title.length; i++) {
    const c = title.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "a tab's name can't have control characters";
  }
  return null;
}

/** `'Tab name'!A1:C3`: the tab always quoted, a `'` in it doubled. */
export function qualifiedRange(title: string, cells: string): string {
  return `'${title.split("'").join("''")}'!${cells}`;
}

/**
 * Splits `'Tab name'!A1:C3` (or `Tab!A1`) into the tab and the cells; null when it isn't one.
 * Google answers ranges this way (`updatedRange`, `range`).
 */
export function splitQualifiedRange(s: string): { title: string; cells: string } | null {
  if (s.length > 400) return null;
  if (s.startsWith("'")) {
    let title = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] !== "'") {
        title += s[i];
        continue;
      }
      if (s[i + 1] === "'") {
        title += "'";
        i += 1;
        continue;
      }
      return s[i + 1] === "!" ? { title, cells: s.slice(i + 2) } : null;
    }
    return null;
  }
  const bang = s.lastIndexOf("!");
  return bang > 0 ? { title: s.slice(0, bang), cells: s.slice(bang + 1) } : null;
}

/** A Google file id: letters, digits, `-` and `_`, 10 to 200 of them. */
export function isFileId(s: string): boolean {
  if (s.length < 10 || s.length > 200) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isUpper(c) || isLower(c) || isDigit(c) || c === 45 || c === 95)) return false;
  }
  return true;
}

/** Plain numbers written as text (`-12.50`, `+3`, `1e5`): no formula can start that way. */
export function isNumericText(s: string): boolean {
  let i = 0;
  if (s[i] === "+" || s[i] === "-") i++;
  let digits = 0;
  while (i < s.length && isDigit(s.charCodeAt(i))) {
    i++;
    digits++;
  }
  if (s[i] === ".") {
    i++;
    while (i < s.length && isDigit(s.charCodeAt(i))) {
      i++;
      digits++;
    }
  }
  if (digits === 0) return false;
  if (s[i] === "e" || s[i] === "E") {
    i++;
    if (s[i] === "+" || s[i] === "-") i++;
    let exp = 0;
    while (i < s.length && isDigit(s.charCodeAt(i))) {
      i++;
      exp++;
    }
    if (exp === 0) return false;
  }
  return i === s.length;
}

/** The characters a spreadsheet may read as the start of a formula (OWASP's CSV injection list). */
const FORMULA_STARTS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * A cell as we write it. Text that could start a formula gets a leading `'`, so it stays text
 * even where the sheet is exported and opened by another program; plain numbers written as text
 * are left alone. Everything is written with `valueInputOption=RAW` besides, so Google never
 * parses what we send.
 */
// DECISION: both, RAW and the `'` (docs/plan.md §1.52). RAW alone stops formulas in Google Sheets,
// but a CSV export opened in Excel would still run `=HYPERLINK(…)`; the `'` alone would rely on
// USER_ENTERED parsing, which also turns "1/2" into a date.
export function writtenCell(v: Cell): Cell {
  if (typeof v !== "string" || v.length === 0) return v;
  if (!FORMULA_STARTS.has(v.charAt(0)) || isNumericText(v)) return v;
  return `'${v}`;
}

/** Empty, null and missing cells are the same. */
function plain(v: unknown): Cell {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/** Two cells as read from the sheet: the same content. */
export function sameCell(a: unknown, b: unknown): boolean {
  return plain(a) === plain(b);
}

/**
 * Whether a cell read from the sheet holds what we wrote. A null target keeps the cell as it is
 * (Google skips it), so anything matches. A `'`-escaped text matches with or without its `'`:
 * whether Google keeps the mark in a RAW value is one of the facts to verify (NOTES.md).
 */
export function holdsWritten(read: unknown, target: Cell): boolean {
  if (target === null) return true;
  if (sameCell(read, target)) return true;
  return typeof target === "string" && target.startsWith("'") && sameCell(read, target.slice(1));
}

/** A grid padded (or cut) to `rows` × `cols`, empty cells as null. */
export function padGrid(
  values: readonly (readonly unknown[])[],
  rows: number,
  cols: number,
): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = values[r] ?? [];
    const cells: Cell[] = [];
    for (let c = 0; c < cols; c++) cells.push(plain(row[c]));
    out.push(cells);
  }
  return out;
}
