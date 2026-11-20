// §1.162: what the client sees for one agent, inside the back office and read only
// (`/ops/clients/:clientId/agents/:slug/client-view`): a banner says whose view it is and links to
// the agent lab; the portal page's header, this month's figures and recent runs come from the
// operator's copy of the portal's answer; nothing on it acts as the client or opens the portal.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { AGENT_SUMMARY, fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";

const CLIENT = SANDBOX_DETAIL.client.id;
const AGENT = AGENT_SUMMARY.id;
const RUN = "00000000-0000-4000-8000-0000000f1000";
const VIEW_PATH = `/ops/clients/${CLIENT}/agents/material-costs/client-view`;

const DETAIL = {
  ...SANDBOX_DETAIL,
  client: { ...SANDBOX_DETAIL.client, name: "Harbor Millwork" },
  agents: [
    { ...AGENT_SUMMARY, serviceName: "Pia" },
    {
      ...AGENT_SUMMARY,
      id: "00000000-0000-4000-8000-00000000b002",
      slug: "collections",
      name: "Collections",
      liveVersionId: null,
      runStatus: "draft",
      bindings: {},
    },
  ],
};

const runs = (o: Partial<Record<string, number>> = {}) => ({
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  waiting: 0,
  going: 0,
  ...o,
});

/** The portal's answer for the agent (`GET /api/services/:id`), as the back office gets it. */
const CLIENT_VIEW = {
  service: {
    id: AGENT,
    name: "Pia",
    description: "Checks every vendor invoice against your price history.",
    status: "active",
  },
  thisMonth: {
    from: "2026-11-01",
    to: "2026-11-20",
    runs: runs({ total: 4, succeeded: 3, waiting: 1 }),
    documentsRead: 3,
    actions: 2,
  },
  recentRuns: [
    {
      id: RUN,
      service: { id: AGENT, name: "Pia" },
      status: "succeeded",
      startedAt: "2026-11-03T10:00:00.000Z",
      finishedAt: "2026-11-03T10:03:00.000Z",
    },
  ],
  packs: [],
  template: null,
  readsDocuments: true,
  stage: "live",
  now: null,
  runsNow: { running: 0, waitingOnYou: 2 },
  kpis: [],
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const base = () => ({
  "GET /api/session": () => OPERATOR_SESSION,
  [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/inbox": () => ({ items: [], agents: [] }),
});

describe("what the client sees, in the back office", () => {
  it("shows the portal's agent page read only, under a banner naming the client", async () => {
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/agents/${AGENT}/client-view`]: () => CLIENT_VIEW,
    });
    renderAt(VIEW_PATH, api);

    const page = await screen.findByTestId("ops-client-agent-view", {}, { timeout: 10_000 });
    const banner = await within(page).findByTestId("ops-client-view-banner");
    expect(banner).toHaveTextContent("What Harbor Millwork sees");
    expect(banner).toHaveTextContent("read only");
    expect(within(banner).getByTestId("ops-client-view-edit")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/material-costs`,
    );

    // The portal page's header: its name, its state in the client's words, what it does.
    expect(await within(page).findByRole("heading", { level: 1, name: "Pia" })).toBeVisible();
    expect(within(page).getByTestId("agent-state")).toHaveTextContent("Waiting on you");
    expect(page).toHaveTextContent("Checks every vendor invoice against your price history.");

    // This month's figures, none of them a link into the portal.
    const month = within(page).getByTestId("agent-month");
    expect(within(month).getByTestId("portal-service-runs")).toHaveTextContent("4");
    expect(within(month).getByTestId("portal-service-actions")).toHaveTextContent("2");
    expect(within(month).getByTestId("agent-kpi-waiting")).toHaveTextContent("2");
    expect(within(month).queryAllByRole("link")).toEqual([]);
    expect(within(page).queryByTestId("agent-full-report")).toBeNull();

    // Its recent runs open the back office's run page, not the portal's.
    expect(within(page).getByTestId(`agent-recent-run-${RUN}`).querySelector("a")).toHaveAttribute(
      "href",
      `/ops/runs/${RUN}`,
    );
    // What waits on the client: a count with its word, never the items' buttons.
    expect(within(page).getByTestId("ops-client-view-waiting")).toHaveTextContent(
      "2 runs waiting on them",
    );

    // Read only: no Pause, no Run now, no sign or approve, no upload, and no form at all.
    expect(within(page).queryByTestId("agent-pause")).toBeNull();
    expect(within(page).queryByTestId("agent-run-now")).toBeNull();
    expect(within(page).queryByTestId("agent-documents")).toBeNull();
    expect(page.querySelector("form, input, textarea, select")).toBeNull();
    expect(within(page).queryAllByRole("button")).toEqual([]);
    // Every link stays in the back office.
    for (const a of within(page).getAllByRole("link")) {
      expect(a.getAttribute("href"), a.textContent ?? "").toMatch(/^\/ops/);
    }
    // Only the back office's own route was asked; never a portal one.
    expect(api.calls.filter((c) => !c.includes("/api/ops") && c !== "GET /api/session")).toEqual(
      [],
    );
  });

  it("says so when the client's portal doesn't show the agent yet", async () => {
    const api = fakeApi(base());
    renderAt(`/ops/clients/${CLIENT}/agents/collections/client-view`, api);
    expect(
      await screen.findByTestId("ops-client-view-unseen", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Harbor Millwork doesn't see this agent in their portal yet.");
  });
});
