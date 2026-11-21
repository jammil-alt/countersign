// The one bar (docs/builder-plan.md §12.3, F2): the counts in one line, what is left to settle
// (each pill opening the next one), the view, undo and redo, and the host's primary action.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { countsLine, FlowBar, type FlowBarProps } from "./FlowBar";

const base = (over: Partial<FlowBarProps> = {}): FlowBarProps => ({
  name: "Invoice intake",
  version: { state: "draft", version: 3 },
  counts: { steps: 18, ifs: 3, writes: 3, needApproval: 3 },
  open: { issues: 1, questions: 4 },
  onNextOpen: vi.fn(),
  view: "chart",
  onView: vi.fn(),
  canUndo: true,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  ...over,
});

describe("countsLine", () => {
  it("says the steps in one line, leaving out what is zero", () => {
    expect(countsLine({ steps: 18, ifs: 3, writes: 3, needApproval: 3 })).toBe(
      "18 steps · 3 decisions · 3 write to a tool · 3 need approval",
    );
    expect(countsLine({ steps: 1, ifs: 0, writes: 1, needApproval: 1 })).toBe(
      "1 step · 1 writes to a tool · 1 needs approval",
    );
    expect(countsLine({ steps: 2, ifs: 0, writes: 0, needApproval: 0 })).toBe("2 steps");
  });
});

describe("FlowBar", () => {
  it("shows the name, version, counts and the issues and questions that open the next one", () => {
    const props = base();
    render(<FlowBar {...props} primary={<button type="button">Turn on</button>} />);
    expect(screen.getByTestId("flow-bar-name")).toHaveTextContent("Invoice intake");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v3");
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent(
      "18 steps · 3 decisions · 3 write to a tool · 3 need approval",
    );
    expect(screen.getByTestId("flow-bar-issues")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-bar-questions")).toHaveTextContent("4 questions");
    fireEvent.click(screen.getByTestId("flow-bar-open"));
    expect(props.onNextOpen).toHaveBeenCalled();
    expect(screen.getByText("Turn on")).toBeTruthy();
  });

  it("says nothing is left to settle when nothing is", () => {
    render(<FlowBar {...base({ open: { issues: 0, questions: 0 } })} />);
    expect(screen.queryByTestId("flow-bar-open")).toBeNull();
    expect(screen.getByTestId("flow-bar-settled")).toHaveTextContent("Nothing to settle");
  });

  it("switches the view, and undoes; redo waits for something to redo", () => {
    const props = base({ onTry: vi.fn(), onAskBuilder: vi.fn(), onSave: vi.fn() });
    render(<FlowBar {...props} />);
    expect(screen.getByTestId("flow-bar-view-chart")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("flow-bar-view-list"));
    expect(props.onView).toHaveBeenCalledWith("list");
    fireEvent.click(screen.getByTestId("flow-bar-undo"));
    expect(props.onUndo).toHaveBeenCalled();
    expect(screen.getByTestId("flow-bar-redo")).toBeDisabled();
    fireEvent.click(screen.getByTestId("flow-bar-try"));
    expect(props.onTry).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("flow-bar-builder"));
    expect(props.onAskBuilder).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("flow-bar-save"));
    expect(props.onSave).toHaveBeenCalled();
  });

  it("marks unsaved changes and a live version", () => {
    const { rerender } = render(<FlowBar {...base({ version: { state: "unsaved" } })} />);
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    rerender(<FlowBar {...base({ version: { state: "live", version: 4 } })} />);
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Live · v4");
  });
});
