// Reading and changing .xlsx workbooks on the client's computer (docs/plan.md §1.124), without
// Excel. A workbook is a zip of XML parts; we change only the cells we write, in the worksheet's
// own XML, and copy every other part byte for byte, so formats, formulas, charts, pivots, names
// and anything we don't understand stay exactly as they were.
// DECISION: a surgical edit (fflate + xmldom), not a spreadsheet library that loads the whole
// workbook into its own model and writes it back: those drop what they don't model (pivots,
// charts, slicers, some formats), which a client's real workbook is full of.
//
// What we write: numbers as numbers, true/false as booleans, text as inline text (`inlineStr`),
// which Excel never runs as a formula. "" empties a cell (its format stays); null leaves it as it
// is. We never write a formula and never replace one (the caller checks `formulaAt` first). New
// cells take the format of the cell above, so an added row looks like the rows before it. The
// workbook is marked to recalculate when it is next opened, so totals that read our cells update.

import {
  type DesktopJobErrorCode,
  formatXlsxRange,
  type XlsxCell,
  type XlsxRange,
  xlsxColumnLetters,
} from "@countersign/core";
import { DOMParser, type DOMParser as DOMParserType, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Unpacked, a workbook may hold at most this much (a zip bomb is refused, not unpacked). */
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;

type El = ReturnType<Document["createElementNS"]>;

/** Why a workbook can't be read or written, with the job error it becomes. */
export class XlsxProblem extends Error {
  constructor(
    readonly code: DesktopJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "XlsxProblem";
  }
}

function parseXml(text: string, part: string): Document {
  const parser: DOMParserType = new DOMParser({
    onError: (level: string, message: string) => {
      if (level !== "warning") {
        throw new XlsxProblem("unsupported_file", `Part ${part} isn't valid XML: ${message}`);
      }
    },
  });
  return parser.parseFromString(text, "text/xml") as unknown as Document;
}

function elements(parent: { childNodes: NodeListOf<ChildNode> }, local?: string): El[] {
  const out: El[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as unknown as El;
    if (n.nodeType === 1 && (local === undefined || n.localName === local)) out.push(n);
  }
  return out;
}

function child(parent: El, local: string): El | undefined {
  return elements(parent, local)[0];
}

function textOf(el: El | undefined): string {
  return el?.textContent ?? "";
}

/** The text of a shared string or inline string: its runs, without phonetic hints. */
function richText(si: El): string {
  const t = child(si, "t");
  if (t) return textOf(t);
  return elements(si, "r")
    .map((r) => textOf(child(r, "t")))
    .join("");
}

/** "B12" → [12, 2]. */
function refOf(ref: string): [number, number] | null {
  let i = 0;
  let col = 0;
  while (i < ref.length) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) col = col * 26 + (c - 64);
    else break;
    i++;
  }
  const row = Number(ref.slice(i));
  if (col === 0 || !Number.isInteger(row) || row < 1) return null;
  return [row, col];
}

const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a custom number format shows a date or time (`d`, `m`, `y`, `h`, `s` outside quotes). */
export function isDateFormatCode(code: string): boolean {
  let inQuote = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "\\" || c === "_" || c === "*") i++;
    else if (c === "[") {
      // [Red], [$-409] and conditions are not dates; [h] and [mm] are elapsed time.
      const end = code.indexOf("]", i);
      const inner = code.slice(i + 1, end < 0 ? code.length : end).toLowerCase();
      if (/^(h+|m+|s+)$/.test(inner)) return true;
      i = end < 0 ? code.length : end;
    } else if (!inQuote && c !== undefined && "dmyhsDMYHS".includes(c)) return true;
  }
  return false;
}

/** An Excel serial date as ISO 8601: a date, or a date and time when it has a fraction. */
export function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86_400_000);
  const iso = new Date(epoch + ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19);
}

interface SheetEntry {
  name: string;
  part: string;
  hidden: boolean;
}

export class Workbook {
  private readonly docs = new Map<string, Document>();
  private readonly changed = new Set<string>();
  private readonly sheetsList: SheetEntry[];
  private readonly shared: string[];
  private readonly dateStyles: Set<number>;
  private readonly date1904: boolean;

  private constructor(private readonly files: Record<string, Uint8Array>) {
    const wb = this.doc("xl/workbook.xml");
    const rels = this.doc("xl/_rels/workbook.xml.rels");
    const targets = new Map<string, { target: string; type: string }>();
    for (const r of elements(rels.documentElement as unknown as El, "Relationship")) {
      targets.set(r.getAttribute("Id") ?? "", {
        target: r.getAttribute("Target") ?? "",
        type: r.getAttribute("Type") ?? "",
      });
    }
    const resolve = (target: string) =>
      target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const root = wb.documentElement as unknown as El;
    const sheetsEl = child(root, "sheets");
    this.sheetsList = (sheetsEl ? elements(sheetsEl, "sheet") : []).flatMap((s) => {
      const id = s.getAttributeNS(DOC_REL, "id") ?? s.getAttribute("r:id") ?? "";
      const rel = targets.get(id);
      // Chart sheets and dialog sheets have no cells: not offered.
      if (!rel?.type.endsWith("/worksheet")) return [];
      const part = resolve(rel.target);
      if (!this.files[part]) return [];
      return [
        {
          name: s.getAttribute("name") ?? "",
          part,
          hidden: (s.getAttribute("state") ?? "visible") !== "visible",
        },
      ];
    });
    const pr = child(root, "workbookPr");
    const d1904 = pr?.getAttribute("date1904");
    this.date1904 = d1904 === "1" || d1904 === "true";
    const sharedRel = [...targets.values()].find((t) => t.type.endsWith("/sharedStrings"));
    const sharedPart = sharedRel ? resolve(sharedRel.target) : "xl/sharedStrings.xml";
    this.shared = this.files[sharedPart]
      ? elements(this.doc(sharedPart).documentElement as unknown as El, "si").map(richText)
      : [];
    this.dateStyles = this.findDateStyles(
      [...targets.values()].find((t) => t.type.endsWith("/styles")),
      resolve,
    );
  }

  /** Opens a workbook's bytes. Throws XlsxProblem for anything that isn't a readable .xlsx. */
  static open(bytes: Uint8Array): Workbook {
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new XlsxProblem(
        "unsupported_file",
        "This workbook is password-protected or in the old .xls format; we can't open it.",
      );
    }
    let total = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (f) => {
          total += f.originalSize;
          if (total > MAX_UNPACKED_BYTES) {
            throw new XlsxProblem("too_large", "This workbook is too large for us to open.");
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof XlsxProblem) throw error;
      throw new XlsxProblem("unsupported_file", "This file isn't a workbook we can read.");
    }
    if (!files["xl/workbook.xml"] || !files["xl/_rels/workbook.xml.rels"]) {
      throw new XlsxProblem("unsupported_file", "This file isn't a workbook we can read.");
    }
    if (files["xl/vbaProject.bin"]) {
      throw new XlsxProblem("unsupported_file", "This workbook has macros; we don't open those.");
    }
    return new Workbook(files);
  }

  private doc(part: string): Document {
    let d = this.docs.get(part);
    if (!d) {
      const bytes = this.files[part];
      if (!bytes) throw new XlsxProblem("unsupported_file", `The workbook has no ${part}.`);
      d = parseXml(strFromU8(bytes), part);
      this.docs.set(part, d);
    }
    return d;
  }

  private findDateStyles(
    rel: { target: string } | undefined,
    resolve: (t: string) => string,
  ): Set<number> {
    const part = rel ? resolve(rel.target) : "xl/styles.xml";
    if (!this.files[part]) return new Set();
    const root = this.doc(part).documentElement as unknown as El;
    const custom = new Map<number, string>();
    const numFmts = child(root, "numFmts");
    for (const f of numFmts ? elements(numFmts, "numFmt") : []) {
      custom.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? "");
    }
    const out = new Set<number>();
    const xfs = child(root, "cellXfs");
    elements(xfs ?? root, "xf").forEach((xf, i) => {
      if (!xfs) return;
      const id = Number(xf.getAttribute("numFmtId") ?? "0");
      const code = custom.get(id);
      if (BUILT_IN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormatCode(code))) {
        out.add(i);
      }
    });
    return out;
  }

  /** Worksheet names, in the workbook's order (hidden ones included). */
  sheetNames(): string[] {
    return this.sheetsList.map((s) => s.name);
  }

  /** A worksheet by name (any case), or the first visible one. */
  sheet(name?: string): Sheet {
    const entry =
      name === undefined
        ? (this.sheetsList.find((s) => !s.hidden) ?? this.sheetsList[0])
        : this.sheetsList.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      throw new XlsxProblem(
        "not_found",
        name === undefined
          ? "This workbook has no worksheets."
          : `There's no worksheet called ${name}.`,
      );
    }
    return new Sheet(
      entry.name,
      this.doc(entry.part),
      this.shared,
      this.dateStyles,
      this.date1904,
      () => this.changed.add(entry.part),
    );
  }

  /** The workbook's bytes with the changed parts, marked to recalculate when next opened. */
  save(): Uint8Array {
    if (this.changed.size > 0) this.markRecalc();
    const out: Record<string, Uint8Array> = {};
    const serializer = new XMLSerializer();
    for (const [name, bytes] of Object.entries(this.files)) {
      const d = this.changed.has(name) ? this.docs.get(name) : undefined;
      out[name] = d ? strToU8(serializer.serializeToString(d as never)) : bytes;
    }
    return zipSync(out, { level: 6 });
  }

  private markRecalc(): void {
    const part = "xl/workbook.xml";
    const d = this.doc(part);
    const root = d.documentElement as unknown as El;
    let calc = child(root, "calcPr");
    if (!calc) {
      calc = d.createElementNS(MAIN, qualified(root, "calcPr")) as unknown as El;
      // CT_Workbook's order: calcPr comes before these.
      const after = new Set([
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
      ]);
      const next = elements(root).find((e) => after.has(e.localName ?? ""));
      if (next) root.insertBefore(calc, next);
      else root.appendChild(calc);
    }
    calc.setAttribute("fullCalcOnLoad", "1");
    this.changed.add(part);
  }
}

/** The element name with the root's prefix, if the part uses one (`x:row`). */
function qualified(root: El, local: string): string {
  return root.prefix ? `${root.prefix}:${local}` : local;
}

interface CellAt {
  value: XlsxCell;
  formula: string | null;
}

export class Sheet {
  private readonly root: El;
  private readonly sheetData: El;
  /** Rows by number; each row's cells by column. Built once, kept up to date by writes. */
  private readonly rows = new Map<number, { el: El; cells: Map<number, El> }>();

  constructor(
    readonly name: string,
    private readonly doc: Document,
    private readonly shared: readonly string[],
    private readonly dateStyles: ReadonlySet<number>,
    private readonly date1904: boolean,
    private readonly touched: () => void,
  ) {
    this.root = doc.documentElement as unknown as El;
    let data = child(this.root, "sheetData");
    if (!data) {
      data = doc.createElementNS(MAIN, qualified(this.root, "sheetData")) as unknown as El;
      this.root.appendChild(data);
    }
    this.sheetData = data;
    let rowNumber = 0;
    for (const rowEl of elements(data, "row")) {
      const r = Number(rowEl.getAttribute("r"));
      rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
      const cells = new Map<number, El>();
      let col = 0;
      for (const c of elements(rowEl, "c")) {
        const at = refOf(c.getAttribute("r") ?? "");
        col = at ? at[1] : col + 1;
        cells.set(col, c);
      }
      this.rows.set(rowNumber, { el: rowEl, cells });
    }
  }

  private valueOf(c: El, render: "values" | "formula"): CellAt {
    const f = child(c, "f");
    const formula = f ? `=${textOf(f)}` : null;
    if (render === "formula" && formula) return { value: formula, formula };
    const t = c.getAttribute("t") ?? "n";
    const v = child(c, "v");
    if (t === "inlineStr") {
      const is = child(c, "is");
      return { value: is ? richText(is) : "", formula };
    }
    if (!v) return { value: null, formula };
    const raw = textOf(v);
    switch (t) {
      case "s":
        return { value: this.shared[Number(raw)] ?? "", formula };
      case "b":
        return { value: raw === "1" || raw === "true", formula };
      case "str":
      case "e":
      case "d":
        return { value: raw, formula };
      default: {
        if (raw === "") return { value: null, formula };
        const n = Number(raw);
        if (!Number.isFinite(n)) return { value: raw, formula };
        const style = Number(c.getAttribute("s") ?? "0");
        if (render === "values" && this.dateStyles.has(style)) {
          return { value: serialToIso(n, this.date1904), formula };
        }
        return { value: n, formula };
      }
    }
  }

  /** What one cell holds (null when empty). */
  cell(row: number, col: number, render: "values" | "formula" = "values"): CellAt {
    const c = this.rows.get(row)?.cells.get(col);
    return c ? this.valueOf(c, render) : { value: null, formula: null };
  }

  /** Whether any cell in the block holds a formula. */
  formulaIn(startRow: number, startCol: number, rows: number, cols: number): boolean {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.cell(startRow + r, startCol + c).formula !== null) return true;
      }
    }
    return false;
  }

  private hasContent(c: El): boolean {
    if (child(c, "f")) return true;
    if (c.getAttribute("t") === "inlineStr") return richText(child(c, "is") ?? c) !== "";
    return textOf(child(c, "v")) !== "";
  }

  /** The last row with a value or formula (0 when the sheet is empty). */
  lastRow(): number {
    let last = 0;
    for (const [r, row] of this.rows) {
      if (r > last && [...row.cells.values()].some((c) => this.hasContent(c))) last = r;
    }
    return last;
  }

  /** The last column with a value or formula (0 when the sheet is empty). */
  lastCol(): number {
    let last = 0;
    for (const row of this.rows.values()) {
      for (const [c, el] of row.cells) if (c > last && this.hasContent(el)) last = c;
    }
    return last;
  }

  /** The cells of a block, never past the last row with data and never more than `limit` rows. */
  read(
    range: XlsxRange,
    render: "values" | "formula",
    limit: number,
  ): { values: XlsxCell[][]; range: string; truncated: boolean } {
    const last = this.lastRow();
    const end = Math.min(range.endRow ?? last, last);
    const there = Math.max(end - range.startRow + 1, 0);
    const count = Math.min(there, limit);
    const values: XlsxCell[][] = [];
    for (let r = 0; r < count; r++) {
      const row: XlsxCell[] = [];
      for (let c = range.startCol; c <= range.endCol; c++) {
        row.push(this.cell(range.startRow + r, c, render).value);
      }
      values.push(row);
    }
    return {
      values,
      range: formatXlsxRange({ ...range, endRow: range.startRow + Math.max(count, 1) - 1 }),
      truncated: there > limit,
    };
  }

  private rowEl(r: number): { el: El; cells: Map<number, El> } {
    const have = this.rows.get(r);
    if (have) return have;
    const el = this.doc.createElementNS(MAIN, qualified(this.root, "row")) as unknown as El;
    el.setAttribute("r", String(r));
    const next = [...this.rows.entries()].filter(([n]) => n > r).sort(([a], [b]) => a - b)[0];
    if (next) this.sheetData.insertBefore(el, next[1].el);
    else this.sheetData.appendChild(el);
    const row = { el, cells: new Map<number, El>() };
    this.rows.set(r, row);
    return row;
  }

  private cellEl(r: number, col: number, inheritStyle: boolean): El {
    const row = this.rowEl(r);
    const have = row.cells.get(col);
    if (have) return have;
    const el = this.doc.createElementNS(MAIN, qualified(this.root, "c")) as unknown as El;
    el.setAttribute("r", `${xlsxColumnLetters(col)}${r}`);
    const above = inheritStyle
      ? this.rows
          .get(r - 1)
          ?.cells.get(col)
          ?.getAttribute("s")
      : null;
    if (above) el.setAttribute("s", above);
    const next = [...row.cells.entries()].filter(([n]) => n > col).sort(([a], [b]) => a - b)[0];
    if (next) row.el.insertBefore(el, next[1]);
    else row.el.appendChild(el);
    row.cells.set(col, el);
    return el;
  }

  /**
   * Writes a block of cells at (startRow, startCol): numbers, booleans, text (as inline text),
   * "" to empty, null to leave. Every written row gets explicit cell references, and its `spans`
   * hint is dropped (Excel recomputes it).
   */
  write(
    startRow: number,
    startCol: number,
    grid: readonly (readonly XlsxCell[])[],
    options: { inheritStyle: boolean },
  ): number {
    let written = 0;
    grid.forEach((cells, i) => {
      const r = startRow + i;
      cells.forEach((value, j) => {
        if (value === null) return;
        const c = this.cellEl(r, startCol + j, options.inheritStyle);
        while (c.firstChild) c.removeChild(c.firstChild);
        c.removeAttribute("t");
        if (typeof value === "number") {
          const v = this.doc.createElementNS(MAIN, qualified(this.root, "v"));
          v.appendChild(this.doc.createTextNode(String(value)));
          c.appendChild(v as unknown as El);
        } else if (typeof value === "boolean") {
          c.setAttribute("t", "b");
          const v = this.doc.createElementNS(MAIN, qualified(this.root, "v"));
          v.appendChild(this.doc.createTextNode(value ? "1" : "0"));
          c.appendChild(v as unknown as El);
        } else if (value !== "") {
          c.setAttribute("t", "inlineStr");
          const is = this.doc.createElementNS(MAIN, qualified(this.root, "is"));
          const t = this.doc.createElementNS(MAIN, qualified(this.root, "t"));
          if (value.trim() !== value) t.setAttribute("xml:space", "preserve");
          t.appendChild(this.doc.createTextNode(value));
          is.appendChild(t);
          c.appendChild(is as unknown as El);
        }
        written++;
      });
      this.rows.get(r)?.el.removeAttribute("spans");
    });
    this.updateDimension();
    this.touched();
    return written;
  }

  private updateDimension(): void {
    const dim = child(this.root, "dimension");
    if (!dim) return;
    const lastRow = this.lastRow();
    const lastCol = this.lastCol();
    if (lastRow === 0 || lastCol === 0) return;
    dim.setAttribute(
      "ref",
      formatXlsxRange({ startCol: 1, startRow: 1, endCol: lastCol, endRow: lastRow }),
    );
  }
}

/** The relationship namespace of a package part, for tests that build workbooks. */
export const XLSX_NAMESPACES = { MAIN, DOC_REL, PKG_REL } as const;
