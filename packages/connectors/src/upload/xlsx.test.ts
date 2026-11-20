// The .xlsx reader and writer (docs/plan.md §1.164). The reader is tested against a workbook made
// here by hand from raw XML (as Excel writes it: shared strings with runs and phonetic hints,
// inline strings, booleans, errors, date formats built in and custom, cached formula values, the
// 1904 date system, a hidden sheet), so it isn't only tested against our own writer; then the
// writer's files are read back.
import type { processes } from "@countersign/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isDateFormat, readXlsx, writeXlsx, XlsxError, xlsxSheetName } from "./xlsx";

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook as Excel lays one out, with a hidden first sheet and a second, visible one. */
function handMade(options: { date1904?: boolean } = {}): Uint8Array {
  const sheet2 = `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:F6"/><sheetData>
<row r="1" spans="1:6"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="inlineStr"><is><t>Note</t></is></c><c r="F1" t="s"><v>4</v></c></row>
<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" s="2"><v>1250.5</v></c><c r="C2" s="1"><v>46328</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="inlineStr"><is><r><t xml:space="preserve">rush </t></r><r><rPr><b/></rPr><t>&amp; fragile</t></r></is></c><c r="F2" s="3"><f>B2*2</f><v>2501</v></c></row>
<row r="3"><c r="A3" t="str"><f>"North"&amp;"line"</f><v>Northline</v></c><c r="B3"><v>980.1</v></c><c r="C3" s="4"><v>46340.5</v></c><c r="D3" t="b"><v>0</v></c><c r="F3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
<row r="5"><c r="A5" t="s"><v>6</v></c><c r="C5"><f>TODAY()</f></c><c r="D5" s="1"/></row>
<row r="6" customHeight="1" ht="20"/>
</sheetData></worksheet>`;
  const shared = `${HEAD}<sst xmlns="${MAIN}" count="7" uniqueCount="7"><si><t>Vendor</t></si><si><t>Amount</t></si><si><t>Invoice date</t></si><si><t>Paid?</t></si><si><t>Total</t></si><si><r><t>Cascade</t></r><r><rPr><i/></rPr><t xml:space="preserve"> Lumber</t></r><rPh sb="0" eb="1"><t>カスケード</t></rPh></si><si><t>Kéystone_x000D_</t></si></sst>`;
  const styles = `${HEAD}<styleSheet xmlns="${MAIN}"><numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yyyy;@"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="4"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`${HEAD}<Types/>`),
    "xl/workbook.xml": strToU8(
      `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Notes" sheetId="1" state="hidden" r:id="rId1"/><sheet name="November" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `${HEAD}<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>`,
    ),
    "xl/worksheets/sheet2.xml": strToU8(sheet2),
    "xl/sharedStrings.xml": strToU8(shared),
    "xl/styles.xml": strToU8(styles),
  };
  return zipSync(files);
}

describe("readXlsx", () => {
  it("reads the first visible sheet: strings, numbers, booleans, dates by format, cached formulas", () => {
    const r = readXlsx(handMade());
    expect(r.sheets).toEqual(["Notes", "November"]);
    expect(r.sheet).toBe("November");
    expect(r.grid).toEqual([
      ["Vendor", "Amount", "Invoice date", "Paid?", "Note", "Total"],
      ["Cascade Lumber", 1250.5, "2026-11-02", true, "rush & fragile", 2501],
      ["Northline", 980.1, "2026-11-14T12:00:00", false, null, "#DIV/0!"],
      [],
      // A formula never calculated reads as empty; a styled empty cell has no value.
      ["Kéystone\r"],
    ]);
  });

  it("reads a sheet by name, in any case, and the 1904 date system", () => {
    expect(readXlsx(handMade(), { sheet: "notes" }).grid).toEqual([["hidden"]]);
    const r = readXlsx(handMade({ date1904: true }));
    // 46328 days after 1904-01-01.
    expect(r.grid[1]?.[2]).toBe("2030-11-03");
  });

  it("refuses what isn't a workbook, and a sheet it doesn't have", () => {
    expect(() => readXlsx(strToU8("not a zip"))).toThrow(XlsxError);
    expect(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toThrow(/old .xls/);
    expect(() => readXlsx(zipSync({ "a.txt": strToU8("x") }))).toThrow(/isn't a workbook/);
    expect(() => readXlsx(handMade(), { sheet: "December" })).toThrow(
      "the workbook has no sheet called December (it has Notes, November)",
    );
  });

  it("knows date formats from number formats", () => {
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("[$-409]d\\-mmm\\-yyyy;@")).toBe(true);
    expect(isDateFormat('"$"#,##0.00')).toBe(false);
    expect(isDateFormat("[Red]#,##0;[Blue]-#,##0")).toBe(false);
    expect(isDateFormat("[h]:mm")).toBe(true);
  });
});

describe("writeXlsx", () => {
  const grid: processes.WriteGrid = {
    headers: ["Vendor", "Amount", "Date", "Paid", "Count"],
    rows: [
      [
        { kind: "text", value: '=HYPERLINK("x") & <Co>' },
        { kind: "money", value: "1250.50" },
        { kind: "date", value: "2026-11-02", style: "mdy" },
        { kind: "boolean", value: true },
        { kind: "number", value: 3 },
      ],
      [
        { kind: "text", value: "Kéystone" },
        null,
        { kind: "date", value: "2026-11-20", style: "iso" },
        null,
        null,
      ],
    ],
  };

  it("writes a workbook our reader and Excel's layout agree on", () => {
    const bytes = writeXlsx(grid, { sheet: "Out: [Nov]" });
    const r = readXlsx(bytes);
    expect(r.sheet).toBe("Out   Nov");
    expect(r.grid).toEqual([
      ["Vendor", "Amount", "Date", "Paid", "Count"],
      ['=HYPERLINK("x") & <Co>', 1250.5, "2026-11-02", true, 3],
      ["Kéystone", null, "2026-11-20"],
    ]);
    const parts = unzipSync(bytes);
    const sheet = strFromU8(parts["xl/worksheets/sheet1.xml"] as Uint8Array);
    // Text is an inline string, never a formula; an amount is its decimal text.
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("<v>1250.50</v>");
    expect(Object.keys(parts).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("makes the same bytes for the same rows", () => {
    expect(writeXlsx(grid)).toEqual(writeXlsx(grid));
  });

  it("names sheets as Excel allows", () => {
    expect(xlsxSheetName("")).toBe("Sheet1");
    expect(xlsxSheetName("a".repeat(40))).toHaveLength(31);
  });
});
