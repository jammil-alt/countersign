// P-4: conversations (docs/plan.md §1.66): the step's settings, its validation in the one validator,
// the result typed for later steps, the model's answer and the confirmation rule.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillDefinition } from "../schemas/skill";
import { validateWorkflow } from "../workflow/validate";
import {
  CONVERSE_FIXED_INPUTS,
  CONVERSE_SKILL,
  ConverseAnswer,
  ConverseInput,
  ConverseOutput,
  converseProblems,
  converseTurnSchema,
  doneProblem,
} from "./index";

const RESULT = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, qty: { type: "number" } },
        required: ["name", "qty"],
      },
    },
    neededBy: { type: "string" },
  },
  required: ["items"],
};

const input = (over: Record<string, unknown> = {}) => ({
  to: { contactId: "{{trigger.contactId}}" },
  channel: "whatsapp",
  goal: "Get the exact item list for this purchase request.",
  result: RESULT,
  opening: "Thank them and ask which items and how many.",
  ...over,
});

const json = (s: z.ZodType) =>
  z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;

const SKILL = SkillDefinition.parse({
  schemaVersion: 1,
  id: CONVERSE_SKILL,
  name: "Talk with a person",
  description: "x",
  category: "people",
  mode: "tool",
  handler: "comms.converse",
  tools: [],
  input: json(ConverseInput),
  output: json(ConverseOutput),
  settings: [],
  fixedInputs: [...CONVERSE_FIXED_INPUTS],
  reachesPeople: true,
  resultFromInput: "result",
});

function wf(stepInput: Record<string, unknown>, after: string) {
  return {
    schemaVersion: 3,
    trigger: {
      id: "t",
      on: {
        type: "manual",
        input: {
          type: "object",
          properties: { contactId: { type: "string" } },
          required: ["contactId"],
        },
      },
    },
    steps: [
      { id: "talk", name: "Clarify", kind: "skill", skill: CONVERSE_SKILL, input: stepInput },
      {
        id: "tell",
        name: "Tell",
        kind: "notify",
        channel: "thread",
        message: after,
      },
    ],
  };
}

describe("conversation settings", () => {
  it("parses with defaults and caps", () => {
    const v = ConverseInput.parse(input());
    expect(v.limits).toEqual({
      maxMessages: 6,
      waitPerReply: "1 day",
      deadline: "3 days",
      maxCostUsd: "0.50",
    });
    expect(v.confirm).toBe(true);
    expect(ConverseInput.safeParse(input({ limits: { maxMessages: 13 } })).success).toBe(false);
    expect(ConverseInput.safeParse(input({ channel: "voice" })).success).toBe(false);
  });

  it("checks what the schema can't: result shape, channel for who, limits, the template", () => {
    expect(converseProblems(input())).toEqual([]);
    const fields = (i: unknown) => converseProblems(i).map((p) => p.field);
    expect(fields(input({ result: { type: "string" } }))).toEqual(["result"]);
    expect(fields(input({ result: { type: "object", properties: {} } }))).toEqual(["result"]);
    expect(fields(input({ to: { userId: "u" } }))).toEqual(["channel"]);
    expect(fields(input({ channel: "portal" }))).toEqual(["channel"]);
    expect(
      fields(input({ channel: "sms", whatsappTemplate: { id: "HX1", variables: {} } })),
    ).toEqual(["whatsappTemplate"]);
    expect(fields(input({ limits: { waitPerReply: "8 days", deadline: "10 days" } }))).toEqual([
      "limits.waitPerReply",
    ]);
    expect(fields(input({ limits: { deadline: "15 days" } }))).toEqual(["limits.deadline"]);
    expect(fields(input({ limits: { waitPerReply: "2 days", deadline: "1 day" } }))).toEqual([
      "limits.waitPerReply",
    ]);
    expect(fields(input({ limits: { maxCostUsd: "6" } }))).toEqual(["limits.maxCostUsd"]);
  });
});

describe("validation and typing", () => {
  const ctx = { skills: { [CONVERSE_SKILL]: SKILL } };

  it("a valid step passes, and a later step reads the result typed", () => {
    const r = validateWorkflow(wf(input(), "First item: {{steps.talk.output.result.items}}"), ctx);
    expect(r.errors).toEqual([]);
    const bad = validateWorkflow(wf(input(), "{{steps.talk.output.result.colour}}"), ctx);
    expect(bad.errors.map((e) => [e.stepId, e.code])).toEqual([["tell", "template_path"]]);
  });

  it("refuses a templated goal, result or opening (they become instructions)", () => {
    for (const f of CONVERSE_FIXED_INPUTS) {
      const r = validateWorkflow(wf(input({ [f]: "{{trigger.contactId}}" }), "x"), ctx);
      expect(r.errors.some((e) => e.code === "input_not_fixed" && e.field === `input.${f}`)).toBe(
        true,
      );
    }
  });

  it("reports converse problems on the step's field", () => {
    const r = validateWorkflow(wf(input({ channel: "portal" }), "x"), ctx);
    expect(r.errors).toContainEqual(
      expect.objectContaining({ stepId: "talk", field: "input.channel", code: "converse_invalid" }),
    );
  });
});

describe("the model's answer", () => {
  it("has no field for a recipient, channel, approval or limit", () => {
    const schema = converseTurnSchema(RESULT);
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      ["action", "closing", "confirmed", "message", "reason", "result"].sort(),
    );
    expect(
      ConverseAnswer.safeParse({ action: "ask", message: "hi", to: "+15550000000" }).success,
    ).toBe(false);
  });

  it("finishes only after a confirmed confirm, when asked to confirm", () => {
    const done = { action: "done" as const, result: {}, confirmed: true };
    expect(doneProblem(done, true, "ask")).toMatch(/confirm/);
    expect(doneProblem({ ...done, confirmed: false }, true, "confirm")).toMatch(/hasn't/);
    expect(doneProblem(done, true, "confirm")).toBeNull();
    expect(doneProblem({ ...done, confirmed: false }, false, null)).toBeNull();
  });
});
