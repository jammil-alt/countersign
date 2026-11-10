// Cut text and its quick tooltip: it opens on hover or focus with the tip, closes on leave and
// Escape, and stays shut for text that wasn't cut and has no tip.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Clamp } from "./Clamp";

describe("Clamp", () => {
  it("shows its tip on hover, tied to the text, and hides it on leave", async () => {
    render(
      <Clamp tip="When an invoice has been read" testId="cell">
        Bill clerk
      </Clamp>,
    );
    const cell = screen.getByTestId("cell");
    expect(cell).toHaveClass("line-clamp-3");
    await userEvent.hover(cell);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("When an invoice has been read");
    expect(cell).toHaveAttribute("aria-describedby", tip.id);
    await userEvent.unhover(cell);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on keyboard focus and closes on Escape", async () => {
    render(
      <Clamp tip="Midwest Hardware · Invoice 55201">
        <a href="/run">Invoice 55201</a>
      </Clamp>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Midwest Hardware");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays shut for text that fits and has no tip, or a tip only for cut text", async () => {
    render(
      <>
        <Clamp testId="plain">Harbor Millwork</Clamp>
        <Clamp testId="owner" tip="Client admin, for 5 h" onlyWhenCut>
          Client admin
        </Clamp>
      </>,
    );
    await userEvent.hover(screen.getByTestId("plain"));
    await userEvent.hover(screen.getByTestId("owner"));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
