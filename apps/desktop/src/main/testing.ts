// Small workbooks for tests, built as Excel writes them: shared strings, a date format, a formula,
// a hidden sheet, and a chart part we never read (it must come back byte for byte).
import { strToU8, zipSync } from "fflate";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const CHART_BYTES = strToU8('<?xml version="1.0"?><c:chartSpace>untouched</c:chartSpace>');

export function costsWorkbook(options: { macros?: boolean } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr/><sheets><sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/><sheet name="Costs" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${T}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${T}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${T}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${T}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId5" Type="${T}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${MAIN}" count="5" uniqueCount="5"><si><t>Date</t></si><si><t>Vendor</t></si><si><t>Amount</t></si><si><r><t>Northside </t></r><r><t>Lumber</t></r></si><si><t>Hardwood Supply</t></si></sst>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    ),
    // Row 1 heads; rows 2–3 data (A dates, C currency); C4 a total by formula.
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:C4"/><sheetData><row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2" spans="1:3"><c r="A2" s="1"><v>46296</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" s="2"><v>412.5</v></c></row><row r="3" spans="1:3"><c r="A3" s="1"><v>46298</v></c><c r="B3" t="s"><v>4</v></c><c r="C3" s="2"><v>129.95</v></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>Total</t></is></c><c r="C4" s="2"><f>SUM(C2:C3)</f><v>542.45</v></c></row></sheetData><drawing r:id="rId9"/></worksheet>`,
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN}"><sheetData><row><c t="b"><v>1</v></c><c t="str"><f>"x"&amp;"y"</f><v>xy</v></c></row></sheetData></worksheet>`,
    ),
    "xl/worksheets/sheet3.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN}"><sheetData/></worksheet>`,
    ),
    "xl/charts/chart1.xml": CHART_BYTES,
  };
  if (options.macros) files["xl/vbaProject.bin"] = new Uint8Array([1, 2, 3]);
  return zipSync(files);
}
