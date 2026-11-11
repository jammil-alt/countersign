import { SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  clean,
  definitionFromForm,
  EMPTY_FORM,
  formFromDefinition,
  schemaFromFields,
  validateSkillForm,
} from "./skill-form";

const TOOLS = [
  { id: "testkit.record.query", connector: "testkit" },
  { id: "inbox.create" },
] as const;

const stored = SkillDefinition.parse({
  schemaVersion: 1,
  id: "custom:vendor-check",
  name: "Check vendors",
  description: "Checks a bill's vendor against the list",
  category: "data",
  mode: "agent",
  instructions: "Compare the vendor with the list.",
  tools: ["testkit.record.query"],
  input: {
    type: "object",
    properties: {
      vendor: { type: "string", description: "Vendor name" },
      lines: { type: "array", items: { type: "object" } },
    },
    required: ["vendor"],
  },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  settings: [
    { key: "vendors", label: "Vendors", type: "string", default: "Acme", clientSpecific: true },
    { key: "level", label: "Level", type: "enum", default: "low", options: ["low", "high"] },
    { key: "limit", label: "Limit", type: "number", default: 500 },
  ],
  summary: "Checked {{vendor}}",
  requiresConnectors: ["testkit"],
});

describe("skill form", () => {
  it("round-trips a stored definition", () => {
    const form = formFromDefinition(stored);
    expect(form.slug).toBe("vendor-check");
    expect(form.input.map((r) => [r.key, r.type, r.required])).toEqual([
      ["vendor", "string", true],
      ["lines", "array", false],
    ]);
    expect(validateSkillForm(form)).toEqual({});
    // Skill model (2026-11-10): a stored agent-mode skill opens as AI and saves as an AI skill
    // (a task on its recommended model); everything else round-trips as it was.
    expect(form.kind).toBe("ai");
    const back = definitionFromForm(form, TOOLS, stored);
    expect(SkillDefinition.parse(clean(back))).toEqual({
      ...stored,
      mode: "task",
      model: { id: "claude-haiku-5-5" },
    });
    // An AI skill saved once round-trips exactly.
    const task = SkillDefinition.parse(clean(back));
    expect(
      SkillDefinition.parse(clean(definitionFromForm(formFromDefinition(task), TOOLS, task))),
    ).toEqual(task);
  });

  it("builds JSON Schema from fields and derives connectors from tools", () => {
    const def = definitionFromForm(
      {
        ...EMPTY_FORM,
        slug: "notes",
        name: "Notes",
        description: "Writes notes",
        instructions: "Write.",
        tools: ["testkit.record.query", "inbox.create"],
        input: [{ key: "about", type: "array", description: "", required: true, extra: {} }],
      },
      TOOLS,
    );
    expect(def.input).toEqual({
      type: "object",
      properties: { about: { type: "array", items: {} } },
      required: ["about"],
    });
    expect(def.requiresConnectors).toEqual(["testkit"]);
    expect(def.mode).toBe("task");
    expect(SkillDefinition.safeParse(clean(def)).success).toBe(true);
  });

  it("drops shapes a field can't have after its type changes", () => {
    expect(
      schemaFromFields([
        { key: "x", type: "string", description: "", required: false, extra: { items: {} } },
      ]),
    ).toEqual({ type: "object", properties: { x: { type: "string" } } });
  });

  it("says what is missing or wrong", () => {
    const errors = validateSkillForm({
      ...EMPTY_FORM,
      slug: "Bad Slug",
      producesAlerts: true,
      settings: [
        {
          key: "Mode",
          label: "",
          type: "enum",
          default: "z",
          options: "a, b",
          clientSpecific: false,
        },
      ],
    });
    expect(Object.keys(errors).sort()).toEqual([
      "description",
      "instructions",
      "name",
      "output",
      "settings.0.default",
      "settings.0.key",
      "settings.0.label",
      "slug",
    ]);
  });
});
