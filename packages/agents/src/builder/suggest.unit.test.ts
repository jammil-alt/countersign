// Suggest's backend against scripted model answers (FakeModel): whatever the model says, the step
// that comes back is one the form accepts, keeps its id and kind, and never loosens an approval.

import type { steps } from "@countersign/core";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import {
  approvalLoosened,
  onlyField,
  type SuggestAsk,
  type SuggestWorld,
  suggestStep,
} from "./suggest";

const world: SuggestWorld = {
  actions: [
    { id: "qbo.bill.create", label: "QuickBooks › Create bill", kind: "change" },
    { id: "qbo.vendor.get", label: "QuickBooks › Get vendor", kind: "get" },
  ],
  skills: [{ ref: "custom:pick-account", name: "Pick account", description: "Sets the account" }],
  context: {
    sideEffect: (id) => (id === "qbo.bill.create" ? "external" : "none"),
  },
};

const DO = {
  id: "s1",
  kind: "do",
  name: "Pick the account",
  doneBy: "rules",
  input: {},
  rules: { rows: [] },
} as unknown as steps.DoStep;

const END = {
  id: "e1",
  kind: "end",
  name: "Done",
  outputs: ["o1"],
  status: "succeeded",
} as unknown as steps.EndStep;

const workflowOf = (step: steps.Step): steps.Workflow =>
  ({
    schemaVersion: 5,
    triggers: [],
    outputs: [{ id: "o1", name: "Result", kind: "nothing" }],
    steps: [step, END],
  }) as unknown as steps.Workflow;

const ask = (over: Partial<SuggestAsk> = {}, step: steps.Step = DO): SuggestAsk => ({
  workflow: workflowOf(step),
  stepId: step.id,
  how: "tell",
  text: "Home Depot is materials",
  ...over,
});

const row = {
  id: "home-depot",
  when: { match: "all", rules: [{ field: "{{input.vendor}}", op: "=", value: "Home Depot" }] },
  set: { account: "Materials" },
};

function run(a: SuggestAsk, answer: unknown) {
  const model = new FakeModel([{ toolUse: { name: "submit_suggestion", input: answer } }]);
  return {
    model,
    result: suggestStep(a, world, { llm: createLlmClient({ transport: model }) }),
  };
}

describe("suggestStep", () => {
  it("applies what the person asked for, as a step the form accepts", async () => {
    const { result, model } = run(ask(), {
      summary: "Added a rule: Home Depot sets the account to Materials.",
      step: { ...DO, rules: { rows: [row] } },
    });
    const out = await result;
    expect(out.applied).toBe(true);
    expect((out.step as steps.DoStep).rules?.rows).toHaveLength(1);
    expect(out.summary).toMatch(/Home Depot/);
    // The person's words reach the model as data in a tag, and the model's call is recorded.
    const sent = JSON.stringify(model.requests[0]?.messages);
    expect(sent).toContain("<instruction>");
    expect(out.calls).toHaveLength(1);
  });

  it("never changes the step's id or kind", async () => {
    const { result } = run(ask(), {
      summary: "ok",
      step: { ...DO, id: "other", rules: { rows: [row] } },
    });
    const out = await result;
    expect(out.applied).toBe(false);
    expect(out.step).toEqual(DO);
    expect(out.summary).toMatch(/which step this is/);

    const kind = await run(ask(), {
      summary: "ok",
      step: { id: "s1", kind: "wait", name: "x", for: "1h" },
    }).result;
    expect(kind.applied).toBe(false);
  });

  it("never loosens an approval, nor adds one that doesn't always ask", async () => {
    const guarded = {
      ...DO,
      uses: { type: "action", action: "qbo.bill.create" },
      checks: {
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      },
    } as unknown as steps.DoStep;
    const off = await run(ask({}, guarded), {
      summary: "Turned the approval off.",
      step: { ...guarded, checks: {} },
    }).result;
    expect(off.applied).toBe(false);
    expect(off.step).toEqual(guarded);
    expect(off.summary).toMatch(/loosen an approval/);

    const conditional = await run(ask({}, guarded), {
      summary: "Only asks over $500.",
      step: {
        ...guarded,
        checks: {
          approval: {
            ...guarded.checks?.approval,
            when: { match: "all", rules: [{ field: "{{input.total}}", op: ">", value: 500 }] },
          },
        },
      },
    }).result;
    expect(conditional.applied).toBe(false);
  });

  it("holds a field's suggestion to that field", async () => {
    const out = await run(ask({ field: "goal", text: "Name it plainly" }), {
      summary: "Renamed it.",
      // It also tried to add a rule and move to AI: only the goal (the step's name) is taken.
      step: {
        ...DO,
        name: "Set the account from the vendor",
        doneBy: "ai",
        rules: { rows: [row] },
      },
    }).result;
    expect(out.applied).toBe(true);
    const step = out.step as steps.DoStep;
    expect(step.name).toBe("Set the account from the vendor");
    expect(step.doneBy).toBe("rules");
    expect(step.rules?.rows).toEqual([]);
  });

  it("refuses an action or a skill that isn't in the catalog", async () => {
    const ghost = await run(ask({ how: "default", text: undefined }), {
      summary: "Uses a new action.",
      step: { ...DO, uses: { type: "action", action: "qbo.ghost" } },
    }).result;
    expect(ghost.applied).toBe(false);
    expect(ghost.summary).toMatch(/isn't in the catalog/);

    const real = await run(ask({ how: "default", text: undefined }), {
      summary: "Uses Pick account.",
      step: { ...DO, uses: { type: "skill", skill: "custom:pick-account" } },
    }).result;
    expect(real.applied).toBe(true);
  });

  it("doesn't apply what leaves the step flagged by the publish checks", async () => {
    // Rules using nothing and no rule rows is flagged already; a step that adds a new flag isn't applied.
    const out = await run(ask({ text: "Make it a person" }), {
      summary: "Made it a person step.",
      step: { ...DO, doneBy: "person", rules: undefined },
    }).result;
    expect(out.applied).toBe(false);
    expect(out.summary).toMatch(/flagged/);
  });

  it("Resolve fixes what is flagged, and says when nothing is", async () => {
    const empty = { ...DO, name: "" } as steps.DoStep;
    const fixed = await run(ask({ how: "resolve", text: undefined }, empty), {
      summary: "Gave it a goal.",
      step: { ...empty, name: "Pick the account" },
    }).result;
    expect(fixed.applied).toBe(true);
    expect((fixed.step as steps.DoStep).name).toBe("Pick the account");

    // A step that is fine: no model call at all.
    const model = new FakeModel([]);
    const clean = { ...DO, rules: { rows: [row] } } as unknown as steps.DoStep;
    const none = await suggestStep(ask({ how: "resolve", text: undefined }, clean), world, {
      llm: createLlmClient({ transport: model }),
    });
    expect(none).toMatchObject({ applied: false, summary: "Nothing is flagged on this step." });
    expect(model.requests).toHaveLength(0);

    // Resolve that doesn't fix it is not applied.
    const stuck = await run(ask({ how: "resolve", text: undefined }, empty), {
      summary: "Tried.",
      step: { ...empty, purpose: "Because" },
    }).result;
    expect(stuck.applied).toBe(false);
  });

  it("asks nothing of the model when 'tell it' has no words", async () => {
    const model = new FakeModel([]);
    const out = await suggestStep(ask({ text: undefined }), world, {
      llm: createLlmClient({ transport: model }),
    });
    expect(out.applied).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("says when it changed nothing", async () => {
    const out = await run(ask(), { summary: "Nothing to add.", step: DO }).result;
    expect(out).toMatchObject({ applied: false, summary: "Nothing needed changing." });
  });
});

describe("the guards by themselves", () => {
  it("takes only the instructions blocks for 'instructions'", () => {
    const proposed = { ...DO, name: "Renamed", rules: { rows: [row] } };
    const next = onlyField(DO, proposed, "instructions") as steps.DoStep;
    expect(next.name).toBe(DO.name);
    expect(next.rules?.rows).toHaveLength(1);
  });

  it("reads a field path into the step", () => {
    const proposed = { ...DO, input: { vendor: "{{trigger.vendor}}", extra: "x" } };
    const next = onlyField(DO, proposed, "input.vendor") as steps.DoStep;
    expect(next.input).toEqual({ vendor: "{{trigger.vendor}}" });
  });

  it("an approval that was on stays on", () => {
    const on = {
      ...DO,
      checks: {
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      },
    } as unknown as steps.Step;
    expect(approvalLoosened(on, on)).toBeNull();
    expect(approvalLoosened(DO, on)).toBeNull();
    expect(approvalLoosened(on, DO)).toMatch(/loosen/);
  });
});
