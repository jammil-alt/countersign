// Read table and Write table (docs/plan.md §1.164) as tools: a client's .xlsx (a real file in
// fixtures/tables, made by our own writer) read through the documents port with the step's
// parameters, a missing required column failing, and rows written to a new document that names
// its sources.
//
// The fixture is written by Write table's own code; regenerate it after changing the writer:
//   WRITE_TABLE_FIXTURES=1 pnpm --filter @countersign/agents exec vitest run src/tools/tables.unit.test.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XLSX_MIME_TYPE } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  READ_TABLE_SKILL_DEF,
  readTable,
  readTableTool,
  WRITE_TABLE_SKILL_DEF,
  writeTable,
  writeTableTool,
} from "./tables";
import type { DocumentsPort, ToolInvocation } from "./types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/tables/vendor-invoices.xlsx",
);
const DOC = "0190a1b2-0000-7000-8000-0000000000d1";

/** The fixture's rows, as a client's spreadsheet holds them. */
const ROWS = [
  {
    supplier: "Cascade Lumber",
    invoice: "INV-1042",
    amount: "1616.60",
    date: "2026-10-28",
    paid: false,
  },
  {
    supplier: "Northline Panel Supply",
    invoice: "20418",
    amount: "980.10",
    date: "2026-11-02",
    paid: true,
  },
  {
    supplier: "Keystone Hardware",
    invoice: "55102",
    amount: "12.00",
    date: "2026-11-14",
    paid: false,
  },
];
const FIXTURE_PARAMS = {
  format: "xlsx",
  sheet: "Invoices",
  columns: [
    { field: "supplier", headers: ["Supplier"], type: "text" },
    { field: "invoice", headers: ["Invoice #"], type: "text" },
    { field: "amount", headers: ["Amount due"], type: "money" },
    { field: "date", headers: ["Invoice date"], type: "date", dateStyle: "mdy" },
    { field: "paid", headers: ["Paid"], type: "boolean" },
  ],
};

/** The columns an agent reads the file with: its own names for the fields, other headers too. */
const COLUMNS = [
  { field: "vendor", headers: ["Vendor", "Supplier", "Payee"], type: "text", required: true },
  { field: "number", headers: ["Invoice number", "Invoice #"], type: "text", required: true },
  { field: "total", headers: ["Total", "Amount due"], type: "money", required: true },
  { field: "date", headers: ["Invoice date"], type: "date" },
  { field: "paid", headers: ["Paid"], type: "boolean" },
];

if (process.env.WRITE_TABLE_FIXTURES === "1") {
  const made = writeTable(ROWS, FIXTURE_PARAMS, {
    filename: "vendor-invoices",
    today: "2026-11-20",
  });
  writeFileSync(FIXTURE, made.bytes);
}

function ctx(documents: Partial<DocumentsPort>, settings: Record<string, unknown>) {
  return {
    tenantId: "t",
    agentId: "a",
    agentVersionId: "v",
    runId: "r",
    stepRunId: "s",
    stepId: "step",
    mode: "live",
    platform: {} as never,
    documents: documents as DocumentsPort,
    settings,
  } as ToolInvocation;
}

describe("Read table", () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const file = {
    documentId: DOC,
    filename: "vendor-invoices.xlsx",
    mimeType: XLSX_MIME_TYPE,
    bytes,
  };

  it("reads the fixture, written by our own writer, with the agent's columns", async () => {
    const asked: string[] = [];
    const out = await readTableTool.run(
      { documentId: DOC },
      ctx(
        {
          async table(_tenant, id) {
            asked.push(id);
            return file;
          },
        },
        { columns: COLUMNS },
      ),
    );
    expect(asked).toEqual([DOC]);
    expect(out).toEqual({
      columns: [
        { field: "vendor", header: "Supplier", column: "A", type: "text", required: true },
        { field: "number", header: "Invoice #", column: "B", type: "text", required: true },
        { field: "total", header: "Amount due", column: "C", type: "money", required: true },
        { field: "date", header: "Invoice date", column: "D", type: "date", required: false },
        { field: "paid", header: "Paid", column: "E", type: "boolean", required: false },
      ],
      rows: [
        {
          vendor: "Cascade Lumber",
          number: "INV-1042",
          total: "1616.6",
          date: "2026-10-28",
          paid: false,
        },
        {
          vendor: "Northline Panel Supply",
          number: "20418",
          total: "980.1",
          date: "2026-11-02",
          paid: true,
        },
        {
          vendor: "Keystone Hardware",
          number: "55102",
          total: "12",
          date: "2026-11-14",
          paid: false,
        },
      ],
      rowCount: 3,
      sheet: "Invoices",
      problems: [],
      sources: [DOC],
    });
  });

  it("fails naming a required column the file doesn't have", () => {
    const columns = [...COLUMNS, { field: "po", headers: ["PO"], type: "text", required: true }];
    expect(() => readTable(file, { columns })).toThrow(
      "vendor-invoices.xlsx: the file has no column for po",
    );
    expect(() => readTable(file, { columns, sheet: "Other" })).toThrow(
      "vendor-invoices.xlsx: the workbook has no sheet called Other (it has Invoices)",
    );
  });

  it("is a built-in code skill whose parameters have defaults", () => {
    expect(READ_TABLE_SKILL_DEF.handler).toBe(readTableTool.spec.id);
    expect(READ_TABLE_SKILL_DEF.mode).toBe("tool");
    expect(READ_TABLE_SKILL_DEF.parameters?.every((p) => p.default !== undefined)).toBe(true);
    expect(readTableTool.pure).toBeUndefined();
    expect(readTableTool.spec.sideEffect).toBe("none");
  });
});

describe("Write table", () => {
  it("makes a new document naming its sources; internal, no approval", async () => {
    const stored: unknown[] = [];
    const out = await writeTableTool.run(
      { rows: ROWS, sources: [DOC], filename: "Invoices: November" },
      ctx(
        {
          async storeTable(_tenant, input) {
            stored.push(input);
            return { documentId: "0190a1b2-0000-7000-8000-0000000000d2", created: true };
          },
        },
        FIXTURE_PARAMS,
      ),
    );
    expect(out).toMatchObject({
      documentId: "0190a1b2-0000-7000-8000-0000000000d2",
      filename: "Invoices- November.xlsx",
      mimeType: XLSX_MIME_TYPE,
      rowCount: 3,
      created: true,
      sources: ["0190a1b2-0000-7000-8000-0000000000d2", DOC],
    });
    expect(stored[0]).toMatchObject({ sources: [DOC], testRun: false, runId: "r" });
    expect(writeTableTool.spec.sideEffect).toBe("internal");
    expect(WRITE_TABLE_SKILL_DEF.handler).toBe(writeTableTool.spec.id);
  });

  it("writes the same bytes as the fixture holds", () => {
    const made = writeTable(ROWS, FIXTURE_PARAMS, { today: "2026-11-20" });
    expect(made.bytes).toEqual(new Uint8Array(readFileSync(FIXTURE)));
    expect(made.filename).toBe("table-2026-11-20.xlsx");
  });

  it("refuses a file type it doesn't write", () => {
    expect(() => writeTable(ROWS, { format: "pdf" }, { today: "2026-11-20" })).toThrow(
      "Write table's file type is csv or xlsx, not pdf",
    );
  });
});
