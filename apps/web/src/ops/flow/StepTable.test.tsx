// The List (docs/builder-plan.md §12.3, F2): every step in reading order with its paths between,
// the first open item under a step, its status, and "Needs you" keeping only the open ones.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Process } from "../builder/model";
import { StepTable, tableRows } from "./StepTable";
import { buildStatuses } from "./status";

const process = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    { id: "read", kind: "skill", name: "Read the invoice", skill: "doc.read", input: {} },
    {
      id: "dup",
      kind: "if",
      name: "The invoice is a duplicate?",
      paths: [
        {
          id: "pa",
          name: "The invoice is a duplicate",
          when: { match: "all", rules: [] },
          steps: [
            { id: "tell", kind: "wait", name: "Tell Dana", for: "1 day" },
            { id: "end", kind: "stop", name: "Stop here", status: "succeeded" },
          ],
        },
      ],
      otherwise: { id: "po", steps: [] },
    },
    { id: "code", kind: "missing", name: "Code each line to a job", need: "A coding skill" },
    { id: "price", kind: "wait", name: "Check each price", for: "1 hour" },
  ],
} as unknown as Process;

const statuses = buildStatuses({
  process,
  items: [
    {
      key: "item:q",
      stepId: "price",
      level: "question",
      title: "How big a price change should it flag?",
      source: "build_item",
    },
  ],
  tried: [{ stepId: "read", status: "did", summary: "Read 4 lines" }],
});

describe("tableRows", () => {
  it("lists the trigger, the steps in reading order and the paths between", () => {
    const rows = tableRows(
      process,
      (s) => s.kind,
      () => "Started by hand",
    );
    expect(
      rows.map((r) => (r.type === "step" ? `${r.number}|${r.name}` : `${r.letter}|${r.text}`)),
    ).toEqual([
      "|Started by hand",
      "1|Read the invoice",
      "2|The invoice is a duplicate?",
      "A|if the invoice is a duplicate · ends there",
      "A1|Tell Dana",
      "A2|Stop here",
      "|otherwise · comes back",
      "3|Code each line to a job",
      "4|Check each price",
    ]);
  });
});

describe("StepTable", () => {
  it("shows each step's status and first open item, and opens a step", () => {
    const onSelect = vi.fn();
    render(<StepTable process={process} statuses={statuses} selected="read" onSelect={onSelect} />);
    expect(screen.getByTestId("flow-list-row-read")).toHaveTextContent("Did");
    expect(screen.getByTestId("flow-list-row-read")).toHaveTextContent("Read 4 lines");
    expect(screen.getByTestId("flow-list-row-tell")).toHaveTextContent("Ready");
    expect(screen.getByTestId("flow-list-row-code")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-list-why-code")).toHaveTextContent(
      "Nothing in the library does this yet",
    );
    expect(screen.getByTestId("flow-list-why-code")).toHaveClass("text-risk-ink");
    expect(screen.getByTestId("flow-list-row-price")).toHaveTextContent("1 question");
    expect(screen.getByTestId("flow-list-why-price")).toHaveClass("text-signal-ink");
    fireEvent.click(screen.getByTestId("flow-list-row-price"));
    expect(onSelect).toHaveBeenLastCalledWith("price");
    // A path row opens its decision.
    fireEvent.click(screen.getByTestId("flow-list-path:pa"));
    expect(onSelect).toHaveBeenLastCalledWith("dup");
  });

  it("keeps only the steps that need you", () => {
    render(<StepTable process={process} statuses={statuses} selected={null} onSelect={() => {}} />);
    expect(screen.getByTestId("flow-list-all")).toHaveTextContent("All 6 steps");
    expect(screen.getByTestId("flow-list-needs")).toHaveTextContent("Needs you · 2");
    fireEvent.click(screen.getByTestId("flow-list-needs"));
    expect(screen.getByTestId("flow-list-row-code")).toBeTruthy();
    expect(screen.getByTestId("flow-list-row-price")).toBeTruthy();
    expect(screen.queryByTestId("flow-list-row-read")).toBeNull();
    expect(screen.queryByTestId("flow-list-path:pa")).toBeNull();
  });

  it("says when nothing needs you", () => {
    render(
      <StepTable
        process={process}
        statuses={buildStatuses({ process: { ...process, steps: [] } })}
        selected={null}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("flow-list-needs"));
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });
});
