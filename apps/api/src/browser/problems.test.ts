// Every sentence core's scriptProblems says has a code here (./problems.ts): a reworded sentence
// fails this test instead of reaching the portal as "other".

import { BrowserScriptDefinition, scriptProblems } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { invalidProblem, problemOf } from "./problems";

const ORIGIN = "https://portal.supplier.test";

function problems(def: Record<string, unknown>) {
  const parsed = BrowserScriptDefinition.parse({
    schemaVersion: 1,
    site: "supplier",
    name: "Script",
    ...def,
  });
  return scriptProblems(parsed).map(problemOf);
}

describe("script problems as codes", () => {
  it("gives every sentence core says a code and its values", () => {
    const found = [
      ...problems({
        inputs: [
          { name: "sku", label: "SKU", type: "text", example: "A" },
          { name: "sku", label: "SKU", type: "text", example: "A" },
          { name: "unused", label: "Unused", type: "text", example: "A" },
        ],
        outputs: [
          { name: "submitted", label: "Submitted", type: "text" },
          { name: "table", label: "Table", type: "table" },
          { name: "twice", label: "Twice", type: "text" },
          { name: "never", label: "Never", type: "text" },
        ],
        steps: [
          { id: "s1", op: "open", url: `${ORIGIN}/orders?sku={{missing}}` },
          { id: "s1", op: "read_field", selector: "#a", output: "nowhere" },
          { id: "s3", op: "read_field", selector: "#b", output: "table" },
          { id: "s4", op: "read_field", selector: "#c", output: "twice" },
          { id: "s5", op: "read_field", selector: "#d", output: "twice" },
          { id: "s6", op: "click", selector: "#go", submits: true },
          { id: "s7", op: "click", selector: "#again", submits: true },
          { id: "s8", op: "read_field", selector: "#e", output: "submitted" },
        ],
        sideEffect: "none",
        undo: {
          kind: "reverse",
          script: "cancel-order",
          inputs: { a: { input: "nope" }, b: { output: "nada" } },
        },
      }),
      ...problems({
        steps: [{ id: "s1", op: "open", url: `${ORIGIN}/orders` }],
        sideEffect: "external",
      }),
      ...problems({
        steps: [
          { id: "s1", op: "click", selector: "#go", submits: true },
          { id: "s2", op: "open", url: `${ORIGIN}/orders` },
        ],
        sideEffect: "external",
      }),
    ];
    expect(found.filter((p) => p.code === "other")).toEqual([]);
    const codes = new Set(found.map((p) => p.code));
    for (const code of [
      "duplicate_name",
      "reserved_output",
      "unknown_input",
      "unknown_output",
      "output_type",
      "unused_input",
      "output_read_twice",
      "unread_output",
      "submit_not_write",
      "submits_twice",
      "submit_not_last",
      "reverse_not_write",
      "reverse_unknown_input",
      "reverse_unknown_output",
      "write_without_submit",
    ] as const) {
      expect(codes.has(code), code).toBe(true);
    }
    expect(found).toContainEqual({
      code: "unknown_input",
      params: { step: "s1", name: "missing" },
      text: "step s1 uses missing, which isn't an input",
    });
  });

  it("words the API's own sentences too", () => {
    expect(problemOf("nothing is recorded yet").code).toBe("empty");
    expect(problemOf("this site is no longer in our catalogue").code).toBe("site_gone");
    expect(
      problemOf("step s2 opens https://elsewhere.test/x: agents never open this page"),
    ).toEqual({
      code: "off_site",
      params: {
        step: "s2",
        url: "https://elsewhere.test/x",
        reason: "agents never open this page",
      },
      text: "step s2 opens https://elsewhere.test/x: agents never open this page",
    });
    expect(invalidProblem("steps", "too short")).toEqual({
      code: "invalid",
      params: { path: "steps", message: "too short" },
      text: "steps: too short",
    });
    expect(problemOf("something new").code).toBe("other");
  });
});
