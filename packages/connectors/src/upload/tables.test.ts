// Table files in and out (docs/plan.md §1.164): CSV, JSON and XLSX read by Read table's options,
// the limits, and rows written as .csv and .xlsx then read back the same.
import {
  bytesMatchType,
  CSV_MIME_TYPE,
  isExtractable,
  JSON_MIME_TYPE,
  processes,
  type TableColumnInput,
  TableColumns,
  tableFiles,
  XLSX_MIME_TYPE,
} from "@countersign/core";
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { documentMimeType, isDocumentType } from "./forwarding";
import { readTableFile, TableFileError, writeTableFile } from "./tables";

const COLUMNS: TableColumnInput[] = [
  { field: "vendor", headers: ["Vendor", "Payee"], type: "text", required: true },
  { field: "amount", headers: ["Amount"], type: "money", required: true },
  { field: "invoiceDate", headers: ["Date"], type: "date", dateStyle: "dmy" },
  { field: "paid", headers: ["Paid"], type: "boolean" },
  { field: "qty", headers: ["Qty"], type: "number" },
];

function options(params: Record<string, unknown> = {}) {
  const r = tableFiles.readTableOptions({ columns: COLUMNS, ...params });
  if (!r.ok) throw new Error(r.error);
  return r.options;
}

const CSV = [
  "\ufeffPayee,Amount,Date,Paid,Qty",
  '"Cascade, Lumber","1,250.50",02/11/2026,yes,3',
  "",
  'Keystone "K",12.00,20/11/2026,no,',
  "Total,1262.50,,,",
].join("\r\n");

describe("readTableFile", () => {
  it("reads a CSV, its rows numbered as the file's lines", () => {
    const r = readTableFile(
      { bytes: strToU8(CSV), mimeType: "text/plain", filename: "november.csv" },
      options(),
    );
    expect(r.kind).toBe("csv");
    expect(r.read.failure).toBeNull();
    expect(r.read.rows).toEqual([
      {
        vendor: "Cascade, Lumber",
        amount: "1250.50",
        invoiceDate: "2026-11-02",
        paid: true,
        qty: 3,
      },
      { vendor: 'Keystone "K"', amount: "12.00", invoiceDate: "2026-11-20", paid: false },
    ]);
    // Header on row 1, data from row 2: skipping one row skips Cascade (line 2).
    const skipped = readTableFile(
      { bytes: strToU8(CSV), mimeType: CSV_MIME_TYPE, filename: "november.csv" },
      options({ skip_rows: 1 }),
    );
    expect(skipped.read.rows.map((x) => x.vendor)).toEqual(['Keystone "K"']);
  });

  it("reads a JSON file", () => {
    const json = JSON.stringify([{ Vendor: "Cascade", Amount: 10, Paid: true }]);
    const r = readTableFile(
      { bytes: strToU8(json), mimeType: JSON_MIME_TYPE, filename: "rows.json" },
      options(),
    );
    expect(r.kind).toBe("json");
    expect(r.read.rows).toEqual([{ vendor: "Cascade", amount: "10", paid: true }]);
    expect(() =>
      readTableFile({ bytes: strToU8("{nope"), mimeType: "", filename: "rows.json" }, options()),
    ).toThrow("rows.json isn't JSON we can read");
  });

  it("refuses a file over 5 MB and a file that isn't a table", () => {
    const big = new Uint8Array(processes.TABLE_MAX_BYTES + 1);
    expect(() =>
      readTableFile({ bytes: big, mimeType: CSV_MIME_TYPE, filename: "big.csv" }, options()),
    ).toThrow("big.csv is over 5 MB; we read files of at most 5 MB");
    expect(() =>
      readTableFile(
        { bytes: strToU8("%PDF-1.7"), mimeType: "application/pdf", filename: "a.pdf" },
        options(),
      ),
    ).toThrow(TableFileError);
  });

  it("fails a file with more than 10,000 rows", () => {
    const lines = ["Vendor,Amount"];
    for (let i = 0; i <= processes.TABLE_MAX_ROWS; i++) lines.push(`V${i},${i}`);
    const r = readTableFile(
      { bytes: strToU8(lines.join("\n")), mimeType: CSV_MIME_TYPE, filename: "many.csv" },
      options(),
    );
    expect(r.read.failure).toBe(
      "the file has more than 10,000 rows of data; we read at most 10,000",
    );
  });
});

describe("writeTableFile", () => {
  const rows = [
    { vendor: "=SUM(A1)", amount: "1250.50", invoiceDate: "2026-11-02", paid: true, qty: 3 },
    { vendor: "Kéystone, Inc.", amount: "12.00", invoiceDate: "2026-11-20" },
  ];
  const columns = TableColumns.parse(COLUMNS);

  it("writes a CSV a spreadsheet opens safely, and reads it back the same", () => {
    const out = writeTableFile(rows, columns, "csv");
    expect(out.mimeType).toBe(CSV_MIME_TYPE);
    const text = strFromU8(out.bytes);
    expect([...out.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.replace(/^\ufeff/, "").startsWith("Vendor,Amount,Date,Paid,Qty\r\n")).toBe(true);
    expect(parseCsv(text)[1]).toEqual(["'=SUM(A1)", "1250.50", "02/11/2026", "true", "3"]);
    const back = readTableFile(
      { bytes: out.bytes, mimeType: out.mimeType, filename: "out.csv" },
      options(),
    );
    expect(back.read.rows).toEqual([{ ...rows[0], vendor: "'=SUM(A1)" }, rows[1]]);
  });

  it("writes an .xlsx and reads it back the same", () => {
    const out = writeTableFile(rows, columns, "xlsx", { sheet: "November" });
    expect(out.mimeType).toBe(XLSX_MIME_TYPE);
    expect(out.rowCount).toBe(2);
    const back = readTableFile(
      { bytes: out.bytes, mimeType: out.mimeType, filename: "out.xlsx" },
      options(),
    );
    expect(back.sheets).toEqual(["November"]);
    // Amounts come back as numbers' shortest decimals (1250.5); dates as dates.
    expect(back.read.rows).toEqual([
      { ...rows[0], amount: "1250.5" },
      { ...rows[1], amount: "12" },
    ]);
  });

  it("refuses rows that don't fit the columns, and too many rows", () => {
    expect(() => writeTableFile([{ vendor: "A", amount: "lots" }], columns, "csv")).toThrow(
      'row 1: amount: "lots" is not an amount',
    );
    const many = Array.from({ length: processes.TABLE_MAX_ROWS + 1 }, (_, i) => ({
      vendor: `V${i}`,
    }));
    expect(() => writeTableFile(many, [], "xlsx")).toThrow(/more than 10,000 rows/);
  });
});

describe("table files as documents", () => {
  it("are kept, typed by their extension when declared generically, and checked by their bytes", () => {
    expect(documentMimeType("application/octet-stream", "Nov.XLSX")).toBe(XLSX_MIME_TYPE);
    expect(documentMimeType("text/plain", "rows.csv")).toBe(CSV_MIME_TYPE);
    expect(documentMimeType("application/csv", "rows")).toBe(CSV_MIME_TYPE);
    expect(documentMimeType("", "rows.json")).toBe(JSON_MIME_TYPE);
    for (const t of [CSV_MIME_TYPE, XLSX_MIME_TYPE, JSON_MIME_TYPE, "application/pdf"]) {
      expect(isDocumentType(t)).toBe(true);
    }
    expect(isDocumentType("application/zip")).toBe(false);
    const xlsx = writeTableFile([{ a: 1 }], [], "xlsx").bytes;
    expect(bytesMatchType(xlsx, XLSX_MIME_TYPE)).toBe(true);
    expect(bytesMatchType(strToU8("not really a spreadsheet"), XLSX_MIME_TYPE)).toBe(false);
    expect(bytesMatchType(strToU8(' \n[{"a":1}]'), JSON_MIME_TYPE)).toBe(true);
    expect(bytesMatchType(strToU8("a,b"), JSON_MIME_TYPE)).toBe(false);
    expect(bytesMatchType(strToU8("a,b\r\n1,2"), CSV_MIME_TYPE)).toBe(true);
    expect(bytesMatchType(new Uint8Array([0x61, 0, 0x62]), CSV_MIME_TYPE)).toBe(false);
    // Never sent to a model as files.
    expect(isExtractable(XLSX_MIME_TYPE)).toBe(false);
  });
});
