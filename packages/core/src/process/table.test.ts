// Read table and Write table's pure parts (docs/plan.md §1.164): options, cell typing, header
// matching, row skips, limits, JSON files, the output schema the columns give, and rows laid out
// for writing.
import { describe, expect, it } from "vitest";
import type { XlsxCell } from "../desktop/a1";
import type { SkillDefinition } from "../schemas/skill";
import { parameterValueProblem } from "../schemas/skill-model";
import type { TableColumnInput } from "../schemas/table";
import { Process } from "./schema";
import {
  decimalText,
  parseTableDate,
  READ_TABLE_PARAMETERS,
  READ_TABLE_SKILL,
  type ReadTableOptions,
  readTableOptions,
  readTableOutputSchema,
  TABLE_MAX_ROWS,
  tableForWriting,
  tableFromGrid,
  tableFromJson,
  typeCell,
} from "./table";
import { stepOutputSchema } from "./validate";

const COLUMNS: TableColumnInput[] = [
  { field: "vendor", headers: ["Vendor", "Payee", "Supplier"], type: "text", required: true },
  { field: "amount", headers: ["Amount", "Total"], type: "money", required: true },
  { field: "invoiceDate", headers: ["Date", "Invoice date"], type: "date", dateStyle: "mdy" },
  { field: "paid", headers: ["Paid?"], type: "boolean" },
  { field: "qty", headers: ["Quantity", "Qty"], type: "number" },
];

function options(params: Record<string, unknown> = {}): ReadTableOptions {
  const r = readTableOptions({ columns: COLUMNS, ...params });
  if (!r.ok) throw new Error(r.error);
  return r.options;
}

const GRID: XlsxCell[][] = [
  ["Supplier list, November", null, null, null, null],
  [null, null, null, null, null],
  ["Payee", "Total", "Invoice Date", "Paid?", "Notes", "Qty"],
  ["Cascade Lumber", "$1,250.50", "11/02/2026", "yes", "rush", "3"],
  ["Northline Panel", 980.1, "11/14/26", "no", "", 12],
  [null, null, null, null, null],
  ["Keystone", "(12.00)", "20/11/2026", "x", null, null],
  ["Total", "2,218.60", null, null, null, null],
];

describe("cells", () => {
  it("reads dates by the column's style; month names are never ambiguous", () => {
    expect(parseTableDate("2026-11-20")).toBe("2026-11-20");
    expect(parseTableDate("2026-11-20T08:30:00Z")).toBe("2026-11-20");
    expect(parseTableDate("11/02/2026", "mdy")).toBe("2026-11-02");
    expect(parseTableDate("11/02/2026", "dmy")).toBe("2026-02-11");
    expect(parseTableDate("11/02/2026", "iso")).toBeNull();
    expect(parseTableDate("31/02/2026", "dmy")).toBeNull();
    expect(parseTableDate("11/14/26", "mdy")).toBe("2026-11-14");
    expect(parseTableDate("Nov 20, 2026")).toBe("2026-11-20");
    expect(parseTableDate("20-Nov-2026", "mdy")).toBe("2026-11-20");
    // An Excel serial date, as a number cell without a date format gives it.
    expect(parseTableDate(46346)).toBe("2026-11-20");
    expect(parseTableDate("soon")).toBeNull();
  });

  it("reads amounts as decimal text, never through a float", () => {
    expect(decimalText("$1,250.50")).toBe("1250.50");
    expect(decimalText("(12.00)")).toBe("-12.00");
    expect(decimalText("12.00-")).toBe("-12.00");
    expect(decimalText("-.5")).toBe("-0.5");
    expect(decimalText(0.1 + 0.2)).toBe("0.3");
    expect(decimalText("1.234,56")).toBeNull();
    expect(decimalText("twelve")).toBeNull();
    expect(typeCell("1,250", { type: "number" })).toEqual({ ok: true, value: 1250 });
    expect(typeCell("Yes", { type: "boolean" })).toEqual({ ok: true, value: true });
    expect(typeCell("maybe", { type: "boolean" }).ok).toBe(false);
    expect(typeCell(42, { type: "text" })).toEqual({ ok: true, value: "42" });
  });
});

describe("tableFromGrid", () => {
  it("matches headers by the names each column accepts, types the rows and skips blank and total rows", () => {
    const r = tableFromGrid(GRID, options({ header_row: 3 }), "November");
    expect(r.failure).toBeNull();
    expect(r.sheet).toBe("November");
    expect(r.columns).toEqual([
      { field: "vendor", header: "Payee", column: "A", type: "text", required: true },
      { field: "amount", header: "Total", column: "B", type: "money", required: true },
      { field: "invoiceDate", header: "Invoice Date", column: "C", type: "date", required: false },
      { field: "paid", header: "Paid?", column: "D", type: "boolean", required: false },
      { field: "qty", header: "Qty", column: "F", type: "number", required: false },
    ]);
    expect(r.unmatched).toEqual([{ header: "Notes", column: "E" }]);
    expect(r.rows).toEqual([
      {
        vendor: "Cascade Lumber",
        amount: "1250.50",
        invoiceDate: "2026-11-02",
        paid: true,
        qty: 3,
      },
      {
        vendor: "Northline Panel",
        amount: "980.1",
        invoiceDate: "2026-11-14",
        paid: false,
        qty: 12,
      },
      // "20/11/2026" isn't month first: listed, left empty (the column isn't required).
      { vendor: "Keystone", amount: "-12.00", paid: true },
    ]);
    expect(r.problems).toEqual([
      { row: 7, field: "invoiceDate", message: '"20/11/2026" is not a date written month first' },
    ]);
  });

  it("keeps blank and total rows when told to, and skips rows without a named field", () => {
    const kept = tableFromGrid(
      GRID,
      options({ header_row: 3, skip_blank_rows: false, skip_total_rows: false }),
    );
    // The blank row is left out all the same: its required fields are empty.
    expect(kept.rows.map((r) => r.vendor)).toEqual([
      "Cascade Lumber",
      "Northline Panel",
      "Keystone",
      "Total",
    ]);
    expect(kept.problems.some((p) => p.row === 6 && p.message.startsWith("left out"))).toBe(true);
    const r = tableFromGrid(GRID, options({ header_row: 3, skip_if_empty: "qty" }));
    expect(r.rows.map((x) => x.vendor)).toEqual(["Cascade Lumber", "Northline Panel"]);
  });

  it("skips rows after the header, and reads only a range", () => {
    const r = tableFromGrid(GRID, options({ header_row: 3, skip_rows: 1 }));
    expect(r.rows.map((x) => x.vendor)).toEqual(["Northline Panel", "Keystone"]);
    const ranged = tableFromGrid(GRID, options({ range: "A3:D5" }));
    expect(ranged.failure).toBeNull();
    expect(ranged.columns.find((c) => c.field === "qty")?.header).toBeNull();
    expect(ranged.rows).toHaveLength(2);
  });

  it("fails naming a missing required column and the headers it accepts", () => {
    const grid: XlsxCell[][] = [
      ["Vendor", "Memo"],
      ["Cascade", "x"],
    ];
    const r = tableFromGrid(grid, options());
    expect(r.failure).toBe('the file has no column for amount (or "Total")');
    expect(r.columns.find((c) => c.field === "amount")?.header).toBeNull();
  });

  it("drops a row whose required value can't be read, saying why", () => {
    const grid: XlsxCell[][] = [
      ["Vendor", "Amount"],
      ["Cascade", "n/a"],
      ["Keystone", "10"],
    ];
    const r = tableFromGrid(grid, options());
    expect(r.rows).toEqual([{ vendor: "Keystone", amount: "10" }]);
    expect(r.problems).toEqual([
      { row: 2, field: "amount", message: 'left out: "n/a" is not an amount' },
    ]);
  });

  it("with no expected columns reads every header as a field, as it is", () => {
    const r = tableFromGrid(
      [
        ["Vendor name", "Amount", "", "Amount"],
        ["Cascade", 12.5, "x", 3],
      ],
      options({ columns: [] }),
    );
    expect(r.columns.map((c) => c.field)).toEqual(["vendorName", "amount", "amount2"]);
    expect(r.rows).toEqual([{ vendorName: "Cascade", amount: 12.5, amount2: 3 }]);
  });

  it("fails past the most rows, never giving part of the file", () => {
    const grid: XlsxCell[][] = [["Vendor", "Amount"]];
    for (let i = 0; i < 6; i++) grid.push([`V${i}`, i]);
    const r = tableFromGrid(grid, options({ max_rows: 5 }));
    expect(r.failure).toBe("the file has more than 5 rows of data; we read at most 5");
    expect(r.rows).toEqual([]);
    expect(readTableOptions({ max_rows: TABLE_MAX_ROWS + 1 }).ok).toBe(false);
  });

  it("says when the header row isn't in the file", () => {
    expect(tableFromGrid([["a"]], options({ header_row: 4 })).failure).toBe(
      "the file has no row 4 for its headers (it has 1)",
    );
    expect(tableFromGrid([], options()).failure).toBe("the file is empty");
  });
});

describe("tableFromJson", () => {
  const value = {
    exportedAt: "2026-11-20",
    items: [
      { Payee: "Cascade", Total: 1250.5, Date: "11/02/2026" },
      { Payee: "Keystone", Total: "12.00", extra: { nested: true } },
      "not an object",
    ],
  };

  it("reads a top-level list of objects, its keys matched as headers", () => {
    const r = tableFromJson(value, options());
    expect(r.failure).toBeNull();
    expect(r.rows).toEqual([
      { vendor: "Cascade", amount: "1250.5", invoiceDate: "2026-11-02" },
      { vendor: "Keystone", amount: "12.00" },
    ]);
    expect(r.problems).toEqual([{ row: 3, field: null, message: "left out: not an object" }]);
    expect(r.unmatched).toEqual([{ header: "extra", column: "extra" }]);
  });

  it("checks the expected shape first", () => {
    const shape = {
      type: "object",
      properties: { items: { type: "array" }, account: { type: "string" } },
      required: ["items", "account"],
    };
    const r = tableFromJson(value, options({ shape }));
    expect(r.failure).toMatch(/^the file doesn't have the expected shape: /);
    expect(tableFromJson(value, options({ shape: { type: "object" } })).failure).toBeNull();
  });

  it("with no columns gives the rows as they are", () => {
    const r = tableFromJson([{ a: 1, b: { c: 2 } }], options({ columns: [] }));
    expect(r.rows).toEqual([{ a: 1, b: { c: 2 } }]);
    expect(r.columns.map((c) => c.field)).toEqual(["a", "b"]);
  });
});

describe("the columns parameter", () => {
  it("is checked as a parameter type, with boolean and json_schema", () => {
    const p = (type: "columns" | "boolean" | "json_schema", v: unknown) =>
      parameterValueProblem({ name: "x", type }, v);
    expect(p("columns", COLUMNS)).toBeNull();
    expect(p("columns", [])).toBeNull();
    expect(
      p("columns", [
        { field: "a", type: "text" },
        { field: "a", type: "money" },
      ]),
    ).toBe("x: each field is named once");
    expect(p("columns", [{ field: "1a", type: "text" }])).toMatch(/^x \(column 1\): /);
    expect(p("columns", "vendor")).toBe("x is a list of columns");
    expect(p("boolean", true)).toBeNull();
    expect(p("boolean", "yes")).toBe("x is on or off (true or false)");
    expect(p("json_schema", {})).toBeNull();
    expect(p("json_schema", { type: "array", items: { type: "object" } })).toBeNull();
    expect(p("json_schema", [])).toBe("x is a JSON Schema (an object)");
    // Every default of Read table's parameters is a value of its type.
    for (const param of READ_TABLE_PARAMETERS) {
      expect(parameterValueProblem(param, param.default)).toBeNull();
    }
  });

  it("types a Read table step's rows: the step's columns over the agent's", () => {
    const skill = {
      id: READ_TABLE_SKILL,
      parameters: [...READ_TABLE_PARAMETERS],
      output: { type: "object", additionalProperties: true },
    } as unknown as SkillDefinition;
    const process = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: { type: "object" } } }],
      steps: [
        { id: "read", kind: "skill", name: "Read table", skill: READ_TABLE_SKILL, input: {} },
      ],
    });
    const step = process.steps[0];
    if (step?.kind !== "skill") throw new Error("no step");
    const rowsOf = (schema: unknown) =>
      (schema as { properties: { rows: { items: Record<string, unknown> } } }).properties.rows
        .items;
    // Neither sets columns: rows any path reads.
    expect(rowsOf(stepOutputSchema(step, { skills: { [READ_TABLE_SKILL]: skill } }))).toEqual({
      type: "object",
      additionalProperties: true,
    });
    // The agent's columns.
    const agentSkills = [{ skill: READ_TABLE_SKILL, parameters: { columns: COLUMNS } }];
    const byAgent = rowsOf(
      stepOutputSchema(step, { skills: { [READ_TABLE_SKILL]: skill }, agentSkills }),
    );
    expect(byAgent.required).toEqual(["vendor", "amount"]);
    expect(Object.keys(byAgent.properties as object)).toEqual([
      "vendor",
      "amount",
      "invoiceDate",
      "paid",
      "qty",
    ]);
    // A process's validation context names the agent instead.
    const byContext = rowsOf(
      stepOutputSchema(step, {
        skills: { [READ_TABLE_SKILL]: skill },
        agent: { skills: agentSkills },
      } as never),
    );
    expect(byContext).toEqual(byAgent);
    // The step's own columns win.
    const own = { ...step, customize: { parameters: { columns: [COLUMNS[0]] } } };
    expect(
      rowsOf(stepOutputSchema(own, { skills: { [READ_TABLE_SKILL]: skill }, agentSkills }))
        .required,
    ).toEqual(["vendor"]);
    expect(readTableOutputSchema([]).required).toContain("rows");
  });
});

describe("tableForWriting", () => {
  const out: TableColumnInput[] = [
    { field: "vendor", headers: ["Vendor"], type: "text", required: true },
    { field: "amount", headers: ["Amount"], type: "money" },
    { field: "date", headers: ["Date"], type: "date", dateStyle: "dmy" },
    { field: "paid", headers: [], type: "boolean" },
  ];

  it("lays rows out in the columns' order, typed", () => {
    const r = tableForWriting(
      [
        { vendor: "Cascade", amount: "1250.50", date: "2026-11-02", paid: true, other: 1 },
        { vendor: "Keystone", amount: { amount: "12.00", currency: "USD" } },
      ],
      out.map((c) => ({ ...c, headers: c.headers ?? [] })),
    );
    expect(r).toEqual({
      ok: true,
      grid: {
        headers: ["Vendor", "Amount", "Date", "paid"],
        rows: [
          [
            { kind: "text", value: "Cascade" },
            { kind: "money", value: "1250.50" },
            { kind: "date", value: "2026-11-02", style: "dmy" },
            { kind: "boolean", value: true },
          ],
          [{ kind: "text", value: "Keystone" }, { kind: "money", value: "12.00" }, null, null],
        ],
      },
    });
  });

  it("fails the whole file on a value that isn't its type or a missing required one", () => {
    const r = tableForWriting(
      [{ vendor: "", amount: "lots" }],
      out.map((c) => ({ ...c, headers: c.headers ?? [] })),
    );
    expect(r).toEqual({
      ok: false,
      error: 'row 1: vendor is empty; row 1: amount: "lots" is not an amount',
    });
  });

  it("with no columns writes every field, typed by its values", () => {
    const r = tableForWriting([{ a: 1, b: "x", c: false }], []);
    expect(r.ok && r.grid.headers).toEqual(["a", "b", "c"]);
  });
});
