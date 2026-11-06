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
      const runs = [run(RUN_A, "waiting"), run(RUN_B, "succeeded")].filter(
        (r) => !statuses || statuses.split(",").includes(r.status),
      );
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
    expect(rowA).toHaveTextContent("Pia");
    expect(rowA).toHaveTextContent("Waiting on you");
    expect(within(table).getByTestId(`portal-run-${RUN_A}-open`)).toHaveAttribute(
      "href",
      `/runs/${RUN_A}`,
    );
    expect(within(table).getByTestId(`portal-run-row-${RUN_B}`)).toHaveTextContent("Done");
    expect(screen.getByTestId("portal-runs-per-day")).toBeInTheDocument();
    expect(screen.getByLabelText(/3 runs, 1 didn't finish/)).toBeInTheDocument();
    expect(queries[0]?.get("perDay")).toBe("true");
    expect(document.body.textContent).not.toContain("0.12");
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
