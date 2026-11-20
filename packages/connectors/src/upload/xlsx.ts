// A small .xlsx reader and writer for Read table and Write table (docs/plan.md §1.164), on
// `fflate` (the desktop app's zip library) and a few lines of XML scanning: Workers have no
// DOMParser, and a spreadsheet library would be far more than one sheet of values needs.
// DECISION (§1.164 "XLSX in the Worker"): not the npm `xlsx` package (stale, open advisories) nor
// `exceljs` (Node streams).
//
// Reading: one worksheet at a time; shared and inline strings, numbers, booleans and error values;
// a number whose cell format shows a date or time is a date (ISO 8601, the 1900 or 1904 system as
// the workbook says); a formula is read as its cached value (we never calculate). Writing: one
// worksheet, a bold header row kept in view, text as inline strings (never run as a formula),
// numbers and amounts as numbers, dates as real dates in the column's style, true and false.

import { processes, type XlsxCell, xlsxColumnLetters } from "@countersign/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export class XlsxError extends Error {
  override name = "XlsxError";
}

/** One part, unpacked, may be at most this large (a zip bomb is refused, not unpacked). */
const MAX_PART_BYTES = 64 * 1024 * 1024;
/** A worksheet with values past this row is refused rather than read into memory. */
export const XLSX_MAX_SHEET_ROWS = 100_000;
/** The last column a worksheet has (XFD). */
const MAX_COLUMN = 16_384;

// ── XML, scanned ──────────────────────────────────────────────────────────────────────────────

type XmlEvent =
  | { kind: "open"; name: string; attrs: Record<string, string>; empty: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML's entities and Excel's own `_x000D_` escapes, decoded. */
function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITY[e] ?? m;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
}

/** An element's local name (`x:row` → `row`). */
const local = (name: string) => name.slice(name.indexOf(":") + 1);

function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1] as string] = decode(m[2] ?? m[3] ?? "");
  }
  return out;
}

/** The elements and text of an XML part, in order; comments, declarations and CDATA handled. */
function* scan(xml: string): Generator<XmlEvent> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      yield { kind: "text", text: decode(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { kind: "text", text: decode(xml.slice(i, lt)) };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      yield { kind: "text", text: xml.slice(lt + 9, end < 0 ? xml.length : end) };
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) throw new XlsxError("the workbook has a part that isn't valid XML");
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    if (tag.startsWith("/")) {
      yield { kind: "close", name: local(tag.slice(1).trim()) };
      continue;
    }
    const empty = tag.endsWith("/");
    const body = empty ? tag.slice(0, -1) : tag;
    const space = body.search(/\s/);
    const name = local(space < 0 ? body : body.slice(0, space));
    yield { kind: "open", name, attrs: space < 0 ? {} : attrsOf(body.slice(space)), empty };
    if (empty) yield { kind: "close", name };
  }
}

/** The text of each `<si>` (shared strings) or of one `<is>`: its runs, without phonetic hints. */
function richTexts(xml: string, item: "si" | "is"): string[] {
  const out: string[] = [];
  let inItem = false;
  let inT = false;
  let inPhonetic = 0;
  let text = "";
  for (const e of scan(xml)) {
    if (e.kind === "open") {
      if (e.name === item) {
        inItem = true;
        text = "";
      } else if (e.name === "rPh") inPhonetic++;
      else if (e.name === "t" && inItem && inPhonetic === 0) inT = true;
    } else if (e.kind === "close") {
      if (e.name === item && inItem) {
        out.push(text);
        inItem = false;
      } else if (e.name === "rPh") inPhonetic--;
      else if (e.name === "t") inT = false;
    } else if (inT) {
      text += e.text;
    }
  }
  return out;
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────

const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a number format shows a date or time (`d`, `m`, `y`, `h`, `s` outside quotes). */
export function isDateFormat(code: string): boolean {
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "\\" || c === "_" || c === "*") i++;
    else if (c === "[") {
      // [Red], [$-409] and conditions aren't dates; [h] and [mm] are elapsed time.
      const end = code.indexOf("]", i);
      const inner = code.slice(i + 1, end < 0 ? code.length : end).toLowerCase();
      if (/^(h+|m+|s+)$/.test(inner)) return true;
      i = end < 0 ? code.length : end;
    } else if (c !== undefined && "dmyhsDMYHS".includes(c)) return true;
  }
  return false;
}

/** "B12" → [12, 2]; null when it isn't a cell reference. */
function cellRef(ref: string): [number, number] | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), col];
}

export interface XlsxSheetRead {
  /** Every worksheet, in the workbook's order (hidden ones too). */
  sheets: string[];
  /** The worksheet read. */
  sheet: string;
  /** Its values: `grid[0]` is row 1, `grid[r][0]` column A; empty cells are null. */
  grid: XlsxCell[][];
}

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new XlsxError("the workbook is password-protected or in the old .xls format");
  }
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        if (f.originalSize > MAX_PART_BYTES) {
          throw new XlsxError("the workbook is too large to open");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("the file isn't a workbook we can read");
  }
}

const part = (files: Record<string, Uint8Array>, name: string) => {
  const b = files[name];
  return b ? strFromU8(b) : null;
};

/** A relationship's target as a part name (`worksheets/sheet1.xml` → `xl/worksheets/sheet1.xml`). */
function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ["xl"];
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * One worksheet's values: by name (any case), else the first visible one. Throws XlsxError for a
 * file that isn't a readable .xlsx or a sheet it doesn't have.
 */
export function readXlsx(
  bytes: Uint8Array,
  options: { sheet?: string | null } = {},
): XlsxSheetRead {
  const meta = unzip(
    bytes,
    (n) =>
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      n === "xl/styles.xml" ||
      n === "xl/sharedStrings.xml",
  );
  const workbook = part(meta, "xl/workbook.xml");
  const rels = part(meta, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new XlsxError("the file isn't a workbook we can read");

  const targets = new Map<string, { target: string; type: string }>();
  for (const e of scan(rels)) {
    if (e.kind === "open" && e.name === "Relationship") {
      targets.set(e.attrs.Id ?? "", { target: e.attrs.Target ?? "", type: e.attrs.Type ?? "" });
    }
  }
  const sheets: { name: string; part: string; hidden: boolean }[] = [];
  let date1904 = false;
  for (const e of scan(workbook)) {
    if (e.kind !== "open") continue;
    if (e.name === "workbookPr") date1904 = e.attrs.date1904 === "1" || e.attrs.date1904 === "true";
    if (e.name !== "sheet") continue;
    const id = e.attrs["r:id"] ?? Object.entries(e.attrs).find(([k]) => k.endsWith(":id"))?.[1];
    const rel = id ? targets.get(id) : undefined;
    // Chart sheets and dialog sheets have no cells: not offered.
    if (!rel?.type.endsWith("/worksheet")) continue;
    sheets.push({
      name: e.attrs.name ?? "",
      part: resolveTarget(rel.target),
      hidden: (e.attrs.state ?? "visible") !== "visible",
    });
  }
  const wanted = options.sheet?.trim();
  const entry = wanted
    ? sheets.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
    : (sheets.find((s) => !s.hidden) ?? sheets[0]);
  if (!entry) {
    throw new XlsxError(
      wanted
        ? `the workbook has no sheet called ${wanted} (it has ${sheets.map((s) => s.name).join(", ") || "none"})`
        : "the workbook has no worksheets",
    );
  }

  const shared = richTexts(part(meta, "xl/sharedStrings.xml") ?? "", "si");
  const dateStyles = dateStylesOf(part(meta, "xl/styles.xml"));
  const sheetXml = part(
    unzip(bytes, (n) => n === entry.part),
    entry.part,
  );
  if (sheetXml === null) throw new XlsxError(`the workbook's sheet ${entry.name} is missing`);
  return {
    sheets: sheets.map((s) => s.name),
    sheet: entry.name,
    grid: sheetGrid(sheetXml, shared, dateStyles, date1904),
  };
}

/** The cell formats (`s`, an index into cellXfs) that show a date or time. */
function dateStylesOf(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  let inXfs = false;
  let xf = 0;
  for (const e of scan(xml)) {
    if (e.kind === "open" && e.name === "numFmt") {
      custom.set(Number(e.attrs.numFmtId), e.attrs.formatCode ?? "");
    } else if (e.kind === "open" && e.name === "cellXfs") {
      inXfs = true;
    } else if (e.kind === "close" && e.name === "cellXfs") {
      inXfs = false;
    } else if (e.kind === "open" && e.name === "xf" && inXfs) {
      const id = Number(e.attrs.numFmtId ?? "0");
      const code = custom.get(id);
      if (BUILT_IN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code))) out.add(xf);
      xf++;
    }
  }
  return out;
}

/** An Excel serial date as ISO 8601: a date, or a date and time when it has a fraction. */
function serialToIso(serial: number, date1904: boolean): string {
  if (!date1904 && Number.isInteger(serial)) return processes.excelSerialToIso(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + Math.round(serial * 86_400_000)).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19);
}

function sheetGrid(
  xml: string,
  shared: readonly string[],
  dateStyles: ReadonlySet<number>,
  date1904: boolean,
): XlsxCell[][] {
  const grid: XlsxCell[][] = [];
  let rowNumber = 0;
  let col = 0;
  let cell: { t: string; s: number; v: string | null; inline: string | null } | null = null;
  let into: "v" | "t" | null = null;
  let inPhonetic = 0;
  for (const e of scan(xml)) {
    if (e.kind === "open") {
      switch (e.name) {
        case "row": {
          const r = Number(e.attrs.r);
          rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
          col = 0;
          break;
        }
        case "c": {
          const at = cellRef(e.attrs.r ?? "");
          col = at ? at[1] : col + 1;
          cell = { t: e.attrs.t ?? "n", s: Number(e.attrs.s ?? "0"), v: null, inline: null };
          break;
        }
        case "v":
          if (cell) {
            into = "v";
            cell.v = "";
          }
          break;
        case "rPh":
          inPhonetic++;
          break;
        case "t":
          if (cell && inPhonetic === 0) {
            into = "t";
            cell.inline ??= "";
          }
          break;
      }
    } else if (e.kind === "close") {
      if (e.name === "v" || e.name === "t") into = null;
      else if (e.name === "rPh") inPhonetic--;
      else if (e.name === "c" && cell) {
        const value = cellValue(cell, shared, dateStyles, date1904);
        if (value !== null) {
          if (rowNumber > XLSX_MAX_SHEET_ROWS) {
            throw new XlsxError(
              `the sheet has values past row ${XLSX_MAX_SHEET_ROWS.toLocaleString("en-US")}; we read at most that many`,
            );
          }
          if (col >= 1 && col <= MAX_COLUMN) {
            while (grid.length < rowNumber) grid.push([]);
            const row = grid[rowNumber - 1] as XlsxCell[];
            while (row.length < col - 1) row.push(null);
            row[col - 1] = value;
          }
        }
        cell = null;
      }
    } else if (cell && into === "v") {
      cell.v += e.text;
    } else if (cell && into === "t") {
      cell.inline += e.text;
    }
  }
  return grid;
}

function cellValue(
  cell: { t: string; s: number; v: string | null; inline: string | null },
  shared: readonly string[],
  dateStyles: ReadonlySet<number>,
  date1904: boolean,
): XlsxCell {
  switch (cell.t) {
    case "inlineStr":
      return cell.inline ?? "";
    case "s":
      return cell.v === null ? null : (shared[Number(cell.v)] ?? "");
    case "b":
      return cell.v === null ? null : cell.v === "1" || cell.v === "true";
    // A formula's text result, an error (#N/A) and an ISO date are read as their text.
    case "str":
    case "e":
      return cell.v;
    case "d":
      return cell.v === null ? null : cell.v.slice(0, cell.v.includes("T00:00:00") ? 10 : 19);
    default: {
      // A formula with no cached value (never calculated) reads as empty.
      if (cell.v === null || cell.v.trim() === "") return null;
      const n = Number(cell.v);
      if (!Number.isFinite(n)) return cell.v;
      return dateStyles.has(cell.s) ? serialToIso(n, date1904) : n;
    }
  }
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Text as XML: escaped, without the control characters XML can't hold. */
function esc(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 refuses these characters.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

/** A worksheet name Excel takes: at most 31 characters, none of []:*?/\. */
export function xlsxSheetName(name: string | null | undefined): string {
  const clean = (name ?? "")
    .replace(/[[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, "");
  return clean || "Sheet1";
}

// cellXfs: 0 plain, 1 header (bold), 2 amount, 3-5 dates by style.
const STYLE = { plain: 0, header: 1, money: 2, iso: 3, mdy: 4, dmy: 5 } as const;

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="mm/dd/yyyy"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function inlineCell(ref: string, text: string, style: number): string {
  const s = style === STYLE.plain ? "" : ` s="${style}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function cellXml(ref: string, cell: processes.WriteCell): string {
  if (cell === null) return "";
  switch (cell.kind) {
    case "text":
      return inlineCell(ref, cell.value, STYLE.plain);
    case "number":
      return Number.isFinite(cell.value) ? `<c r="${ref}"><v>${cell.value}</v></c>` : "";
    // DECISION: an amount is written as a number cell from its decimal text, never through a
    // float (invariant 6), formatted #,##0.00.
    case "money":
      return `<c r="${ref}" s="${STYLE.money}"><v>${esc(cell.value)}</v></c>`;
    case "date":
      return `<c r="${ref}" s="${STYLE[cell.style]}"><v>${processes.isoToExcelSerial(cell.value)}</v></c>`;
    case "boolean":
      return `<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
  }
}

/** One worksheet as an .xlsx file: the header row, then each row, in the grid's order. */
export function writeXlsx(
  grid: processes.WriteGrid,
  options: { sheet?: string | null } = {},
): Uint8Array {
  const width = Math.max(1, grid.headers.length);
  const last = `${xlsxColumnLetters(width)}${grid.rows.length + 1}`;
  const rows: string[] = [];
  rows.push(
    `<row r="1">${grid.headers
      .map((h, i) => inlineCell(`${xlsxColumnLetters(i + 1)}1`, h, STYLE.header))
      .join("")}</row>`,
  );
  grid.rows.forEach((cells, i) => {
    const r = i + 2;
    rows.push(
      `<row r="${r}">${cells.map((c, j) => cellXml(`${xlsxColumnLetters(j + 1)}${r}`, c)).join("")}</row>`,
    );
  });
  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const name = xlsxSheetName(options.sheet);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(STYLES_XML),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  // A fixed time in the zip's entries, so the same rows make the same bytes (one document).
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
