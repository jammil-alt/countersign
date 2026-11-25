// A Loop step picks a saved Loop (docs/step-model-plan.md §8): it takes the Loop's goal, reads,
// turns, output and checks; it may read only what the Loop reads; and it goes back to being written
// in the step. The usesContext builds the choices from the builder's catalog.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { usesContextFrom } from "../../builder/steps/catalog";
import type { StepFormEnv } from "../../builder/steps/form-kit";
import { newStep } from "../../builder/steps/model";
import { LoopForm } from "../../builder/steps/OtherForms";
import { indexCatalog, type LoopChoice, NO_USES_CONTEXT } from "../../builder/steps/options";
import type { Step, Workflow } from "../../builder/steps/types";
import { formFromStep, fromSavedLoop, writeInStep } from "./use-loop";

type LoopStep = Extract<Step, { kind: "loop" }>;
let n = 0;
const id = () => `l${++n}`;

const SAVED: LoopChoice = {
  ref: "custom:find-why",
  name: "Find why",
  description: "Looks a record up and says why it is off.",
  goal: "Say why the record is off.",
  reads: ["qbo.vendor.query"],
  maxTurns: 6,
  atLimit: "hand_back",
  output: [{ name: "why", type: "text", required: true }],
  conferFocus: "Is the cause right?",
  review: "always",
};

const action = (id: string, label: string, kind: "get" | "change") => ({
  id,
  label,
  description: "",
  kind,
  input: [],
  output: [],
});

function env(loops: LoopChoice[]): StepFormEnv {
  return {
    workflow: { schemaVersion: 5, triggers: [], outputs: [], steps: [] } as unknown as Workflow,
    uses: {
      ...NO_USES_CONTEXT,
      loops,
      actions: indexCatalog([
        {
          type: "connector",
          id: "qbo",
          name: "QuickBooks",
          actions: [
            action("qbo.vendor.query", "Find vendors", "get"),
            action("qbo.bill.query", "Find bills", "get"),
            action("qbo.bill.create", "Create bill", "change"),
          ],
        },
      ]),
    },
    trigger: [],
    people: { members: [], people: [] },
    suggest: vi.fn(),
    models: [],
  } as unknown as StepFormEnv;
}

describe("a Loop step and a saved Loop", () => {
  it("takes the Loop's goal, reads, turns, output and checks, and keeps its own name", () => {
    const step = { ...(newStep("loop", id) as LoopStep), name: "Look into the leftovers" };
    const next = fromSavedLoop(step, SAVED);
    expect(next).toMatchObject({
      id: step.id,
      name: "Look into the leftovers",
      skill: "custom:find-why",
      goal: "Say why the record is off.",
      reads: ["qbo.vendor.query"],
      maxTurns: 6,
      atLimit: "hand_back",
      instructions: "",
      review: "always",
      checks: { confer: { with: [{ ai: { focus: "Is the cause right?" } }] } },
    });
    expect(next.output).toEqual([{ name: "why", type: "text", required: true }]);
    // Written in the step again: no skill, what it had kept.
    const back = writeInStep(next);
    expect(back).not.toHaveProperty("skill");
    expect(back.goal).toBe("Say why the record is off.");
  });

  it("offers only the Loop's own reads once one is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const step = fromSavedLoop(newStep("loop", id) as LoopStep, SAVED);
    render(
      <MemoryRouter>
        <LoopForm step={step} env={env([SAVED])} issues={[]} onChange={onChange} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Find vendors")).toBeTruthy();
    // A Get the Loop doesn't read, and a change, are not offered.
    expect(screen.queryByLabelText("Find bills")).toBeNull();
    expect(screen.queryByLabelText("Create bill")).toBeNull();
    // Back to written in the step: all the Gets come back.
    await user.selectOptions(screen.getByLabelText("Saved Loop"), "");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ skill: expect.anything() }),
    );
  });

  it("picks a saved Loop from the list", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LoopForm
          step={newStep("loop", id) as LoopStep}
          env={env([SAVED])}
          issues={[]}
          onChange={onChange}
        />
      </MemoryRouter>,
    );
    await user.selectOptions(screen.getByLabelText("Saved Loop"), "custom:find-why");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "custom:find-why", reads: ["qbo.vendor.query"] }),
    );
  });

  it("carries a Loop written in the step to the designer as a form", () => {
    const step = {
      ...(newStep("loop", id) as LoopStep),
      name: "Look into the leftovers",
      goal: "Find why.",
      reads: ["qbo.vendor.query"],
      maxTurns: 7,
      output: [{ name: "why", type: "text" as const, required: true }],
    };
    expect(formFromStep(step)).toMatchObject({
      name: "Look into the leftovers",
      slug: "look-into-the-leftovers",
      goal: "Find why.",
      reads: ["qbo.vendor.query"],
      maxTurns: 7,
      output: [{ key: "why", type: "string", required: true }],
    });
    // A Loop written in the step offers Save as Loop; a saved one doesn't.
    render(
      <MemoryRouter>
        <LoopForm step={step} env={env([])} issues={[]} onChange={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Save as Loop" })).toBeTruthy();
  });

  it("shows no picker when there is no saved Loop", () => {
    render(
      <MemoryRouter>
        <LoopForm
          step={newStep("loop", id) as LoopStep}
          env={env([])}
          issues={[]}
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("Saved Loop")).toBeNull();
  });
});

describe("the builder's catalog and Loops", () => {
  it("lists saved Loops apart from the palette's skills", () => {
    const def = (extra: object) => ({
      name: "X",
      description: "",
      input: { type: "object" },
      output: { type: "object", properties: { why: { type: "string" } } },
      reads: ["qbo.vendor.query"],
      ...extra,
    });
    const ctx = usesContextFrom({
      actions: [],
      catalog: {
        automations: [],
        skills: [
          {
            ref: "custom:find-why",
            source: "shared",
            version: 1,
            kind: "ai",
            palette: false,
            definition: def({ loop: { goal: "Why?", maxTurns: 4, atLimit: "stop" } }),
          },
          {
            ref: "docs.read",
            source: "builtin",
            version: null,
            kind: "ai",
            palette: true,
            definition: def({}),
          },
        ],
      } as never,
    });
    expect(ctx.skills.map((s) => s.ref)).toEqual(["docs.read"]);
    expect(ctx.loops?.map((l) => [l.ref, l.goal, l.maxTurns, l.reads])).toEqual([
      ["custom:find-why", "Why?", 4, ["qbo.vendor.query"]],
    ]);
  });
});
