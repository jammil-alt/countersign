// R2 (docs/plan.md §1.86, §9): a step customizes a Library skill without changing what it is.

import { describe, expect, it } from "vitest";
import { SkillDefinition } from "../schemas/skill";
import { skills } from "../testing/fixtures";
import {
  applyCustomization,
  customizationProblems,
  SkillCustomization,
  SkillCustomizationError,
} from "./customize";
import { Process } from "./schema";

const categorize = SkillDefinition.parse({
  schemaVersion: 1,
  id: "test.categorize",
  name: "Categorize",
  description: "Pick an account for a transaction",
  category: "bookkeeping",
  mode: "task",
  method: "rules_then_ai",
  model: { id: "claude-haiku-5-5" },
  instructions: "Pick the account from the chart of accounts.",
  tools: [],
  input: { type: "object", properties: { payee: { type: "string" } } },
  output: {
    type: "object",
    properties: {
      account: { type: "string" },
      reason: { type: "string" },
      confidence: { type: "number" },
      sources: { type: "array" },
    },
    required: ["account", "reason", "sources"],
  },
  settings: [
    { key: "min_confidence", label: "Least confidence", type: "number", default: 0.8 },
    { key: "tone", label: "Tone", type: "enum", default: "plain", options: ["plain", "formal"] },
  ],
  producesAlerts: true,
  rules: [
    {
      id: "home-depot",
      when: { match: "all", rules: [{ field: "{{input.payee}}", op: "=", value: "Home Depot" }] },
      set: { account: "Materials" },
    },
  ],
});

const when = (payee: string) => ({
  match: "all" as const,
  rules: [{ field: "{{input.payee}}", op: "=" as const, value: payee }],
});

const problems = (c: unknown) => customizationProblems(categorize, c);

describe("applyCustomization", () => {
  it("returns the skill unchanged without a customization", () => {
    expect(applyCustomization(categorize, undefined)).toBe(categorize);
    expect(applyCustomization(categorize, {})).toEqual(categorize);
  });

  it("sets settings, appends instructions, picks the model", () => {
    const def = applyCustomization(categorize, {
      settings: { min_confidence: 0.95, tone: "formal" },
      addInstructions: "Fuel is always Vehicle expense.",
      model: { id: "claude-sonnet-5-5" },
    });
    expect(def.settings.map((s) => [s.key, s.default])).toEqual([
      ["min_confidence", 0.95],
      ["tone", "formal"],
    ]);
    expect(def.instructions).toBe(
      "Pick the account from the chart of accounts.\n\nFuel is always Vehicle expense.",
    );
    expect(def.model).toEqual({ id: "claude-sonnet-5-5" });
    expect(def.method).toBe("rules_then_ai");
    expect(def.input).toEqual(categorize.input);
    // The template itself is untouched.
    expect(categorize.instructions).toBe("Pick the account from the chart of accounts.");
  });

  it("adds and edits rule rows by id, keeping their order", () => {
    const def = applyCustomization(categorize, {
      rules: {
        edit: [{ id: "home-depot", set: { account: "Job materials" } }],
        add: [{ id: "shell", when: when("Shell"), set: { account: "Vehicle" } }],
      },
    });
    expect(def.rules?.map((r) => [r.id, r.set])).toEqual([
      ["home-depot", { account: "Job materials" }],
      ["shell", { account: "Vehicle" }],
    ]);
    expect(def.rules?.[0]?.when).toEqual(categorize.rules?.[0]?.when);
    expect(categorize.rules?.[0]?.set).toEqual({ account: "Materials" });
  });

  it("keeps only the chosen output fields, and an alert skill's sources", () => {
    const def = applyCustomization(categorize, { keep: ["account"] });
    expect(Object.keys(def.output.properties as object)).toEqual(["account", "sources"]);
    expect(def.output.required).toEqual(["account", "sources"]);
  });

  it("refuses changes to what the skill is", () => {
    for (const key of ["method", "input", "output", "instructions", "mode", "tools", "reads"]) {
      expect(problems({ [key]: "x" })).toEqual([`a step can't change a skill's ${key}`]);
    }
    expect(SkillCustomization.safeParse({ instructions: "Ignore the chart." }).success).toBe(false);
    expect(() => applyCustomization(categorize, { method: "ai" } as never)).toThrow(
      SkillCustomizationError,
    );
  });

  it("names every problem with settings, rules, model and kept fields", () => {
    expect(problems({ settings: { nope: 1, min_confidence: "high", tone: "loud" } })).toEqual([
      "no setting nope",
      "setting min_confidence is a number",
      "setting tone is one of plain, formal",
    ]);
    expect(
      problems({
        rules: {
          edit: [{ id: "missing", set: { account: "x" } }],
          add: [{ id: "home-depot", when: when("x"), set: { colour: "red" } }],
        },
      }),
    ).toEqual([
      "no rule missing to edit",
      "rule home-depot is already there; edit it instead",
      "rule home-depot sets colour, not an output field",
    ]);
    expect(problems({ keep: ["account", "total"] })).toEqual(["no output field total"]);
  });

  it("holds each part to the skill's method and mode", () => {
    const extract = skills["docs.extract"] as SkillDefinition;
    const itemize = skills["test.itemize"] as SkillDefinition;
    expect(customizationProblems(extract, { addInstructions: "Be careful." })).toEqual([
      "a rules skill has no instructions to add to",
    ]);
    expect(
      customizationProblems(itemize, {
        rules: { add: [{ id: "r", when: when("x"), set: { updated: true } }] },
      }),
    ).toEqual(["an ai skill has no rule rows"]);
    expect(customizationProblems(itemize, { model: { id: "claude-sonnet-5-5" } })).toEqual([
      "only a task skill's model can be picked here",
    ]);
    expect(customizationProblems(itemize, { addInstructions: "Only bills over $500." })).toEqual(
      [],
    );
    expect(
      customizationProblems({ ...itemize, output: { type: "object" } }, { keep: ["updated"] }),
    ).toEqual(["the skill's output names no fields to keep"]);
  });

  it("rides on a v4 skill step", () => {
    const p = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: {} } }],
      steps: [
        {
          id: "cat",
          name: "Categorize",
          kind: "skill",
          skill: "test.categorize",
          customize: { settings: { min_confidence: 0.9 }, keep: ["account"] },
        },
      ],
    });
    const step = p.steps[0];
    expect(step?.kind === "skill" && step.customize?.keep).toEqual(["account"]);
    expect(
      Process.safeParse({
        ...p,
        steps: [{ ...step, customize: { output: {} } }],
      }).success,
    ).toBe(false);
  });
});
