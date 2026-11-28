// The supervisor on the step builder (owner, 2026-11-27): the bar's level, the marks on the steps
// it checks after they succeed, and the list's marks. What it did in a try: ../../run/Supervision.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepTable } from "../../flow/StepTable";
import { displayProcess } from "./display";
import { indexCatalog, NO_USES_CONTEXT, type UsesContext } from "./options";
import { SupervisorControl, supervisorMarks } from "./Supervisor";
import type { Workflow } from "./types";

const uses: UsesContext = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks Online",
      actions: [
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
  ] as never),
};

const workflow = {
  schemaVersion: 5,
  triggers: [{ id: "t1", on: { type: "manual" } }],
  outputs: [{ id: "o", name: "Done", kind: "nothing", fields: [] }],
  steps: [
    {
      id: "read",
      kind: "do",
      name: "Read the invoice",
      doneBy: "ai",
      input: { documentId: "{{trigger.documentId}}" },
    },
    { id: "check", kind: "do", name: "Check the total", doneBy: "rules", input: {} },
    {
      id: "enter",
      kind: "do",
      name: "Enter the bill",
      doneBy: "rules",
      uses: { type: "action", action: "qbo.bill.create" },
      input: { lines: "{{steps.read.output.lines}}" },
    },
    {
      id: "tell",
      kind: "do",
      name: "Tell the team",
      doneBy: "rules",
      uses: { type: "tell" },
      tell: { to: ["client_admin"], channel: "inbox", message: "Done" },
      input: {},
    },
    { id: "end", kind: "end", name: "Done", outputs: ["o"], status: "succeeded" },
  ],
} as unknown as Workflow;

describe("supervisorMarks", () => {
  it("marks the steps checked after they succeed, at each level", () => {
    const at = (r: "off" | "failures" | "checkpoints" | "all") => [
      ...supervisorMarks(workflow, r, uses).keys(),
    ];
    expect(at("off")).toEqual([]);
    expect(at("failures")).toEqual([]);
    // The read feeds the bill's lines: a checkpoint. A Tell is a person's, never the supervisor's.
    expect(at("checkpoints")).toEqual(["read"]);
    expect(at("all")).toEqual(["read", "check", "enter"]);
    expect(supervisorMarks(workflow, "checkpoints", uses).get("read")).toBe(
      "Supervisor checks this step: its result feeds a write or reaches a person",
    );
  });

  it("marks a step set to always under any level, and never one set to off", () => {
    const w = {
      ...workflow,
      steps: workflow.steps.map((s) =>
        s.id === "check"
          ? { ...s, review: "always" }
          : s.id === "read"
            ? { ...s, review: "off" }
            : s,
      ),
    } as Workflow;
    expect([...supervisorMarks(w, "failures", uses)]).toEqual([
      ["check", "Supervisor always checks this step"],
    ]);
    expect([...supervisorMarks(w, "all", uses).keys()]).toEqual(["check", "enter"]);
  });

  it("shows on the list's rows", () => {
    const marks = supervisorMarks(workflow, "checkpoints", uses);
    render(
      <StepTable
        process={displayProcess(workflow, uses)}
        statuses={new Map()}
        selected={null}
        onSelect={() => {}}
        supervisor={(id) => marks.get(id) ?? null}
      />,
    );
    expect(screen.getByTestId("flow-list-supervisor-read")).toHaveAttribute(
      "aria-label",
      "Supervisor checks this step: its result feeds a write or reaches a person",
    );
    expect(screen.queryByTestId("flow-list-supervisor-enter")).toBeNull();
  });
});

describe("SupervisorControl", () => {
  it("says the level in words and offers the four choices with what each costs", () => {
    const onChange = vi.fn();
    render(<SupervisorControl review="checkpoints" set verifies onChange={onChange} />);
    expect(screen.getByTestId("steps-supervisor-level")).toHaveTextContent(
      "Review failures and checkpoints",
    );
    fireEvent.click(screen.getByTestId("steps-supervisor"));
    const menu = screen.getByTestId("steps-supervisor-menu");
    expect(menu.textContent).toContain("Cost: none.");
    expect(menu.textContent).toContain("every write is checked against the run's sources");
    fireEvent.click(screen.getByTestId("steps-supervisor-off"));
    expect(onChange).toHaveBeenCalledWith("off");
    expect(screen.queryByTestId("steps-supervisor-menu")).toBeNull();
  });

  it("says when the agent has no level of its own yet", () => {
    render(<SupervisorControl review="failures" set={false} verifies onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("steps-supervisor"));
    expect(screen.getByTestId("steps-supervisor-menu").textContent).toContain("Not set");
  });
});
