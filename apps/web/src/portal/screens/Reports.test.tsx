// The portal's activity report and service page render only what the contract names: counts of
// runs, documents and changes. Cost, tokens or prompts mixed into a response are dropped by the
// contract parse and never shown. Pack reports have a slot under /reports and none are built yet.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { type PackReport, packReportPath, packReportsFor } from "../../packs/registry";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";
import { reportPeriod } from "./Reports";

const SVC = "00000000-0000-4000-8000-00000000b001";
const SVC2 = "00000000-0000-4000-8000-00000000b002";
const RUN = "00000000-0000-4000-8000-0000000f1001";

const runs = (o: Partial<Record<string, number>> = {}) => ({
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  waiting: 0,
  going: 0,
  ...o,
});

/** An activity report with fields a portal response must never carry mixed in. */
const LEAKY_REPORT = {
  from: "2026-11-01",
  to: "2026-11-03",
  timezone: "America/Chicago",
  runs: { ...runs({ total: 3, succeeded: 1, failed: 1, waiting: 1 }), costUsd: "0.9100" },
  documents: { received: 4, read: 3, tokensIn: 5000 },
  actions: {
    total: 2,
    byConnector: [{ connector: "qbo", name: "QuickBooks Online", count: 2 }],
  },
  services: [
    {
      id: SVC,
      name: "Record keeping",
      runs: runs({ total: 2, succeeded: 1, waiting: 1 }),
      documentsRead: 3,
      actions: 2,
      costUsd: "0.8000",
      prompt: "You are a records clerk",
    },
    { id: SVC2, name: "Notes", runs: runs({ total: 1, failed: 1 }), documentsRead: 0, actions: 0 },
  ],
  packs: [],
  modelCost: "0.9100",
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

describe("portal reports", () => {
  it("shows the period's runs, documents and changes per service, never cost", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": ({ url }) => {
        queries.push(url.searchParams);
        return LEAKY_REPORT;
      },
    });
    const { container } = renderAt("/reports", api);
    expect(await screen.findByTestId("portal-report-runs")).toHaveTextContent(
      "31 done, 1 failed, 1 waiting for a person",
    );
    expect(screen.getByText("What your services did, Nov 1 – Nov 3, 2026.")).toBeInTheDocument();
    expect(screen.getByTestId("portal-report-documents")).toHaveTextContent("34 documents came in");
    expect(screen.getByTestId("portal-report-actions")).toHaveTextContent("QuickBooks Online 2");
    const row = screen.getByTestId(`portal-report-service-${SVC}`);
    expect(within(row).getByRole("link", { name: "Record keeping" })).toHaveAttribute(
      "href",
      `/services/${SVC}`,
    );
    expect(row).toHaveTextContent("1 waiting");
    // Nothing of cost, tokens or prompts reaches the page.
    expect(container.textContent).not.toMatch(/\$|0\.91|0\.8000|5000|records clerk/);
    // This month leaves the days to the API (the client's time zone).
    expect(queries[0]?.has("from")).toBe(false);
    await userEvent.click(screen.getByTestId("portal-report-period-filter-last"));
    await waitFor(() => expect(queries.at(-1)?.get("from")).toBe(reportPeriod("last").from));
    expect(queries.at(-1)?.get("to")).toBe(reportPeriod("last").to);
  });

  it("narrows to one service from its page's link", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": ({ url }) => {
        queries.push(url.searchParams);
        return { ...LEAKY_REPORT, services: LEAKY_REPORT.services.slice(0, 1) };
      },
    });
    renderAt(`/reports?service=${SVC}`, api);
    expect(await screen.findByText("Record keeping", { selector: "span" })).toBeInTheDocument();
    expect(queries[0]?.get("service")).toBe(SVC);
    await userEvent.click(screen.getByTestId("portal-report-all-services"));
    await waitFor(() => expect(queries.at(-1)?.has("service")).toBe(false));
  });

  it("keeps a slot for pack reports, shown only for the client's packs", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": () => ({ ...LEAKY_REPORT, packs: ["materials"] }),
    });
    renderAt("/reports/materials/prices", api);
    expect(await screen.findByText("This report isn't available for you.")).toBeInTheDocument();
    const prices: PackReport = {
      pack: "materials",
      slug: "prices",
      title: "Price watch",
      description: "What you pay per item, and what changed.",
      Component: () => null,
    };
    expect(packReportsFor(["materials"], [prices])).toEqual([prices]);
    expect(packReportsFor([], [prices])).toEqual([]);
    expect(packReportPath(prices)).toBe("/reports/materials/prices");
  });

  it("says when there are no services yet", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": () => ({ ...LEAKY_REPORT, services: [] }),
    });
    renderAt("/reports", api);
    expect(await screen.findByText(/No services yet/)).toBeInTheDocument();
  });
});

describe("portal service page", () => {
  const SERVICE = {
    service: {
      id: SVC,
      name: "Record keeping",
      description: "Keeps your records right.",
      status: "active",
      instructions: "never shown",
    },
    thisMonth: {
      from: "2026-11-01",
      to: "2026-11-04",
      runs: runs({ total: 2, succeeded: 1, waiting: 1 }),
      documentsRead: 3,
      actions: 1,
      costUsd: "0.4000",
    },
    recentRuns: [
      {
        id: RUN,
        service: { id: SVC, name: "Record keeping" },
        status: "waiting",
        startedAt: "2026-11-03T10:00:00.000Z",
        finishedAt: null,
      },
    ],
    packs: [],
  };

  it("says what the service does, what it did this month, its runs and its reports", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      [`GET /api/services/${SVC}`]: () => SERVICE,
    });
    const { container } = renderAt(`/services/${SVC}`, api);
    expect(await screen.findByRole("heading", { name: "Record keeping" })).toBeInTheDocument();
    expect(screen.getByText("Keeps your records right.")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByTestId("portal-service-runs")).toHaveTextContent("21 done, 1 waiting");
    expect(screen.getByTestId("portal-service-documents")).toHaveTextContent("3");
    expect(screen.getByTestId(`portal-service-run-${RUN}`)).toHaveAttribute("href", `/runs/${RUN}`);
    expect(screen.getByTestId(`portal-service-run-${RUN}`)).toHaveTextContent("Waiting");
    expect(
      within(screen.getByTestId("portal-service-reports")).getByRole("link", { name: "Activity" }),
    ).toHaveAttribute("href", `/reports?service=${SVC}`);
    expect(container.textContent).not.toMatch(/\$|0\.4000|never shown/);
  });

  it("shows not found for a service that isn't the client's", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      [`GET /api/services/${SVC}`]: () =>
        new Reply(404, { error: { code: "not_found", message: "service not found" } }),
    });
    renderAt(`/services/${SVC}`, api);
    expect(await screen.findByText("Not found.")).toBeInTheDocument();
  });
});
