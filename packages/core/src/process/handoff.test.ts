// Hand off (owner, 2026-11-11): the step's schema and the validator's checks on it.
import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "../schemas/skill";
import { type HandoffAgent, handoffStepLabel, handoffTargetSteps, skippedReads } from "./handoff";
import { type Process, Process as ProcessSchema } from "./schema";
import { type ProcessValidationContext, validateProcess } from "./validate";

const itemize: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:itemize",
  name: "Itemize the invoice",
  description: "Itemize an invoice",
  mode: "agent",
  instructions: "Itemize it.",
  tools: [],
  input: {
    type: "object",
    properties: { documentId: { type: "string" }, total: { type: "number" } },
    required: ["documentId"],
    additionalProperties: false,
  },
  output: { type: "object" },
} as unknown as SkillDefinition;

/** Price checker: pull bills, read them, itemize (reads the pull), check prices. */
const priceChecker: Process = ProcessSchema.parse({
  schemaVersion: 4,
  triggers: [{ id: "pc-t", on: { type: "manual", input: { type: "object" } } }],
  steps: [
    { id: "pull", name: "Pull bills", kind: "skill", skill: "custom:pull", input: {} },
    {
      id: "itemize",
      name: "Itemize the invoice",
      kind: "skill",
      skill: "custom:itemize",
      input: { documentId: "{{trigger.documentId}}" },
    },
    {
      id: "check",
      name: "Check prices",
      kind: "skill",
      skill: "custom:check",
      input: { lines: "{{steps.itemize.output.lines}}", bills: "{{steps.pull.output}}" },
    },
    { id: "done", name: "Stop", kind: "stop", status: "succeeded" },
  ],
});

const typing = { skills: { "custom:itemize": itemize } };

function agents(): HandoffAgent[] {
  return [
    { slug: "ap-clerk", name: "AP bill clerk", workflow: "main", steps: [] },
    {
      slug: "price-checker",
      name: "Price checker",
      workflow: "main",
      steps: handoffTargetSteps(priceChecker, typing),
    },
    { slug: "draft-only", name: "Draft only", workflow: null, steps: [] },
  ];
}

/** AP bill clerk: read the invoice, then hand off to Price checker. */
function apClerk(handoff: Record<string, unknown>): unknown {
  return {
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
    steps: [
      { id: "read", name: "Read the invoice", kind: "skill", skill: "custom:read", input: {} },
      { id: "hand", name: "Hand off", kind: "handoff", ...handoff },
    ],
  };
}

const ctx = (): ProcessValidationContext => ({ handoff: { self: "ap-clerk", agents: agents() } });

describe("the hand-off step", () => {
  it("parses with its target and input, and empty pickers while the operator chooses", () => {
    const ok = ProcessSchema.safeParse(
      apClerk({ to: { agent: "price-checker", step: "itemize" }, input: { documentId: "x" } }),
    );
    expect(ok.success).toBe(true);
    const empty = validateProcess(apClerk({ to: { agent: "", step: "" } }));
    expect(empty.errors.map((e) => [e.field, e.code])).toEqual([
      ["to.agent", "handoff_unknown_agent"],
    ]);
    const noStep = validateProcess(apClerk({ to: { agent: "price-checker", step: "" } }));
    expect(noStep.errors.map((e) => e.message)).toEqual(["choose the step it starts at"]);
  });

  it("is valid against a started agent's live step, with the input fitting that step", () => {
    const r = validateProcess(
      apClerk({
        to: { agent: "price-checker", step: "itemize" },
        input: { documentId: "{{steps.read.output.id}}" },
      }),
      ctx(),
    );
    expect(r.errors).toEqual([]);
  });

  it("goes to another agent of the same client, never this one", () => {
    const same = validateProcess(apClerk({ to: { agent: "ap-clerk", step: "read" } }), ctx());
    expect(same.errors.map((e) => e.code)).toEqual(["handoff_same_agent"]);
    const unknown = validateProcess(apClerk({ to: { agent: "elsewhere", step: "x" } }), ctx());
    expect(unknown.errors.map((e) => e.code)).toEqual(["handoff_unknown_agent"]);
    const noLive = validateProcess(apClerk({ to: { agent: "draft-only", step: "x" } }), ctx());
    expect(noLive.errors.map((e) => e.code)).toEqual(["handoff_no_live"]);
  });

  it("starts at a step of the live version that takes an input", () => {
    const missing = validateProcess(
      apClerk({ to: { agent: "price-checker", step: "nope" } }),
      ctx(),
    );
    expect(missing.errors.map((e) => [e.field, e.code])).toEqual([
      ["to.step", "handoff_unknown_step"],
    ]);
    const stop = validateProcess(apClerk({ to: { agent: "price-checker", step: "done" } }), ctx());
    expect(stop.errors.map((e) => e.code)).toEqual(["handoff_entry_kind"]);
  });

  it("checks the input against the target step's input schema", () => {
    const r = validateProcess(
      apClerk({
        to: { agent: "price-checker", step: "itemize" },
        input: { total: "{{steps.read.output.total}}", vendor: "Acme" },
      }),
      ctx(),
    );
    expect(r.errors.map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([
        ["input.documentId", "input_missing"],
        ["input.vendor", "input_unknown"],
      ]),
    );
  });

  it("warns, without blocking, when the target's later steps read a step it skips", () => {
    const r = validateProcess(
      apClerk({ to: { agent: "price-checker", step: "itemize" }, input: { documentId: "d" } }),
      ctx(),
    );
    expect(r.valid).toBe(true);
    expect(r.warnings.filter((w) => w.code === "handoff_skips_outputs")).toEqual([
      expect.objectContaining({
        stepId: "hand",
        message: `Price checker's "Check prices" reads "Pull bills", which the hand-off skips`,
      }),
    ]);
    // Starting at the first step skips nothing.
    expect(skippedReads(agents()[1]?.steps ?? [], "pull")).toEqual([]);
  });

  it("types its output for later steps, and refuses going on past its failure", () => {
    const later = apClerk({ to: { agent: "price-checker", step: "itemize" }, input: {} }) as {
      steps: Record<string, unknown>[];
    };
    later.steps.push({
      id: "note",
      name: "Note",
      kind: "notify",
      notify: { to: ["client_admin"], message: "Run {{steps.hand.output.runId}}" },
    });
    const bad = {
      ...later,
      steps: later.steps.map((s) => (s.id === "hand" ? { ...s, onError: "continue" } : s)),
    };
    expect(validateProcess(later).errors).toEqual([]);
    expect(validateProcess(bad).errors.map((e) => e.code)).toEqual(["on_error_not_here"]);
  });

  it("names a target step by its number and name", () => {
    expect(handoffStepLabel(agents()[1]?.steps ?? [], "itemize")).toBe("2 · Itemize the invoice");
  });
});
