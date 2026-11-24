import { describe, expect, it } from "vitest";
import { blankField, schemaFromShape, shapeFromSchema, shapeProblems } from "./shape";

const FILTER_OUTPUT = {
  type: "object",
  properties: {
    kept: {
      type: "array",
      description: "The filings that stay",
      items: {
        type: "object",
        properties: {
          buyer: { type: "string" },
          filed_on: { type: "string", format: "date" },
          county: { type: "string", enum: ["Harris", "Fort Bend"] },
        },
        required: ["buyer"],
      },
    },
    keptCount: { type: "integer" },
    notice: { type: "string", "x-document": true },
    tags: { type: "array", items: { type: "string" } },
    ok: { type: "boolean" },
  },
  required: ["kept", "keptCount"],
};

describe("a skill's fields", () => {
  it("reads a schema into fields in plain kinds, a list of records with its own fields", () => {
    const fields = shapeFromSchema(FILTER_OUTPUT);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["kept", "records", true],
      ["keptCount", "whole", true],
      ["notice", "document", false],
      ["tags", "list", false],
      ["ok", "yesno", false],
    ]);
    expect(fields[0]?.meaning).toBe("The filings that stay");
    expect(fields[0]?.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["buyer", "text", true],
      ["filed_on", "date", false],
      ["county", "text", false],
    ]);
  });

  it("writes them back as they were, keeping what the screen doesn't show", () => {
    expect(schemaFromShape(shapeFromSchema(FILTER_OUTPUT))).toEqual(FILTER_OUTPUT);
  });

  it("changes only what was edited: a new field inside the records, a kind changed", () => {
    const fields = shapeFromSchema(FILTER_OUTPUT);
    const kept = fields[0];
    if (!kept) throw new Error("no kept");
    kept.fields.push({ ...blankField(), name: "reason", meaning: "Why it stays" });
    const tags = fields[3];
    if (!tags) throw new Error("no tags");
    tags.kind = "text";
    const out = schemaFromShape(fields) as {
      properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
    };
    expect(out.properties.kept?.items?.properties.reason).toEqual({
      type: "string",
      description: "Why it stays",
    });
    // The enum on county is still there.
    expect(out.properties.kept?.items?.properties.county).toEqual({
      type: "string",
      enum: ["Harris", "Fort Bend"],
    });
    expect(out.properties.tags).toEqual({ type: "string" });
  });

  it("says what stops the fields from saving", () => {
    const fields = [
      { ...blankField(), name: "rows", kind: "records" as const, fields: [blankField()] },
      { ...blankField(), name: "rows" },
      { ...blankField(), name: "two words" },
    ];
    expect(shapeProblems(fields, "What it gets")).toEqual([
      "A field in What it gets › rows has no name.",
      "What it gets has “rows” twice.",
      "What it gets: “two words” is a field name with letters, digits and _ only.",
    ]);
  });
});
