// What's left (owner, 2026-11-24): a pack that is off has its fix beside it, so it can be switched
// on without leaving the builder; other items have none.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LeftItem } from "./data-use";
import { WhatsLeft } from "./whats-left";

const ITEMS: LeftItem[] = [
  {
    kind: "pack",
    key: "pack:materials",
    workflow: "match-invoice",
    stepId: "s7",
    text: "Turn on the Materials pack for Demo client: 4 steps need it",
  },
  {
    kind: "connection",
    key: "connection:qbo",
    workflow: "match-invoice",
    stepId: "s1",
    text: "Connect QuickBooks Online for Demo client: 1 step needs it",
  },
];

describe("What's left", () => {
  it("puts the fix beside a pack that is off", () => {
    render(
      <WhatsLeft
        items={ITEMS}
        problems={null}
        problemCount={0}
        summary={{ reads: [], saves: [], changes: [] }}
        onSelect={() => {}}
        onTest={() => {}}
        action={(item) =>
          item.kind === "pack" ? (
            <button type="button" data-testid={`switch-on-${item.key}`}>
              Switch on
            </button>
          ) : null
        }
      />,
    );
    const rows = within(screen.getByTestId("builder-left-setup")).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByTestId("switch-on-pack:materials")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText("Switch on")).toBeNull();
  });
});
