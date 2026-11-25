import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StepFormEnv } from "./form-kit";
import { ensureEnd, newOutput, setEndOutputs } from "./model";
import { OutputsEditor, withKind } from "./OutputsEditor";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { Workflow } from "./types";

const uses = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.bill.create",
          label: "Create bill",
          description: "",
          kind: "change",
          input: [{ name: "vendorId", type: "text", required: true }],
          output: [],
        },
        {
          id: "qbo.vendor.query",
          label: "Find vendors",
          description: "",
          kind: "get",
          input: [],
          output: [],
        },
      ],
    },
  ]),
};
const env = (workflow: Workflow): StepFormEnv => ({
  workflow,
  uses,
  trigger: [],
  people: { members: [], people: [] },
  suggest: vi.fn(),
  models: [],
});
const base = (): Workflow =>
  ensureEnd(
    {
      schemaVersion: 5,
      triggers: [],
      outputs: [{ ...newOutput("Bill", () => "o1"), kind: "nothing" }],
      steps: [],
    } as unknown as Workflow,
    () => "e1",
  );

describe("the workflow's outputs", () => {
  it("says which End delivers an output, and warns when none does", () => {
    const w = base();
    const { rerender } = render(
      <OutputsEditor workflow={w} env={env(w)} issues={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("No End delivers this yet")).toBeTruthy();
    const w2 = setEndOutputs(w, "e1", { outputs: ["o1"] });
    rerender(<OutputsEditor workflow={w2} env={env(w2)} issues={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/Delivered by:/)).toBeTruthy();
  });

  it("changes the kind and offers only changes and sends for a write, with approval on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const w = base();
    const { rerender } = render(
      <OutputsEditor workflow={w} env={env(w)} issues={[]} onChange={onChange} />,
    );
    await user.selectOptions(screen.getByLabelText("Kind of Bill"), "write");
    const next = onChange.mock.calls.at(-1)?.[0] as Workflow;
    expect(next.outputs[0]?.kind).toBe("write");
    rerender(<OutputsEditor workflow={next} env={env(next)} issues={[]} onChange={onChange} />);
    expect(screen.getByText("Needs approval")).toBeTruthy();
    const pick = screen.getByLabelText("Action of Bill");
    expect(within(pick).getByText("QuickBooks › Create bill")).toBeTruthy();
    expect(within(pick).queryByText("QuickBooks › Find vendors")).toBeNull();
  });

  it("adds an output, and removing one takes it off the End that picked it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const w = setEndOutputs(base(), "e1", { outputs: ["o1"] });
    render(<OutputsEditor workflow={w} env={env(w)} issues={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Add an output" }));
    const added = onChange.mock.calls.at(-1)?.[0] as Workflow;
    expect(added.outputs).toHaveLength(2);
    render(<OutputsEditor workflow={added} env={env(added)} issues={[]} onChange={onChange} />);
    await user.click(screen.getAllByRole("button", { name: "Remove Bill" })[1] as HTMLElement);
    const out = onChange.mock.calls.at(-1)?.[0] as Workflow;
    expect(out.outputs).toHaveLength(1);
    expect((out.steps.at(-1) as unknown as { outputs: string[] }).outputs).toEqual([]);
  });

  it("gives each kind only its own part", () => {
    const o = withKind(
      withKind(
        newOutput("x", () => "o"),
        "report",
      ),
      "pass_on",
    );
    expect(o.report).toBeUndefined();
    expect(o.passOn).toBeDefined();
  });
});
