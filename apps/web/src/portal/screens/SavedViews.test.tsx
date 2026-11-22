// R6 (docs/plan.md §1.236): the runs list's saved views. A filtered list is saved under a name, an
// admin may share it with the team; a view opens the list on its filter; the team's views show
// who shared them; a view is deleted from its chip.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { viewFilter } from "./Runs";
import { sameFilter } from "./SavedViews";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const SVC = "00000000-0000-4000-8000-00000000b001";
const MINE = "00000000-0000-4000-8000-00000000f001";
const TEAM = "00000000-0000-4000-8000-00000000f002";

const view = (id: string, name: string, extra: Record<string, unknown>) => ({
  id,
  name,
  shared: false,
  mine: true,
  ownerName: null,
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...extra,
});

function setup(at = "/runs") {
  const queries: URLSearchParams[] = [];
  const saved: unknown[] = [];
  const patched: unknown[] = [];
  const deleted: string[] = [];
  let views = [
    view(MINE, "Failed", { filters: { statuses: ["failed"] } }),
    view(TEAM, "Pia waiting", {
      filters: { agents: [SVC], statuses: ["waiting"] },
      shared: true,
      mine: false,
      ownerName: "Iris",
    }),
  ];
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => ({
      client: { id: DEMO, name: "Demo client" },
      services: [{ id: SVC, name: "Pia", description: null, status: "active" }],
      needsYou: { inbox: 0 },
      recentRuns: [],
    }),
    "GET /api/runs": ({ url }) => {
      queries.push(url.searchParams);
      return { runs: [], perDay: [] };
    },
    "GET /api/views": () => ({ views }),
    "POST /api/views": ({ init }) => {
      const body = JSON.parse(String(init.body));
      saved.push(body);
      const made = view("00000000-0000-4000-8000-00000000f003", body.name, body);
      views = [made, ...views];
      return { view: made };
    },
    [`PATCH /api/views/${MINE}`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      patched.push(body);
      views = views.map((v) => (v.id === MINE ? { ...v, ...body } : v));
      return { view: views.find((v) => v.id === MINE) };
    },
    [`DELETE /api/views/${MINE}`]: () => {
      deleted.push(MINE);
      views = views.filter((v) => v.id !== MINE);
      return { deleted: true };
    },
  });
  render(
    <MemoryRouter initialEntries={[at]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { queries, saved, patched, deleted };
}

describe("the portal's saved views", () => {
  it("opens the list on a view's filter, and names who shared a team view", async () => {
    const { queries } = setup();
    const team = await screen.findByTestId(`portal-views-open-${TEAM}`);
    expect(team).toHaveAttribute("title", "Shared by Iris");
    // Not the admin's own: nothing to share there.
    expect(screen.queryByTestId(`portal-views-share-${TEAM}`)).toBeNull();
    await userEvent.click(team);
    await waitFor(() => {
      const last = queries.at(-1);
      expect(last?.get("agents")).toBe(SVC);
      expect(last?.get("statuses")).toBe("waiting");
    });
    await waitFor(() => expect(team).toHaveAttribute("aria-pressed", "true"));
  });

  it("saves a filtered list under a name, shared with the team by an admin", async () => {
    const { saved } = setup("/runs?statuses=failed,cancelled&agents=" + SVC);
    await userEvent.click(await screen.findByTestId("portal-views-save"));
    await userEvent.type(screen.getByTestId("portal-views-name"), "Pia not finished");
    await userEvent.click(screen.getByTestId("portal-views-share"));
    await userEvent.click(screen.getByTestId("portal-views-confirm"));
    await waitFor(() =>
      expect(saved).toEqual([
        {
          name: "Pia not finished",
          filters: { agents: [SVC], statuses: ["failed", "cancelled"] },
          shared: true,
        },
      ]),
    );
    expect(await screen.findByText("Pia not finished")).toBeInTheDocument();
  });

  it("offers no save on the whole list", async () => {
    setup();
    await screen.findByTestId(`portal-views-open-${MINE}`);
    expect(screen.queryByTestId("portal-views-save")).toBeNull();
  });

  it("shares and deletes an admin's own view from its chip", async () => {
    const { patched, deleted } = setup();
    await userEvent.click(await screen.findByTestId(`portal-views-share-${MINE}`));
    await waitFor(() => expect(patched).toEqual([{ shared: true }]));
    await userEvent.click(screen.getByTestId(`portal-views-delete-${MINE}`));
    await waitFor(() => expect(deleted).toEqual([MINE]));
    await waitFor(() => expect(screen.queryByTestId(`portal-views-open-${MINE}`)).toBeNull());
  });

  it("keeps a view's filter whatever its keys' order, and nothing for the whole list", () => {
    expect(
      sameFilter({ statuses: ["failed"], agents: [SVC] }, { agents: [SVC], statuses: ["failed"] }),
    ).toBe(true);
    expect(viewFilter({ limit: 100, perDay: true })).toBeNull();
    expect(viewFilter({ limit: 100, perDay: true, statuses: "waiting" })).toEqual({
      statuses: ["waiting"],
    });
  });
});
