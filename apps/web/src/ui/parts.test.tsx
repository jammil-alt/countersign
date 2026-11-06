// The shared page parts (ui/README.md): each renders its words, its state and its colour meaning.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { fillPath } from "../shell/Redirect";
import { applyTheme, storedTheme } from "../shell/theme";
import { ActivityRow, BeforeAfter } from "./activity";
import { AgentBadge, PersonBadge } from "./badges";
import { ProgressBar, Sparkbars, StatTile } from "./figures";
import { CHIP_STATES, CHIP_TONE, runChipState, StatusChip, serviceChipState } from "./status";
import { StepList } from "./steps";

describe("StatusChip", () => {
  it("draws each state in its fixed colour meaning, always with words", () => {
    expect(CHIP_TONE).toEqual({
      running: "accent",
      waiting: "warning",
      blocked: "risk",
      failed: "risk",
      done: "positive",
      checked: "positive",
      setup: "neutral",
      idle: "neutral",
      paused: "neutral",
      person: "person",
    });
    render(
      CHIP_STATES.map((s) => (
        <StatusChip key={s} state={s} testId={`chip-${s}`}>
          {s}
        </StatusChip>
      )),
    );
    expect(screen.getByTestId("chip-waiting")).toHaveClass("ds-pill--warning", "ui-chip");
    expect(screen.getByTestId("chip-running")).toHaveClass("ds-pill--accent");
    expect(screen.getByTestId("chip-done")).toHaveClass("ds-pill--positive");
    expect(screen.getByTestId("chip-failed")).toHaveClass("text-risk-ink");
    expect(screen.getByTestId("chip-person")).toHaveClass("text-copper-ink");
    expect(screen.getByTestId("chip-waiting")).toHaveTextContent("waiting");
  });

  it("maps run and service statuses", () => {
    expect(
      ["queued", "running", "waiting", "succeeded", "failed", "cancelled"].map(runChipState),
    ).toEqual(["idle", "running", "waiting", "done", "failed", "idle"]);
    expect(["active", "paused", "draft", "retired"].map(serviceChipState)).toEqual([
      "running",
      "paused",
      "setup",
      "idle",
    ]);
  });
});

describe("badges", () => {
  it("draws an agent as an initials tile and a person in copper", () => {
    render(
      <>
        <AgentBadge name="Pia" testId="agent" />
        <PersonBadge name="Ana Ruiz" line="Your Mezonas lead" testId="lead" />
        <PersonBadge name="Dana Kim" plain testId="client" />
      </>,
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("PI");
    expect(screen.getByTestId("agent")).toHaveClass("ui-agentbadge");
    const lead = screen.getByTestId("lead");
    expect(lead).toHaveClass("mz-person--lead");
    expect(lead.querySelector(".mz-lead")).toHaveTextContent("AR");
    expect(lead).toHaveTextContent("Your Mezonas lead");
    expect(screen.getByRole("img", { name: "Dana Kim" }).firstElementChild).toHaveClass(
      "ui-personbadge--plain",
    );
  });
});

describe("figures", () => {
  it("shows a stat tile's label, value and toned note", () => {
    render(
      <StatTile
        label="Need us"
        value="4"
        note="2 blocked over 6 h"
        noteTone="risk"
        alert
        testId="t"
      />,
    );
    const tile = screen.getByTestId("t");
    expect(tile).toHaveClass("ui-stat--alert");
    expect(within(tile).getByText("4")).toHaveClass("ui-stat__value");
    expect(within(tile).getByText("2 blocked over 6 h")).toHaveClass("ui-tone-risk");
  });

  it("fills a progress bar to its share, and labels sparkbars", () => {
    render(
      <>
        <ProgressBar value={3} max={6} label="Step 3 of 6" tone="waiting" />
        <Sparkbars
          label="Last 3 runs: 1 failed"
          values={[{ value: 2 }, { value: 4, failed: true }, { value: 1 }]}
        />
      </>,
    );
    const bar = screen.getByRole("progressbar", { name: "Step 3 of 6" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveClass("ui-bar--waiting");
    expect(bar.firstElementChild).toHaveStyle({ width: "50%" });
    const spark = screen.getByRole("img", { name: "Last 3 runs: 1 failed" });
    expect(spark.children).toHaveLength(3);
    expect(spark.children[1]).toHaveClass("is-failed");
    expect(spark.children[1]).toHaveStyle({ height: "100%" });
  });
});

describe("StepList", () => {
  it("numbers the steps, marks each state in words, and colours person steps copper", () => {
    render(
      <I18nProvider locale="es">
        <StepList
          testId="steps"
          steps={[
            { key: "a", title: "Pulled the aging report", state: "done", time: "8:01" },
            { key: "b", title: "Waiting for your sign", state: "waiting", time: "8:05" },
            { key: "c", title: "Tell Dana", state: "person" },
            { key: "d", title: "Send", state: "todo", detail: "Follow up Nov 12" },
          ]}
        />
      </I18nProvider>,
    );
    const items = within(screen.getByTestId("steps")).getAllByRole("listitem");
    expect(items.map((i) => i.dataset.state)).toEqual(["done", "waiting", "person", "todo"]);
    expect(items[0]).toHaveTextContent("8:01");
    expect(items[0]).toHaveTextContent("Hecho");
    expect(items[1]).toHaveTextContent("!");
    expect(items[2]?.querySelector(".is-person")).toHaveTextContent("3");
    expect(within(items[2] as HTMLElement).getByText("Tell Dana")).toHaveClass("text-copper-ink");
    expect(items[3]).toHaveTextContent("Follow up Nov 12");
  });
});

describe("activity", () => {
  it("shows a row's time, badge, text and chip, linking the text", () => {
    render(
      <MemoryRouter>
        <ActivityRow
          time="8:40"
          badge={<AgentBadge name="Iris" size="sm" />}
          end={<StatusChip state="done">Done</StatusChip>}
          to="/runs/r1"
          testId="row"
        >
          Iris entered 6 draft bills
        </ActivityRow>
      </MemoryRouter>,
    );
    const row = screen.getByTestId("row");
    expect(row).toHaveTextContent("8:40");
    expect(within(row).getByRole("link", { name: "Iris entered 6 draft bills" })).toHaveAttribute(
      "href",
      "/runs/r1",
    );
    expect(within(row).getByText("Done")).toBeInTheDocument();
  });

  it("puts a change's before beside its after", () => {
    render(<BeforeAfter before="$71.80" after="$76.72" afterLabel="After you sign" testId="ba" />);
    const ba = screen.getByTestId("ba");
    expect(ba).toHaveTextContent("Before$71.80");
    expect(ba).toHaveTextContent("After you sign$76.72");
  });
});

describe("shell helpers", () => {
  it("fills a redirect's params", () => {
    expect(fillPath("/agents/:id", { id: "a b" })).toBe("/agents/a%20b");
    expect(fillPath("/reports/*", { "*": "materials/costs" })).toBe("/reports/materials/costs");
    expect(fillPath("/desk", {})).toBe("/desk");
  });

  it("applies a theme to <html> and reads the stored one", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe("system");
  });
});
