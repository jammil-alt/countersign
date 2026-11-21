// A client agent's steps against its template: the changed and added ones, each opening its step,
// "Put back the template's step" handing the host the template's step under the same id, Remove on
// an added one, and the same lines for the step's side panel.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Process, Step } from "../../builder/model";
import { CustomizationsList, customizedLine, StepDiff } from "./CustomizationsList";

const step = (s: Record<string, unknown>) => s as unknown as Step;
const READ = step({
  id: "read",
  kind: "skill",
  name: "Read the invoice",
  skill: "docs.read-invoice@3",
  input: {},
});
const UPDATE = step({
  id: "update",
  kind: "write",
  name: "Update the bill",
  tool: "qbo.bill.update_lines",
  input: {},
});
const TEMPLATE = {
  schemaVersion: 4,
  triggers: [{ id: "t1", on: { type: "manual" } }],
  steps: [READ, UPDATE],
} as unknown as Process;
const NOTE = step({ id: "note", kind: "wait", name: "Wait a day", for: "1 day" });
const MINE = {
  ...TEMPLATE,
  steps: [step({ ...READ, name: "Read it", skill: "docs.read-invoice@4" }), NOTE, UPDATE],
} as Process;

describe("CustomizationsList", () => {
  it("lists the changed and added steps in words, and opens a step on the chart", () => {
    const onSelect = vi.fn();
    render(<CustomizationsList process={MINE} template={TEMPLATE} onSelect={onSelect} />);
    expect(screen.queryByTestId("flow-customization-update")).toBeNull();
    const changed = screen.getByTestId("flow-customization-read");
    expect(changed).toHaveTextContent("Read it");
    expect(changed).toHaveTextContent("Customized");
    expect(screen.getByTestId("flow-diff-read")).toHaveTextContent(
      "Name: “Read the invoice” → “Read it”",
    );
    expect(screen.getByTestId("flow-diff-read")).toHaveTextContent("Skill version 3 → 4");
    expect(screen.getByTestId("flow-customization-note")).toHaveTextContent("Added");
    expect(screen.getByTestId("flow-customization-note")).toHaveTextContent("Not in the template.");
    // Read only without onChange: no way back, no Remove.
    expect(screen.queryByTestId("flow-customization-read-put-back")).toBeNull();
    expect(screen.queryByTestId("flow-customization-note-remove")).toBeNull();

    fireEvent.click(screen.getByTestId("flow-customization-note-open"));
    expect(onSelect).toHaveBeenCalledWith("note");
  });

  it("puts back the template's step under the same id", () => {
    const onChange = vi.fn();
    render(
      <CustomizationsList
        process={MINE}
        template={TEMPLATE}
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const button = screen.getByTestId("flow-customization-read-put-back");
    expect(button).toHaveTextContent("Put back the template's step");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Process;
    expect(next.steps[0]).toEqual(READ);
    expect(next.steps[0]?.id).toBe("read");
    // Nothing else moved: the added step and the template's own are where they were.
    expect(next.steps.map((s) => s.id)).toEqual(["read", "note", "update"]);
  });

  it("removes an added step", () => {
    const onChange = vi.fn();
    render(
      <CustomizationsList
        process={MINE}
        template={TEMPLATE}
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("flow-customization-note-remove"));
    const next = onChange.mock.calls[0]?.[0] as Process;
    expect(next.steps.map((s) => s.id)).toEqual(["read", "update"]);
  });

  it("says so when the steps are the template's", () => {
    render(<CustomizationsList process={TEMPLATE} template={TEMPLATE} onSelect={vi.fn()} />);
    expect(screen.getByTestId("flow-customizations-none")).toHaveTextContent(
      "Nothing changed: the steps are the template's.",
    );
  });

  it("counts them for the strip", () => {
    expect(customizedLine(new Map())).toBe("");
    expect(customizedLine(new Map([["a", "changed"]]))).toBe("1 step changed");
    expect(
      customizedLine(
        new Map([
          ["a", "changed"],
          ["b", "changed"],
          ["c", "added"],
        ]),
      ),
    ).toBe("2 steps changed, 1 added");
    expect(customizedLine(new Map([["c", "added"]]))).toBe("1 step added");
  });
});

describe("StepDiff", () => {
  it("shows what a step changed and puts it back", () => {
    const onChange = vi.fn();
    render(
      <StepDiff
        step={MINE.steps[0] as Step}
        process={MINE}
        template={TEMPLATE}
        onChange={onChange}
      />,
    );
    const diff = screen.getByTestId("flow-step-diff");
    expect(diff).toHaveTextContent("Changed from the template");
    expect(diff).toHaveTextContent("Skill version 3 → 4");
    fireEvent.click(screen.getByTestId("flow-step-diff-put-back"));
    const next = onChange.mock.calls[0]?.[0] as Process | undefined;
    expect(next?.steps[0]).toEqual(READ);
  });

  it("says an added step is this client's, and nothing for the template's step as it is", () => {
    const { rerender } = render(<StepDiff step={NOTE} process={MINE} template={TEMPLATE} />);
    expect(screen.getByTestId("flow-step-diff")).toHaveTextContent(
      "Added for this client. It is not in the template.",
    );
    rerender(<StepDiff step={UPDATE} process={MINE} template={TEMPLATE} />);
    expect(screen.queryByTestId("flow-step-diff")).toBeNull();
    rerender(<StepDiff step={UPDATE} process={MINE} template={undefined} />);
    expect(screen.queryByTestId("flow-step-diff")).toBeNull();
  });
});
