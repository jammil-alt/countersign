import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StepFormEnv } from "./form-kit";
import { newStep } from "./model";
import { ForEachForm, ForkForm, HandoffForm, LoopForm, RepeatForm, WaitForm } from "./OtherForms";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { Step, Workflow } from "./types";

let n = 0;
const id = () => `f${++n}`;

const read = {
  ...(newStep("do", id) as Extract<Step, { kind: "do" }>),
  name: "Read the invoice",
  doneBy: "ai" as const,
  output: [{ name: "lines", type: "list" as const, required: true, of: [] }],
};

function env(extra: Partial<StepFormEnv> = {}): StepFormEnv {
  const workflow = {
    schemaVersion: 5,
    triggers: [],
    outputs: [],
    steps: [],
  } as unknown as Workflow;
  return {
    workflow,
    uses: {
      ...NO_USES_CONTEXT,
      actions: indexCatalog([
        {
          type: "connector",
          id: "qbo",
          name: "QuickBooks",
          actions: [
            {
              id: "qbo.vendor.query",
              label: "Find vendors",
              description: "",
              kind: "get",
              input: [],
              output: [],
            },
            {
              id: "qbo.bill.create",
              label: "Create bill",
              description: "",
              kind: "change",
              input: [],
              output: [],
            },
          ],
        },
      ]),
    },
    trigger: [],
    people: { members: [], people: [] },
    suggest: vi.fn(),
    models: [],
    ...extra,
  };
}

describe("the other forms", () => {
  it("a Loop offers read actions only, and says goal and limit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const loop = newStep("loop", id) as Extract<Step, { kind: "loop" }>;
    render(<LoopForm step={loop} env={env()} issues={[]} onChange={onChange} />);
    expect(screen.getByLabelText("Find vendors")).toBeTruthy();
    expect(screen.queryByLabelText("Create bill")).toBeNull();
    await user.click(screen.getByLabelText("Find vendors"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reads: ["qbo.vendor.query"] }));
    expect(screen.getByText(/A Loop only reads/)).toBeTruthy();
  });

  it("a Fork adds a path with its own id and lets rules or the AI decide", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const fork = newStep("fork", id) as Extract<Step, { kind: "fork" }>;
    render(<ForkForm step={fork} env={env()} issues={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Add a path" }));
    const next = onChange.mock.calls[0]?.[0] as typeof fork;
    expect(next.paths).toHaveLength(2);
    expect(next.paths[1]?.id).toBeTruthy();
    expect(next.paths[1]?.id).not.toBe(next.paths[0]?.id);
    await user.selectOptions(screen.getByLabelText("Decided by"), "agent");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ decide: "agent" }));
  });

  it("For each offers the lists the steps before it hand on", () => {
    const each = newStep("for_each", id) as Extract<Step, { kind: "for_each" }>;
    const workflow = {
      schemaVersion: 5,
      triggers: [],
      outputs: [],
      steps: [read, each],
    } as unknown as Workflow;
    render(<ForEachForm step={each} env={env({ workflow })} issues={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Read the invoice › lines" })).toBeTruthy();
  });

  it("Repeat switches between rules and a goal; Wait and Hand off say what they need", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const repeat = newStep("repeat", id) as Extract<Step, { kind: "repeat" }>;
    render(<RepeatForm step={repeat} env={env()} issues={[]} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText("Until"), "rules");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ until: { rules: { match: "all", rules: [] } } }),
    );
    render(
      <WaitForm
        step={newStep("wait", id) as Extract<Step, { kind: "wait" }>}
        env={env()}
        issues={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("form-wait")).toBeTruthy();
    render(
      <HandoffForm
        step={newStep("handoff", id) as Extract<Step, { kind: "handoff" }>}
        env={env({ agents: [{ slug: "ap", name: "AP clerk" }] })}
        issues={[
          { at: "x", code: "handoff_target_missing", message: "Pick who this hands off to." },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pick who this hands off to/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "AP clerk" })).toBeTruthy();
  });
});
