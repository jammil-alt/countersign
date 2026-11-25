import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EndCard } from "./EndCard";
import type { StepFormEnv } from "./form-kit";
import { newOutput, newStep } from "./model";
import { NO_USES_CONTEXT } from "./options";
import type { EndStep, Workflow } from "./types";

const report = {
  ...newOutput("Exception report", () => "o1"),
  kind: "report",
  report: { to: ["client_admin"], channel: "email", message: "x" },
} as never;
const save = {
  ...newOutput("Purchase saved", () => "o2"),
  kind: "save",
  action: { action: "a.b", input: {} },
} as never;
const env = (): StepFormEnv => ({
  workflow: {
    schemaVersion: 5,
    triggers: [],
    outputs: [report, save],
    steps: [],
  } as unknown as Workflow,
  uses: NO_USES_CONTEXT,
  trigger: [],
  people: { members: [], people: [] },
  suggest: vi.fn(),
  models: [],
});

describe("an End card", () => {
  it("picks outputs, and says where each goes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const step = newStep("end", () => "e1") as EndStep;
    const { rerender } = render(
      <EndCard step={step} env={env()} issues={[]} onChange={onChange} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Exception report" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outputs: ["o1"] }));
    rerender(
      <EndCard step={{ ...step, outputs: ["o1"] }} env={env()} issues={[]} onChange={onChange} />,
    );
    expect(screen.getByText("Report to Client admin by email")).toBeTruthy();
  });

  it("nothing to do clears the outputs, and choosing outputs clears the reason", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const step = { ...(newStep("end", () => "e1") as EndStep), outputs: ["o1"] };
    const { rerender } = render(
      <EndCard step={step} env={env()} issues={[]} onChange={onChange} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Nothing to do" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputs: [], nothingToDo: "" }),
    );
    rerender(
      <EndCard
        step={{ ...step, outputs: [], nothingToDo: "done" }}
        env={env()}
        issues={[]}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Purchase saved" }));
    const last = onChange.mock.calls.at(-1)?.[0] as EndStep;
    expect(last.outputs).toEqual(["o2"]);
    expect(last.nothingToDo).toBeUndefined();
  });

  it("shows its issues in words and has no Remove", () => {
    const step = newStep("end", () => "e1") as EndStep;
    render(
      <EndCard
        step={step}
        env={env()}
        issues={[{ at: "e1", code: "end_empty", message: "Pick what this End delivers." }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pick what this End delivers/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
