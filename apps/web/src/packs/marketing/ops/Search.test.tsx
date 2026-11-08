// The Search screen (M45, docs/plan.md §1.75): the figures with the day they run to and the small
// samples marked, close to page one and losing ground, the provider choice sent as the report's
// query, the empty states, and pointing a site at one of the client's connections.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";
import type { SearchReport, SearchSourcesReport } from "./Search";

const CLIENT = "00000000-0000-4000-8000-00000000a011";
const SITE = "00000000-0000-4000-8000-00000000b011";
const GSC = "00000000-0000-4000-8000-00000000c011";

const totals = (impressions: number, clicks: number, position: number | null) => ({
  impressions,
  clicks,
  ctr: impressions ? (clicks / impressions).toFixed(4) : null,
  position,
  smallSample: impressions < 20,
});

const REPORT: SearchReport = {
  site: { id: SITE, domain: "mezonas.com", name: "mezonas.com" },
  provider: null,
  sources: [
    {
      id: "s1",
      provider: "google",
      connected: true,
      dataRunsTo: "2026-11-04",
      lastImportedAt: "2026-11-08T03:41:00.000Z",
      lastError: null,
    },
  ],
  dataRunsTo: "2026-11-04",
  period: { from: "2026-10-08", to: "2026-11-04" },
  previous: { from: "2026-09-10", to: "2026-10-07" },
  cappedToData: false,
  totals: totals(896, 84, 7.2),
  previousTotals: totals(800, 70, 6.9),
  daily: [],
  queries: [
    { query: "back office agents", ...totals(420, 28, 9), previousPosition: 9, topPage: "/" },
    { query: "=cmd()", ...totals(3, 0, 40), previousPosition: null, topPage: null },
  ],
  pages: [{ path: "/", ...totals(560, 56, 5) }],
  closeToPageOne: [
    {
      query: "back office agents",
      position: 9,
      previousPosition: 9,
      impressions: 420,
      topPage: "/",
      smallSample: false,
    },
  ],
  losingGround: [
    {
      path: "/how-it-works",
      position: 14,
      previousPosition: 9,
      clicks: 28,
      previousClicks: 30,
      query: { query: "invoice agent", position: 15, previousPosition: 9 },
    },
  ],
};

const SOURCES: SearchSourcesReport = {
  sites: [{ id: SITE, domain: "mezonas.com", name: "mezonas.com" }],
  sources: [],
  connections: [
    { id: GSC, provider: "google", status: "connected", property: "sc-domain:mezonas.com" },
  ],
};

const CLIENTS = {
  clients: [
    {
      id: CLIENT,
      name: "Mezonas",
      timezone: "America/Chicago",
      createdAt: "2026-11-01T00:00:00.000Z",
      agents: 0,
      openInbox: 0,
      needsUs: 0,
      waitingRuns: 0,
      sandbox: false,
      internal: true,
    },
  ],
};

function renderSearch(report: SearchReport, sources: SearchSourcesReport = SOURCES) {
  const asked: string[] = [];
  const posted: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => CLIENTS,
    [`GET /api/ops/clients/${CLIENT}/reports/marketing/search`]: ({ url }) => {
      asked.push(url.search);
      return { report };
    },
    [`GET /api/ops/clients/${CLIENT}/reports/marketing/search-sources`]: () => ({
      report: sources,
    }),
    [`POST /api/ops/clients/${CLIENT}/packs/marketing/actions/set-search-source`]: ({ init }) => {
      posted.push(JSON.parse(String(init.body)));
      return { result: { source: { id: "s1" } } };
    },
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/marketing/search`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { asked, posted };
}

describe("the Search screen", () => {
  it("shows the figures, the day they run to, and what's close to page one or losing ground", async () => {
    const { asked } = renderSearch(REPORT);
    expect(await screen.findByTestId("marketing-search-runs-to")).toHaveTextContent(
      "Figures run to Nov 4, 2026",
    );
    expect(screen.getByTestId("marketing-search-totals")).toHaveTextContent("896");
    const near = screen.getByTestId("marketing-search-near");
    expect(within(near).getByText("back office agents")).toBeInTheDocument();
    const losing = screen.getByTestId("marketing-search-losing-row");
    expect(losing).toHaveTextContent("/how-it-works");
    expect(losing).toHaveTextContent("invoice agent (9.0 to 15.0)");
    // A query with few impressions is marked; a query is shown as text, never run.
    const rows = screen.getAllByTestId("marketing-search-query-row");
    expect(rows[1]).toHaveTextContent("=cmd()");
    expect(rows[1]).toHaveTextContent("small sample");
    expect(screen.getByTestId("marketing-search-csv-download")).toHaveAttribute(
      "href",
      `/api/ops/clients/${CLIENT}/reports/marketing/search/csv`,
    );
    fireEvent.click(screen.getByTestId("marketing-search-provider-google-select"));
    await waitFor(() => expect(asked).toContain("?provider=google"));
  });

  it("points the site at one of the client's connections", async () => {
    const { posted } = renderSearch(REPORT);
    const google = await screen.findByTestId("marketing-search-source-google");
    expect(google).toHaveTextContent("Not set up");
    expect(screen.getByTestId("marketing-search-source-bing")).toHaveTextContent(
      "No Bing connection yet",
    );
    fireEvent.click(screen.getByTestId("marketing-search-source-google-save"));
    await waitFor(() =>
      expect(posted).toEqual([{ siteId: SITE, provider: "google", connectionId: GSC }]),
    );
  });

  it("says when there are no figures yet, and when there is no site", async () => {
    renderSearch({
      ...REPORT,
      dataRunsTo: null,
      totals: totals(0, 0, null),
      queries: [],
      pages: [],
      closeToPageOne: [],
      losingGround: [],
    });
    expect(await screen.findByTestId("marketing-search-runs-to")).toHaveTextContent(
      "No search figures yet",
    );
    expect(screen.getByTestId("marketing-search-queries-empty")).toBeInTheDocument();
  });

  it("asks for a site first", async () => {
    renderSearch({ ...REPORT, site: null }, { ...SOURCES, sites: [] });
    expect(await screen.findByTestId("marketing-search-no-site")).toBeInTheDocument();
  });
});
