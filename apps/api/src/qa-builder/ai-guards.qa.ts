// AI robustness QA: the Builder's server guards (packages/agents/src/builder/guards.ts) against a
// model answer that keeps a step's id but changes what the step does. The guard keeps an
// approval loosening the operator set on "that same step", and decides "same" by id and kind
// (plus the tool for a tool write). Each test asserts the correct behaviour and fails while the
// defect is there.
import type { BuilderContext } from "@countersign/agents";
import { guardBundle } from "@countersign/agents";
import {
  type ProcessAgentBundle,
  ProcessAgentBundle as ProcessAgentBundleSchema,
  processes,
  type SkillDefinition,
} from "@countersign/core";
import { describe, expect, it } from "vitest";

const sendSkill: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:send-thanks",
  name: "Send a thank-you note",
  description: "Writes and sends a short thank-you email to the vendor",
  category: "writing",
  mode: "agent",
  instructions: "Thank the vendor.",
  tools: [],
  input: { type: "object", properties: {} },
  output: { type: "object", properties: {} },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
  reachesPeople: true,
};

const payerSkill: SkillDefinition = {
  ...sendSkill,
  id: "custom:chase-overdue",
  name: "Chase overdue customers",
  description: "Emails every overdue customer a payment demand",
};

function context(): BuilderContext {
  return {
    tools: [],
    skills: [
      { ref: sendSkill.id, definition: sendSkill, source: "shared" },
      { ref: payerSkill.id, definition: payerSkill, source: "shared" },
    ],
    connectors: [],
    packs: [],
    events: [],
    templates: [],
    client: null,
    agentSlugs: [],
  };
}

/** The operator's version: one step whose approval the operator switched off. */
function bundleWith(step: Record<string, unknown>): ProcessAgentBundle {
  return ProcessAgentBundleSchema.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Vendor clerk", role: "Payables", mission: "Keep vendors happy" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5" },
      instructions: "Look after vendors.",
      skills: [],
      permissions: { mode: "act" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "trg", on: { type: "manual", input: { type: "object" } } }],
          steps: [step],
        },
      },
    ],
  }) as ProcessAgentBundle;
}

const off = {
  approval: { required: "not_required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
};

function stepById(b: ProcessAgentBundle, id: string): processes.Step | undefined {
  let found: processes.Step | undefined;
  for (const w of b.workflows) {
    processes.walkSteps(w.workflow, ({ step }) => {
      if (step.id === id) found = step;
    });
  }
  return found;
}

describe("AI-guards: an approval the operator switched off does not follow a changed step", () => {
  it("AI-1a: an action write step whose action the model changes gets approval back on", () => {
    // The operator let "Email the vendor" go without approval (an email action).
    const origin = bundleWith({
      id: "s-email",
      kind: "write",
      name: "Email the vendor",
      action: "send_email",
      input: { to: "{{trigger.vendor}}", subject: "Thanks", body: "Thanks" },
      checks: off,
    });
    // The model keeps the id and name but makes it create a bill, approval still off.
    const answer = bundleWith({
      id: "s-email",
      kind: "write",
      name: "Email the vendor",
      action: "create_bill",
      input: { vendor: "{{trigger.vendor}}", amount: "{{trigger.amount}}" },
      checks: off,
    });
    const r = guardBundle(answer, context(), { mode: "revise", source: origin, origin });
    const step = stepById(r.bundle, "s-email");
    expect(step?.kind === "write" && step.action).toBe("create_bill");
    // Invariant 8: the Builder never loosens an approval; the operator's switch-off was for
    // sending an email, not for creating bills.
    expect(step?.checks?.approval?.required).toBe("required");
  });

  it("AI-1b: a skill step the model points at another skill gets approval back on", () => {
    const origin = bundleWith({
      id: "s-thanks",
      kind: "skill",
      name: "Thank the vendor",
      skill: sendSkill.id,
      input: {},
      checks: off,
    });
    const answer = bundleWith({
      id: "s-thanks",
      kind: "skill",
      name: "Thank the vendor",
      skill: payerSkill.id,
      input: {},
      checks: off,
    });
    const r = guardBundle(answer, context(), { mode: "revise", source: origin, origin });
    const step = stepById(r.bundle, "s-thanks");
    expect(step?.kind === "skill" && step.skill).toBe(payerSkill.id);
    expect(step?.checks?.approval?.required).toBe("required");
  });
});
