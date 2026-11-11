// Reshape data (owner, 2026-11-11): the expressions, the money rules, typing, the deterministic
// proposer and the validator's flags (docs/plan.md §1.86 "Reshape data").

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InvoiceExtraction } from "../documents/extraction";
import type { JsonSchema } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import { actionInputSchema } from "./actions";
import {
  evaluateReshape,
  RESHAPE_SKILL,
  type ReshapeExpr,
  ReshapeExpr as ReshapeExprSchema,
  type ReshapeField,
  ReshapeMapping,
  reshapeExprSchema,
  reshapeOutputSchema,
  reshapeProblems,
  sampleFromSchema,
  schemaFitProblems,
} from "./reshape";
import { proposeReshape, reshapeContext, wireToReshape } from "./reshape-propose";
import { Process, type Step } from "./schema";
import { validateProcess } from "./validate";

const TODAY = "2026-11-11";

/** One field, required, of any type, run on `input`. */
function run(from: ReshapeExpr, input: unknown = {}, schema: JsonSchema = {}) {
  const r = evaluateReshape({ fields: [{ name: "out", schema, from }] }, input, { today: TODAY });
  return { value: r.output.out, problems: r.problems };
}

const value = (from: ReshapeExpr, input: unknown = {}) => {
  const r = run(from, input);
  expect(r.problems).toEqual([]);
  return r.value;
};

const invoice = {
  header: {
    vendorName: "Cascade Lumber",
    invoiceNumber: "INV-1042",
    invoiceDate: "2026-10-28",
    dueDate: null,
    currency: "USD",
  },
  lines: [
    { lineNo: 1, description: "2x4 stud 8ft", qty: "100", extPrice: "512.50", uom: "EA" },
    { lineNo: 2, description: "Plywood 3/4", qty: "20", extPrice: "1104.10", uom: "SHT" },
  ],
  subtotal: "1616.60",
  freight: "75.00",
  tax: "0",
  total: "1691.60",
};

describe("the expressions", () => {
  it("copies an input field, a literal and today", () => {
    expect(value({ input: "doc.header.vendorName" }, { doc: invoice })).toBe("Cascade Lumber");
    expect(value({ input: "doc.lines.1.extPrice" }, { doc: invoice })).toBe("1104.10");
    expect(value({ value: "Net 30" })).toBe("Net 30");
    expect(value({ value: [1, 2] })).toEqual([1, 2]);
    expect(value({ today: true })).toBe(TODAY);
  });

  it("works out days between two dates, timestamps by the date written", () => {
    expect(
      value({ daysBetween: { from: { input: "d" }, to: { today: true } } }, { d: "2026-10-28" }),
    ).toBe(14);
    expect(
      value(
        { daysBetween: { from: { input: "d" }, to: { value: "2026-11-01" } } },
        { d: "2026-10-31T23:30:00-07:00" },
      ),
    ).toBe(1);
    expect(
      run({ daysBetween: { from: { input: "d" }, to: { today: true } } }, { d: "soon" }).problems[0]
        ?.message,
    ).toMatch(/two dates/);
  });

  it("adds and subtracts in decimals, keeping the operands' form", () => {
    // 0.1 + 0.2 is 0.3, never 0.30000000000000004.
    expect(value({ sum: [{ value: "0.1" }, { value: "0.2" }] })).toBe("0.3");
    expect(value({ sum: [{ value: 1 }, { value: 2 }] })).toBe(3);
    expect(value({ sum: [{ input: "a" }, { input: "b" }] }, { a: "1616.60", b: "75.00" })).toBe(
      "1691.6",
    );
    expect(
      value(
        { sum: [{ input: "a" }, { input: "b" }] },
        { a: { amount: "10.10", currency: "USD" }, b: { amount: "0.20", currency: "USD" } },
      ),
    ).toEqual({ amount: "10.3000", currency: "USD" });
    expect(
      value({ difference: [{ input: "t" }, { input: "s" }] }, { t: "1691.60", s: "1616.60" }),
    ).toBe("75");
  });

  it("refuses amounts in two currencies, and text that isn't a number", () => {
    const two = run(
      { sum: [{ input: "a" }, { input: "b" }] },
      { a: { amount: "1", currency: "USD" }, b: { amount: "1", currency: "CAD" } },
    );
    expect(two.problems[0]?.message).toMatch(/one currency/);
    expect(run({ sum: [{ value: "ten" }] }).problems).toHaveLength(1);
  });

  it("takes a percent change, rounded to 2 places, and none from 0", () => {
    expect(value({ percentChange: { from: { value: "80" }, to: { value: "100" } } })).toBe("25");
    expect(value({ percentChange: { from: { value: 3 }, to: { value: 2 } } })).toBe(-33.33);
    expect(run({ percentChange: { from: { value: 0 }, to: { value: 2 } } }).problems).toHaveLength(
      1,
    );
  });

  it("names the bucket a number falls in", () => {
    const buckets = [
      { from: 0, to: 15, label: "Current" },
      { from: 16, to: 30, label: "Due" },
      { from: 31, label: "Past due" },
    ];
    expect(value({ bucket: { value: { input: "d" }, buckets } }, { d: 15 })).toBe("Current");
    expect(value({ bucket: { value: { input: "d" }, buckets } }, { d: "45" })).toBe("Past due");
    expect(run({ bucket: { value: { input: "d" }, buckets } }, { d: -1 }).problems).toHaveLength(1);
  });

  it("formats dates both ways", () => {
    const d = (from: ReshapeExpr, input: unknown) => value(from, input);
    expect(d({ formatDate: { value: { input: "x" }, to: "mdy" } }, { x: "2026-03-04" })).toBe(
      "03/04/2026",
    );
    expect(d({ formatDate: { value: { input: "x" }, to: "dmy" } }, { x: "2026-03-04" })).toBe(
      "04/03/2026",
    );
    expect(d({ formatDate: { value: { input: "x" }, to: "long" } }, { x: "2026-03-04" })).toBe(
      "March 4, 2026",
    );
    expect(
      d({ formatDate: { value: { input: "x" }, from: "mdy", to: "iso" } }, { x: "3/4/2026" }),
    ).toBe("2026-03-04");
    expect(
      d({ formatDate: { value: { input: "x" }, from: "dmy", to: "iso" } }, { x: "3.4.2026" }),
    ).toBe("2026-04-03");
    // 2026-02-30 is not a date; nor is a slashed date without saying how it is written.
    expect(
      run({ formatDate: { value: { value: "2026-02-30" }, to: "mdy" } }).problems,
    ).toHaveLength(1);
    expect(run({ formatDate: { value: { value: "3/4/2026" }, to: "iso" } }).problems).toHaveLength(
      1,
    );
  });

  it("formats numbers and money in decimals, rounding half up", () => {
    expect(value({ formatNumber: { value: { value: "2.345" }, places: 2 } })).toBe("2.35");
    expect(value({ formatNumber: { value: { value: "1,250" }, as: "number" } })).toBe(1250);
    expect(value({ formatMoney: { value: { value: "$1,250.5" } } })).toBe("1250.50");
    expect(value({ formatMoney: { value: { value: "(12.345)" } } })).toBe("-12.35");
    // A JS number is read by its decimal text: 0.1 stays 0.1.
    expect(value({ formatMoney: { value: { value: 0.1 } } })).toBe("0.10");
    expect(
      value({ formatMoney: { value: { value: "10" }, currency: { value: "USD" }, places: 4 } }),
    ).toEqual({
      amount: "10.0000",
      currency: "USD",
    });
    expect(
      run(
        { formatMoney: { value: { input: "a" }, currency: { value: "CAD" } } },
        { a: { amount: "5.00", currency: "USD" } },
      ).problems[0]?.message,
    ).toMatch(/never change currency/);
    expect(run({ formatMoney: { value: { value: "a lot" } } }).problems).toHaveLength(1);
  });

  it("joins and splits text", () => {
    expect(
      value(
        {
          join: {
            values: [{ value: "Invoice" }, { input: "n" }, { input: "missing" }],
            separator: " ",
          },
        },
        { n: "INV-1042" },
      ),
    ).toBe("Invoice INV-1042");
    expect(
      value({ join: { values: [{ input: "tags" }], separator: ", " } }, { tags: ["a", "b"] }),
    ).toBe("a, b");
    expect(value({ split: { value: { value: "Ann, Bo ,, Cy" }, separator: "," } })).toEqual([
      "Ann",
      "Bo",
      "Cy",
    ]);
    expect(value({ split: { value: { value: "Ann Lee" }, separator: " ", index: -1 } })).toBe(
      "Lee",
    );
  });

  it("picks from a list, plucks a field, and maps a list field by field", () => {
    const input = { doc: invoice };
    expect(
      value({ pick: { list: { input: "doc.lines" }, index: -1, field: "description" } }, input),
    ).toBe("Plywood 3/4");
    expect(
      value(
        {
          pick: {
            list: { input: "doc.lines" },
            where: { field: "uom", equals: { value: "SHT" } },
            field: "extPrice",
          },
        },
        input,
      ),
    ).toBe("1104.10");
    // A where comparing decimals compares them as numbers ("512.5" = "512.50").
    expect(
      value(
        {
          pick: {
            list: { input: "doc.lines" },
            where: { field: "extPrice", equals: { value: "512.5" } },
            field: "lineNo",
          },
        },
        input,
      ),
    ).toBe(1);
    expect(value({ pluck: { list: { input: "doc.lines" }, field: "description" } }, input)).toEqual(
      ["2x4 stud 8ft", "Plywood 3/4"],
    );
    expect(
      value(
        {
          mapList: {
            list: { input: "doc.lines" },
            fields: {
              description: { item: "description" },
              amount: { formatMoney: { value: { item: "extPrice" } } },
              memo: {
                join: {
                  values: [{ input: "doc.header.invoiceNumber" }, { item: "lineNo" }],
                  separator: "/",
                },
              },
            },
          },
        },
        input,
      ),
    ).toEqual([
      { description: "2x4 stud 8ft", amount: "512.50", memo: "INV-1042/1" },
      { description: "Plywood 3/4", amount: "1104.10", memo: "INV-1042/2" },
    ]);
  });

  it("names the item a mapped list fails on", () => {
    const r = run(
      {
        mapList: {
          list: { input: "l" },
          fields: { amount: { formatMoney: { value: { item: "p" } } } },
        },
      },
      { l: [{ p: "1" }, { p: "x" }] },
      {
        type: "array",
        items: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] },
      },
    );
    expect(r.problems.map((p) => p.field)).toEqual(["out.1.amount"]);
  });

  it("converts units with core's table, never across kinds", () => {
    expect(value({ convertUnit: { value: { value: "12" }, from: "in", to: "ft" } })).toBe("1");
    expect(value({ convertUnit: { value: { value: 1 }, from: "lb", to: "kg" } })).toBe(0.4536);
    expect(value({ convertUnit: { value: { value: "2" }, from: "MBF", to: "BF" } })).toBe("2000");
    expect(
      run({ convertUnit: { value: { value: "1" }, from: "ft", to: "lb" } }).problems,
    ).toHaveLength(1);
  });

  it("reads a list item only inside a list map", () => {
    expect(run({ item: "x" }, {}).problems[0]?.message).toMatch(/outside a list map/);
  });
});

describe("the mapping", () => {
  it("is data: no code, no unknown expression, and buckets in order", () => {
    expect(ReshapeExprSchema.safeParse({ code: "return 1" }).success).toBe(false);
    expect(ReshapeExprSchema.safeParse({ template: "{{input.x}}" }).success).toBe(false);
    expect(
      ReshapeExprSchema.safeParse({
        bucket: {
          value: { input: "d" },
          buckets: [
            { from: 0, to: 30, label: "A" },
            { from: 10, label: "B" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      ReshapeMapping.safeParse({
        fields: [
          { name: "a", schema: {} },
          { name: "a", schema: {} },
        ],
      }).success,
    ).toBe(false);
  });

  it("leaves an empty optional field out, keeps null where the type allows it, and names an empty required one", () => {
    const fields: ReshapeField[] = [
      { name: "dueDate", schema: { type: "string" }, required: false, from: { input: "d" } },
      { name: "poNumber", schema: { type: ["string", "null"] }, from: { input: "d" } },
      { name: "invoiceNumber", schema: { type: "string" }, from: { input: "n" } },
      { name: "memo", schema: { type: "string" }, required: false },
    ];
    const r = evaluateReshape({ fields }, { d: null }, { today: TODAY });
    expect(r.output).toEqual({ poNumber: null });
    expect(r.problems).toEqual([
      { field: "invoiceNumber", message: "invoiceNumber is empty: input.n has no value" },
    ]);
  });

  it("promises its fields as the step's output", () => {
    expect(
      reshapeOutputSchema({
        fields: [
          { name: "a", schema: { type: "string" } },
          { name: "b", schema: { type: "number" }, required: false },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
      additionalProperties: false,
    });
  });
});

const extraction = z.toJSONSchema(InvoiceExtraction, { io: "output" }) as JsonSchema;
const readInput: JsonSchema = {
  type: "object",
  properties: { readDocument: extraction },
  additionalProperties: false,
};

describe("typing", () => {
  it("types each expression from what it reads", () => {
    expect(
      reshapeExprSchema({ input: "readDocument.total" }, { input: readInput }).schema,
    ).toMatchObject({
      type: "string",
    });
    expect(
      reshapeExprSchema(
        { daysBetween: { from: { today: true }, to: { today: true } } },
        { input: readInput },
      ).schema,
    ).toEqual({ type: "integer" });
    expect(
      reshapeExprSchema(
        {
          mapList: {
            list: { input: "readDocument.lines" },
            fields: { d: { item: "description" }, q: { item: "nope" } },
          },
        },
        { input: readInput },
      ).problems,
    ).toEqual(['q reads item.nope: no field "nope"']);
  });

  it("finds a field read that isn't there, a value that doesn't fit, and a field unmapped", () => {
    const mapping: ReshapeMapping = {
      fields: [
        {
          name: "vendorName",
          schema: { type: "string" },
          from: { input: "readDocument.header.vendor" },
        },
        {
          name: "lineCount",
          schema: { type: "string" },
          from: { input: "readDocument.lines.length" },
        },
        { name: "invoiceNumber", schema: { type: "string" } },
        { name: "memo", schema: { type: "string" }, required: false },
      ],
    };
    expect(reshapeProblems(mapping, readInput).map((p) => p.message)).toEqual([
      'vendorName reads input.readDocument.header.vendor: no field "vendor"',
      "lineCount gets a whole number; it takes text",
      "invoiceNumber isn't mapped",
    ]);
  });

  it("looks into lists and records when fitting", () => {
    const want: JsonSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, amount: { type: "string" } },
        required: ["description", "amount"],
      },
    };
    const have: JsonSchema = {
      type: "array",
      items: { type: "object", properties: { description: { type: "string" } }, required: [] },
    };
    expect(schemaFitProblems(want, have, "lines")).toEqual([
      "each of lines has no amount, which is required",
    ]);
  });

  it("samples a value from a schema", () => {
    expect(sampleFromSchema(actionInputSchema("create_bill"))).toMatchObject({
      invoiceNumber: "Sample invoiceNumber",
      date: "2026-11-10",
      total: "125.00",
      currency: "USD",
    });
  });
});

// ── The proposer and the validator, on a process ──────────────────────────────────────────────

const readSkill: SkillDefinition = {
  schemaVersion: 1,
  id: "docs.read-document",
  name: "Read document",
  description: "Reads an invoice.",
  category: "documents",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Read it.",
  tools: [],
  input: {
    type: "object",
    properties: { documentId: { type: "string" } },
    required: ["documentId"],
  },
  output: extraction,
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const reshapeSkill: SkillDefinition = {
  schemaVersion: 1,
  id: RESHAPE_SKILL,
  name: "Reshape data",
  description: "Reshapes data.",
  category: "data",
  mode: "tool",
  handler: "data.reshape",
  tools: ["data.reshape"],
  input: { type: "object", additionalProperties: true },
  output: { type: "object", additionalProperties: true },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const typing = { skills: { [readSkill.id]: readSkill, [RESHAPE_SKILL]: reshapeSkill } };

function billProcess(reshape?: Step): Process {
  return Process.parse({
    schemaVersion: 4,
    triggers: [
      {
        id: "t",
        on: {
          type: "manual",
          input: { type: "object", properties: { documentId: { type: "string" } } },
        },
      },
    ],
    steps: [
      {
        id: "read",
        kind: "skill",
        name: "Read document",
        skill: readSkill.id,
        input: { documentId: "{{trigger.documentId}}" },
      },
      ...(reshape ? [reshape] : []),
      { id: "bill", kind: "write", name: "Create bill", action: "create_bill", input: {} },
    ],
  });
}

const newReshape: Step = {
  id: "shape",
  kind: "skill",
  name: "Reshape data",
  skill: RESHAPE_SKILL,
  input: {},
  reshape: { fields: [] },
};

describe("the deterministic proposal", () => {
  it("maps Read document's output to Create bill's input by name, synonym and type", () => {
    const process = billProcess(newReshape);
    const context = reshapeContext(process, "shape", typing);
    expect(context?.next?.stepId).toBe("bill");
    expect(context?.sources.map((s) => [s.key, s.template])).toEqual([
      ["trigger", "{{trigger}}"],
      ["readDocument", "{{steps.read.output}}"],
    ]);
    if (!context) return;
    const p = proposeReshape({ context });
    expect(p.input).toEqual({ readDocument: "{{steps.read.output}}" });
    const from = Object.fromEntries(p.mapping.fields.map((f) => [f.name, f.from]));
    expect(from).toEqual({
      vendorId: undefined,
      vendorName: { input: "readDocument.header.vendorName" },
      invoiceNumber: { input: "readDocument.header.invoiceNumber" },
      date: { input: "readDocument.header.invoiceDate" },
      dueDate: { input: "readDocument.header.dueDate" },
      lines: {
        mapList: {
          list: { input: "readDocument.lines" },
          fields: { description: { item: "description" }, amount: { item: "extPrice" } },
        },
      },
      total: { input: "readDocument.total" },
      currency: { input: "readDocument.header.currency" },
      memo: undefined,
    });
    expect(p.how).toMatchObject({ vendorName: "exact", date: "synonym", currency: "exact" });
    expect(p.unmapped).toEqual(["vendorId", "lines.account", "lines.item", "memo"]);
    // Each field keeps the next step's type, and its optional ones stay optional.
    expect(p.mapping.fields.find((f) => f.name === "memo")?.required).toBe(false);
    expect(p.mapping.fields.find((f) => f.name === "total")?.required).toBeUndefined();
  });

  it("converts a number into money text, and never maps by type alone", () => {
    const context = {
      sources: [
        {
          key: "calc",
          template: "{{steps.c.output}}",
          label: "Calc",
          schema: {
            type: "object",
            properties: { total: { type: "number" }, other: { type: "string" } },
          },
        },
      ],
      next: {
        stepId: "n",
        name: "Next",
        schema: {
          type: "object",
          properties: { total: { type: "string" }, note: { type: "string" } },
          required: ["total"],
        },
      },
      input: { type: "object" },
    };
    const p = proposeReshape({ context });
    expect(p.mapping.fields).toEqual([
      {
        name: "total",
        schema: { type: "string" },
        from: { formatMoney: { value: { input: "calc.total" } } },
      },
      { name: "note", schema: { type: "string" }, required: false },
    ]);
  });
});

describe("the validator", () => {
  function proposed(): Process {
    const process = billProcess(newReshape);
    const context = reshapeContext(process, "shape", typing);
    if (!context) throw new Error("no context");
    const p = proposeReshape({ context });
    const steps = process.steps.map((s): Step => {
      if (s.id === "shape") return { ...newReshape, input: p.input, reshape: p.mapping } as Step;
      if (s.id === "bill" && s.kind === "write")
        return {
          ...s,
          input: wireToReshape(
            s.input,
            "shape",
            p.mapping,
            actionInputSchema("create_bill"),
          ) as Record<string, string>,
        };
      return s;
    });
    return { ...process, steps };
  }

  it("passes a proposed mapping wired to Create bill, typing the bill's input by it", () => {
    const r = validateProcess(proposed(), typing);
    expect(r.errors).toEqual([]);
  });

  it("flags the Reshape step, naming fields, after the step before moves to a version that renames them", () => {
    const v2: SkillDefinition = {
      ...readSkill,
      output: {
        type: "object",
        properties: {
          header: {
            type: "object",
            properties: {
              supplier: { type: "string" },
              invoiceNumber: { type: "string" },
              invoiceDate: { type: "string" },
              currency: { type: "string" },
            },
          },
          lines: extraction.properties
            ? (extraction.properties as Record<string, JsonSchema>).lines
            : {},
          total: { type: "number" },
        },
      },
    };
    const r = validateProcess(proposed(), { skills: { ...typing.skills, [readSkill.id]: v2 } });
    const mine = r.errors.filter((e) => e.stepId === "shape");
    expect(mine.map((e) => [e.field, e.code, e.message])).toEqual([
      [
        "reshape.vendorName",
        "reshape_mapping",
        'vendorName reads input.readDocument.header.vendorName: no field "vendorName"',
      ],
      [
        "reshape.dueDate",
        "reshape_mapping",
        'dueDate reads input.readDocument.header.dueDate: no field "dueDate"',
      ],
      ["reshape.total", "reshape_mapping", "total gets a number; it takes text"],
    ]);
    // "Propose an updated mapping" keeps what still fits and re-proposes the rest.
    const process = proposed();
    const context = reshapeContext(process, "shape", {
      skills: { ...typing.skills, [readSkill.id]: v2 },
    });
    if (!context) throw new Error("no context");
    const shape = process.steps.find((s) => s.id === "shape");
    if (shape?.kind !== "skill") throw new Error("no shape");
    const again = proposeReshape({
      context,
      current: { input: shape.input, mapping: shape.reshape },
    });
    expect(again.how).toMatchObject({
      invoiceNumber: "kept",
      lines: "kept",
      vendorName: "synonym",
    });
    expect(Object.fromEntries(again.mapping.fields.map((f) => [f.name, f.from]))).toMatchObject({
      vendorName: { input: "readDocument.header.supplier" },
      total: { formatMoney: { value: { input: "readDocument.total" } } },
    });
  });

  it("flags the Reshape step when the next step takes something the mapping doesn't give", () => {
    const process = proposed();
    const steps = process.steps.map((s) =>
      s.id === "bill" && s.kind === "write"
        ? {
            ...s,
            input: { ...s.input, invoiceNumber: undefined, total: "{{steps.shape.output.totals}}" },
          }
        : s,
    );
    const r = validateProcess({ ...process, steps: JSON.parse(JSON.stringify(steps)) }, typing);
    const mine = r.errors.filter((e) => e.stepId === "shape").map((e) => e.message);
    expect(mine).toEqual([
      "Create bill reads totals, which the mapping doesn't give",
      "Create bill needs invoiceNumber, which the mapping doesn't give",
    ]);
  });

  it("needs a mapping on a Reshape step, and only there", () => {
    const bare = billProcess({ ...newReshape, reshape: undefined } as Step);
    expect(validateProcess(bare, typing).errors.map((e) => [e.stepId, e.code])).toContainEqual([
      "shape",
      "reshape_mapping",
    ]);
    const wrong = billProcess();
    const read = wrong.steps[0];
    if (read?.kind !== "skill") throw new Error("no read");
    const withMapping = {
      ...wrong,
      steps: [{ ...read, reshape: { fields: [] } }, ...wrong.steps.slice(1)],
    };
    expect(
      validateProcess(withMapping, typing).errors.map((e) => [e.stepId, e.message]),
    ).toContainEqual(["read", "only a Reshape data step has a mapping"]);
  });
});
