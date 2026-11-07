// The shared page parts (ui/README.md): each renders its words, its state and its colour meaning.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { fillPath, redirectTarget } from "../shell/Redirect";
import { applyTheme, storedTheme } from "../shell/theme";
import { ActivityRow, BeforeAfter } from "./activity";
import {
  AGENT_HUES,
  AgentBadge,
  AgentHuesProvider,
  agentHue,
  agentHues,
  PersonBadge,
} from "./badges";
import { Delta, hasRuns, ProgressBar, Sparkbars, Sparkline, StatTile } from "./figures";
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

  it("gives a tile its state colour, a mark and a link", () => {
    render(
      <MemoryRouter>
        <StatTile label="Waiting on you" value="5" tone="signal" to="/inbox" testId="w" />
        <StatTile
          label="Runs"
          value="12"
          tone="positive"
          mark={
            <Sparkline days={[{ runs: 1 }, { runs: 3, failed: 1 }, { runs: 2 }]} label="6 runs" />
          }
          testId="r"
        />
      </MemoryRouter>,
    );
    const waiting = screen.getByTestId("w");
    expect(waiting.tagName).toBe("A");
    expect(waiting).toHaveAttribute("href", "/inbox");
    expect(waiting).toHaveAttribute("data-tone", "signal");
    expect(waiting).toHaveClass("ui-accent", "ui-stat--signal");
    const spark = within(screen.getByTestId("r")).getByRole("img", { name: "6 runs" });
    expect(spark).toHaveClass("dt-spark");
    // One point per day, today's dot, and a risk dot on the day a run failed.
    expect(spark.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(3);
    expect(spark.querySelectorAll(".ui-sparkline__failed")).toHaveLength(1);
    expect(spark.querySelectorAll(".dot")).toHaveLength(1);
  });

  it("leaves a chart out when nothing ran, and says a change in words", () => {
    expect(hasRuns(undefined)).toBe(false);
    expect(hasRuns([{ runs: 0 }, { runs: 0 }])).toBe(false);
    expect(hasRuns([{ runs: 0 }, { runs: 2 }])).toBe(true);
    const words = (d: "up" | "down" | "same", by: number) =>
      d === "same" ? "Same as last week" : `${d === "up" ? "Up" : "Down"} ${by} on last week`;
    render(
      <>
        <Delta now={64} before={50} words={words} testId="up" />
        <Delta now={31} before={34} words={words} testId="down" />
        <Delta now={3} before={3} words={words} testId="same" />
      </>,
    );
    expect(screen.getByTestId("up")).toHaveTextContent("Up 14 on last week");
    expect(screen.getByTestId("up").querySelector(".up")).not.toBeNull();
    expect(screen.getByTestId("down")).toHaveTextContent("Down 3 on last week");
    expect(screen.getByTestId("down").querySelector(".down")).not.toBeNull();
    expect(screen.getByTestId("same")).toHaveTextContent("Same as last week");
  });
});

describe("an agent's colour", () => {
  it("is the same for the same agent, one of the five, wherever it shows", () => {
    const id = "00000000-0000-4000-8000-00000000b001";
    expect(agentHue(id)).toBe(agentHue(id));
    const hues = new Set(
      Array.from({ length: 50 }, (_, i) => agentHue(`agent-${i}`)).filter(
        (h) => h >= 1 && h <= AGENT_HUES,
      ),
    );
    // Every colour gets used across agents, and none falls outside the ramp.
    expect(hues.size).toBe(AGENT_HUES);
    render(
      <>
        <AgentBadge name="Pia" seed={id} testId="a" />
        <AgentBadge name="Material costs" seed={id} size="sm" testId="b" />
        <AgentBadge name="Sloan" testId="c" />
      </>,
    );
    // By its id, whatever name it shows; without an id, its name picks it.
    expect(screen.getByTestId("a").dataset.hue).toBe(String(agentHue(id)));
    expect(screen.getByTestId("b").dataset.hue).toBe(String(agentHue(id)));
    expect(screen.getByTestId("c").dataset.hue).toBe(String(agentHue("Sloan")));
  });

  it("never repeats within a client's first five agents, and follows its client's set", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000c00${i}`);
    const one = agentHues(ids.map((id) => ({ id, group: "harbor" })));
    expect(new Set(one.values()).size).toBe(5);
    // Another client's agents are spread on their own.
    const two = agentHues([
      ...ids.map((id) => ({ id, group: "harbor" })),
      ...ids.map((id) => ({ id: `x${id}`, group: "demo" })),
    ]);
    expect(new Set(ids.map((id) => two.get(`x${id}`))).size).toBe(5);
    render(
      <AgentHuesProvider agents={ids.map((id) => ({ id }))}>
        {ids.map((id) => (
          <AgentBadge key={id} name="Agent" seed={id} testId={`b-${id}`} />
        ))}
      </AgentHuesProvider>,
    );
    const shown = ids.map((id) => screen.getByTestId(`b-${id}`).dataset.hue);
    expect(new Set(shown).size).toBe(5);
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
            { key: "b", title: "Waiting for your approval", state: "waiting", time: "8:05" },
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

  it("keeps a new address's own query, then the old one's", () => {
    expect(redirectTarget("/inbox", {}, "?status=open")).toBe("/inbox?status=open");
    expect(redirectTarget("/contacts?show=organizations", {}, "")).toBe(
      "/contacts?show=organizations",
    );
    expect(redirectTarget("/contacts?import=1", {}, "?person=p1&import=0")).toBe(
      "/contacts?import=1&person=p1",
    );
  });

  it("applies a theme to <html> and reads the stored one", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe("system");
  });
});
