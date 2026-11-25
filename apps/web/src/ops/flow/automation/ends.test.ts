// An automation's Takes in and Gives back as rows, and back (F7): the schema and the template the
// rows write, what a half-typed row leaves out, the words on the chart's end boxes, and the
// automation as the builder's editing model holds it.
import { AutomationDefinition, type AutomationDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  automationEnds,
  draftProcess,
  editable,
  inputFields,
  inputLine,
  inputProblems,
  inputSchema,
  newInputField,
  outputFields,
  outputLine,
  outputPaths,
  outputProblems,
  outputTemplate,
  toDefinition,
  toDraft,
  valueWords,
  withFace,
  withInputType,
  withProcess,
} from "./ends";

const INPUT = {
  type: "object",
  title: "A bill",
  properties: {
    billId: { type: "string", description: "The bill to read" },
    pages: { type: "integer", minimum: 1 },
    lines: { type: "array", items: { type: "object" } },
    extra: {},
  },
  required: ["billId"],
};

const DEFINITION = AutomationDefinition.parse({
  schemaVersion: 2,
  slug: "bill-intake",
  name: "Bill intake",
  input: INPUT,
  output: { documentId: "{{steps.find.output.documentId}}", note: "For {{input.billId}}" },
  steps: [
    {
      id: "find",
      name: "Find the document",
      kind: "skill",
      skill: "docs.find-support",
      input: { billId: "{{input.billId}}" },
    },
  ],
}) as AutomationDefinition;

const names = (id: string) => (id === "find" ? "Find the document" : null);

describe("Takes in", () => {
  it("reads a schema's fields in order, with what each holds", () => {
    expect(inputFields(INPUT).map((f) => [f.name, f.type, f.required, f.description])).toEqual([
      ["billId", "string", true, "The bill to read"],
      ["pages", "number", false, ""],
      ["lines", "array", false, ""],
      ["extra", "any", false, ""],
    ]);
    expect(inputFields(undefined)).toEqual([]);
  });

  it("writes the same schema back, keeping what the rows don't show", () => {
    expect(inputSchema(inputFields(INPUT), INPUT)).toEqual(INPUT);
  });

  it("writes a new field, a renamed one and a retyped one", () => {
    const [billId, pages, ...rest] = inputFields(INPUT);
    if (!billId || !pages) throw new Error("fixture");
    const next = inputSchema(
      [
        { ...billId, name: "bill", required: false },
        // Another type: what the schema said about the old one (its minimum) goes.
        withInputType(pages, "string"),
        ...rest,
        { ...newInputField("new:1"), name: "note", description: " Why it is sent " },
      ],
      INPUT,
    );
    expect(next).toEqual({
      type: "object",
      title: "A bill",
      properties: {
        bill: { type: "string", description: "The bill to read" },
        pages: { type: "string" },
        lines: { type: "array", items: { type: "object" } },
        extra: {},
        note: { type: "string", description: "Why it is sent" },
      },
      required: ["note"],
    });
    // The same type picked again changes nothing.
    expect(withInputType(pages, "number")).toBe(pages);
  });

  it("leaves out a row with no name and the second of two with one name, and says so", () => {
    const rows = [
      { ...newInputField("a"), name: "amount" },
      { ...newInputField("b"), name: "" },
      { ...newInputField("c"), name: "amount", type: "number" as const },
      { ...newInputField("d"), name: "bill id" },
    ];
    expect(inputSchema(rows)).toEqual({
      type: "object",
      properties: { amount: { type: "string" }, "bill id": { type: "string" } },
      required: ["amount", "bill id"],
    });
    expect([...inputProblems(rows)]).toEqual([
      ["b", "Give this field a name."],
      ["c", "Another field is already called amount."],
      ["d", "Use letters, digits and _ only, starting with a letter."],
    ]);
  });

  it("says a field in a line", () => {
    expect(inputFields(INPUT).map(inputLine)).toEqual([
      "billId · text",
      "pages · number, optional",
      "lines · list, optional",
      "extra · anything, optional",
    ]);
  });
});

describe("Gives back", () => {
  it("reads and writes the output template", () => {
    const rows = outputFields(DEFINITION.output);
    expect(rows.map((r) => r.name)).toEqual(["documentId", "note"]);
    expect(outputTemplate(rows)).toEqual(DEFINITION.output);
    expect(
      outputTemplate([
        ...rows,
        { key: "new:1", name: "", value: "{{input.billId}}" },
        { key: "new:2", name: "note", value: "again" },
        { key: "new:3", name: "count", value: 2 },
      ]),
    ).toEqual({ ...DEFINITION.output, count: 2 });
  });

  it("says what is wrong with a row as typed", () => {
    expect([
      ...outputProblems([
        { key: "a", name: "bill", value: "" },
        { key: "b", name: "", value: "x" },
        { key: "c", name: "ok", value: "{{input.billId}}" },
      ]),
    ]).toEqual([
      ["b", "Give this field a name."],
      ["a", "Pick what it gives back here."],
    ]);
  });

  it("says a value in words", () => {
    expect(valueWords("{{steps.find.output.documentId}}", names)).toBe(
      "Find the document · document id",
    );
    expect(valueWords("For {{input.billId}}", names)).toBe("For Input · bill id");
    expect(valueWords({ a: 1 }, names)).toBe("A fixed value");
    expect(valueWords("", names)).toBe("Nothing yet");
    expect(outputLine({ name: "documentId", value: "{{input.billId}}" }, names)).toBe(
      "documentId: Input · bill id",
    );
  });

  it("offers what it takes in and what its top-level steps give", () => {
    const ctx = {
      skills: {
        "docs.find-support": {
          output: { type: "object", properties: { documentId: { type: "string" } } },
        },
      },
    } as never;
    const paths = outputPaths(DEFINITION, ctx).map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining(["input.billId", "input.pages", "steps.find.output.documentId"]),
    );
    expect(paths.some((p) => p.startsWith("trigger"))).toBe(false);
  });
});

describe("the chart's end boxes", () => {
  it("titles them and lists their fields", () => {
    const ends = automationEnds(DEFINITION, names);
    expect(ends.start).toEqual({
      title: "Takes in",
      lines: [
        "billId · text",
        "pages · number, optional",
        "lines · list, optional",
        "extra · anything, optional",
      ],
    });
    expect(ends.givesBack).toEqual({
      title: "Gives back",
      lines: ["documentId: Find the document · document id", "note: For Input · bill id"],
    });
  });

  it("says so when there is nothing", () => {
    const none = automationEnds({ input: { type: "object", properties: {} }, output: {} }, names);
    expect(none.start?.lines).toEqual(["Nothing. Add what it needs to start."]);
    expect(none.givesBack?.lines).toEqual(["Nothing yet. Pick what later steps can use."]);
  });
});

describe("the automation as a draft", () => {
  it("holds its steps as one process with no trigger, and its ids as they were", () => {
    const draft = toDraft(DEFINITION);
    const process = draftProcess(draft);
    expect(process.triggers).toEqual([]);
    expect(process.steps).toBe(DEFINITION.steps);
    expect(draft.automation).toEqual({
      name: "Bill intake",
      description: "",
      input: DEFINITION.input,
      output: DEFINITION.output,
    });
    // Unchanged, it saves as it was stored.
    expect(toDefinition(draft, DEFINITION)).toEqual(DEFINITION);
  });

  it("saves the draft's name, input, output and steps over the stored definition", () => {
    const draft = toDraft(DEFINITION);
    const steps = [...DEFINITION.steps].reverse();
    const next = withFace(withProcess(draft, { ...draftProcess(draft), steps }), {
      name: "  ",
      output: { a: "{{input.billId}}" },
    });
    const def = toDefinition(next, DEFINITION);
    expect(def.slug).toBe("bill-intake");
    expect(def.schemaVersion).toBe(2);
    // A blank name keeps the stored one.
    expect(def.name).toBe("Bill intake");
    expect(def.output).toEqual({ a: "{{input.billId}}" });
    expect(def.steps).toBe(steps);
    expect(def.requires).toBe(DEFINITION.requires);
    // The same process again is the same draft (no undo step).
    expect(withProcess(draft, draftProcess(draft))).toBe(draft);
  });

  it("opens only v4 process steps", () => {
    expect(editable(DEFINITION)).toBe(true);
    expect(editable({ ...DEFINITION, schemaVersion: 1, steps: [] } as never)).toBe(false);
  });
});
