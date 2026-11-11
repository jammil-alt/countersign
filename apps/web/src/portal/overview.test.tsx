// The portal shares one overview (docs/audit-plan.md 2.1): the frame, Home and Runs read one
// answer, asked once per load and at most once per move.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, tableView } from "../test/fixtures";

const OVERVIEW = {
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const overviewCalls = (calls: string[]) => calls.filter((c) => c === "GET /api/overview").length;

describe("the portal's overview", () => {
  it("is asked once on load, and not again on a move a moment later", async () => {
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
  });
});
