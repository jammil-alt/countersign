import { describe, expect, it } from "vitest";
import { schemaAtPath } from "./typer";

describe("schemaAtPath", () => {
  const schema = {
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "object", properties: { qty: { type: "number" } } } },
      meta: { type: "object", additionalProperties: { type: "string" } },
      free: { type: "object" },
      either: {
        anyOf: [{ type: "string" }, { type: "object", properties: { x: { type: "integer" } } }],
      },
      ref: { $ref: "#/$defs/R" },
    },
    $defs: { R: { type: "object", properties: { deep: { type: "boolean" } } } },
  };

  it("walks properties, items, length, additionalProperties, anyOf and $ref", () => {
    expect(schemaAtPath(schema, ["lines", "0", "qty"])).toEqual({
      ok: true,
      schema: { type: "number" },
    });
    expect(schemaAtPath(schema, ["lines", "length"])).toEqual({
      ok: true,
      schema: { type: "integer" },
    });
    expect(schemaAtPath(schema, ["meta", "anything"])).toEqual({
      ok: true,
      schema: { type: "string" },
    });
    expect(schemaAtPath(schema, ["free", "anything", "at", "all"]).ok).toBe(true);
    expect(schemaAtPath(schema, ["either", "x"])).toEqual({
      ok: true,
      schema: { type: "integer" },
    });
    expect(schemaAtPath(schema, ["ref", "deep"])).toEqual({
      ok: true,
      schema: { type: "boolean" },
    });
  });

  it("says when a field doesn't exist", () => {
    expect(schemaAtPath(schema, ["nope"])).toEqual({ ok: false, message: 'no field "nope"' });
    expect(schemaAtPath(schema, ["lines", "0", "qty", "x"]).ok).toBe(false);
    expect(schemaAtPath(undefined, ["anything"]).ok).toBe(true);
  });
});
