// B5 (docs/builder-plan.md §7): what the client may adjust, on the agent's Settings. Each setting
// shows its limits and its value now (a schedule in words); the client admin changes one: within
// its limits it is saved at once, beyond them it goes to us as a request; a client user only reads.
// Nothing marked: the card stays away.
import type { AdjustRowView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { AdjustSettings } from "./AdjustSettings";

const SVC = "00000000-0000-4000-8000-00000000b001";

const FLOOR: AdjustRowView = {
  id: "param-floor",
  label: "Price tolerance (%)",
  hint: "How far a price may move before a person looks.",
  kind: "number",
  current: "2",
  min: "0",
  max: "5",
  options: null,
  tighter: "lower",
  changedBy: null,
  changedSide: null,
  changedAt: null,
};

const DAILY: AdjustRowView = {
  id: "schedule-daily",
  label: "When it checks prices",
  hint: "",
  kind: "schedule",
  current: "0 7 * * 1-5",
  min: null,
  max: null,
  options: ["0 7 * * 1-5", "0 7 * * 1"],
  tighter: null,
  changedBy: "Ada",
  changedSide: "client",
  changedAt: "2026-11-19T10:00:00.000Z",
};

function show(settings: AdjustRowView[], isAdmin = true) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    [`GET /api/services/${SVC}/adjustable`]: () => ({ settings }),
  });
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <AdjustSettings
          id={SVC}
          name="Pia"
          isAdmin={isAdmin}
          scheduleText={(cron) => (cron === "0 7 * * 1" ? "Mondays at 7:00 AM" : `cron ${cron}`)}
        />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("what the client may adjust", () => {
  it("shows each setting's limits, its value now and who changed it", async () => {
    show([FLOOR, DAILY]);
    const card = await screen.findByTestId("agent-adjust");
    const floor = within(card).getByTestId("agent-adjust-param-floor");
    expect(floor).toHaveTextContent("Price tolerance (%)");
    expect(floor).toHaveTextContent("Between 0 and 5");
    expect(floor).toHaveTextContent("Lower is stricter.");
    expect(within(floor).getByTestId("agent-adjust-param-floor-value")).toHaveTextContent("2");
    const daily = within(card).getByTestId("agent-adjust-schedule-daily");
    expect(within(daily).getByTestId("agent-adjust-schedule-daily-value")).toHaveTextContent(
      "cron 0 7 * * 1-5",
    );
    expect(within(daily).getByTestId("agent-adjust-schedule-daily-by")).toHaveTextContent(
      /^Changed by Ada on /,
    );
    expect(card).toHaveTextContent(
      "A change within the limits, or a stricter one, applies at once.",
    );
  });

  it("saves a change within the limits at once", async () => {
    const api = show([FLOOR]);
    let body: unknown = null;
    api.on(`POST /api/services/${SVC}/adjustable/param-floor`, ({ init }) => {
      body = JSON.parse(String(init.body));
      return {
        outcome: "applied",
        message: "Saved.",
        request: null,
        settings: [
          {
            ...FLOOR,
            current: "1",
            changedBy: "Ada",
            changedSide: "client",
            changedAt: "2026-11-19T10:00:00.000Z",
          },
        ],
      };
    });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId("agent-adjust-param-floor-change"));
    const input = screen.getByTestId("agent-adjust-param-floor-input");
    await u.clear(input);
    await u.type(input, "1");
    await u.click(screen.getByTestId("agent-adjust-param-floor-save"));
    expect(await screen.findByTestId("agent-adjust-notice")).toHaveTextContent(
      "Saved. Price tolerance (%) is now 1.",
    );
    expect(body).toEqual({ value: "1" });
    expect(screen.getByTestId("agent-adjust-param-floor-value")).toHaveTextContent("1");
  });

  it("sends a change beyond the limits to us, with why", async () => {
    const api = show([DAILY]);
    let body: unknown = null;
    api.on(`POST /api/services/${SVC}/adjustable/schedule-daily`, ({ init }) => {
      body = JSON.parse(String(init.body));
      return {
        outcome: "requested",
        message: "Sent.",
        request: { id: "00000000-0000-4000-8000-0000000d0001", number: 12 },
        settings: [DAILY],
      };
    });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId("agent-adjust-schedule-daily-change"));
    const select = screen.getByTestId("agent-adjust-schedule-daily-input");
    // The allowed times read in words; anything else is asked for.
    expect(within(select).getByRole("option", { name: "Mondays at 7:00 AM" })).toBeInTheDocument();
    await u.selectOptions(select, "__other__");
    await u.type(screen.getByTestId("agent-adjust-schedule-daily-other"), "Every hour");
    await u.type(screen.getByTestId("agent-adjust-schedule-daily-note"), "Bills come all day.");
    await u.click(screen.getByTestId("agent-adjust-schedule-daily-save"));
    expect(await screen.findByTestId("agent-adjust-notice")).toHaveTextContent(
      "That is beyond what we set up, so it came to us as request #12. We'll answer there.",
    );
    expect(body).toEqual({ value: "Every hour", note: "Bills come all day." });
  });

  it("lets a client user read, never change, and stays away when nothing is marked", async () => {
    show([FLOOR], false);
    const card = await screen.findByTestId("agent-adjust");
    expect(card).toHaveTextContent("Your admin can change these.");
    expect(within(card).queryByTestId("agent-adjust-param-floor-change")).toBeNull();
  });

  it("shows nothing when the agent has nothing to adjust", async () => {
    const api = show([]);
    await waitFor(() => expect(api.calls).toContain(`GET /api/services/${SVC}/adjustable`));
    // Give the answer a turn to render, then nothing is there.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("agent-adjust")).toBeNull();
  });
});
