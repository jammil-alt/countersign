// The Marketing area in the client's portal (M50, docs/plan.md §1.78): for a client with the pack
// on, the reports list has Website, Search and Weekly report; each reads only the portal's own
// report routes, says what it can't show yet, marks small samples, and reads in the client's
// language. The weekly report is read only: its actions show where they stand, with no buttons.
import type { Locale } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../../test/fixtures";
import { packReportsFor } from "../../registry";

const SITE = "00000000-0000-4000-8000-0000000e0001";
const SITE2 = "00000000-0000-4000-8000-0000000e0002";
const R1 = "00000000-0000-4000-8000-0000000e1001";
const R2 = "00000000-0000-4000-8000-0000000e1002";

const site = { id: SITE, domain: "clinic.example", name: "clinic.example" };
const totals = (o: Record<string, unknown> = {}) => ({
  visits: 120,
  views: 300,
  goals: 6,
  bounces: 40,
  goalRate: "0.0500",
  bounceRate: "0.3333",
  medianEngaged: { band: 3, fromSeconds: 30, toSeconds: 60 },
  smallSample: false,
  ...o,
});

const OVERVIEW = {
  site,
  sites: [site, { id: SITE2, domain: "shop.example", name: "shop.example" }],
  range: { period: 28, from: "2026-10-11", to: "2026-11-07", days: 28, includesToday: false },
  totals: totals(),
  previousTotals: totals({ visits: 90 }),
  daily: [
    { day: "2026-11-06", visits: 10, goals: 1, built: true },
    { day: "2026-11-07", visits: 0, goals: 0, built: false },
  ],
  pages: [{ path: "/booking", views: 80, entries: 40, goals: 5, smallSample: false }],
  sources: [
    {
      source: "search/google",
      group: "search",
      name: "google",
      visits: 50,
      goals: 3,
      smallSample: false,
    },
  ],
  filtered: 7,
};

const SEARCH = {
  site,
  provider: null,
  sources: [],
  dataRunsTo: "2026-11-05",
  period: { from: "2026-10-09", to: "2026-11-05" },
  previous: { from: "2026-09-11", to: "2026-10-08" },
  cappedToData: false,
  totals: { impressions: 1500, clicks: 60, ctr: "0.0400", position: 11.3, smallSample: false },
  previousTotals: {
    impressions: 1000,
    clicks: 60,
    ctr: "0.0600",
    position: 12,
    smallSample: false,
  },
  daily: [],
  queries: [
    {
      query: "walk-in clinic near me",
      impressions: 400,
      clicks: 20,
      ctr: "0.0500",
      position: 9.4,
      previousPosition: 10,
      topPage: "/",
      smallSample: false,
    },
  ],
  pages: [
    { path: "/", impressions: 900, clicks: 40, ctr: "0.0444", position: 8, smallSample: false },
  ],
  closeToPageOne: [],
  losingGround: [],
};

const WEEKLY = {
  site,
  sites: [site],
  reports: [
    { id: R2, periodFrom: "2026-11-02", periodTo: "2026-11-08", createdAt: "x", read: false },
    { id: R1, periodFrom: "2026-10-26", periodTo: "2026-11-01", createdAt: "x", read: true },
  ],
  latest: {
    id: R2,
    siteId: SITE,
    periodFrom: "2026-11-02",
    periodTo: "2026-11-08",
    createdAt: "x",
    read: false,
    summary: "Visits rose by a third.",
    changes: [{ text: "Visits up from 90 to 120." }],
    causes: [{ text: "A local news link." }],
    unknown: "Whether the link brought bookings.",
    actions: [
      { idx: 0, text: "Write a guide on walk-in hours.", decision: "open" },
      { idx: 1, text: "Fix the booking page title.", decision: "done" },
    ],
    sourceCount: 4,
    // Mixed in: nothing of the agent reaches the page.
    agentVersionId: "00000000-0000-4000-8000-0000000a9001",
    prompt: "You write the weekly report",
  },
};

function portalApi(locale: Locale = "en", routes: Parameters<typeof fakeApi>[0] = {}) {
  const asked: string[] = [];
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/reports/activity": () => ({
      from: "2026-11-01",
      to: "2026-11-08",
      timezone: "UTC",
      runs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 },
      documents: { received: 0, read: 0 },
      actions: { total: 0, byConnector: [] },
      services: [],
      packs: ["marketing"],
    }),
    "GET /api/reports/marketing/overview": ({ url }) => {
      asked.push(url.search);
      return { report: OVERVIEW };
    },
    "GET /api/reports/marketing/search": ({ url }) => {
      asked.push(url.search);
      return { report: SEARCH };
    },
    "GET /api/reports/marketing/weekly-report": () => ({ report: WEEKLY }),
    [`GET /api/reports/marketing/weekly-report/items/${R1}`]: () => ({
      report: { ...WEEKLY.latest, id: R1, summary: "A quiet week.", actions: [] },
    }),
    ...routes,
  });
  return { api, asked };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the Marketing area in the portal", () => {
  it("registers Website, Search and Weekly report for a client with the pack on", () => {
    expect(packReportsFor(["marketing"]).map((r) => r.slug)).toEqual([
      "overview",
      "search",
      "weekly-report",
    ]);
    expect(packReportsFor(["materials"]).some((r) => r.pack === "marketing")).toBe(false);
  });

  it("shows the website's figures against the days before, and its pages and sources", async () => {
    const { api, asked } = portalApi();
    renderAt("/reports/marketing/overview", api);
    const visits = await screen.findByTestId("portal-marketing-visits");
    expect(visits).toHaveTextContent("120");
    expect(visits).toHaveTextContent("Up 30 on the days before");
    expect(screen.getByTestId("portal-marketing-goals")).toHaveTextContent("5% of visits");
    expect(screen.getByTestId("portal-marketing-engaged")).toHaveTextContent("30 s to 1 min");
    expect(screen.getByTestId("portal-marketing-range")).toHaveTextContent(
      "1 day is not counted yet.",
    );
    expect(screen.getByTestId("portal-marketing-pages")).toHaveTextContent("/booking");
    expect(screen.getByTestId("portal-marketing-sources")).toHaveTextContent("google (Search)");
    expect(screen.getByTestId("portal-marketing-filtered")).toHaveTextContent(
      "7 requests from bots and scripts were not counted.",
    );
    expect(screen.getByTestId("portal-marketing-privacy")).toHaveTextContent("without cookies");
    // The tabs name the area's three reports.
    const tabs = screen.getByTestId("portal-report-links");
    for (const name of ["Website", "Search", "Weekly report"]) {
      expect(within(tabs).getByText(name)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByTestId("portal-marketing-period-filter-7"));
    expect(await screen.findByTestId("portal-marketing-visits")).toBeInTheDocument();
    expect(asked.at(-1)).toContain("period=7");
    expect(screen.getByTestId("portal-marketing-overview-csv")).toHaveAttribute(
      "href",
      "/api/reports/marketing/overview/csv?period=7",
    );
  });

  it("says when no site is measured yet", async () => {
    const { api } = portalApi("en", {
      "GET /api/reports/marketing/overview": () => ({
        report: { ...OVERVIEW, site: null, sites: [] },
      }),
    });
    renderAt("/reports/marketing/overview", api);
    expect(await screen.findByTestId("portal-marketing-no-site")).toHaveTextContent(
      "No website is measured yet",
    );
  });

  it("shows search figures with the day they run to, and searches as written", async () => {
    const { api } = portalApi();
    renderAt("/reports/marketing/search", api);
    expect(await screen.findByTestId("portal-marketing-search-range")).toHaveTextContent(
      "The figures run to Nov 5, 2026.",
    );
    expect(screen.getByTestId("portal-marketing-search-impressions")).toHaveTextContent("1,500");
    expect(screen.getByTestId("portal-marketing-search-position")).toHaveTextContent("11.3");
    expect(screen.getByTestId("portal-marketing-search-queries")).toHaveTextContent(
      "walk-in clinic near me",
    );
    expect(screen.getByTestId("portal-marketing-search-close")).toHaveTextContent(
      "No searches sit just past the first page.",
    );
  });

  it("says when search isn't connected yet", async () => {
    const { api } = portalApi("en", {
      "GET /api/reports/marketing/search": () => ({ report: { ...SEARCH, dataRunsTo: null } }),
    });
    renderAt("/reports/marketing/search", api);
    expect(await screen.findByTestId("portal-marketing-search-empty")).toHaveTextContent(
      "No search figures yet",
    );
  });

  it("reads the weekly report, its actions with where they stand and no buttons", async () => {
    const { api } = portalApi();
    const { container } = renderAt("/reports/marketing/weekly-report", api);
    expect(await screen.findByTestId("portal-marketing-weekly-summary")).toHaveTextContent(
      "Visits rose by a third.",
    );
    expect(screen.getByTestId("portal-marketing-weekly-changes")).toHaveTextContent(
      "Visits up from 90 to 120.",
    );
    expect(screen.getByTestId("portal-marketing-weekly-action-0")).toHaveTextContent("Open");
    expect(screen.getByTestId("portal-marketing-weekly-action-1")).toHaveTextContent("Done");
    const actions = screen.getByTestId("portal-marketing-weekly-actions");
    expect(within(actions).queryAllByRole("button")).toEqual([]);
    expect(container.textContent).not.toMatch(/You write the weekly report|a9001/);
    await userEvent.click(screen.getByTestId(`portal-marketing-weekly-open-${R1}`));
    expect(await screen.findByText("A quiet week.")).toBeInTheDocument();
  });

  it("says when there is no weekly report yet", async () => {
    const { api } = portalApi("en", {
      "GET /api/reports/marketing/weekly-report": () => ({
        report: { ...WEEKLY, reports: [], latest: null },
      }),
    });
    renderAt("/reports/marketing/weekly-report", api);
    expect(await screen.findByTestId("portal-marketing-weekly-none")).toHaveTextContent(
      "No weekly report yet",
    );
  });

  it("reads in the client's language", async () => {
    const { api } = portalApi("de");
    renderAt("/reports/marketing/overview", api);
    const visits = await screen.findByTestId("portal-marketing-visits");
    expect(visits).toHaveTextContent("Besuche");
    expect(visits).toHaveTextContent("30 mehr als in den Tagen davor");
    expect(screen.getByTestId("portal-marketing-privacy")).toHaveTextContent("ohne Cookies");
  });
});
