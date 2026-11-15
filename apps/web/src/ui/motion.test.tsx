// Agent motion (docs/plan.md §1.103): the thinking loops' markup, the progress displays, and the
// running step in a step list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { clampPercent, Progress, rulerTicks, sheetFills, Thinking } from "./motion";
import { StepList } from "./steps";

describe("Thinking", () => {
  it("draws each state with the delivery's markup, hidden from screen readers", () => {
    const { container } = render(
      <>
        <Thinking state="weighing" />
        <Thinking state="tracing" />
        <Thinking state="drafting" />
        <Thinking state="rechecking" />
      </>,
    );
    const [weighing, tracing, drafting, rechecking] = [
      ...container.querySelectorAll<HTMLElement>(".mz-think"),
    ];
    for (const el of [weighing, tracing, drafting, rechecking]) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
    expect(weighing).toHaveClass("mz-think--weighing");
    expect(weighing?.querySelectorAll("i")).toHaveLength(3);
    expect(tracing?.querySelectorAll("path.p")).toHaveLength(3);
    expect(tracing?.querySelectorAll("circle.n")).toHaveLength(5);
    expect(drafting?.querySelectorAll("i")).toHaveLength(3);
    expect(drafting?.querySelectorAll("b")).toHaveLength(1);
    // Rechecking's cursor comes first: the rows are picked by :nth-of-type.
    expect(rechecking?.firstElementChild?.tagName).toBe("B");
    expect(rechecking?.querySelectorAll("i")).toHaveLength(4);
  });

  it("has a class in the design system for every state", () => {
    const css = readFileSync(
      join(__dirname, "../../../../packages/design-system/components/Motion/motion.css"),
      "utf8",
    );
    for (const state of ["weighing", "tracing", "drafting", "rechecking"]) {
      expect(css).toContain(`.mz-think--${state}`);
    }
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("Progress", () => {
  it("rounds and bounds the percent as the delivery does", () => {
    expect(clampPercent(42.4)).toBe(42);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("fills one sheet per 10%, from the bottom", () => {
    expect(sheetFills(0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sheetFills(35)).toEqual([1, 1, 1, 0.5, 0, 0, 0, 0, 0, 0]);
    expect(sheetFills(100).every((f) => f === 1)).toBe(true);
  });

  it("turns on one ruler tick per 2.5%, none at zero", () => {
    expect(rulerTicks(0).filter(Boolean)).toHaveLength(0);
    expect(rulerTicks(10).filter(Boolean)).toHaveLength(5);
    expect(rulerTicks(100).filter(Boolean)).toHaveLength(41);
  });

  it("is a progressbar with its value, in either display", () => {
    render(
      <>
        <Progress variant="sheets" percent={35} label="Matching" name="Run" testId="sheets" />
        <Progress variant="ruler" percent={50} label="Drafting" name="Run" testId="ruler" />
      </>,
    );
    const sheets = screen.getByTestId("sheets");
    expect(sheets).toHaveAttribute("role", "progressbar");
    expect(sheets).toHaveAttribute("aria-valuenow", "35");
    expect(sheets).toHaveTextContent("35%");
    expect(sheets.querySelectorAll(".mz-sheets span.is-started")).toHaveLength(4);
    const ruler = screen.getByTestId("ruler");
    expect(ruler).toHaveAttribute("aria-valuenow", "50");
    expect(ruler.querySelectorAll(".mz-ruler span")).toHaveLength(41);
    expect(ruler.querySelectorAll(".mz-ruler span.is-on")).toHaveLength(21);
  });
});

describe("StepList's running step", () => {
  it("shows its thinking loop in place of the ring, and says which step is under way", () => {
    render(
      <I18nProvider locale="en">
        <StepList
          testId="steps"
          steps={[
            { key: "a", title: "Read the invoices", state: "done" },
            { key: "b", title: "Draft four reminders", state: "current", thinking: "drafting" },
            { key: "c", title: "Send", state: "todo" },
          ]}
        />
      </I18nProvider>,
    );
    const items = within(screen.getByTestId("steps")).getAllByRole("listitem");
    const mark = items[1]?.querySelector(".ui-steps__mark");
    expect(mark).toHaveClass("is-current", "is-thinking");
    expect(mark?.querySelector(".mz-think--drafting")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("In progress: Draft four reminders");
  });

  it("weighs when the step does not say, and announces nothing when no step runs", () => {
    const { rerender } = render(
      <I18nProvider locale="en">
        <StepList
          steps={[{ key: "a", title: <b>Match</b>, announce: "Match", state: "current" }]}
        />
      </I18nProvider>,
    );
    expect(document.querySelector(".mz-think--weighing")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("In progress: Match");
    rerender(
      <I18nProvider locale="en">
        <StepList steps={[{ key: "a", title: "Match", state: "done" }]} />
      </I18nProvider>,
    );
    expect(document.querySelector(".mz-think")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
