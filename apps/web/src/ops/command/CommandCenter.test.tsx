// O1 Command center: the six figures, "Needs us" with a way into each escalation, all agents by
// client, template or status, the live feed, client health with the supervisor's findings.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { agentChip } from "./CommandCenter";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const OTHER = "00000000-0000-4000-8000-00000000a003";
const RUN = "00000000-0000-4000-8000-00000000f001";
const AGENT = "00000000-0000-4000-8000-00000000b001";
const AGENT2 = "00000000-0000-4000-8000-00000000b002";

const demo = { id: DEMO, name: "Demo client" };
const other = { id: OTHER, name: "Harbor Millwork" };
const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const agent = (over: Record<string, unknown>) => ({
  id: AGENT,
  name: "Pia",
  serviceName: "Material costs",
  client: demo,
  template: { id: "t1", name: "Purchasing" },
  status: "active",
  stage: "live",
  openRuns: 0,
  recentRuns: [],
  cost7dUsd: "8.4000",
  ...over,
});

const center = (over: Record<string, unknown> = {}) => ({
  at: now.toISOString(),
  today: now.toISOString(),
  agentsLive: {
    count: 2,
    clients: [
      { ...demo, agents: 1 },
      { ...other, agents: 1 },
    ],
  },
  runningNow: { runs: 1, steps: 3 },
  needUs: { count: 2, blockedLong: 1 },
  waitingOnClients: { count: 3, oldestSince: hoursAgo(26), oldestAgeSeconds: 26 * 3600 },
  runsToday: { runs: 312, clean: 306, cleanShare: 0.9808 },
  spendToday: {
    costUsd: "41.8000",
    stepsUsd: "40.0000",
    readingUsd: "1.8000",
    perRunUsd: "0.1300",
  },
  escalations: [
    {
      kind: "failed_run",
      id: RUN,
      client: demo,
      agent: { id: AGENT, name: "Cole", serviceName: null },
      runId: RUN,
      title: "Gmail said the sign-in expired (401)",
      blockedSince: hoursAgo(14),
    },
    {
      kind: "connection",
      id: "00000000-0000-4000-8000-00000000c001",
      client: other,
      agent: { id: AGENT2, name: "Iris", serviceName: null },
      runId: null,
      title: "gmail",
      blockedSince: hoursAgo(7),
    },
  ],
  lowConfidence: [],
  health: [
    {
      ...demo,
      status: "bad",
      cleanShare: 0.61,
      runs: 40,
      medianResponseHours: 80,
      openEscalations: 3,
    },
    {
      ...other,
      status: "good",
      cleanShare: 0.96,
      runs: 80,
      medianResponseHours: 5,
      openEscalations: 0,
    },
  ],
  agents: [
    agent({
      openRuns: 1,
      recentRuns: [
        { id: "r2", status: "running", mode: "live", createdAt: hoursAgo(1) },
        { id: "r1", status: "failed", mode: "live", createdAt: hoursAgo(2) },
      ],
    }),
    agent({
      id: AGENT2,
      name: "Iris",
      client: other,
      template: null,
      status: "paused",
      cost7dUsd: "6.1000",
    }),
  ],
  ...over,
});

const overview = {
  since: hoursAgo(24 * 7),
  clients: 2,
  failedRuns: [],
  inbox: [],
  connections: [],
  updates: [
    {
      agent: { id: AGENT, slug: "pia", name: "Pia" },
      client: demo,
      template: { id: "t1", name: "Purchasing" },
      behind: 1,
      releaseNote: null,
    },
  ],
  counts: { failedRuns: 0, inbox: 0, connections: 0, updates: 1 },
};

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/ops"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

function routes(over: Record<string, () => unknown> = {}) {
  return fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/command-center": () => center(),
    "GET /api/ops/overview": () => overview,
    "GET /api/ops/feed": () => ({
      at: now.toISOString(),
      items: [
        {
          id: "failure:1",
          kind: "failure",
          at: hoursAgo(1),
          client: demo,
          agent: { id: AGENT, name: "Cole", serviceName: null },
          runId: RUN,
          text: "Gmail 401",
        },
        {
          id: "signature:2",
          kind: "signature",
          at: hoursAgo(2),
          client: other,
          agent: { id: AGENT2, name: "Pia", serviceName: null },
          runId: null,
          text: "4 cost updates",
        },
      ],
    }),
    "GET /api/ops/oversight": () => ({
      decisions: [],
      totals: { count: 0, costUsd: "0", byAction: {} },
    }),
    [`GET /api/ops/clients/${DEMO}/health`]: () => ({
      supervisor: {
        id: "s1",
        slug: "supervisor",
        name: "Supervisor",
        runStatus: "active",
        liveVersionId: "v1",
      },
      summary: null,
      findings: [
        {
          id: "f1",
          audience: "operator",
          kind: "run_failures",
          title: "Cole failed 3 times this week",
          fingerprint: "x",
          status: "open",
          createdAt: hoursAgo(5),
          resolvedAt: null,
          remindedAt: null,
          reminders: 0,
          occurrences: 3,
          details: null,
          note: null,
          steps: [],
          sources: [],
        },
      ],
    }),
    ...over,
  });
}

describe("command center", () => {
  it("shows the figures, what needs us and the agents, and opens a blocked run", async () => {
    renderAt(routes());
    const figures = await screen.findByTestId("ops-command-figures");
    expect(within(figures).getByTestId("ops-command-need-us")).toHaveTextContent(
      "Need us21 blocked over 6 h",
    );
    expect(within(figures).getByTestId("ops-command-waiting")).toHaveTextContent("Oldest 26 h");
    expect(within(figures).getByTestId("ops-command-runs")).toHaveTextContent("98.1% clean");
    expect(within(figures).getByTestId("ops-command-spend")).toHaveTextContent("$41.80");
    expect(within(figures).getByTestId("ops-command-spend")).toHaveTextContent("$0.13 per run");

    const run = screen.getByTestId(`ops-needs-${RUN}`);
    expect(run).toHaveTextContent("Blocked 14 h");
    expect(run).toHaveTextContent("Cole · Demo client");
    expect(within(run).getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      `/ops/runs/${RUN}`,
    );
    const conn = screen.getByTestId("ops-needs-00000000-0000-4000-8000-00000000c001");
    expect(within(conn).getByRole("link", { name: "Open connections" })).toHaveAttribute(
      "href",
      `/ops/clients/${OTHER}/connections`,
    );

    // Agents by client, with the template update waiting and the last runs.
    const agents = screen.getByTestId("ops-command-agents");
    expect(within(agents).getByTestId("ops-agents-group-Demo client")).toHaveTextContent("1 agent");
    const pia = within(agents).getByTestId(`ops-agent-${AGENT}`);
    expect(pia).toHaveTextContent("Running");
    expect(pia).toHaveTextContent("1 run open");
    expect(pia).toHaveTextContent("1 version behind");
    expect(pia).toHaveTextContent("$8.40");
    expect(within(pia).getByRole("img", { name: "Last 2 runs: 1 failed" })).toBeInTheDocument();
    expect(within(agents).getByTestId(`ops-agent-${AGENT2}`)).toHaveTextContent("Paused");

    // By status groups them by what their chips say.
    await userEvent.click(within(agents).getByTestId("ops-agents-by-status"));
    expect(within(agents).getByTestId("ops-agents-group-Paused")).toBeInTheDocument();
    expect(within(agents).getByTestId("ops-agents-group-Running")).toBeInTheDocument();
    await userEvent.click(within(agents).getByTestId("ops-agents-by-template"));
    expect(
      within(agents).getByTestId("ops-agents-group-Built for this client"),
    ).toBeInTheDocument();
  });

  it("shows the live feed and client health with the supervisor's findings", async () => {
    renderAt(routes());
    const feed = await screen.findByTestId("ops-command-feed");
    expect(await within(feed).findByTestId("ops-feed-failure:1")).toHaveTextContent(
      "Cole · Demo client · failed: Gmail 401",
    );
    expect(within(feed).getByTestId("ops-feed-failure:1").querySelector("a")).toHaveAttribute(
      "href",
      `/ops/runs/${RUN}`,
    );
    expect(within(feed).getByText("signed")).toHaveClass("text-copper-ink");

    const health = screen.getByTestId(`ops-health-${DEMO}`);
    expect(within(health).getByTestId(`ops-health-${DEMO}-facts`)).toHaveTextContent(
      "Needs us · 61% clean · answers in 80 h · 3 escalations",
    );
    expect(within(health).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "61");
    await userEvent.click(within(health).getByTestId(`ops-health-${DEMO}-findings`));
    expect(await within(health).findByText("Cole failed 3 times this week")).toBeInTheDocument();
  });

  it("says so when nothing needs us", async () => {
    renderAt(
      routes({
        "GET /api/ops/command-center": () =>
          center({ escalations: [], needUs: { count: 0, blockedLong: 0 } }),
      }),
    );
    expect(await screen.findByTestId("ops-command-clear")).toHaveTextContent("Nothing needs us.");
    expect(screen.getByTestId("ops-command-need-us")).toHaveTextContent("None blocked long");
  });

  it("names an agent's state in words", () => {
    expect(agentChip({ status: "active", openRuns: 0, recentRuns: [] }).words).toBe("Idle");
    expect(
      agentChip({
        status: "active",
        openRuns: 1,
        recentRuns: [{ id: "a", status: "waiting", mode: "live", createdAt: "" }],
      }),
    ).toEqual({ state: "waiting", words: "On client" });
    expect(
      agentChip({
        status: "active",
        openRuns: 0,
        recentRuns: [{ id: "a", status: "failed", mode: "live", createdAt: "" }],
      }).state,
    ).toBe("failed");
    expect(agentChip({ status: "draft", openRuns: 0, recentRuns: [] }).words).toBe("Setting up");
  });
});
