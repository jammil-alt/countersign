// Reshape data (2026-11-11): the Builder AI's suggestion for the fields the deterministic proposal
// left unmapped. Asked once; every expression is parsed and typed, and what fails is dropped.

import { type JsonSchema, processes } from "@countersign/core";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { RESHAPE_SUGGEST_TOOL, reshapeSuggestPrompt, suggestReshape } from "./reshape";

const READ: JsonSchema = {
  type: "object",
  properties: {
    header: {
      type: "object",
      properties: {
        vendorName: { type: "string" },
        invoiceNumber: { type: "string" },
        poNumber: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, extPrice: { type: "string" } },
      },
    },
    total: { type: "string" },
  },
};

const context: processes.ReshapeContext = {
  sources: [
    { key: "readDocument", template: "{{steps.read.output}}", schema: READ, label: "Read" },
  ],
  next: {
    stepId: "bill",
    name: "Create bill",
    schema: processes.actionInputSchema("create_bill"),
  },
  input: { type: "object", properties: { readDocument: READ } },
};

const proposal = processes.proposeReshape({ context });

describe("the Builder AI's suggestion", () => {
  it("is asked about the unmapped fields only, as data", () => {
    expect(proposal.unmapped).toEqual([
      "vendorId",
      "date",
      "dueDate",
      "lines.account",
      "lines.item",
      "currency",
      "memo",
    ]);
    const prompt = JSON.parse(
      reshapeSuggestPrompt({ context, mapping: proposal.mapping, unmapped: ["memo", "vendorId"] }),
    );
    expect(prompt.readable).toContain("readDocument.header.poNumber: text or nothing");
    expect(prompt.readable).toContain(
      "readDocument.lines: a list of records with description, extPrice",
    );
    expect(prompt.unmapped.map((f: { name: string }) => f.name)).toEqual(["memo", "vendorId"]);
  });

  it("keeps expressions that parse and type-check, and drops the rest", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: RESHAPE_SUGGEST_TOOL,
          input: {
            fields: [
              {
                name: "memo",
                expression: {
                  join: {
                    values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }],
                    separator: " ",
                  },
                },
                why: "The PO number is the job.",
              },
              { name: "vendorId", expression: { code: "lookup(vendorName)" } },
              { name: "date", expression: { input: "readDocument.header.invoiceDay" } },
              { name: "currency", expression: { value: 840 } },
              { name: "total", expression: { input: "readDocument.total" } },
              { name: "dueDate", expression: { today: true } },
            ],
          },
        },
      },
    ]);
    const llm = createLlmClient({ transport: model });
    const s = await suggestReshape(
      {
        context,
        mapping: proposal.mapping,
        unmapped: proposal.unmapped.filter((u) => !u.includes(".")),
      },
      { llm },
    );
    expect(s.fields).toEqual({
      memo: {
        join: {
          values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }],
          separator: " ",
        },
      },
      dueDate: { today: true },
    });
    expect(s.why).toEqual({ memo: "The PO number is the job." });
    expect(s.dropped).toEqual([
      { field: "vendorId", reason: "not an expression from the allowed set" },
      {
        field: "date",
        reason: 'date reads input.readDocument.header.invoiceDay: no field "invoiceDay"',
      },
      { field: "currency", reason: "currency gets a whole number; it takes text" },
      { field: "total", reason: "not a field that was unmapped" },
    ]);
    expect(model.requests).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
  });

  it("asks nothing when nothing is unmapped", async () => {
    const model = new FakeModel([]);
    const s = await suggestReshape(
      { context, mapping: proposal.mapping, unmapped: [] },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(s.fields).toEqual({});
    expect(model.requests).toHaveLength(0);
  });
});
