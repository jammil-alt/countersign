// O9 Runs: the filter as chips (and in the address), quick views, a question in plain words,
// failures grouped by error, retry of the selected runs, saved views and the CSV; a run waiting on
// a person reads "Waiting for approval" with whom it waits on, never "Running".
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const AGENT = "00000000-0000-4000-8000-00000000b001";
const FAILED = "00000000-0000-4000-8000-0000000f1001";
const RUNNING = "00000000-0000-4000-8000-0000000f1002";
const WAITING = "00000000-0000-4000-8000-0000000f1003";
const VIEW = "00000000-0000-4000-8000-0000000f9001";

const run = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: DEMO,
  agentId: AGENT,
  agentVersionId: "00000000-0000-4000-8000-0000000e0001",
  workflowSlug: "weekly-reminders",
  mode: "live",
  status,
  trigger: { type: "schedule" },
  costUsd: "0.0900",
  error: null,
  startedAt: "2026-11-06T09:10:00.000Z",
  finishedAt: status === "running" ? null : "2026-11-06T09:11:03.000Z",
  createdAt: "2026-11-06T09:10:00.000Z",
  ...over,
});

const failedRun = run(FAILED, "failed", {
  workflowName: "Weekly reminders",
  error: { reason: "HTTP 401", nodeId: "send", key: "gmail.send:unauthorized" },
  errorStep: "Send the reminder",
});

const waitingRun = run(WAITING, "running", {
  createdAt: new Date(Date.now() - 39 * 3_600_000).toISOString(),
  waiting: {
    on: "client_admin",
    person: null,
    since: new Date(Date.now() - 39 * 3_600_000).toISOString(),
    items: 1,
    nobodyToAct: "not_signed_in",
    emailOff: false,
  },
});

function renderAt(api: ReturnType<typeof fakeApi>, path = "/ops/runs") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

function setup() {
  const queries: URLSearchParams[] = [];
  const retried: string[] = [];
  const saved: unknown[] = [];
  let views: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/runs": ({ url }) => {
      queries.push(url.searchParams);
      const statuses = url.searchParams.get("statuses");
      return {
        runs:
          statuses === "failed"
            ? [failedRun]
            : statuses === "waiting"
              ? [waitingRun]
              : [failedRun, run(RUNNING, "running"), waitingRun],
        agents: [{ id: AGENT, tenantId: DEMO, slug: "cole", name: "Cole", serviceName: null }],
        ...(url.searchParams.get("groupBy") === "error"
          ? {
              groups: [
                {
                  key: "gmail.send:unauthorized",
                  count: 5,
                  clients: [{ id: DEMO, name: "Demo client" }],
                  agents: [AGENT],
                  latestRunId: FAILED,
                  latestAt: "2026-11-06T09:11:03.000Z",
                },
              ],
            }
          : {}),
      };
    },
    "GET /api/ops/saved-views": () => ({ views }),
    "POST /api/ops/saved-views": ({ init }) => {
      const body = JSON.parse(String(init.body));
      saved.push(body);
      const view = {
        id: VIEW,
        surface: "ops_runs",
        name: body.name,
        filters: body.filters,
        createdAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
      };
      views = [view];
      return { view };
    },
    [`POST /api/ops/runs/${FAILED}/retry`]: () => {
      retried.push(FAILED);
      return { runId: FAILED, shortId: "R-0f1001", resumeFrom: "send" };
    },
    "POST /api/ops/runs/ask": () => ({
      understood: true,
      filter: { statuses: ["failed"], clients: [DEMO] },
      chips: [],
      leftOut: ["slow"],
      query: { statuses: "failed", clients: DEMO },
      runs: [],
    }),
  });
  return { api, queries, retried, saved };
}

describe("ops runs", () => {
  it("lists runs with their error, and retries the selected failed run", async () => {
    const { api, retried } = setup();
    renderAt(api);
    const row = await screen.findByTestId(`ops-run-row-${FAILED}`);
    expect(row).toHaveTextContent("R-0f1001");
    expect(row).toHaveTextContent("Demo client");
    expect(row).toHaveTextContent("Cole");
    expect(row).toHaveTextContent("Weekly reminders");
    expect(row).not.toHaveTextContent("weekly-reminders");
    // The error in plain words, at the step's name (not "unknown · at send").
    expect(screen.getByTestId(`ops-run-${FAILED}-error`)).toHaveTextContent(
      "HTTP 401 · at Send the reminder",
    );
    expect(row).toHaveTextContent("$0.09");
    expect(within(row).getByRole("link", { name: "R-0f1001" })).toHaveAttribute(
      "href",
      `/ops/runs/${FAILED}`,
    );
    // The list starts with its column heads: the bulk actions show once a run is picked.
    expect(screen.queryByTestId("ops-runs-retry")).toBeNull();
    await userEvent.click(screen.getByTestId(`ops-run-${FAILED}-select`));
    expect(screen.getByTestId("ops-runs-selected")).toHaveTextContent("1 selected");
    // A running run can be cancelled, not retried.
    expect(screen.getByTestId("ops-runs-cancel")).toBeDisabled();
    await userEvent.click(screen.getByTestId("ops-runs-retry"));
    await waitFor(() => expect(retried).toEqual([FAILED]));
    expect(await screen.findByTestId("ops-runs-note")).toHaveTextContent("Retried 1 run.");
  });

  it("filters with a quick view, groups failures by error and picks a group", async () => {
    const { api, queries } = setup();
    renderAt(api);
    await screen.findByTestId(`ops-run-row-${FAILED}`);
    await userEvent.click(screen.getByTestId("ops-runs-view-failed"));
    expect(await screen.findByTestId("ops-runs-chip-statuses")).toHaveTextContent("status Failed");
    expect(screen.getByTestId("ops-runs-chip-since")).toBeInTheDocument();
    const group = await screen.findByTestId("ops-runs-error-gmail.send:unauthorized");
    expect(group).toHaveTextContent("5");
    expect(group).toHaveTextContent("Gmail · Send an email · unauthorized");
    expect(group).toHaveTextContent("Demo client · Cole");
    await userEvent.click(group);
    expect(await screen.findByTestId("ops-runs-chip-errorKey")).toHaveTextContent(
      "error Gmail · Send an email · unauthorized",
    );
    await waitFor(() => expect(queries.at(-1)?.get("errorKey")).toBe("gmail.send:unauthorized"));
    expect(queries.at(-1)?.get("groupBy")).toBe("error");
    // The CSV link carries the same filter.
    expect(screen.getByTestId("ops-runs-csv").getAttribute("href")).toContain(
      "errorKey=gmail.send%3Aunauthorized",
    );
    // Removing a chip removes its filter.
    await userEvent.click(screen.getByRole("button", { name: "Remove the error filter" }));
    expect(screen.queryByTestId("ops-runs-chip-errorKey")).toBeNull();
  });

  it("turns a question into the filter and saves it as a view", async () => {
    const { api, saved } = setup();
    renderAt(api);
    await screen.findByTestId(`ops-run-row-${FAILED}`);
    await userEvent.type(
      screen.getByTestId("ops-runs-ask"),
      "failed runs for the demo client{Enter}",
    );
    expect(await screen.findByTestId("ops-runs-chip-clients")).toHaveTextContent(
      "client Demo client",
    );
    expect(screen.getByTestId("ops-runs-note")).toHaveTextContent("We left out: slow.");

    await userEvent.click(screen.getByTestId("ops-runs-save-view"));
    await userEvent.type(screen.getByTestId("ops-runs-view-name"), "Demo failures");
    await userEvent.click(screen.getByTestId("ops-runs-view-save"));
    await waitFor(() =>
      expect(saved).toEqual([
        {
          surface: "ops_runs",
          name: "Demo failures",
          filters: { statuses: ["failed"], clients: [DEMO] },
        },
      ]),
    );
    expect(await screen.findByTestId(`ops-runs-saved-${VIEW}`)).toHaveTextContent("Demo failures");
  });

  it("shows a run waiting on a person as waiting for approval, on whom and for how long", async () => {
    const { api } = setup();
    renderAt(api);
    const status = await screen.findByTestId(`ops-run-${WAITING}-status`);
    expect(status).toHaveTextContent("Waiting for approval · client admin");
    expect(status).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId(`ops-run-${WAITING}-wait`)).toHaveTextContent(
      "For 39 h · Everyone who may approve it is still invited and hasn't signed in.",
    );
    expect(screen.getByTestId(`ops-run-${RUNNING}-status`)).toHaveTextContent("Running");
  });

  it("sorts by a column and opens a run from anywhere on its row", async () => {
    const { api } = setup();
    renderAt(api);
    await screen.findByTestId(`ops-run-row-${FAILED}`);
    const firstRow = () => within(screen.getByTestId("ops-runs")).getAllByRole("row")[1];
    await userEvent.click(screen.getByTestId("ops-runs-sort-status"));
    expect(screen.getByTestId("ops-runs-sort-status").closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(firstRow()).toHaveAttribute("data-testid", `ops-run-row-${FAILED}`);
    await userEvent.click(screen.getByTestId("ops-runs-sort-status"));
    expect(firstRow()).toHaveAttribute("data-testid", `ops-run-row-${WAITING}`);

    // The check box keeps its own click; the rest of the row opens the run.
    await userEvent.click(screen.getByTestId(`ops-run-${FAILED}-select`));
    expect(screen.getByTestId("ops-runs-selected")).toHaveTextContent("1 selected");
    await userEvent.click(screen.getByTestId(`ops-run-${FAILED}-error`));
    await waitFor(() => expect(api.calls).toContain(`GET /api/ops/runs/${FAILED}`));
  });

  it("opens filtered from its address, as the command center links to it", async () => {
    const { api, queries } = setup();
    renderAt(api, "/ops/runs?statuses=waiting&mode=live");
    await screen.findByTestId(`ops-run-row-${WAITING}`);
    expect(queries.at(-1)?.get("statuses")).toBe("waiting");
    expect(queries.at(-1)?.get("mode")).toBe("live");
    expect(screen.getByTestId("ops-runs-view-waiting")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ops-runs-view-waiting")).toHaveTextContent("Waiting for approval");
    expect(screen.queryByTestId(`ops-run-row-${FAILED}`)).toBeNull();
    // The older single `status` works too.
    const again = setup();
    renderAt(again.api, "/ops/runs?status=failed");
    await waitFor(() => expect(again.queries.at(-1)?.get("statuses")).toBe("failed"));
  });

  it("lists one client's runs on its page", async () => {
    const { api, queries } = setup();
    renderAt(api, `/ops/clients/${DEMO}/runs`);
    await screen.findByTestId(`ops-run-row-${FAILED}`);
    expect(queries.at(-1)?.get("clients")).toBe(DEMO);
    expect(screen.queryByTestId("ops-runs-chip-clients")).toBeNull();
  });
});
