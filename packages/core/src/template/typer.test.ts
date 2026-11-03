import { describe, expect, it } from "vitest";
import { ctx, workflowInput } from "../testing/fixtures";
import { pathsAt, schemaAtPath, scopeAt, typeTemplatePath } from "./typer";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

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

describe("scope", () => {
  const wf = workflowInput();

  it("sees the trigger and earlier steps on the same path", () => {
    const scope = scopeAt(wf, "s3", ctx);
    expect(Object.keys(scope?.steps ?? {})).toEqual(["s1"]);
    expect(typeTemplatePath(must(scope), ["trigger", "vendor"])).toEqual({
      ok: true,
      schema: { type: "string" },
    });
  });

  it("hides what a fork path produced after the paths join", () => {
    const after = scopeAt(wf, "s5", ctx);
    expect(Object.keys(after?.steps ?? {})).toEqual(["s1", "s2"]);
    const r = typeTemplatePath(must(after), ["steps", "s3", "output", "approved"]);
    expect(r.ok).toBe(false);
    // The fork itself exposes which path ran.
    expect(typeTemplatePath(must(after), ["steps", "s2", "output", "pathId"]).ok).toBe(true);
  });

  it("types item from the for_each list and limits item/index to the loop", () => {
    const inLoop = must(scopeAt(wf, "s6", ctx));
    expect(typeTemplatePath(inLoop, ["item", "description"])).toEqual({
      ok: true,
      schema: { type: "string" },
    });
    expect(typeTemplatePath(inLoop, ["index"]).ok).toBe(true);
    const outside = must(scopeAt(wf, "s7", ctx));
    expect(typeTemplatePath(outside, ["item"]).ok).toBe(false);
    expect(typeTemplatePath(outside, ["steps", "s6", "output"]).ok).toBe(false);
    expect(typeTemplatePath(outside, ["steps", "s5", "output", "count"]).ok).toBe(true);
  });

  it("refuses steps that run later and unknown roots", () => {
    const scope = must(scopeAt(wf, "s1", ctx));
    expect(typeTemplatePath(scope, ["steps", "s7", "output"]).ok).toBe(false);
    expect(typeTemplatePath(scope, ["env", "SECRET"]).ok).toBe(false);
    expect(scopeAt(wf, "nope", ctx)).toBeUndefined();
  });

  it("lists the picker's options at a step", () => {
    const paths = pathsAt(wf, "s7", ctx).map((p) => p.path);
    expect(paths).toContain("trigger.documentId");
    expect(paths).toContain("steps.s1.output.lines.length");
    expect(paths).toContain("steps.s1.output.lines");
    expect(paths).toContain("steps.s2.output.pathId");
    expect(paths).not.toContain("item");
    expect(paths.some((p) => p.startsWith("steps.s3"))).toBe(false);
    expect(pathsAt(wf, "s6", ctx).map((p) => p.path)).toEqual(
      expect.arrayContaining(["item", "item.description", "index"]),
    );
  });
});
