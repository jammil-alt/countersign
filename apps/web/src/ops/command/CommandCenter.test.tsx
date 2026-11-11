// O1 Command center: up to four figures, each a link to its filtered list; "Needs us" with a way
// into each escalation (an approval stuck at a client among them); all agents by client, template
// or status; the live feed; client health with the supervisor's findings.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { agentChip } from "./CommandCenter";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const OTHER = "00000000-0000-4000-8000-00000000a003";
const RUN = "00000000-0000-4000-8000-00000000f001";
const WAITING_RUN = "00000000-0000-4000-8000-00000000f002";
const AGENT = "00000000-0000-4000-8000-00000000b001";
const AGENT2 = "00000000-0000-4000-8000-00000000b002";
const RUN2 = "00000000-0000-4000-8000-00000000f002";
const runQueries: string[] = [];
const opsRun = (id: string, tenantId: string, agentId: string, status: string, at: string) => ({
  id,
  tenantId,
  agentId,
  agentVersionId: "v1",
  workflowSlug: "main",
  mode: "live",
  status,
  trigger: {},
  costUsd: "0",
  error: null,
  startedAt: at,
  finishedAt: at,
  createdAt: at,
});

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
  waitingForApproval: { runs: 1, oldestSince: hoursAgo(39), overdue: 1, nobodyToAct: 1 },
  failedToday: { runs: 2 },
  needUs: { count: 3, blockedLong: 2 },
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
      kind: "approval",
      id: WAITING_RUN,
      client: demo,
      agent: { id: AGENT, name: "Bill clerk", serviceName: null },
      runId: WAITING_RUN,
      title: "Itemize bill 20418",
      blockedSince: hoursAgo(39),
      wait: {
        on: "client_admin",
        person: null,
        since: hoursAgo(39),
        items: 1,
        nobodyToAct: "not_signed_in",
        emailOff: true,
      },
    },
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
      // §1.84: the template update waiting comes with the command center.
      behind: 1,
      recentRuns: [
        { id: "r2", status: "running", mode: "live", createdAt: hoursAgo(1) },
        { id: "r1", status: "failed", mode: "live", createdAt: hoursAgo(2) },
      ],
      perDay: [
        ...Array.from({ length: 12 }, () => ({ runs: 0, failed: 0 })),
        { runs: 2, failed: 1 },
        { runs: 2, failed: 0 },
      ],
    }),
    agent({
      id: AGENT2,
      name: "Iris",
      serviceName: null,
      client: other,
      template: null,
      status: "paused",
      cost7dUsd: "6.1000",
    }),
  ],
  clientCounts: [
    { id: DEMO, needsUs: 3, waitingRuns: 1 },
    { id: OTHER, needsUs: 0, waitingRuns: 0 },
  ],
  perDay: Array.from({ length: 14 }, (_, i) => ({
    runs: i === 13 ? 18 : 24,
    failed: i === 13 ? 2 : 0,
  })),
  ...over,
});

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
    "GET /api/ops/runs": ({ url }: { url: URL }) => {
      runQueries.push(url.search);
      const status = url.searchParams.get("status");
      const all = [
        opsRun(RUN, DEMO, AGENT, "failed", "2026-11-09T08:23:00.000Z"),
        opsRun(RUN2, DEMO, AGENT2, "succeeded", "2026-11-09T07:10:00.000Z"),
      ];
      return {
        runs: status ? all.filter((r) => status.split(",").includes(r.status)) : all,
        agents: [
          { id: AGENT, tenantId: DEMO, slug: "cole", name: "Cole", serviceName: null },
          { id: AGENT2, tenantId: DEMO, slug: "pia", name: "Pia", serviceName: null },
        ],
      };
    },
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
    const api = routes();
    renderAt(api);
    const figures = await screen.findByTestId("ops-command-figures");
    // Four figures, each a link to its list filtered.
    const need = within(figures).getByTestId("ops-command-need-us");
    expect(need).toHaveTextContent("Needs us32 blocked over 6 h");
    expect(need).toHaveAttribute("href", "/ops/inbox");
    const waiting = within(figures).getByTestId("ops-command-waiting");
    expect(waiting).toHaveTextContent("Waiting for approval1Nobody can approve 1");
    expect(waiting).toHaveAttribute("href", "/ops/runs?statuses=waiting&mode=live");
    // Today's live runs, always shown, with its 14 days and what runs now.
    const runs = within(figures).getByTestId("ops-command-runs-today");
    expect(runs).toHaveTextContent("Live runs today312");
    expect(runs).toHaveTextContent("1 run running now, 3 steps in flight");
    expect(runs).toHaveAttribute("data-tone", "slate");
    expect(
      within(runs).getByRole("img", {
        name: "Live runs each day, last 14 days: 330 in all, 2 failed",
      }),
    ).toBeInTheDocument();
    expect(new URL(runs.getAttribute("href") ?? "", "http://x").searchParams.get("statuses")).toBe(
      "queued,running",
    );
    // Each figure in its state colour: Needs us risk, waiting gold, failed risk.
    expect(need).toHaveAttribute("data-tone", "risk");
    expect(waiting).toHaveAttribute("data-tone", "signal");
    const failed = within(figures).getByTestId("ops-command-failed");
    expect(failed).toHaveTextContent("Failed today2");
    expect(failed).toHaveAttribute("data-tone", "risk");
    const failedQuery = new URL(failed.getAttribute("href") ?? "", "http://x").searchParams;
    expect(Object.fromEntries(failedQuery)).toEqual({
      statuses: "failed",
      mode: "live",
      since: now.toISOString(),
    });
    expect(figures.querySelectorAll("a")).toHaveLength(4);
    // Spend and the agents live sit under the title; today's runs are the figure, said once.
    // "Live" is switched on and at the live stage: the paused one isn't counted.
    expect(screen.getByText("$41.80 model spend today · 1 agent live")).toBeInTheDocument();

    // An approval stuck at a client: what waits, on whom, how long, why, and its run.
    const stuck = screen.getByTestId(`ops-needs-${WAITING_RUN}`);
    expect(stuck).toHaveTextContent("Waiting 39 h");
    expect(stuck).toHaveTextContent(
      "Waiting for approval · client admin: Itemize bill 20418. Everyone who may approve it is still invited and hasn't signed in.",
    );
    expect(within(stuck).getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      `/ops/runs/${WAITING_RUN}`,
    );

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

    // Filtered by type, then by client: only what matches stays.
    const needs = screen.getByTestId("ops-command-needs-us");
    await userEvent.selectOptions(within(needs).getByTestId("ops-needs-kind"), "connection");
    expect(
      within(needs).getByTestId("ops-needs-00000000-0000-4000-8000-00000000c001"),
    ).toBeVisible();
    expect(within(needs).queryByTestId(`ops-needs-${RUN}`)).toBeNull();
    await userEvent.selectOptions(within(needs).getByTestId("ops-needs-client"), DEMO);
    expect(within(needs).getByTestId("ops-needs-none")).toBeInTheDocument();
    await userEvent.selectOptions(within(needs).getByTestId("ops-needs-kind"), "");
    expect(within(needs).getByTestId(`ops-needs-${RUN}`)).toBeInTheDocument();

    // Agents by client, with the template update waiting and the last runs.
    const agents = screen.getByTestId("ops-command-agents");
    expect(within(agents).getByTestId("ops-agents-group-Demo client")).toHaveTextContent("1 agent");
    const pia = within(agents).getByTestId(`ops-agent-${AGENT}`);
    expect(pia).toHaveTextContent("Running");
    expect(pia).toHaveTextContent("1 run running");
    expect(pia).toHaveTextContent("1 version behind");
    expect(pia).toHaveTextContent("$8.40");
    // The name the client knows (its service name), not the bundle's own.
    expect(pia).toHaveTextContent("Material costs");
    expect(pia).not.toHaveTextContent("Pia");
    // Its runs each day for 14 days, failed days marked.
    expect(
      within(pia).getByRole("img", { name: "Runs each day, last 14 days: 4 in all, 1 failed" }),
    ).toBeInTheDocument();
    expect(within(agents).getByTestId(`ops-agent-${AGENT2}`)).toHaveTextContent("Paused");

    // §1.84: one request for the page. The badge reads the command center's count, and nothing
    // else asks for Needs us, the overview or oversight.
    await waitFor(() =>
      expect(screen.getByTestId("shell-inbox")).toHaveTextContent("Escalations3"),
    );
    for (const other of ["/api/ops/counts", "/api/ops/needs-us", "/api/ops/overview"]) {
      expect(api.calls).not.toContain(`GET ${other}`);
    }
    expect(api.calls).not.toContain("GET /api/ops/oversight");
    expect(api.calls.filter((c) => c === "GET /api/ops/command-center")).toHaveLength(1);
    // Without the days (an older API), the last runs as bars.
    expect(
      within(within(agents).getByTestId(`ops-agent-${AGENT2}`)).getByText("No runs"),
    ).toBeInTheDocument();

    // By status groups them by what their chips say.
    await userEvent.click(within(agents).getByTestId("ops-agents-by-status"));
    expect(within(agents).getByTestId("ops-agents-group-Paused")).toBeInTheDocument();
    expect(within(agents).getByTestId("ops-agents-group-Running")).toBeInTheDocument();
    await userEvent.click(within(agents).getByTestId("ops-agents-by-template"));
    expect(
      within(agents).getByTestId("ops-agents-group-Built for this client"),
    ).toBeInTheDocument();
  });

  it("shows recent runs with the date, by client and status, and client health", async () => {
    renderAt(routes());
    const runs = await screen.findByTestId("ops-command-runs");
    expect(within(runs).getByText("Recent runs")).toBeInTheDocument();
    const row = await within(runs).findByTestId(`ops-recent-${RUN}`);
    // The date stacked on the time.
    expect(row.querySelector(".ops-when")).toHaveAttribute("title", "9 Nov 08:23");
    expect(row).toHaveTextContent("9 Nov08:23");
    expect(row).toHaveTextContent("Cole · Demo client");
    expect(within(row).getByTestId(`ops-recent-${RUN}-status`)).toHaveTextContent("Failed");
    expect(row.querySelector("a")).toHaveAttribute("href", `/ops/runs/${RUN}`);
    expect(runQueries.at(-1)).toContain("mode=live");

    // Failed asks for failed runs only; a client narrows it to that client.
    await userEvent.selectOptions(within(runs).getByTestId("ops-recent-status"), "failed");
    await waitFor(() => expect(within(runs).queryByTestId(`ops-recent-${RUN2}`)).toBeNull());
    expect(runQueries.at(-1)).toContain("status=failed");
    await userEvent.selectOptions(within(runs).getByTestId("ops-recent-status"), "going");
    await waitFor(() => expect(runQueries.at(-1)).toContain("status=queued%2Crunning%2Cwaiting"));
    await userEvent.selectOptions(within(runs).getByTestId("ops-recent-client"), DEMO);
    await waitFor(() => expect(runQueries.at(-1)).toContain(`client=${DEMO}`));
    expect(await within(runs).findByText("No runs match these filters.")).toBeInTheDocument();

    // Health is a chip with its word, whatever the clean share (a bar drew nothing at 0%).
    const health = screen.getByTestId(`ops-health-${DEMO}`);
    expect(within(health).getByTestId(`ops-health-${DEMO}-status`)).toHaveTextContent("At risk");
    expect(within(health).getByTestId(`ops-health-${DEMO}-facts`)).toHaveTextContent(
      "61% of 40 runs clean · answers in 80 h · 3 escalations",
    );
    expect(within(health).queryByRole("progressbar")).toBeNull();
    const findings = within(health).getByTestId(`ops-health-${DEMO}-findings`);
    expect(findings).toHaveTextContent("What the supervisor found");
    await userEvent.click(findings);
    expect(await within(health).findByText("Cole failed 3 times this week")).toBeInTheDocument();
  });

  it("asks for the recent runs with the command center, each section in its own place", async () => {
    // docs/audit-plan.md 1.5: Recent runs does not wait for the command center's answer.
    let answer: (v: unknown) => void = () => {};
    const api = routes({
      "GET /api/ops/command-center": () => new Promise((resolve) => (answer = resolve)),
    });
    renderAt(api);
    const row = await screen.findByTestId(`ops-recent-${RUN}`);
    expect(row).toBeInTheDocument();
    expect(api.calls).toContain("GET /api/ops/command-center");
    // The figures, Needs us and All agents hold their places with skeletons, titled at once.
    expect(screen.queryByTestId("ops-command-figures")).toBeNull();
    expect(screen.getByText("Needs us")).toBeInTheDocument();
    expect(screen.getByText("All agents")).toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(3);
    answer(center());
    expect(await screen.findByTestId("ops-command-figures")).toBeInTheDocument();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("prefetches Escalations' list once Home has settled, and a run on hover, once", async () => {
    // docs/audit-plan.md 1.6.
    const api = routes({
      "GET /api/ops/inbox": () => ({ items: [], agents: [] }),
      [`GET /api/ops/runs/${RUN}`]: () => ({}),
    });
    renderAt(api);
    await screen.findByTestId("ops-command-figures");
    await waitFor(() => expect(api.calls).toContain("GET /api/ops/inbox"));
    // Never Needs us again: Home has just computed it (§1.84).
    expect(api.calls).not.toContain("GET /api/ops/needs-us");

    const row = await screen.findByTestId(`ops-recent-${RUN}`);
    const link = row.querySelector("a") as HTMLAnchorElement;
    // A touch (scrolling the list on a phone) fetches nothing.
    fireEvent.pointerOver(link, { pointerType: "touch" });
    expect(api.calls).not.toContain(`GET /api/ops/runs/${RUN}`);
    fireEvent.pointerOver(link, { pointerType: "mouse" });
    fireEvent.pointerOver(link, { pointerType: "mouse" });
    fireEvent.focus(link);
    await waitFor(() => expect(api.calls).toContain(`GET /api/ops/runs/${RUN}`));
    expect(api.calls.filter((c) => c === `GET /api/ops/runs/${RUN}`)).toHaveLength(1);
    expect(api.calls.filter((c) => c === "GET /api/ops/inbox")).toHaveLength(1);
  });

  it("keeps the recent runs on screen, dimmed, while a filter's list loads", async () => {
    // docs/audit-plan.md 1.8: a filter answers at once.
    let answer: (v: unknown) => void = () => {};
    const api = routes();
    renderAt(api);
    const runs = await screen.findByTestId("ops-command-runs");
    await within(runs).findByTestId(`ops-recent-${RUN}`);
    api.on("GET /api/ops/runs", () => new Promise((resolve) => (answer = resolve)));
    await userEvent.selectOptions(within(runs).getByTestId("ops-recent-status"), "failed");
    const list = within(runs).getByTestId("ops-recent-list");
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(within(runs).getByTestId(`ops-recent-${RUN2}`)).toBeInTheDocument();
    answer({ runs: [opsRun(RUN, DEMO, AGENT, "failed", "2026-11-09T08:23:00.000Z")], agents: [] });
    await waitFor(() => expect(within(runs).queryByTestId(`ops-recent-${RUN2}`)).toBeNull());
    expect(within(runs).getByTestId("ops-recent-list")).not.toHaveAttribute("aria-busy");
  });

  it("says so when nothing needs us", async () => {
    renderAt(
      routes({
        "GET /api/ops/command-center": () =>
          center({ escalations: [], needUs: { count: 0, blockedLong: 0 } }),
      }),
    );
    expect(await screen.findByTestId("ops-command-clear")).toHaveTextContent("Nothing needs us.");
    // A figure at 0 is left out.
    expect(screen.queryByTestId("ops-command-need-us")).toBeNull();
    expect(screen.getByTestId("ops-command-waiting")).toBeInTheDocument();
  });

  it("names an agent's state in words", () => {
    expect(agentChip({ status: "active", openRuns: 0, recentRuns: [] }).words).toBe("Idle");
    expect(
      agentChip({
        status: "active",
        openRuns: 1,
        recentRuns: [{ id: "a", status: "waiting", mode: "live", createdAt: "" }],
      }),
    ).toEqual({ state: "waiting", words: "Waiting for approval" });
    // A run stored as running that waits on a person counts as waiting.
    expect(agentChip({ status: "active", openRuns: 1, waitingRuns: 1, recentRuns: [] }).words).toBe(
      "Waiting for approval",
    );
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
