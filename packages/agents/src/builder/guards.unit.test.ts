// The Builder's shared guard helpers: `replaceTemplates` reads `{{…}}` references without the
// quadratic regular expression it replaces. (What the guards hold in a v5 bundle is tested with the
// step model's: `./step-model/step-model.test.ts`.)

import { describe, expect, it } from "vitest";
import { plainPurpose, replaceTemplates } from "./guards";

describe("replaceTemplates", () => {
  // The regular expression it replaces (CodeQL js/polynomial-redos), as the reference.
  const reference = (text: string, fn: (inner: string) => string): string =>
    text.replace(/\{\{([^}]*)\}\}/g, (_whole, inner: string) => fn(inner));
  const mark = (inner: string): string => `<${inner}>`;

  it("matches the regular expression on hand-picked cases", () => {
    for (const text of [
      "",
      "plain",
      "{{steps.a.out}}",
      "a {{x}} b {{y}} c",
      "{{{x}}}",
      "{{a}b}}",
      "{{a} {{b}}",
      "{{ open",
      "}} {{ }",
      "{{}}",
      "{{{{}}}}",
    ]) {
      expect(replaceTemplates(text, mark)).toBe(reference(text, mark));
    }
  });

  it("matches the regular expression on random strings of braces", () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = ["{", "}", "a", " "];
    for (let n = 0; n < 2000; n++) {
      const length = next() % 14;
      let text = "";
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length];
      expect(replaceTemplates(text, mark)).toBe(reference(text, mark));
    }
  });

  it("is quick on a long run of {{ with no }}", () => {
    const text = `${"{{".repeat(50_000)}x`;
    const started = Date.now();
    expect(replaceTemplates(text, mark)).toBe(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// Staging, 2026-11-25: "Too big: expected string to have <=200 characters → at
// workflows[0].workflow.steps[1].purpose". A purpose checked with short ids grew past the limit
// once its {{steps.…}} references got their real ids, and the turn failed after the model answered.
describe("guards: a step's purpose stays plain and within the limit", () => {
  const ID = "01a2104a-928c-78c6-84dd-828e77acf308";

  it("takes references out of a purpose and leaves short plain ones alone", () => {
    expect(plainPurpose("Looks the vendor up so the bill goes to the right vendor")).toBe(
      "Looks the vendor up so the bill goes to the right vendor",
    );
    expect(
      plainPurpose(`Compares the vendor ({{steps.${ID}.vendor}}) with earlier invoices.`),
    ).toBe("Compares the vendor with earlier invoices.");
    expect(plainPurpose(`{{steps.${ID}.output}}`)).toBeNull();
  });

  it("cuts a long one at its last sentence, else its last word, within 200", () => {
    const first = `Checks the vendor and invoice number against invoices this agent already reviewed${", so a repeat stops early".repeat(3)}.`;
    const long = `${first} ${"Then it goes on to match the lines. ".repeat(4)}`;
    // The last whole sentence that fits.
    expect(plainPurpose(long)).toBe(`${first} Then it goes on to match the lines.`);
    const words = plainPurpose("word ".repeat(60)) ?? "";
    expect(words.length).toBeLessThanOrEqual(200);
    expect(words.endsWith("word…")).toBe(true);
  });
});
