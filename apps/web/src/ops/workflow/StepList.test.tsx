import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE } from "../../test/fixtures";
import { StepList } from "./StepList";

const workflow = FORK_BUNDLE.workflows[0]?.workflow;
if (!workflow) throw new Error("fixture has no workflow");

describe("StepList", () => {
  it("numbers the trigger and top-level steps in order", () => {
    render(<StepList workflow={workflow} />);
    const list = screen.getByTestId("step-list");
    const numbered = within(list)
      .getAllByTestId(/-number$/)
      .map((n) => [n.getAttribute("data-testid"), n.textContent]);
    expect(numbered).toEqual([
      ["step-t1-number", "1"],
      ["step-find-number", "2"],
      ["step-read-number", "3"],
      ["step-confidence-number", "4"],
      ["step-update-number", "5"],
    ]);
    expect(
      within(screen.getByTestId("step-t1")).getByText("When bill created"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("step-update")).getByText("Itemize a bill · needs approval"),
    ).toBeInTheDocument();
  });

  it("lays a fork's paths side by side in order, with otherwise last", () => {
    render(<StepList workflow={workflow} />);
    const fork = screen.getByTestId("fork-confidence");
    const columns = within(fork).getAllByRole("region");
    expect(columns.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Path 1: Any line below 90%",
      "Path 2: Big change",
      "Otherwise",
    ]);
    expect((fork.querySelector(".grid") as HTMLElement).style.gridTemplateColumns).toBe(
      "minmax(226px, 1fr) minmax(226px, 1fr) minmax(226px, 1fr)",
    );

    // Rules read as the builder writes them; template braces are dropped.
    const low = screen.getByTestId("fork-confidence-path-low");
    expect(within(low).getByText("if Read a document · confidence < 0.9")).toBeInTheDocument();
    // A path's steps sit inside it, unnumbered.
    const ask = within(low).getByTestId("step-ask");
    expect(within(ask).getByText("Ask Jammil")).toBeInTheDocument();
    expect(within(ask).queryByTestId("step-ask-number")).toBeNull();

    // Empty paths and otherwise say the run continues.
    expect(
      within(screen.getByTestId("fork-confidence-path-big")).getByText("Nothing · continue"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("fork-confidence-otherwise")).getByText("Nothing · continue"),
    ).toBeInTheDocument();
    expect(within(fork).getByText("Paths join here")).toBeInTheDocument();
  });
});
