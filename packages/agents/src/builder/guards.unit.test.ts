// The guard keeps an approval loosening the operator set only on that same step: a step whose id
// the model kept but whose action, skill, tool or process it changed is a different step, and its
// approval is on again (invariant 8; BUILDER_QA AI-1).
import {
  type ProcessAgentBundle,
  ProcessAgentBundle as ProcessAgentBundleSchema,
  processes,
  type SkillDefinition,
  type ToolSpec,
} from "@countersign/core";
import { DEFAULT_MODELS } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import type { BuilderContext } from "./context";
import { DEFAULT_APPROVAL, guardBundle, plainPurpose } from "./guards";

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

const chaseSkill: SkillDefinition = {
  ...sendSkill,
  id: "custom:chase-overdue",
  name: "Chase overdue customers",
  description: "Emails every overdue customer a payment demand",
};

const tool = (id: string, sideEffect: ToolSpec["sideEffect"], verb: ToolSpec["verb"]) =>
  ({
    id,
    description: id,
    sideEffect,
    verb,
    connector: "qbo",
    input: { type: "object" },
    output: { type: "object" },
  }) as unknown as ToolSpec;

function context(): BuilderContext {
  return {
    tools: [tool("qbo.bill.list", "none", "read"), tool("qbo.bill.create", "external", "create")],
    skills: [
      { ref: sendSkill.id, definition: sendSkill, source: "shared" },
      { ref: chaseSkill.id, definition: chaseSkill, source: "shared" },
    ],
    connectors: [],
    packs: [],
    events: [],
    templates: [],
    client: null,
    agentSlugs: [],
  };
}

/** An agent in act mode with one step. */
function bundleWith(step: Record<string, unknown>): ProcessAgentBundle {
  return ProcessAgentBundleSchema.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Vendor clerk", role: "Payables", mission: "Keep vendors happy" },
      kind: "functional",
      model: { id: DEFAULT_MODELS.reasoning },
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

/** The approval the operator switched off. */
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

function guarded(origin: ProcessAgentBundle, answer: ProcessAgentBundle) {
  return guardBundle(answer, context(), { mode: "revise", source: origin, origin }).bundle;
}

describe("guards: an approval the operator switched off does not follow a changed step", () => {
  const emailStep = {
    id: "s-email",
    kind: "write",
    name: "Email the vendor",
    action: "send_email",
    input: { to: "{{trigger.vendor}}", subject: "Thanks", body: "Thanks" },
    checks: off,
  };

  it("keeps the operator's switch-off on the same step", () => {
    const origin = bundleWith(emailStep);
    const step = stepById(guarded(origin, bundleWith(emailStep)), "s-email");
    expect(step?.checks?.approval?.required).toBe("not_required");
  });

  // AI-1a
  it("turns approval back on for an action write step whose action the model changed", () => {
    const origin = bundleWith(emailStep);
    // The model keeps the id and name but makes it create a bill, approval still off.
    const answer = bundleWith({
      id: "s-email",
      kind: "write",
      name: "Email the vendor",
      action: "create_bill",
      input: { vendor: "{{trigger.vendor}}", amount: "{{trigger.amount}}" },
      checks: off,
    });
    const step = stepById(guarded(origin, answer), "s-email");
    expect(step?.kind === "write" && step.action).toBe("create_bill");
    expect(step?.checks?.approval?.required).toBe("required");
  });

  it("turns approval back on for a tool write step whose tool the model changed", () => {
    const origin = bundleWith({ ...emailStep, action: undefined, tool: "qbo.bill.create" });
    const answer = bundleWith({ ...emailStep, action: "send_email" });
    const step = stepById(guarded(origin, answer), "s-email");
    expect(step?.checks?.approval?.required).toBe("required");
  });

  // AI-1b
  it("turns approval back on for a skill step the model pointed at another skill", () => {
    const thanks = {
      id: "s-thanks",
      kind: "skill",
      name: "Thank the vendor",
      skill: sendSkill.id,
      input: {},
      checks: off,
    };
    const origin = bundleWith(thanks);
    const answer = bundleWith({ ...thanks, skill: chaseSkill.id });
    const step = stepById(guarded(origin, answer), "s-thanks");
    expect(step?.kind === "skill" && step.skill).toBe(chaseSkill.id);
    expect(step?.checks?.approval?.required).toBe("required");
    // The same skill keeps the operator's switch-off.
    const same = stepById(guarded(origin, bundleWith(thanks)), "s-thanks");
    expect(same?.checks?.approval?.required).toBe("not_required");
  });

  it("drops a process step's approval overrides when the model points it at another process", () => {
    const run = {
      id: "s-run",
      kind: "process",
      name: "Follow up",
      process: "follow-up@2",
      input: {},
      approvals: { inner: off.approval },
    };
    const origin = bundleWith(run);
    const kept = stepById(guarded(origin, bundleWith(run)), "s-run");
    expect(kept?.kind === "process" && kept.approvals).toEqual({ inner: off.approval });
    const changed = stepById(
      guarded(origin, bundleWith({ ...run, process: "chase-payment@1" })),
      "s-run",
    );
    expect(changed?.kind === "process" && changed.approvals).toBeUndefined();
  });

  it("gives a kept id the model turned from a read into a write the default approval", () => {
    const origin = bundleWith({
      id: "s-bills",
      kind: "read",
      name: "List the bills",
      tool: "qbo.bill.list",
      input: {},
    });
    const answer = bundleWith({
      id: "s-bills",
      kind: "write",
      name: "List the bills",
      tool: "qbo.bill.create",
      input: {},
    });
    const step = stepById(guarded(origin, answer), "s-bills");
    expect(step?.kind).toBe("write");
    expect(step?.checks?.approval).toEqual(DEFAULT_APPROVAL);
  });
});

// Step model §10f (review of #687): what an agent may read, create and change in our own records is
// the operator's, as its mode is (invariant 9): a Builder draft keeps the operator's version's grants
// and data sets exactly, and a new agent from the Builder is granted nothing.
describe("guards: the Builder never changes an agent's record grants or data sets", () => {
  const step = {
    id: "s-email",
    kind: "write",
    name: "Email the vendor",
    action: "send_email",
    input: { to: "{{trigger.vendor}}", subject: "Thanks", body: "Thanks" },
  };
  const READ_VENDORS = {
    grants: [],
    sets: [
      {
        id: "vendors",
        name: "Vendors",
        on: true,
        grants: [{ recordType: "vendor", read: true, create: false, update: false }],
      },
    ],
  };
  const withData = (b: ProcessAgentBundle, data: unknown): ProcessAgentBundle =>
    ({ ...b, definition: { ...b.definition, data } }) as ProcessAgentBundle;

  it("keeps the operator's data sets when a draft widens them, turns them on or adds grants", () => {
    const origin = withData(bundleWith(step), READ_VENDORS);
    const wider = withData(bundleWith(step), {
      grants: [{ recordType: "bank_transaction", read: true, create: false, update: true }],
      sets: [
        {
          ...READ_VENDORS.sets[0],
          grants: [{ recordType: "vendor", read: true, create: false, update: true }],
        },
      ],
    });
    const out = guardBundle(wider, context(), { mode: "revise", source: origin, origin });
    expect(out.bundle.definition.data).toEqual(READ_VENDORS);
    // Dropped too: a draft that removes the operator's set gets it back.
    expect(guarded(origin, bundleWith(step)).definition.data).toEqual(READ_VENDORS);
  });

  it("grants a new agent from the Builder nothing", () => {
    const drafted = withData(bundleWith(step), READ_VENDORS);
    const out = guardBundle(drafted, context(), { mode: "draft" });
    expect(out.bundle.definition.data).toBeUndefined();
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

  it("guards a draft whose purpose grew past the limit instead of failing the turn", () => {
    const step = {
      id: "s-bills",
      kind: "read",
      name: "Find earlier invoices",
      tool: "qbo.bill.list",
      input: {},
    };
    const origin = bundleWith(step);
    const answer = structuredClone(origin);
    const grown = `Checks {{steps.${ID}.vendor}} and {{steps.${ID}.number}} against {{steps.${ID}.reviewed}} so an invoice this agent already reviewed stops here instead of being matched a second time by the steps below.`;
    expect(grown.length).toBeGreaterThan(200);
    (answer.workflows[0]?.workflow.steps[0] as { purpose?: string }).purpose = grown;
    const out = stepById(guarded(origin, answer), "s-bills") as { purpose?: string };
    expect(out.purpose).toBe(
      "Checks and against so an invoice this agent already reviewed stops here instead of being matched a second time by the steps below.",
    );
  });
});
