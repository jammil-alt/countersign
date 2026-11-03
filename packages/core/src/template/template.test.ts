import { describe, expect, it } from "vitest";
import {
  collectRefs,
  parseTemplate,
  renderSummary,
  renderTemplate,
  resolvePath,
  resolveTemplate,
  singleRef,
  TemplateSyntaxError,
} from "./template";

describe("parseTemplate", () => {
  it("splits text and references", () => {
    expect(parseTemplate("Hi {{ trigger.name }}, {{steps.a-1.output.total}}!")).toEqual([
      { type: "text", text: "Hi " },
      { type: "ref", path: ["trigger", "name"] },
      { type: "text", text: ", " },
      { type: "ref", path: ["steps", "a-1", "output", "total"] },
      { type: "text", text: "!" },
    ]);
  });

  it.each([
    ["{{trigger.x", /unclosed/],
    ["{{}}", /empty/],
    ["{{a..b}}", /invalid reference/],
    ["{{a + b}}", /invalid reference/],
    ["x }} y", /without/],
  ])("rejects %s", (t, msg) => {
    expect(() => parseTemplate(t)).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate(t)).toThrow(msg);
  });

  it("knows a single reference", () => {
    expect(singleRef("{{trigger.total}}")).toEqual(["trigger", "total"]);
    expect(singleRef("Total {{trigger.total}}")).toBeNull();
  });
});

describe("resolving", () => {
  const ctx = {
    trigger: { vendor: "Acme", total: 12, tags: ["a", "b"] },
    steps: { s1: { output: { lines: [{ qty: 2 }, { qty: 3 }] } } },
    item: { description: "Ply" },
    index: 1,
  };

  it("follows paths, indexes and length", () => {
    expect(resolvePath(ctx, ["steps", "s1", "output", "lines", "1", "qty"])).toBe(3);
    expect(resolvePath(ctx, ["steps", "s1", "output", "lines", "length"])).toBe(2);
    expect(resolvePath(ctx, ["trigger", "vendor", "length"])).toBe(4);
    expect(resolvePath(ctx, ["trigger", "missing", "deeper"])).toBeUndefined();
    expect(resolvePath(ctx, ["trigger", "constructor"])).toBeUndefined();
  });

  it("keeps the type of a whole-string reference and renders the rest as text", () => {
    expect(
      resolveTemplate(
        {
          lines: "{{steps.s1.output.lines}}",
          label: "{{trigger.vendor}} #{{index}}",
          nested: ["{{item.description}}", 5, null],
          missing: "[{{trigger.nope}}]",
        },
        ctx,
      ),
    ).toEqual({
      lines: [{ qty: 2 }, { qty: 3 }],
      label: "Acme #1",
      nested: ["Ply", 5, null],
      missing: "[]",
    });
    expect(renderTemplate("{{trigger.tags}}", ctx)).toBe('["a","b"]');
  });

  it("renders summaries over a skill's output", () => {
    expect(
      renderSummary("Extracted {{lines.length}} lines from {{header.vendor_name}}", {
        lines: [1, 2, 3],
        header: { vendor_name: "Acme" },
      }),
    ).toBe("Extracted 3 lines from Acme");
  });

  it("collects every reference with where it sits, and syntax errors", () => {
    const { refs, errors } = collectRefs({
      a: "{{trigger.x}}",
      b: ["x {{steps.s1.output.y}}"],
      c: "{{",
    });
    expect(refs.map((r) => [r.expr, r.at])).toEqual([
      ["trigger.x", ["a"]],
      ["steps.s1.output.y", ["b", 0]],
    ]);
    expect(errors).toEqual([{ at: ["c"], message: "unclosed {{" }]);
  });
});
