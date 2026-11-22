// The rail (docs/builder-plan.md §12.2, F2): today's catalog in the rail's order, tools by tool with
// their reads and writes, a search with "Ask the Builder", pressing an item adds it, and it folds.
import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PaletteSection } from "../builder/catalog";
import type { PaletteItem } from "../builder/model";
import { Rail, railGroups, toolLine } from "./Rail";

const tool = (id: string, sideEffect: "none" | "external") =>
  ({ id, sideEffect, verb: sideEffect === "none" ? "read" : "create", source: "qbo" }) as never;

const sections: PaletteSection[] = [
  {
    key: "triggers",
    label: "Triggers",
    items: [
      {
        type: "trigger",
        key: "trigger:schedule",
        title: "On a schedule",
        detail: "Weekdays at 7:00",
        on: { type: "schedule", cron: "0 7 * * 1-5" },
      },
    ],
  },
  {
    key: "processes",
    label: "Automations",
    items: [
      {
        type: "process",
        key: "process:follow-up@2",
        title: "Polite follow-up",
        detail: "Version 2",
        ref: "follow-up@2",
      },
    ],
  },
  {
    key: "skills",
    label: "Skills",
    items: [
      {
        type: "skill",
        key: "skill:doc.read",
        title: "Read a document",
        detail: "Reads an invoice or a receipt",
        ref: "doc.read",
        skill: {} as never,
        own: false,
      },
    ],
  },
  { key: "actions", label: "Actions", items: [] },
  {
    key: "connector:qbo",
    label: "QuickBooks",
    items: [
      {
        type: "read",
        key: "read:qbo.vendor.find",
        title: "Find a vendor",
        detail: "Reads QuickBooks",
        tool: tool("qbo.vendor.find", "none"),
        group: "QuickBooks",
      },
      {
        type: "read",
        key: "read:qbo.bill.find",
        title: "Find a bill",
        detail: "Reads QuickBooks",
        tool: tool("qbo.bill.find", "none"),
        group: "QuickBooks",
      },
      {
        type: "write",
        key: "write:qbo.bill.create",
        title: "Create a bill",
        detail: "Change in QuickBooks",
        tool: tool("qbo.bill.create", "external"),
        group: "QuickBooks",
      },
    ],
  },
  {
    key: "people",
    label: "People",
    items: [
      {
        type: "person",
        key: "person:approve",
        title: "Approve",
        detail: "A person approves",
        mode: "approve",
      },
    ],
  },
  {
    key: "logic",
    label: "Logic",
    items: [
      {
        type: "logic",
        key: "logic:wait",
        title: "Wait",
        detail: "Pause for a while",
        logic: "wait",
      },
    ],
  },
  {
    key: "handoff",
    label: "Other agents",
    items: [
      {
        type: "handoff",
        key: "handoff",
        title: "Hand off to another agent",
        detail: "Start another agent",
      },
    ],
  },
];

function renderRail(props: Partial<Parameters<typeof Rail>[0]> = {}) {
  const onPick = vi.fn<(item: PaletteItem) => void>();
  const onSay = vi.fn<(words: string) => void>();
  render(
    <DndContext>
      <Rail sections={sections} onPick={onPick} onSay={onSay} {...props} />
    </DndContext>,
  );
  return { onPick, onSay };
}

describe("railGroups", () => {
  it("orders Skills, Automations, Tools, People, Logic, Other agents; triggers only when asked", () => {
    expect(railGroups(sections, false).map((g) => g.label)).toEqual([
      "Skills",
      "Automations",
      "Tools",
      "People",
      "Logic",
      "Other agents",
    ]);
    expect(railGroups(sections, true)[0]?.label).toBe("Starts when");
  });

  it("says a tool's reads and writes", () => {
    expect(toolLine(sections[4]?.items ?? [])).toBe("2 reads · 1 write");
  });
});

describe("Rail", () => {
  it("shows the sections and opens a tool to its reads and writes", () => {
    renderRail();
    expect(screen.queryByTestId("flow-rail-triggers")).toBeNull();
    const qbo = screen.getByTestId("flow-rail-tool-qbo");
    expect(screen.getByTestId("flow-rail-tool-qbo-line")).toHaveTextContent("2 reads · 1 write");
    expect(within(qbo).getByText("Create a bill")).toBeTruthy();
  });

  it("adds an item when it is pressed", () => {
    const { onPick } = renderRail();
    fireEvent.click(screen.getByTestId("flow-rail-item-logic:wait"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: "logic:wait" }));
  });

  it("narrows to what matches, and sends the words to the Builder", () => {
    const { onSay } = renderRail();
    fireEvent.change(screen.getByTestId("flow-rail-search"), { target: { value: "bill" } });
    expect(screen.getByTestId("flow-rail-item-write:qbo.bill.create")).toBeTruthy();
    expect(screen.getByTestId("flow-rail-item-read:qbo.bill.find")).toBeTruthy();
    expect(screen.queryByTestId("flow-rail-item-read:qbo.vendor.find")).toBeNull();
    expect(screen.queryByTestId("flow-rail-skills")).toBeNull();
    expect(screen.getByTestId("flow-rail-say")).toHaveTextContent("Ask the Builder: “bill”");
    fireEvent.click(screen.getByTestId("flow-rail-say"));
    expect(onSay).toHaveBeenCalledWith("bill");

    fireEvent.change(screen.getByTestId("flow-rail-search"), {
      target: { value: "email the vendor twice" },
    });
    expect(screen.getByTestId("flow-rail-none")).toBeTruthy();
    fireEvent.click(screen.getByTestId("flow-rail-say"));
    expect(onSay).toHaveBeenLastCalledWith("email the vendor twice");
  });

  it("offers the triggers when asked", () => {
    renderRail({ triggers: true });
    expect(screen.getByTestId("flow-rail-triggers")).toHaveTextContent("On a schedule");
  });

  it("folds to a thin strip and back", () => {
    const onFold = vi.fn();
    renderRail({ onFold });
    fireEvent.click(screen.getByTestId("flow-rail-fold"));
    expect(onFold).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("flow-rail")).toHaveAttribute("data-folded");
    expect(screen.queryByTestId("flow-rail-search")).toBeNull();
    fireEvent.click(screen.getByTestId("flow-rail-unfold"));
    expect(screen.getByTestId("flow-rail-search")).toBeTruthy();
  });
});
