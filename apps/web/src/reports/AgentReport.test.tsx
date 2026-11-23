// R4: the agent report's tab (docs/plan.md §1.214) on both surfaces: its figures, each opening
// the surface's runs list on exactly its runs, money per currency, the people who signed, what it
// handled, the CSV link, and the back office's errors and cost below it.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { ReportTab } from "../ops/agents/ReportTab";
import { AgentReport } from "../portal/screens/AgentReport";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";

const AGENT = "00000000-0000-4000-8000-00000000c001";
const CLIENT = "00000000-0000-4000-8000-00000000a002";
const PERSON = "00000000-0000-4000-8000-00000000d001";
const VENDOR = "00000000-0000-4000-8000-0000000a7003";
const SINCE = "2026-11-01T00:00:00.000Z";
const UNTIL = "2026-12-01T00:00:00.000Z";
const base = { agents: [AGENT], since: SINCE, until: UNTIL };
const fig = (count: number, extra: Record<string, unknown> | null = {}) => ({
  count,
  filter: extra === null ? null : { ...base, ...extra },
});
const outcomes = (done: number, failed: number) => ({
  done: fig(done, { statuses: ["succeeded"] }),
  waiting: fig(0, { statuses: ["waiting"] }),
  failed: fig(failed, { statuses: ["failed"] }),
  stopped: fig(0, { statuses: ["cancelled"] }),
  going: fig(0, { statuses: ["queued", "running"] }),
});
const headline = (from: string, to: string, runs: number) => ({
  from,
  to,
  runs,
  done: runs,
  failed: 0,
  finishMedianMs: 120_000,
  waitMedianMs: 1_800_000,
  approvals: 1,
  changes: 1,
});

const REPORT = {
  service: { id: AGENT, name: "Bill clerk" },
  from: "2026-11-01",
  to: "2026-11-30",
  timezone: "UTC",
  headline: headline("2026-11-01", "2026-11-30", 3),
  previous: headline("2026-10-01", "2026-10-31", 5),
  runs: fig(3),
  outcomes: outcomes(2, 1),
  perDay: [{ day: "2026-11-02", ...outcomes(2, 1) }],
  timeToFinish: { runs: fig(2, { statuses: ["succeeded"] }), medianMs: 120_000, p90Ms: 300_000 },
  waitingOnPeople: {
    answered: 1,
    open: 0,
    medianMs: 1_800_000,
    p90Ms: 1_800_000,
    totalMs: 1_800_000,
  },
  approvals: {
    signed: 1,
    edited: 0,
    turnedDown: 1,
    byPerson: [
      {
        person: { id: PERSON, name: "Ana Ruiz" },
        steppedIn: false,
        signed: 1,
        edited: 0,
        turnedDown: 0,
        filter: { ...base, signedBy: PERSON },
      },
      { person: null, steppedIn: true, signed: 0, edited: 0, turnedDown: 1, filter: null },
    ],
  },
  changes: {
    total: fig(1, { changedConnector: "qbo" }),
    amounts: [{ currency: "USD", total: "120.5000" }],
    byConnector: [
      {
        connector: "qbo",
        name: "QuickBooks Online",
        count: 1,
        amounts: [{ currency: "USD", total: "120.5000" }],
        entities: [{ entity: "bill", count: 1 }],
        filter: { ...base, changedConnector: "qbo" },
      },
    ],
  },
  handled: [
    {
      kind: "vendor",
      records: 1,
      runs: 2,
      filter: { ...base, about: [{ kind: "vendor", id: VENDOR }] },
      top: [
        {
          id: VENDOR,
          label: "Acme Supply",
          number: null,
          runs: 2,
          filter: { ...base, about: [{ kind: "vendor", id: VENDOR }] },
        },
      ],
    },
  ],
  kpis: [],
};

const href = (testId: string) => screen.getByTestId(testId).getAttribute("href") ?? "";

describe("the agent report", () => {
  it("opens the portal's runs list on exactly each figure's runs", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    api.on(`GET /api/services/${AGENT}/report`, () => REPORT);
    render(
      <MemoryRouter initialEntries={[`/agents/${AGENT}/report`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/agents/:id/report" element={<AgentReport id={AGENT} />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId("agent-report");
    const failed = new URL(href("agent-report-runs-failed"), "https://x");
    expect(failed.pathname).toBe("/runs");
    expect(failed.searchParams.get("statuses")).toBe("failed");
    expect(failed.searchParams.get("agents")).toBe(AGENT);
    expect(failed.searchParams.get("since")).toBe(SINCE);
    expect(screen.getByTestId("agent-report-runs-all").textContent).toContain("5");
    expect(screen.getByTestId("agent-report-changes").textContent).toContain("$120.50");
    const approvers = screen.getByTestId("agent-report-approvers");
    const ana = within(approvers).getByRole("link", { name: "Ana Ruiz" });
    expect(ana.getAttribute("href")).toContain(`signedBy=${PERSON}`);
    // Who stepped in is ours: named as Mezonas, not a link.
    expect(within(approvers).getByText("Mezonas stepped in").closest("a")).toBeNull();
    const acme = within(screen.getByTestId("agent-report-handled")).getByRole("link", {
      name: "Acme Supply",
    });
    expect(decodeURIComponent(acme.getAttribute("href") ?? "")).toContain(`about=vendor:${VENDOR}`);
    expect(href("agent-report-csv")).toBe(`/api/services/${AGENT}/report.csv`);
    expect(screen.queryByTestId("ops-agent-report-errors")).toBeNull();
  });

  it("adds the back office's errors and cost, linked to its runs list", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    const opsBase = { ...base, clients: [CLIENT], mode: "live" };
    api.on(`GET /api/ops/agents/${AGENT}/report`, () => ({
      ...REPORT,
      client: { id: CLIENT, name: "Acme Cabinets" },
      errors: [
        {
          key: "qbo.timeout",
          count: 1,
          filter: { ...opsBase, statuses: ["failed"], errorKey: "qbo.timeout" },
        },
      ],
      spend: {
        runs: 3,
        costUsd: "0.7500",
        costPerRunUsd: "0.2500",
        tokensIn: 1800,
        tokensOut: 600,
        tokensPerRun: 800,
        filter: opsBase,
      },
    }));
    render(
      <MemoryRouter initialEntries={[`/ops/agents/${AGENT}/report`]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/ops/agents/:id/report" element={<ReportTab agentId={AGENT} />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    const errors = await screen.findByTestId("ops-agent-report-errors");
    const link = within(errors).getByRole("link", { name: "qbo.timeout" });
    expect(link.getAttribute("href")).toContain("/ops/runs?");
    expect(link.getAttribute("href")).toContain("errorKey=qbo.timeout");
    expect(screen.getByTestId("ops-agent-report-spend").textContent).toContain("$0.75");
    expect(href("agent-report-csv")).toBe(`/api/ops/agents/${AGENT}/report.csv`);
  });
});
