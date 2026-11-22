// The step's side panel (docs/builder-plan.md §12, F2): what is left to settle (red with an
// issue), settled items and defaults with Change, Next once nothing is left, the host's slots, the
// Builder's three sizes and Remove.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepPanel } from "./StepPanel";
import type { SettleEntry } from "./status";
import type { StepStatus } from "./types";

const status = (items: SettleEntry[], over: Partial<StepStatus> = {}): StepStatus => ({
  stepId: "s1",
  level: items.some((i) => !i.settled && i.level === "issue")
    ? "issue"
    : items.some((i) => !i.settled)
      ? "question"
      : "ok",
  items,
  decided: [],
  ...over,
});

const issue: SettleEntry = {
  key: "missing:s1",
  stepId: "s1",
  level: "issue",
  title: "Nothing in the library does this yet",
  detail: "A skill that codes each line to a job",
  source: "missing",
};
const question: SettleEntry = {
  key: "item:q",
  stepId: "s1",
  level: "question",
  title: "How big a price change should it flag?",
  source: "build_item",
};

describe("StepPanel", () => {
  it("shows the kind and place, and what is left to settle, issues first in red", () => {
    const onClose = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Decision"
        place={{ n: 3, of: 7 }}
        title="The invoice is a duplicate?"
        from="If the invoice is a duplicate"
        status={status([question, issue])}
        itemActions={(item) => <button type="button">Answer {item.key}</button>}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("flow-panel-eyebrow")).toHaveTextContent("Decision · step 3 of 7");
    expect(screen.getByTestId("flow-panel-title")).toHaveTextContent("The invoice is a duplicate?");
    expect(screen.getByTestId("flow-panel-from")).toHaveTextContent(
      "From your list: “If the invoice is a duplicate”",
    );
    const settle = screen.getByTestId("flow-panel-settle");
    expect(settle).toHaveAttribute("data-tone", "issue");
    expect(screen.getByTestId("flow-panel-settle-title")).toHaveTextContent(
      "1 issue and 1 question on this step",
    );
    const keys = [...settle.querySelectorAll("[data-testid^='flow-panel-item-']")].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(keys).toEqual(["flow-panel-item-missing:s1", "flow-panel-item-item:q"]);
    expect(within(settle).getByText("A skill that codes each line to a job")).toBeTruthy();
    expect(within(settle).getByText("Answer item:q")).toBeTruthy();
    // Something is open: no Next.
    expect(screen.queryByTestId("flow-panel-next")).toBeNull();
    fireEvent.click(screen.getByTestId("flow-panel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows settled items with Change, and Next once nothing is left here", () => {
    const onChangeItem = vi.fn();
    const onNext = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Skill"
        title="Check each price"
        status={status([{ ...question, settled: "5%" }])}
        onChangeItem={onChangeItem}
        next={{ id: "s4", name: "Code each line to a job" }}
        onNext={onNext}
        onClose={() => {}}
      />,
    );
    const settle = screen.getByTestId("flow-panel-settle");
    expect(settle).toHaveAttribute("data-tone", "done");
    expect(within(settle).getByText("Settled on this step")).toBeTruthy();
    expect(within(settle).getByText("5%")).toBeTruthy();
    fireEvent.click(screen.getByTestId("flow-panel-item-item:q-change"));
    expect(onChangeItem).toHaveBeenCalledWith(expect.objectContaining({ key: "item:q" }));
    fireEvent.click(screen.getByTestId("flow-panel-next"));
    expect(onNext).toHaveBeenCalledWith("s4");
    expect(screen.getByTestId("flow-panel-next")).toHaveTextContent(
      "Next: “Code each line to a job”",
    );
  });

  it("lists what was decided for you, with Change, and the host's slots in order", () => {
    const onChangeDecided = vi.fn();
    const onRemove = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Write"
        title="Create the bill"
        does="Creates a bill in QuickBooks from the invoice's lines."
        status={status([], {
          decided: [
            {
              key: "d1",
              stepId: "s1",
              what: "Dana signs it",
              why: "The default approver",
              risk: "high",
            },
          ],
          customized: "changed",
          tried: { stepId: "s1", status: "would", summary: "Would create bill 1042" },
        })}
        onChangeDecided={onChangeDecided}
        connections={<p>Comes after “Match”</p>}
        onRemove={onRemove}
        onClose={() => {}}
      >
        <p>The setup</p>
      </StepPanel>,
    );
    expect(screen.queryByTestId("flow-panel-settle")).toBeNull();
    const decided = screen.getByTestId("flow-panel-decided");
    expect(within(decided).getByText("Dana signs it")).toBeTruthy();
    expect(within(decided).getByText("High risk")).toBeTruthy();
    fireEvent.click(screen.getByTestId("flow-panel-decided-d1-change"));
    expect(onChangeDecided).toHaveBeenCalledWith(expect.objectContaining({ key: "d1" }));
    expect(screen.getByTestId("flow-panel-customized")).toHaveTextContent(
      "Changed for this client",
    );
    expect(screen.getByTestId("flow-panel-tried")).toHaveTextContent("Would");
    expect(screen.getByTestId("flow-panel-connections")).toHaveTextContent("Comes after “Match”");
    expect(screen.getByTestId("flow-panel-setup")).toHaveTextContent("The setup");
    // Owner, 2026-11-22: what the step does is the first thing read; where it sits is the last
    // of its setup, after the fields.
    expect(screen.getByTestId("flow-panel-does")).toHaveTextContent(
      "Creates a bill in QuickBooks from the invoice's lines.",
    );
    const body = screen.getByTestId("flow-panel-body");
    expect(body).not.toContainElement(screen.getByTestId("flow-panel-does"));
    expect(
      screen
        .getByTestId("flow-panel-setup")
        .compareDocumentPosition(screen.getByTestId("flow-panel-connections")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("flow-panel-remove"));
    expect(onRemove).toHaveBeenCalled();
    expect(screen.getByTestId("flow-panel-remove")).toHaveTextContent("Remove this step");
  });

  it("renames as you type", () => {
    const onRename = vi.fn();
    render(
      <StepPanel stepId="s1" kind="Skill" title="Read" onRename={onRename} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("flow-panel-name"), {
      target: { value: "Read the invoice" },
    });
    expect(onRename).toHaveBeenCalledWith("Read the invoice");
    expect(screen.getByTestId("flow-panel-name")).toHaveValue("Read the invoice");
  });

  it("gives the Builder three sizes: the message box, beside the setup, the whole panel", () => {
    const onBuilderSize = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Skill"
        title="Read"
        builder={(size) => <p>Builder at {size}</p>}
        onBuilderSize={onBuilderSize}
        onClose={() => {}}
      >
        <p>The setup</p>
      </StepPanel>,
    );
    const panel = screen.getByTestId("flow-panel");
    // Half by default: the setup above, the Builder below, with room for its answer.
    expect(panel).toHaveAttribute("data-builder-size", "beside");
    expect(screen.getByText("Builder at beside")).toBeTruthy();
    expect(screen.getByTestId("flow-panel-builder-beside")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-panel-body")).toBeTruthy();
    // The sizes are small icons with their words for a name, not tabs; the box-only size is gone.
    expect(screen.getByTestId("flow-panel-builder-beside")).toHaveAccessibleName(
      "Half the panel: the setup above, the Builder below",
    );
    expect(screen.getByTestId("flow-panel-builder-max")).toHaveAccessibleName("The whole panel");
    expect(screen.queryByTestId("flow-panel-builder-min")).toBeNull();

    fireEvent.click(screen.getByTestId("flow-panel-builder-max"));
    expect(onBuilderSize).toHaveBeenLastCalledWith("max");
    expect(panel).toHaveAttribute("data-builder-size", "max");
    // The whole panel: the setup steps aside.
    expect(screen.queryByTestId("flow-panel-body")).toBeNull();
    expect(screen.queryByText("The setup")).toBeNull();
  });

  it("folds the Builder to one line and opens it back at the size it had", () => {
    const onBuilderSize = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Skill"
        title="Read"
        builder={(size) => <p>Builder at {size}</p>}
        defaultBuilderSize="max"
        onBuilderSize={onBuilderSize}
        onClose={() => {}}
      >
        <p>The setup</p>
      </StepPanel>,
    );
    const panel = screen.getByTestId("flow-panel");
    const fold = screen.getByTestId("flow-panel-builder-fold");
    expect(fold).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(fold);
    expect(onBuilderSize).toHaveBeenLastCalledWith("line");
    expect(panel).toHaveAttribute("data-builder-size", "line");
    expect(fold).toHaveAttribute("aria-expanded", "false");
    // One line: no sizes, the setup has the panel, and the Builder is kept, out of sight.
    expect(screen.queryByTestId("flow-panel-builder-max")).toBeNull();
    expect(screen.getByText("The setup")).toBeTruthy();
    expect(screen.getByText("Builder at max").parentElement).toHaveClass("hidden");

    fireEvent.click(fold);
    expect(onBuilderSize).toHaveBeenLastCalledWith("max");
    expect(panel).toHaveAttribute("data-builder-size", "max");
    expect(screen.getByText("Builder at max").parentElement).not.toHaveClass("hidden");
  });

  it("moves to the step before and after from the Builder's head", () => {
    const onNextStep = vi.fn();
    render(
      <StepPanel
        stepId="s1"
        kind="Skill"
        title="Read"
        builder={<p>The Builder</p>}
        onNextStep={onNextStep}
        onClose={() => {}}
      />,
    );
    // The first step has none before it.
    expect(screen.getByTestId("flow-panel-builder-previous")).toBeDisabled();
    fireEvent.click(screen.getByTestId("flow-panel-builder-next"));
    expect(onNextStep).toHaveBeenCalledTimes(1);
  });
});
