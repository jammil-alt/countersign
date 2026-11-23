// R5: the account report (docs/plan.md §1.235) on both surfaces, and `/ops/accounts`: its figures,
// each opening what is behind it (the runs list on exactly its runs, a connection, billing, an
// agent's report), the CSV link, Needs us in the back office, and the list's sorting.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { ClientReportScreen } from "../ops/client/ClientReport";
import { AccountsScreen, sortAccounts } from "../ops/screens/Accounts";
import { AccountReportScreen } from "../portal/screens/AccountReport";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";

const AGENT = "00000000-0000-4000-8000-00000000c001";
const CLIENT = "00000000-0000-4000-8000-00000000a002";
const OTHER = "00000000-0000-4000-8000-00000000a003";
const CONN = "00000000-0000-4000-8000-00000000e001";
const SINCE = "2026-11-01T00:00:00.000Z";
const UNTIL = "2026-12-01T00:00:00.000Z";
const base = { since: SINCE, until: UNTIL };
const fig = (count: number, extra: Record<string, unknown> = {}) => ({
  count,
  filter: { ...base, ...extra },
});
const headline = (from: string, to: string, runs: number) => ({
  from,
  to,
  runs,
  done: runs - 1,
  failed: 1,
  finishMedianMs: 120_000,
  waitMedianMs: 1_800_000,
  approvals: 1,
  changes: 2,
});

const REPORT = {
  client: { id: CLIENT, name: "Acme Cabinets" },
  from: "2026-11-01",
  to: "2026-11-30",
  timezone: "UTC",
  headline: headline("2026-11-01", "2026-11-30", 4),
  previous: headline("2026-10-01", "2026-10-31", 6),
  runs: fig(4),
  done: fig(3, { statuses: ["succeeded"] }),
  failed: fig(1, { statuses: ["failed"] }),
  agents: [
    {
      service: { id: AGENT, name: "Bill clerk" },
      headline: headline("2026-11-01", "2026-11-30", 4),
      previous: headline("2026-10-01", "2026-10-31", 6),
      runs: fig(4, { agents: [AGENT] }),
      done: fig(3, { agents: [AGENT], statuses: ["succeeded"] }),
      failed: fig(1, { agents: [AGENT], statuses: ["failed"] }),
      waiting: { count: 1, filter: { agents: [AGENT], statuses: ["waiting"] } },
    },
  ],
  waiting: {
    runs: { count: 1, filter: { statuses: ["waiting"] } },
    items: 2,
    overdue: 1,
    oldestSince: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
  failedUnseen: { count: 1, oldestSince: SINCE, filter: null },
  connections: [
    {
      id: CONN,
      connector: "qbo",
      name: "QuickBooks Online",
      attention: "refresh_failing",
      since: SINCE,
    },
  ],
  usage: { period: "2026-11-01", used: 850, included: 1000, share: 0.85 },
};

const href = (testId: string) => screen.getByTestId(testId).getAttribute("href") ?? "";

function renderAt(
  path: string,
  route: string,
  element: React.ReactNode,
  api: ReturnType<typeof fakeApi>,
) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the account report", () => {
  it("opens the portal's runs list, connectors, billing and each agent's report", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    api.on("GET /api/reports/account", () => REPORT);
    renderAt("/reports/account", "/reports/account", <AccountReportScreen />, api);
    await screen.findByTestId("account-report");
    const failed = new URL(href("account-report-runs-failed"), "https://x");
    expect(failed.pathname).toBe("/runs");
    expect(failed.searchParams.get("statuses")).toBe("failed");
    expect(failed.searchParams.get("since")).toBe(SINCE);
    expect(screen.getByTestId("account-report-runs-all").textContent).toContain("6");
    expect(href("account-report-waiting")).toContain("statuses=waiting");
    expect(screen.getByTestId("account-report-waiting").textContent).toContain("2 open items");
    // Failed runs nobody has looked at have no runs filter, and nowhere to go on the portal.
    expect(screen.getByTestId("account-report-failed-unseen").tagName).not.toBe("A");
    expect(href("account-report-usage")).toBe("/settings/billing");
    expect(screen.getByTestId("account-report-usage").textContent).toContain("85%");
    const conns = screen.getByTestId("account-report-connections");
    expect(within(conns).getByRole("link", { name: "QuickBooks Online" })).toHaveAttribute(
      "href",
      "/connectors/qbo",
    );
    expect(conns.textContent).toContain("Access isn't renewing");
    const line = screen.getByTestId(`account-report-agent-${AGENT}`);
    expect(within(line).getByRole("link", { name: "Bill clerk" })).toHaveAttribute(
      "href",
      `/agents/${AGENT}/report`,
    );
    expect(href("account-report-csv")).toBe("/api/reports/account.csv");
    expect(screen.queryByTestId("ops-account-needs-us")).toBeNull();
  });

  it("adds Needs us in the back office, and links to Escalations and connections", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    const ops = { ...REPORT, needsUs: ["waiting", "failed", "connection", "item"] };
    api.on(`GET /api/ops/clients/${CLIENT}/report`, () => ops);
    renderAt(
      `/ops/clients/${CLIENT}/report`,
      "/ops/clients/:clientId/report",
      <ClientReportScreen />,
      api,
    );
    const needs = await screen.findByTestId("ops-account-needs-us");
    // S4.6: Home's Needs us kinds, in words.
    expect(needs.textContent).toContain("Approval stuck with the client");
    expect(needs.textContent).toContain("Item for us");
    expect(href("account-report-failed-unseen")).toBe(`/ops/inbox?client=${CLIENT}`);
    expect(
      within(screen.getByTestId("account-report-connections")).getByRole("link", {
        name: "QuickBooks Online",
      }),
    ).toHaveAttribute("href", `/ops/clients/${CLIENT}/connections`);
    expect(href("account-report-runs-all")).toContain("/ops/runs?");
    expect(href("account-report-csv")).toBe(`/api/ops/clients/${CLIENT}/report.csv`);
  });
});

describe("/ops/accounts", () => {
  const row = (id: string, name: string, runs: number, needsUs: string[]) => {
    const { agents: _lines, ...rest } = REPORT;
    return {
      ...rest,
      client: { id, name },
      runs: fig(runs, { clients: [id], mode: "live" }),
      headline: headline("2026-11-01", "2026-11-30", runs),
      agents: 2,
      needsUs,
      connections: needsUs.includes("connection") ? REPORT.connections : [],
      usage: null,
    };
  };

  it("lists the clients that need us first, and sorts by a column", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    api.on("GET /api/ops/accounts", () => ({
      accounts: [
        row(OTHER, "Birch Builders", 9, []),
        row(CLIENT, "Acme Cabinets", 4, ["connection"]),
      ],
    }));
    renderAt("/ops/accounts", "/ops/accounts", <AccountsScreen />, api);
    const table = await screen.findByTestId("ops-accounts-table");
    const names = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.getAttribute("data-testid"));
    expect(names()).toEqual([`ops-accounts-row-${CLIENT}`, `ops-accounts-row-${OTHER}`]);
    expect(screen.getByTestId("ops-accounts").textContent).toContain("1 client needs us.");
    const acme = screen.getByTestId(`ops-accounts-row-${CLIENT}`);
    expect(within(acme).getByRole("link", { name: "Acme Cabinets" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/report`,
    );
    expect(within(acme).getByText("Connection needs attention")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ops-accounts-sort-runs"));
    expect(names()).toEqual([`ops-accounts-row-${OTHER}`, `ops-accounts-row-${CLIENT}`]);
  });

  it("breaks ties by Needs us, then name", () => {
    const rows = [row(OTHER, "Birch", 4, []), row(CLIENT, "Acme", 4, ["failed"])] as never[];
    expect(
      sortAccounts(rows, "runs", -1).map((r: { client: { name: string } }) => r.client.name),
    ).toEqual(["Acme", "Birch"]);
  });
});
