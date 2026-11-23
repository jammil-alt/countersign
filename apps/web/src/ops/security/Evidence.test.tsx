// §1.231.3 (A4): the agents' checks' evidence for an auditor, as a printable page with a CSV link,
// and the Overview's rollup per register control.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const AGENT = "0199a000-0000-7000-8000-0000000000a1";

const EVIDENCE = {
  period: { start: "2026-10-24T00:00:00.000Z", end: "2026-11-23T00:00:00.000Z" },
  rows: [
    {
      id: "0199a000-0000-7000-8000-0000000000e1",
      client: { id: "0199a000-0000-7000-8000-0000000000c1", name: "Harbor Millwork" },
      agent: { id: AGENT, name: "Bills in" },
      version: 7,
      checkId: "delete_off",
      number: "K3",
      name: "Delete is off",
      kind: "setup",
      controls: ["AGT-1"],
      soc2: ["CC8.1", "PI1.3"],
      result: "verified",
      found: "Off on QuickBooks Online",
      evidence: { connections: ["c1"], open: [] },
      periodStart: null,
      periodEnd: null,
      checkedAt: "2026-11-21T08:23:00.000Z",
      trigger: "nightly",
      issueId: null,
    },
  ],
  truncated: false,
  generatedAt: "2026-11-22T12:00:00.000Z",
};

const ROLLUP = {
  period: EVIDENCE.period,
  clients: 1,
  agents: 2,
  controls: [
    {
      id: "AGT-1",
      title: "Approval before an agent changes a client's tools",
      soc2: ["CC8.1"],
      agents: 2,
      verified: 1,
      inReview: 1,
      notApplicable: 0,
      results: 30,
    },
  ],
  generatedAt: "2026-11-22T12:00:00.000Z",
};

function renderAt(path: string, more: Parameters<typeof fakeApi>[0] = {}) {
  const queries: URLSearchParams[] = [];
  const api = fakeApi({
    ...more,
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/security": () => ({
      covered: [],
      clients: [],
      audit30d: { events: 0, refused: 0 },
      generatedAt: "2026-11-22T12:00:00.000Z",
    }),
    "GET /api/ops/assurance/evidence": ({ url }) => {
      queries.push(url.searchParams);
      return EVIDENCE;
    },
    "GET /api/ops/assurance/rollup": () => ROLLUP,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, queries };
}

describe("the evidence of agents' checks (§1.231.3)", () => {
  it("lists each result with its check, SOC 2 criteria and evidence ids, with CSV and print", async () => {
    renderAt(`/ops/security/evidence?agent=${AGENT}`);
    const row = await screen.findByTestId(`evidence-row-${EVIDENCE.rows[0]?.id}`);
    expect(within(row).getByText("Verified")).toBeTruthy();
    expect(row.textContent).toContain("K3");
    expect(row.textContent).toContain("SOC 2 CC8.1, PI1.3");
    expect(row.textContent).toContain('"connections":["c1"]');
    expect(screen.getByTestId("evidence-period").textContent).toContain(
      "24 Oct 2026 to 22 Nov 2026",
    );
    expect(screen.getByTestId("evidence-csv").getAttribute("href")).toBe(
      `/api/ops/assurance/evidence.csv?agent=${AGENT}`,
    );
    expect(screen.getByTestId("evidence-print")).toBeTruthy();
  });

  // S6.4: a client to pick, then one of its agents.
  it("narrows the results to a client, then one of its agents", async () => {
    const DEMO = "00000000-0000-4000-8000-00000000a002";
    const agent = (id: string, name: string, testCopy = false) => ({
      id,
      tenantId: DEMO,
      kind: "client",
      slug: name.toLowerCase().replace(/ /g, "-"),
      name,
      role: null,
      templateId: null,
      linked: false,
      liveVersionId: null,
      status: "active",
      runStatus: "active",
      serviceName: null,
      serviceDescription: null,
      bindings: {},
      approver: null,
      testCopy,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const TEST_COPY = "0199a000-0000-7000-8000-0000000000a2";
    const { queries } = renderAt("/ops/security/evidence", {
      [`GET /api/ops/clients/${DEMO}/agents`]: () => ({
        agents: [agent(AGENT, "Bills in"), agent(TEST_COPY, "Bills in (test)", true)],
      }),
    });
    const user = userEvent.setup();
    const agentPick = await screen.findByTestId("evidence-agent");
    expect(agentPick).toBeDisabled();
    await user.selectOptions(screen.getByTestId("evidence-client"), DEMO);
    await waitFor(() => expect(queries.at(-1)?.get("client")).toBe(DEMO));
    await waitFor(() => expect(screen.getByTestId("evidence-agent")).toBeEnabled());
    const options = within(screen.getByTestId("evidence-agent")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All agents", "Bills in"]);
    await user.selectOptions(screen.getByTestId("evidence-agent"), AGENT);
    await waitFor(() => expect(queries.at(-1)?.get("agent")).toBe(AGENT));
    expect(screen.getByTestId("evidence-csv").getAttribute("href")).toBe(
      `/api/ops/assurance/evidence.csv?client=${DEMO}&agent=${AGENT}`,
    );
  });

  it("shows the rollup per control on the Overview", async () => {
    renderAt("/ops/security");
    const row = await screen.findByTestId("ops-security-rollup-AGT-1");
    expect(row.textContent).toContain("1 in review");
    expect(screen.getByTestId("ops-security-rollup").textContent).toContain("2 agents, 1 clients");
  });
});
