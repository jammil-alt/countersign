// The portal's runs list (C9): runs with their short ids, agents and statuses in the portal's words,
// runs per day, the status tabs as the list's filter, and a question in plain words answered as the
// same filter, shown back as chips. Never cost.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const SVC = "00000000-0000-4000-8000-00000000b001";
const RUN_A = "00000000-0000-4000-8000-0000001a2b3c";
const RUN_B = "00000000-0000-4000-8000-0000004d5e6f";

const run = (id: string, status: string) => ({
  id,
  service: { id: SVC, name: "Pia" },
  status,
  startedAt: "2026-11-05T08:00:00.000Z",
  finishedAt: status === "succeeded" ? "2026-11-05T08:04:00.000Z" : null,
  costUsd: "0.1200",
});

function setup() {
  const queries: URLSearchParams[] = [];
  const asks: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => ({
      client: { id: DEMO, name: "Demo client" },
      services: [{ id: SVC, name: "Pia", description: null, status: "active" }],
      needsYou: { inbox: 1 },
      recentRuns: [],
    }),
    "GET /api/runs": ({ url }) => {
      queries.push(url.searchParams);
      const statuses = url.searchParams.get("statuses");
      const runs = [
        {
          ...run(RUN_A, "waiting"),
          subject: {
            kind: "change",
            name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
            number: "20418",
            with: "Northline Panel Supply",
          },
        },
        run(RUN_B, "succeeded"),
      ].filter((r) => !statuses || statuses.split(",").includes(r.status));
      return {
        runs,
        perDay: [
          { day: "2026-11-04", runs: 3, failed: 1 },
          { day: "2026-11-05", runs: 2, failed: 0 },
        ],
      };
    },
    "POST /api/runs/ask": ({ init }) => {
      asks.push(JSON.parse(String(init.body)));
      return {
        understood: true,
        filter: { statuses: ["succeeded"] },
        chips: [{ key: "statuses", value: "succeeded" }],
        leftOut: ["by Iris"],
        query: { statuses: "succeeded" },
        runs: [],
      };
    },
  });
  render(
    <MemoryRouter initialEntries={["/runs"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, queries, asks };
}

describe("portal runs", () => {
  it("lists runs with short ids, agents and statuses, and draws runs per day", async () => {
    const { queries } = setup();
    const table = await screen.findByTestId("portal-runs");
    const rowA = within(table).getByTestId(`portal-run-row-${RUN_A}`);
    expect(rowA).toHaveTextContent("R-1a2b3c");
    // Titled by what it is about; a run with nothing to name keeps its short id as its title.
    expect(within(table).getByTestId(`portal-run-${RUN_A}-open`)).toHaveTextContent(
      "QuickBooks bill 20418 · Northline Panel Supply",
    );
    expect(within(table).getByTestId(`portal-run-${RUN_B}-open`)).toHaveTextContent("R-4d5e6f");
    expect(rowA).toHaveTextContent("Pia");
    expect(rowA).toHaveTextContent("Waiting on you");
    expect(within(table).getByTestId(`portal-run-${RUN_A}-open`)).toHaveAttribute(
      "href",
      `/runs/${RUN_A}`,
    );
    expect(within(table).getByTestId(`portal-run-row-${RUN_B}`)).toHaveTextContent("Done");
    expect(screen.getByTestId("portal-runs-per-day")).toBeInTheDocument();
    // An older answer (runs and failed only): the rest is drawn as done.
    expect(screen.getByLabelText(/Done: 2, Failed: 1/)).toBeInTheDocument();
    expect(queries[0]?.get("perDay")).toBe("true");
    expect(document.body.textContent).not.toContain("0.12");
  });

  // QA round 1: a run waiting on your approval keeps status "running" in the API.
  it("never shows a run waiting on you as running, and keeps its wait out of Took", async () => {
    const HOUR = 3_600_000;
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [],
        needsYou: { inbox: 1 },
        recentRuns: [],
      }),
      "GET /api/runs": () => ({
        runs: [
          {
            ...run(RUN_A, "running"),
            startedAt: "2026-11-05T23:44:00.000Z",
            waitingOnYou: true,
            waitedMs: 21 * HOUR,
          },
          {
            ...run(RUN_B, "succeeded"),
            startedAt: "2026-11-03T08:00:00.000Z",
            finishedAt: "2026-11-04T06:00:00.000Z",
            waitingOnYou: false,
            waitedMs: 21 * HOUR,
          },
        ],
        // Started Nov 5 where the client is, still waiting: one waiting bar on Nov 5.
        perDay: [
          { day: "2026-11-03", runs: 1, failed: 0, done: 1, waiting: 0, going: 0, stopped: 0 },
          { day: "2026-11-05", runs: 1, failed: 0, done: 0, waiting: 1, going: 0, stopped: 0 },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const table = await screen.findByTestId("portal-runs");
    expect(within(table).getByTestId(`portal-run-state-${RUN_A}`)).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(within(table).getByTestId(`portal-run-row-${RUN_A}`)).not.toHaveTextContent("Running");
    // Not finished: Took is "—", and the wait so far shows apart.
    expect(within(table).getByTestId(`portal-run-took-${RUN_A}`)).toHaveTextContent(
      "—Waited 21 h on you",
    );
    // Finished: 22 h in all, 21 of them waiting on you, so it worked 1 h.
    expect(within(table).getByTestId(`portal-run-took-${RUN_B}`)).toHaveTextContent(
      "1 hWaited 21 h on you",
    );
    const nov5 = screen.getByTestId("portal-runs-per-day-2026-11-05");
    expect(nov5.querySelector("[data-state]")?.getAttribute("data-state")).toBe("waiting");
    expect(nov5.querySelector('[data-state="done"]')).toBeNull();
    expect(nov5).toHaveAccessibleName(/Waiting on you: 1/);
    expect(screen.getByTestId("portal-runs-per-day")).toHaveTextContent("Waiting on you");
  });

  it("filters by status from the tabs", async () => {
    const { queries } = setup();
    await screen.findByTestId("portal-runs");
    await userEvent.click(screen.getByTestId("portal-runs-filter-waiting"));
    await waitFor(() => expect(queries.at(-1)?.get("statuses")).toBe("waiting"));
    await waitFor(() =>
      expect(screen.queryByTestId(`portal-run-row-${RUN_B}`)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId(`portal-run-row-${RUN_A}`)).toBeInTheDocument();
  });

  it("sorts by a column head, and turns the order round on a second pick", async () => {
    setup();
    const table = await screen.findByTestId("portal-runs");
    const order = () =>
      within(table)
        .getAllByTestId(/^portal-run-row-/)
        .map((r) => r.getAttribute("data-testid"));
    // Newest first until a head is picked; both started together, so as the API sent them.
    expect(order()).toEqual([`portal-run-row-${RUN_A}`, `portal-run-row-${RUN_B}`]);
    const status = screen.getByTestId("portal-runs-sort-status");
    expect(status.closest("th")).toHaveAttribute("aria-sort", "none");

    // Words go A to Z first: "Done" before "Waiting on you".
    await userEvent.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(order()).toEqual([`portal-run-row-${RUN_B}`, `portal-run-row-${RUN_A}`]);
    await userEvent.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(order()).toEqual([`portal-run-row-${RUN_A}`, `portal-run-row-${RUN_B}`]);
  });

  it("opens a run from anywhere on its row", async () => {
    setup();
    const row = await screen.findByTestId(`portal-run-row-${RUN_B}`);
    // The run's link stays the way in for keyboards; a click on the agent's cell opens it too.
    expect(within(row).getByTestId(`portal-run-${RUN_B}-open`)).toHaveAttribute(
      "href",
      `/runs/${RUN_B}`,
    );
    await userEvent.click(within(row).getByText("Pia"));
    await waitFor(() => expect(screen.queryByTestId("portal-runs-page")).toBeNull());
  });

  it("answers a question in plain words as the list's filter, shown as chips", async () => {
    const { queries, asks } = setup();
    await screen.findByTestId("portal-runs");
    await userEvent.type(screen.getByTestId("portal-runs-ask-input"), "runs that finished");
    await userEvent.click(screen.getByTestId("portal-runs-ask-send"));
    expect(asks).toEqual([{ text: "runs that finished" }]);
    expect(await screen.findByTestId("portal-runs-chip")).toHaveTextContent("status Done");
    expect(screen.getByTestId("portal-runs-ask-leftout")).toHaveTextContent("by Iris");
    await waitFor(() => expect(queries.at(-1)?.get("statuses")).toBe("succeeded"));
    await userEvent.click(screen.getByTestId("portal-runs-ask-clear"));
    expect(screen.queryByTestId("portal-runs-chip")).not.toBeInTheDocument();
  });
});

// Review of #259: a filter of one agent's list keeps that agent's rows, dimmed, while a status
// loads; another agent's rows never show under a filter (docs/plan.md §1.91, 5).
describe("the runs list's kept rows", () => {
  it("never shows the last agent's rows after picking another agent and then a status", async () => {
    const OTHER = "00000000-0000-4000-8000-00000000b002";
    const RUN_X = "00000000-0000-4000-8000-0000000a0001";
    const RUN_Y = "00000000-0000-4000-8000-0000000a0002";
    const runOf = (id: string, agent: string, name: string) => ({
      ...run(id, "succeeded"),
      service: { id: agent, name },
    });
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [
          { id: SVC, name: "Pia", description: null, status: "active" },
          { id: OTHER, name: "Cole", description: null, status: "active" },
        ],
        needsYou: { inbox: 0 },
        recentRuns: [],
      }),
      "GET /api/runs": ({ url }) => {
        const agents = url.searchParams.get("agents");
        // Held: the status filter on the second agent never answers in this test.
        if (url.searchParams.get("statuses")) return new Promise(() => {});
        if (agents === OTHER) return { runs: [runOf(RUN_Y, OTHER, "Cole")] };
        return { runs: [runOf(RUN_X, SVC, "Pia")] };
      },
    });
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId(`portal-run-row-${RUN_X}`)).toBeInTheDocument();
    // Pick the other agent: its rows, never the first agent's.
    await screen.findByRole("option", { name: "Cole" });
    await userEvent.selectOptions(screen.getByTestId("portal-runs-agent"), OTHER);
    expect(await screen.findByTestId(`portal-run-row-${RUN_Y}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`portal-run-row-${RUN_X}`)).toBeNull();
    // A status while the answer is held: the second agent's rows stay, dimmed; never the first's.
    await userEvent.click(screen.getByTestId("portal-runs-filter-done"));
    await waitFor(() =>
      expect(screen.getByTestId("portal-runs-results")).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.getByTestId(`portal-run-row-${RUN_Y}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`portal-run-row-${RUN_X}`)).toBeNull();
  });
});
