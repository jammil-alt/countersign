// The portal shares one overview (docs/audit-plan.md 2.1): the frame, Home and Runs read one
// answer, asked once per load and at most once per move.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, tableView } from "../test/fixtures";

const OVERVIEW = {
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const overviewCalls = (calls: string[]) => calls.filter((c) => c === "GET /api/overview").length;

afterEach(() => {
  vi.useRealTimers();
});

describe("the portal's overview", () => {
  // The clock moves only when the test moves it, so a slow machine never ages the answer.
  it("is asked once on load, not again on a move a moment later, and again once it is older", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T10:00:00Z") });
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => OVERVIEW,
      "GET /api/table": () => tableView(),
      "GET /api/weekly": () => ({ table: null }),
      "GET /api/access": () => ({ items: [], canEdit: false }),
      "GET /api/runs": () => ({ runs: [] }),
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId("home-agents");
    await waitFor(() => expect(api.calls).toContain("GET /api/table"));
    expect(overviewCalls(api.calls)).toBe(1);
    await userEvent.click(screen.getByTestId("portal-nav-runs"));
    await screen.findByTestId("portal-runs-page");
    await waitFor(() => expect(api.calls).toContain("GET /api/runs"));
    expect(overviewCalls(api.calls)).toBe(1);

    // Older than OVERVIEW_STALE_MS: the next move asks once.
    vi.setSystemTime(new Date("2026-11-11T10:00:06Z"));
    await userEvent.click(screen.getByTestId("portal-nav-home"));
    await waitFor(() => expect(overviewCalls(api.calls)).toBe(2));
  });
});
