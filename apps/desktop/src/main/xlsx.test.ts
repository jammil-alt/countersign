import { parseXlsxRange } from "@countersign/core";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { CHART_BYTES, costsWorkbook } from "./testing";
import { isDateFormatCode, serialToIso, Workbook, XlsxProblem } from "./xlsx";

const range = (s: string) => {
  const r = parseXlsxRange(s);
  if (!r) throw new Error(s);
  return r;
};

describe("reading a workbook", () => {
  it("lists sheets and opens the first visible one by default", () => {
    const wb = Workbook.open(costsWorkbook());
    expect(wb.sheetNames()).toEqual(["Hidden", "Costs", "Notes"]);
    expect(wb.sheet().name).toBe("Costs");
    expect(wb.sheet("notes").name).toBe("Notes");
    expect(() => wb.sheet("Nope")).toThrow(/no worksheet called Nope/);
  });

  it("reads shared, rich and inline text, dates, numbers and formulas", () => {
    const sheet = Workbook.open(costsWorkbook()).sheet("Costs");
    expect(sheet.lastRow()).toBe(4);
    expect(sheet.lastCol()).toBe(3);
    expect(sheet.read(range("A1:C"), "values", 100).values).toEqual([
      ["Date", "Vendor", "Amount"],
      ["2026-10-01", "Northside Lumber", 412.5],
      ["2026-10-03", "Hardwood Supply", 129.95],
      [null, "Total", 542.45],
    ]);
    expect(sheet.read(range("A2:C4"), "formula", 100).values).toEqual([
      [46296, "Northside Lumber", 412.5],
      [46298, "Hardwood Supply", 129.95],
      [null, "Total", "=SUM(C2:C3)"],
    ]);
    expect(sheet.formulaIn(4, 3, 1, 1)).toBe(true);
    expect(sheet.formulaIn(2, 1, 2, 3)).toBe(false);
  });

  it("reads cells without references, booleans and formula text", () => {
    const sheet = Workbook.open(costsWorkbook()).sheet("Notes");
    expect(sheet.read(range("A1:B1"), "values", 10).values).toEqual([[true, "xy"]]);
  });

  it("stops at the last row with data and says when it cut rows", () => {
    const sheet = Workbook.open(costsWorkbook()).sheet("Costs");
    const r = sheet.read(range("A1:C1000"), "values", 2);
    expect(r).toMatchObject({ range: "A1:C2", truncated: true });
    expect(r.values).toHaveLength(2);
  });

  it("refuses macros, old or locked files and things that aren't workbooks", () => {
    expect(() => Workbook.open(costsWorkbook({ macros: true }))).toThrow(/macros/);
    expect(() => Workbook.open(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]))).toThrow(
      /password-protected/,
    );
    const notZip = () => Workbook.open(new Uint8Array([1, 2, 3, 4]));
    expect(notZip).toThrow(XlsxProblem);
    expect(notZip).toThrow(/isn't a workbook/);
  });
});

describe("writing a workbook", () => {
  it("adds rows that take the formats above, and keeps everything else as it was", () => {
    const wb = Workbook.open(costsWorkbook());
    const sheet = wb.sheet("Costs");
    const n = sheet.write(5, 1, [[46300, '=HYPERLINK("x")', 99, true]], { inheritStyle: true });
    expect(n).toBe(4);
    const saved = wb.save();
    const again = Workbook.open(saved).sheet("Costs");
    expect(again.read(range("A5:D5"), "values", 10).values).toEqual([
      // A5 has no cell above it (row 4's A is empty): a plain number, no date format.
      [46300, '=HYPERLINK("x")', 99, true],
    ]);
    // Text that looks like a formula stays text: no formula in the cell.
    expect(again.formulaIn(5, 2, 1, 1)).toBe(false);
    // C5 took C4's currency format.
    const parts = unzipSync(saved);
    const xml = strFromU8(parts["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(xml).toContain('<c r="C5" s="2"><v>99</v></c>');
    expect(xml).toContain('<c r="B5" t="inlineStr"><is><t>=HYPERLINK("x")</t></is></c>');
    expect(xml).toContain('<dimension ref="A1:D5"/>');
    expect(xml.startsWith("<?xml")).toBe(true);
    // The chart, styles and shared strings are the very same bytes.
    expect(parts["xl/charts/chart1.xml"]).toEqual(CHART_BYTES);
    expect(parts["xl/sharedStrings.xml"]).toEqual(
      unzipSync(costsWorkbook())["xl/sharedStrings.xml"],
    );
    // The workbook recalculates when next opened.
    expect(strFromU8(parts["xl/workbook.xml"] ?? new Uint8Array())).toContain('fullCalcOnLoad="1"');
  });

  it("changes cells in place, keeps a cell given null, and empties one given text ''", () => {
    const wb = Workbook.open(costsWorkbook());
    wb.sheet("Costs").write(
      2,
      2,
      [
        ["Northside Lumber Co", null],
        ["", 130],
      ],
      {
        inheritStyle: false,
      },
    );
    const sheet = Workbook.open(wb.save()).sheet("Costs");
    expect(sheet.read(range("B2:C3"), "values", 10).values).toEqual([
      ["Northside Lumber Co", 412.5],
      [null, 130],
    ]);
    // C3 kept its currency format.
    expect(sheet.read(range("A3:A3"), "values", 1).values).toEqual([["2026-10-03"]]);
  });

  it("writes rows below gaps in the right order", () => {
    const wb = Workbook.open(costsWorkbook());
    wb.sheet("Costs").write(9, 2, [["later"]], { inheritStyle: true });
    wb.sheet("Costs").write(7, 1, [["sooner"]], { inheritStyle: true });
    const xml = strFromU8(unzipSync(wb.save())["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(xml.indexOf('r="7"')).toBeLessThan(xml.indexOf('r="9"'));
  });

  it("saves an untouched workbook without changing its parts", () => {
    const original = unzipSync(costsWorkbook());
    const saved = unzipSync(Workbook.open(costsWorkbook()).save());
    expect(Object.keys(saved)).toEqual(Object.keys(original));
    for (const [name, bytes] of Object.entries(original)) expect(saved[name]).toEqual(bytes);
  });
});

describe("dates", () => {
  it("knows date formats from currency and text", () => {
    expect(isDateFormatCode("yyyy-mm-dd")).toBe(true);
    expect(isDateFormatCode("[h]:mm")).toBe(true);
    expect(isDateFormatCode('"$"#,##0.00')).toBe(false);
    expect(isDateFormatCode("[Red]0.00")).toBe(false);
    expect(isDateFormatCode('0.0" days"')).toBe(false);
  });

  it("turns serials into dates, in both date systems", () => {
    expect(serialToIso(46296, false)).toBe("2026-10-01");
    expect(serialToIso(46296.5, false)).toBe("2026-10-01T12:00:00");
    expect(serialToIso(0, true)).toBe("1904-01-01");
  });
});
