// O9 Runs (QA, runs and dates): the list pages 50 at a time ("Show 50 more"), folds failed runs
// alike into one row that opens in place, words a failed check plainly, and its "Took" is the time
// a run worked, with its wait on people beneath.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { RUNS_LIMIT } from "./Runs";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const AGENT = "00000000-0000-4000-8000-00000000b001";
const H = 3_600_000;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  tenantId: DEMO,
  agentId: AGENT,
  agentVersionId: "00000000-0000-4000-8000-0000000e0001",
  workflowSlug: "weekly-reminders",
  mode: "live",
  status: "succeeded",
  trigger: { type: "schedule" },
  costUsd: "0.0100",
  error: null,
  startedAt: new Date(Date.UTC(2026, 10, 6, 9) - n * 60_000).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 10, 6, 9, 1) - n * 60_000).toISOString(),
  createdAt: new Date(Date.UTC(2026, 10, 6, 9) - n * 60_000).toISOString(),
  ...over,
});

const AGENTS = [{ id: AGENT, tenantId: DEMO, slug: "cole", name: "Cole", serviceName: null }];

function renderAt(api: ReturnType<typeof fakeApi>, path = "/ops/runs") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("ops runs, a page at a time", () => {
  // Two pages of rows render: more time than the default under a full run.
  it("loads the next page from the last run shown, and stops at the last page", {
    timeout: 20_000,
  }, async () => {
    const all = Array.from({ length: RUNS_LIMIT + 5 }, (_, i) => run(i + 1));
    const asked: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/saved-views": () => ({ views: [] }),
      "GET /api/ops/runs": ({ url }) => {
        asked.push(url.searchParams);
        const before = url.searchParams.get("before");
        const from = before ? all.findIndex((r) => r.id === before) + 1 : 0;
        const page = all.slice(from, from + RUNS_LIMIT);
        const more = from + RUNS_LIMIT < all.length;
        return { runs: page, agents: AGENTS, next: more ? page.at(-1)?.id : null };
      },
    });
    renderAt(api);
    await screen.findByTestId(`ops-run-row-${id(1)}`, {}, { timeout: 5000 });
    expect(asked[0]?.get("limit")).toBe(String(RUNS_LIMIT));
    expect(screen.getByTestId("ops-runs-count")).toHaveTextContent(`The latest ${RUNS_LIMIT}`);
    expect(screen.queryByTestId(`ops-run-row-${id(RUNS_LIMIT + 1)}`)).toBeNull();

    await userEvent.click(screen.getByTestId("ops-runs-more"));
    expect(await screen.findByTestId(`ops-run-row-${id(RUNS_LIMIT + 5)}`)).toBeInTheDocument();
    expect(asked.at(-1)?.get("before")).toBe(id(RUNS_LIMIT));
    expect(screen.getByTestId("ops-runs-count")).toHaveTextContent(`${RUNS_LIMIT + 5} runs`);
    expect(screen.queryByTestId("ops-runs-more")).toBeNull();
  });

  it("folds 32 failed test runs alike into one row that opens, in plain words", {
    timeout: 20_000,
  }, async () => {
    const failed = Array.from({ length: 32 }, (_, i) =>
      run(i + 10, {
        mode: "test",
        status: "failed",
        error: { reason: "✖ Invalid UUID\n  → at trigger.documentId", key: "run:failed" },
      }),
    );
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/saved-views": () => ({ views: [] }),
      "GET /api/ops/runs": () => ({ runs: [run(1), ...failed], agents: AGENTS, next: null }),
    });
    renderAt(api);
    const same = await screen.findByTestId(`ops-runs-same-${id(10)}`, {}, { timeout: 5000 });
    expect(same).toHaveTextContent("32 failed test runs, same error");
    expect(same).toHaveTextContent(
      "The input wasn't valid: an id isn't in the right form (documentId)",
    );
    expect(same).not.toHaveTextContent("✖");
    expect(same).toHaveTextContent("$0.32");
    // One row for them all until it opens.
    expect(within(screen.getByTestId("ops-runs")).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByTestId(`ops-run-row-${id(10)}`)).toBeNull();

    await userEvent.click(screen.getByTestId(`ops-runs-same-${id(10)}-open`));
    expect(screen.getByTestId(`ops-run-row-${id(41)}`)).toBeInTheDocument();
    expect(within(screen.getByTestId("ops-runs")).getAllByRole("row")).toHaveLength(35);

    // Its check box picks every run it stands for.
    await userEvent.click(screen.getByTestId(`ops-runs-same-${id(10)}-select`));
    expect(screen.getByTestId("ops-runs-selected")).toHaveTextContent("32 selected");
  });

  it("says how long a run worked, and how long it waited on people apart", async () => {
    const week = run(2, {
      startedAt: "2026-11-01T09:00:00.000Z",
      finishedAt: "2026-11-08T09:04:00.000Z",
      waitedMs: 168 * H,
    });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/saved-views": () => ({ views: [] }),
      "GET /api/ops/runs": () => ({ runs: [week], agents: AGENTS, next: null }),
    });
    renderAt(api);
    const took = await screen.findByTestId(`ops-run-${id(2)}-took`, {}, { timeout: 5000 });
    await waitFor(() => expect(took).toHaveTextContent("4 min"));
    expect(took).not.toHaveTextContent("168");
    expect(screen.getByTestId(`ops-run-${id(2)}-waited`)).toHaveTextContent("Waited 7 d");
  });
});
