// The chart: a box per step, a click selects, a + adds at the right place, the marks say their
// words (issue, question, a try's Did and the path taken), folding and opening, and read only
// shows no + and no dot.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Process, Step } from "../builder/model";
import { Chart, TIP_SCALE_MAX, TIP_SCALE_MIN, tipScale } from "./Chart";
import { FlowDndContext } from "./dnd";
import { kindDoes } from "./does";
import type { ChartProps, FlowEnds, StatusMap, StepStatus } from "./types";

const read = (id: string, name: string): Step =>
  ({ id, name, kind: "read", tool: "testkit.record.query", input: {} }) as Step;
const stop = (id: string): Step => ({ id, name: "", kind: "stop", status: "succeeded" }) as Step;

const PROCESS = {
  schemaVersion: 4,
  triggers: [{ id: "t1", on: { type: "manual" } }],
  steps: [
    read("a", "Read the invoice"),
    {
      id: "d",
      name: "Is it a duplicate?",
      kind: "if",
      paths: [{ id: "p1", name: "It is a duplicate", when: { all: [] }, steps: [stop("s")] }],
      otherwise: { id: "o1", steps: [] },
    },
    read("b", "Match each line"),
    {
      id: "f",
      name: "Each line",
      kind: "for_each",
      over: "{{trigger.lines}}",
      concurrency: 10,
      steps: [read("i", "Check the price")],
    },
    { id: "auto", name: "Code the lines", kind: "process", process: "code-lines@2", input: {} },
  ],
} as unknown as Process;

const ENDS: FlowEnds = {
  start: { title: "Starts when", lines: ["A vendor invoice arrives"] },
  givesBack: null,
};

function setup(over: Partial<ChartProps> = {}) {
  const events = {
    onSelect: vi.fn(),
    onInsert: vi.fn(),
    onMove: vi.fn(),
    onConnect: vi.fn(),
    onAddPath: vi.fn(),
    onOpenGroup: vi.fn(),
    onFold: vi.fn(),
  };
  const props: ChartProps = {
    process: PROCESS,
    ends: ENDS,
    statuses: new Map(),
    selected: null,
    folded: new Set(),
    ...events,
    ...over,
  };
  render(
    <FlowDndContext events={props}>
      <Chart {...props} />
    </FlowDndContext>,
  );
  return props;
}

const status = (s: Partial<StepStatus> & { stepId: string }): StepStatus => ({
  level: "ok",
  items: [],
  decided: [],
  ...s,
});

describe("Chart", () => {
  it("draws a box per step, the start, and the path labels", () => {
    setup();
    for (const id of ["a", "d", "s", "b", "f", "i", "auto"]) {
      expect(screen.getByTestId(`flow-box-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("flow-start")).toHaveTextContent("A vendor invoice arrives");
    expect(screen.getByTestId("flow-box-a")).toHaveTextContent("1Read the invoice");
    expect(screen.getByTestId("flow-box-s")).toHaveTextContent("Stop");
    expect(screen.getByTestId("flow-path-p1")).toHaveTextContent("AIt is a duplicate");
    expect(screen.getByTestId("flow-path-o1")).toHaveTextContent("BOtherwise");
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("100%");
  });

  it("selects a box on click, and the selected box is marked", () => {
    const props = setup({ selected: "b" });
    fireEvent.click(screen.getByTestId("flow-box-a"));
    expect(props.onSelect).toHaveBeenCalledWith("a");
    expect(screen.getByTestId("flow-box-b")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-box-b")).toHaveClass("is-sel");
    expect(screen.getByTestId("flow-box-a")).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(screen.getByTestId("flow-box-i"), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("i");
    fireEvent.click(screen.getByTestId("flow-path-p1"));
    expect(props.onSelect).toHaveBeenCalledWith("d");
  });

  it("adds a step at the + pressed, in its list and place", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("flow-insert-root-2"));
    expect(props.onInsert).toHaveBeenCalledWith({ container: "root", index: 2 });
    fireEvent.click(screen.getByTestId("flow-insert-otherwise:o1-0"));
    expect(props.onInsert).toHaveBeenCalledWith({ container: "otherwise:o1", index: 0 });
    fireEvent.click(screen.getByTestId("flow-insert-loop:f-1"));
    expect(props.onInsert).toHaveBeenCalledWith({ container: "loop:f", index: 1 });
    fireEvent.click(screen.getByTestId("flow-tail"));
    expect(props.onInsert).toHaveBeenLastCalledWith({ container: "root", index: 5 });
    fireEvent.click(screen.getByTestId("flow-add-path-d"));
    expect(props.onAddPath).toHaveBeenCalledWith("d");
  });

  it("shows an issue in risk with its count, and a question in words", () => {
    const statuses: StatusMap = new Map([
      [
        "a",
        status({
          stepId: "a",
          level: "issue",
          items: [
            {
              key: "problem:x:a:tool",
              stepId: "a",
              level: "issue",
              title: "Choose what it reads",
              source: "problem",
            },
          ],
        }),
      ],
      [
        "b",
        status({
          stepId: "b",
          level: "question",
          items: [
            {
              key: "item:1",
              stepId: "b",
              level: "question",
              title: "Who signs?",
              source: "build_item",
            },
            {
              key: "item:2",
              stepId: "b",
              level: "question",
              title: "How soon?",
              source: "build_item",
            },
          ],
        }),
      ],
      ["i", status({ stepId: "i", customized: "added" })],
      ["f", status({ stepId: "f", customized: "changed" })],
    ]);
    setup({ statuses });
    expect(screen.getByTestId("flow-box-a")).toHaveClass("has-issue");
    expect(screen.getByTestId("flow-flag-a")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-flag-b")).toHaveTextContent("2 questions");
    expect(screen.getByTestId("flow-box-b")).not.toHaveClass("has-issue");
    expect(screen.queryByTestId("flow-flag-i")).toBeNull();
    expect(screen.getByTestId("flow-customized-i")).toHaveTextContent("Added");
    expect(screen.getByTestId("flow-customized-f")).toHaveTextContent("Customized");
  });

  it("shows what a try did and draws the path it took in the positive colour", () => {
    const statuses: StatusMap = new Map([
      ["a", status({ stepId: "a", tried: { stepId: "a", status: "did" } })],
      ["d", status({ stepId: "d", tried: { stepId: "d", status: "did" } })],
      ["b", status({ stepId: "b", tried: { stepId: "b", status: "would" } })],
      ["f", status({ stepId: "f", tried: { stepId: "f", status: "failed" } })],
      ["s", status({ stepId: "s", tried: { stepId: "s", status: "skipped" } })],
    ]);
    setup({ statuses });
    expect(screen.getByTestId("flow-tried-a")).toHaveTextContent("Did");
    expect(screen.getByTestId("flow-tried-b")).toHaveTextContent("Would");
    expect(screen.getByTestId("flow-tried-f")).toHaveTextContent("Failed");
    expect(screen.queryByTestId("flow-tried-s")).toBeNull();
    expect(screen.getByTestId("flow-box-s")).toHaveClass("is-off");
    const on = document.querySelectorAll(".flow-edge.is-on");
    // start → a, a → d, the otherwise path back to b, b → f; not into the Stop.
    expect(on.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId("flow-path-o1")).toHaveClass("is-on");
    expect(screen.getByTestId("flow-path-p1")).not.toHaveClass("is-on");
  });

  it("shows a box's details after the pointer rests on it", async () => {
    const statuses: StatusMap = new Map([
      [
        "b",
        status({
          stepId: "b",
          level: "question",
          items: [
            {
              key: "item:1",
              stepId: "b",
              level: "question",
              title: "Who signs?",
              source: "build_item",
            },
          ],
          decided: [{ key: "dec:1", stepId: "b", what: "It reads the last 90 days" }],
        }),
      ],
    ]);
    setup({ statuses });
    fireEvent.mouseEnter(screen.getByTestId("flow-box-b"));
    const tip = await screen.findByTestId("flow-tip");
    expect(tip).toHaveTextContent("Match each line");
    expect(tip).toHaveTextContent("Who signs?");
    expect(tip).toHaveTextContent("It reads the last 90 days");
    // Owner, 2026-11-22 (docs/plan.md §1.182): it says what the step does, and no longer how to
    // click and drag, which every box repeated.
    expect(screen.getByTestId("flow-tip-does")).toBeInTheDocument();
    expect(tip).not.toHaveTextContent("Click to set it up");
    expect(tip).not.toHaveTextContent("Drag the");
    fireEvent.mouseLeave(screen.getByTestId("flow-box-b"));
    expect(screen.queryByTestId("flow-tip")).toBeNull();
  });

  it("says what a step does in its own words, and why it is there when its author said", async () => {
    setup({
      label: (step) => ({
        title: step.name,
        kind: "Read",
        detail: "QuickBooks Online · Query customer",
        ...(step.id === "a"
          ? {
              does: "Finds customers and jobs in QuickBooks by name.",
              purpose: "So each cost has a job.",
            }
          : {}),
      }),
    });
    fireEvent.mouseEnter(screen.getByTestId("flow-box-a"));
    expect(await screen.findByTestId("flow-tip-does")).toHaveTextContent(
      /^Finds customers and jobs in QuickBooks by name\.$/,
    );
    expect(screen.getByTestId("flow-tip-purpose")).toHaveTextContent(
      "Why it is here: So each cost has a job.",
    );
    fireEvent.mouseLeave(screen.getByTestId("flow-box-a"));
    // A decision and a Stop say what their kind does.
    fireEvent.mouseEnter(screen.getByTestId("flow-box-d"));
    expect(await screen.findByTestId("flow-tip-does")).toHaveTextContent(
      "Sends the run down the first path whose rule holds",
    );
    expect(screen.queryByTestId("flow-tip-purpose")).toBeNull();
  });

  it("keeps the details readable however far the chart is zoomed out", async () => {
    // They follow the zoom, far less than the chart does, and never under what reads.
    expect(tipScale(1)).toBe(1);
    expect(tipScale(0.25)).toBe(TIP_SCALE_MIN);
    expect(tipScale(1.6)).toBe(TIP_SCALE_MAX);
    expect(tipScale(0.8)).toBeLessThan(1);
    expect(tipScale(0.8)).toBeGreaterThan(0.8);

    setup();
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByTestId("flow-zoom-out"));
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("25%");
    fireEvent.mouseEnter(screen.getByTestId("flow-box-b"));
    const tip = await screen.findByTestId("flow-tip");
    // On the stage beside the zoomed chart, not inside it: the chart's own scale never reaches it.
    expect(tip.closest(".flow-graph")).toBeNull();
    expect(tip.closest(".flow-chart__stage")).not.toBeNull();
    expect(tip).toHaveAttribute("data-scale", String(TIP_SCALE_MIN));
    expect(tip.style.transform).toBe(`scale(${TIP_SCALE_MIN})`);
  });

  it("says in the details whether a model does the step, and which", async () => {
    setup({
      label: (step) =>
        step.id === "a"
          ? {
              title: step.name,
              kind: "Skill · AI",
              detail: "Read a request to buy · runs on claude-sonnet-5-5",
              skillKind: "AI",
              model: "claude-sonnet-5-5",
            }
          : step.id === "b"
            ? {
                title: step.name,
                kind: "Skill · Deterministic",
                detail: null,
                skillKind: "Deterministic",
              }
            : { title: step.name, kind: "Read", detail: "Testkit · Find records" },
    });
    fireEvent.mouseEnter(screen.getByTestId("flow-box-a"));
    const tip = await screen.findByTestId("flow-tip");
    // A line of its own, said once: not again in the eyebrow or the detail.
    expect(screen.getByTestId("flow-tip-runs")).toHaveTextContent("AIruns on claude-sonnet-5-5");
    expect(tip.querySelector(".ds-eyebrow")).toHaveTextContent(/^Skill$/);
    expect(tip.querySelector(".flow-tip__d")).toHaveTextContent(/^Read a request to buy$/);
    // With no words of its own from the host, a step says what its kind does.
    expect(screen.getByTestId("flow-tip-does")).toHaveTextContent(
      kindDoes(PROCESS.steps[0] as Step),
    );
    fireEvent.mouseLeave(screen.getByTestId("flow-box-a"));

    // A skill that runs no model says so, with no model beside it.
    fireEvent.mouseEnter(screen.getByTestId("flow-box-b"));
    expect(await screen.findByTestId("flow-tip-runs")).toHaveTextContent(/^Deterministic$/);
    fireEvent.mouseLeave(screen.getByTestId("flow-box-b"));

    // A step with neither has no such line.
    fireEvent.mouseEnter(screen.getByTestId("flow-box-i"));
    await screen.findByTestId("flow-tip");
    expect(screen.queryByTestId("flow-tip-runs")).toBeNull();
  });

  it("marks each box with what it is, and opens a key that says what the marks mean", () => {
    setup({
      label: (step) =>
        step.id === "a"
          ? {
              title: step.name,
              kind: "Read",
              detail: "QuickBooks Online · Find bills",
              connector: { id: "qbo", name: "QuickBooks Online" },
            }
          : { title: step.name, kind: "Read", detail: null },
    });
    // A read on a connector carries its logo; one on none, the reading icon.
    expect(screen.getByTestId("flow-mark-a")).toHaveAttribute("data-connector", "qbo");
    expect(screen.getByTestId("flow-mark-b")).toHaveAttribute("data-mark", "search");
    // An automation and a loop have their own; a decision and a Stop are their shapes.
    expect(screen.getByTestId("flow-mark-auto")).toHaveAttribute("data-mark", "worksheet");
    expect(screen.getByTestId("flow-mark-f")).toHaveAttribute("data-mark", "copy");
    expect(screen.queryByTestId("flow-mark-d")).toBeNull();
    expect(screen.queryByTestId("flow-mark-s")).toBeNull();
    // D2 (docs/plan.md §1.178): the kind is a badge on the corner, the connector's logo sits at
    // the right with who does the step, and the top edge is the colour of whose work it is.
    expect(screen.getByTestId("flow-badge-a")).toHaveTextContent("Read");
    expect(screen.getByTestId("flow-side-a")).toContainElement(screen.getByTestId("flow-mark-a"));
    expect(screen.getByTestId("flow-doer-a")).toHaveTextContent("code");
    expect(screen.getByTestId("flow-box-a")).toHaveClass("flow-box--by-read");
    expect(screen.getByTestId("flow-badge-b")).toContainElement(screen.getByTestId("flow-mark-b"));
    // A loop and an automation keep their own buttons at the right: no chip there.
    expect(screen.queryByTestId("flow-side-auto")).toBeNull();
    expect(screen.getByTestId("flow-box-auto")).toHaveClass("flow-box--by-flow");
    expect(screen.queryByTestId("flow-badge-d")).toBeNull();

    expect(screen.queryByTestId("flow-key")).toBeNull();
    fireEvent.click(screen.getByTestId("flow-key-toggle"));
    const key = screen.getByTestId("flow-key");
    // How to work the chart is said once, here.
    expect(screen.getByTestId("flow-key-how")).toHaveTextContent(
      "Click a step to set it up. Drag a box to move it.",
    );
    expect(key).toHaveTextContent("Reads from or changes a connected tool");
    expect(key).toHaveTextContent("Reads");
    expect(key).toHaveTextContent("An automation: saved steps");
    fireEvent.click(screen.getByTestId("flow-key-toggle"));
    expect(screen.queryByTestId("flow-key")).toBeNull();
  });

  it("folds a loop and opens an automation", () => {
    const props = setup();
    fireEvent.click(screen.getByTestId("flow-fold-f"));
    expect(props.onFold).toHaveBeenCalledWith("f", true);
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("flow-open-auto"));
    expect(props.onOpenGroup).toHaveBeenCalledWith("auto");
  });

  it("draws a folded loop as one box that unfolds", () => {
    const props = setup({ folded: new Set(["f"]) });
    expect(screen.queryByTestId("flow-box-i")).toBeNull();
    expect(screen.getByTestId("flow-fold-f")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("flow-fold-f"));
    expect(props.onFold).toHaveBeenCalledWith("f", false);
  });

  it("zooms with the buttons", () => {
    setup();
    fireEvent.click(screen.getByTestId("flow-zoom-in"));
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("110%");
    fireEvent.click(screen.getByTestId("flow-zoom-out"));
    fireEvent.click(screen.getByTestId("flow-zoom-out"));
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("90%");
    fireEvent.click(screen.getByTestId("flow-zoom-level"));
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("100%");
  });

  it("shows no + and no dot when read only", () => {
    setup({ readOnly: true });
    expect(screen.getByTestId("flow-box-a")).toBeInTheDocument();
    expect(screen.queryAllByLabelText("Add a step here")).toHaveLength(0);
    expect(screen.queryByTestId("flow-tail")).toBeNull();
    expect(screen.queryByTestId("flow-add-path-d")).toBeNull();
    expect(screen.queryByTestId("flow-dot-a")).toBeNull();
  });

  it("offers the dot under a step when it can be edited", () => {
    setup();
    expect(screen.getByTestId("flow-dot-a")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-dot-d")).toBeNull();
    expect(screen.queryByTestId("flow-dot-s")).toBeNull();
    expect(screen.getAllByLabelText("Add a step here").length).toBeGreaterThan(3);
  });
});
