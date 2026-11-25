import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SaveAsSkill as Save, StepFormEnv } from "../form-kit";
import { NO_USES_CONTEXT } from "../options";
import type { DoStep, Step, Workflow } from "../types";
import { SaveAsSkill } from "./SaveAsSkill";

const written = {
  kind: "do",
  id: "s1",
  name: "Pick the account",
  doneBy: "rules",
  input: {},
  rules: { rows: [{ id: "r1", when: { match: "all", rules: [] }, set: { account: "Materials" } }] },
  output: [{ name: "account", type: "text", required: true }],
} as unknown as DoStep;

function setup(step: DoStep, save: Save | undefined) {
  const env: StepFormEnv = {
    workflow: { schemaVersion: 5, triggers: [], outputs: [], steps: [step] } as unknown as Workflow,
    uses: NO_USES_CONTEXT,
    trigger: [],
    people: { members: [], people: [] },
    suggest: async () => ({ step, summary: "", applied: false }),
    models: [],
    saveAsSkill: save,
  };
  const onChange = vi.fn<(s: Step) => void>();
  render(<SaveAsSkill step={step} env={env} onChange={onChange} />);
  return onChange;
}

describe("Save as skill", () => {
  it("names it, picks who can use it, and hands the step back using the skill", async () => {
    const user = userEvent.setup();
    const used = {
      ...written,
      uses: { type: "skill", skill: "custom:pick-the-account" },
    } as unknown as DoStep;
    const run = vi.fn(async () => used);
    const onChange = setup(written, { scopes: ["client", "shared"], run });
    await user.click(screen.getByRole("button", { name: "Save as skill" }));
    // The step's goal is the name to start from; the description is asked for.
    expect(screen.getByLabelText("Name")).toHaveValue("Pick the account");
    expect(screen.getByRole("button", { name: "Save skill" })).toBeDisabled();
    await user.type(screen.getByLabelText("Description"), "Sets the account from the vendor.");
    await user.click(screen.getByRole("radio", { name: /Shared with every client/ }));
    await user.click(screen.getByRole("button", { name: "Save skill" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(used));
    expect(run).toHaveBeenCalledWith({
      step: written,
      name: "Pick the account",
      description: "Sets the account from the vendor.",
      scope: "shared",
    });
  });

  it("says why when it isn't saved, and keeps the form", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => {
      throw new Error("That name is taken.");
    });
    const onChange = setup(written, { scopes: ["shared"], run });
    await user.click(screen.getByRole("button", { name: "Save as skill" }));
    expect(screen.getByText(/template, so the skill is shared/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Description"), "Sets it.");
    await user.click(screen.getByRole("button", { name: "Save skill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is taken.");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("is offered only for rules or AI written in the step", () => {
    const save: Save = { scopes: ["shared"], run: async () => written };
    setup({ ...written, rules: { rows: [] } } as unknown as DoStep, save);
    expect(screen.queryByRole("button", { name: "Save as skill" })).not.toBeInTheDocument();
  });

  it("is not offered where the host can't save one", () => {
    setup(written, undefined);
    expect(screen.queryByRole("button", { name: "Save as skill" })).not.toBeInTheDocument();
  });
});
