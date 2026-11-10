import { describe, expect, it } from "vitest";
import {
  BrowserScriptDefinition,
  type BrowserScriptDefinitionInput,
  fillScriptUrl,
  scriptFieldValue,
  scriptInputSchema,
  scriptOutputSchema,
  scriptProblems,
} from "./script";

const ORDER: BrowserScriptDefinitionInput = {
  schemaVersion: 1,
  site: "supplier",
  name: "Place an order",
  inputs: [
    { name: "sku", label: "SKU", type: "text" },
    { name: "qty", label: "Quantity", type: "integer" },
  ],
  outputs: [{ name: "price", label: "Unit price", type: "decimal" }],
  steps: [
    { id: "s1", op: "open", url: "https://portal.supplier.test/orders/new" },
    { id: "s2", op: "fill", selector: "#sku", value: { input: "sku" } },
    { id: "s3", op: "fill", selector: "#qty", value: { input: "qty" } },
    { id: "s4", op: "read_field", selector: "#price", output: "price" },
    { id: "s5", op: "click", selector: "#place", submits: true },
  ],
  sideEffect: "external",
};

const def = (over: Partial<BrowserScriptDefinitionInput> = {}) =>
  BrowserScriptDefinition.parse({ ...ORDER, ...over });

describe("a script's problems", () => {
  it("has none for a write that submits last", () => {
    expect(scriptProblems(def())).toEqual([]);
  });

  it("holds its side effect to whether it submits, once and last", () => {
    expect(scriptProblems(def({ sideEffect: "none" }))).toContain(
      "a script that submits a form is a write (side effect external)",
    );
    const steps = [...(ORDER.steps ?? [])];
    const moved = [steps[0], steps[4], steps[1], steps[2], steps[3]] as typeof steps;
    expect(scriptProblems(def({ steps: moved }))).toContain("the submit is the script's last step");
    const read = def({
      sideEffect: "external",
      steps: (ORDER.steps ?? []).slice(0, 4),
    });
    expect(scriptProblems(read)).toContain(
      "a write script submits: mark the click that sends the form",
    );
  });

  it("checks inputs used and outputs read, once each and of a fitting kind", () => {
    const p = scriptProblems(
      def({
        inputs: [...(ORDER.inputs ?? []), { name: "note", label: "Note", type: "text" }],
        outputs: [
          { name: "price", label: "Price", type: "table" },
          { name: "url", label: "Kept", type: "text" },
        ],
      }),
    );
    expect(p).toContain("no step uses the input note");
    expect(p).toContain("step s4 can't read price as table");
    expect(p).toContain("\"url\" can't be an output's name");
    expect(p).toContain("no step reads the output url");
  });

  it("names a reverse script only for a write, from its own values", () => {
    const p = scriptProblems(
      def({
        sideEffect: "none",
        steps: (ORDER.steps ?? []).slice(0, 4),
        undo: { kind: "reverse", script: "cancel", inputs: { order: { output: "number" } } },
      }),
    );
    expect(p).toContain("only a write names a reverse script");
    expect(p).toContain("the reverse script's order comes from number, which isn't an output");
  });
});

describe("a script's values", () => {
  it("types inputs strictly: decimals as strings, never an undeclared input", () => {
    const schema = scriptInputSchema(def());
    expect(schema.safeParse({ sku: "OAK-1", qty: 2 }).success).toBe(true);
    expect(schema.safeParse({ sku: "OAK-1", qty: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ sku: "OAK-1", qty: 2, other: 1 }).success).toBe(false);
  });

  it("reads a field as its output's type, and a write gives back whether it submitted", () => {
    expect(scriptFieldValue("decimal", " $1,212.50 ")).toBe("1212.50");
    expect(scriptFieldValue("decimal", "(12.00)")).toBe("-12.00");
    expect(scriptFieldValue("integer", "42")).toBe(42);
    expect(scriptFieldValue("integer", "about 40")).toBe("about 40");
    const out = scriptOutputSchema(def());
    expect(out.safeParse({ price: "1212.50", submitted: true, url: "x" }).success).toBe(true);
    expect(out.safeParse({ price: "about", submitted: true, url: "x" }).success).toBe(false);
  });

  it("fills an address's inputs percent-encoded, so a value never climbs out of its path", () => {
    expect(
      fillScriptUrl("https://s.test/orders/{{id}}?q={{ q }}", { id: "../users", q: "a b" }),
    ).toBe("https://s.test/orders/..%2Fusers?q=a%20b");
  });
});
