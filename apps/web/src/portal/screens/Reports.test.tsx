// The portal's activity report and service page render only what the contract names: counts of
// runs, documents and changes. Cost, tokens or prompts mixed into a response are dropped by the
// contract parse and never shown. Pack reports mount under /reports for the client's packs.
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
      "31 done, 1 failed, 1 waiting on you",
    );
    expect(screen.getByText("What your agents did, Nov 1 – Nov 3, 2026.")).toBeInTheDocument();
    expect(screen.getByTestId("portal-report-documents")).toHaveTextContent("34 documents came in");
    expect(screen.getByTestId("portal-report-actions")).toHaveTextContent("QuickBooks Online 2");
    const row = screen.getByTestId(`portal-report-service-${SVC}`);
    expect(within(row).getByRole("link", { name: "Record keeping" })).toHaveAttribute(
      "href",
      `/agents/${SVC}`,
    );
    expect(row).toHaveTextContent("1 waiting on you");
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

  it("mounts pack reports only for the client's packs", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      // Materials isn't on for this client, so its Price watch isn't mounted.
      "GET /api/reports/activity": () => ({ ...LEAKY_REPORT, packs: [] }),
    });
    renderAt("/reports/materials/prices", api);
    expect(await screen.findByText("This report isn't available for you.")).toBeInTheDocument();
    const prices: PackReport = {
      pack: "materials",
      slug: "prices",
      titleKey: "materials.prices.title",
      descriptionKey: "materials.prices.description",
      Component: () => null,
    };
    expect(packReportsFor(["materials"], [prices])).toEqual([prices]);
    expect(packReportsFor([], [prices])).toEqual([]);
    expect(packReportPath(prices)).toBe("/reports/materials/prices");
  });

  it("says when there are no agents yet", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/reports/activity": () => ({ ...LEAKY_REPORT, services: [] }),
    });
    renderAt("/reports", api);
    expect(await screen.findByText(/No agents yet/)).toBeInTheDocument();
  });
});
