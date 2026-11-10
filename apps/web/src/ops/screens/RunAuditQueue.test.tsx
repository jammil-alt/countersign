// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the audit queue. Its filters (client, agent,
// state) travel in the URL and the request; each run opens the run view; the stats per client and
// per agent show runs queued, audited, problems and when last audited. The client settings' Run
// audit section reads and saves the sampling rule and an agent's override.
import type { AuditMarkView, AuditQueueRun, AuditSettingsView, AuditStat } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { parsePercent, ruleWords } from "./ClientRunAudit";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const BILLS = "00000000-0000-4000-8000-00000000b001";
const CLERK = "00000000-0000-4000-8000-00000000b002";
const RUN_1 = "00000000-0000-4000-8000-0000000f1001";
const RUN_2 = "00000000-0000-4000-8000-0000000f1002";
const VERSION = "00000000-0000-4000-8000-0000000e0001";

const problem: AuditMarkView = {
  id: "00000000-0000-4000-8000-0000000f9001",
  runId: RUN_2,
  verdict: "problem",
  note: "Freight posted twice",
  markedBy: { id: OPERATOR_SESSION.user.id, name: "Operator", email: "operator@example.com" },
  inboxItemId: "00000000-0000-4000-8000-0000000f9101",
  createdAt: "2026-11-04T09:00:00.000Z",
};

const queued = (runId: string, over: Partial<AuditQueueRun> = {}): AuditQueueRun => ({
  runId,
  tenantId: DEMO,
  clientName: "Demo client",
  agentId: BILLS,
  agentName: "Bills",
  agentVersionId: VERSION,
  workflowSlug: "post-bill",
  status: "succeeded",
  startedAt: "2026-11-03T10:00:00.000Z",
  finishedAt: "2026-11-03T10:00:20.000Z",
  queuedAt: "2026-11-03T10:00:20.000Z",
  reason: "wrote",
  latest: null,
  marks: 0,
  ...over,
});

const stat = (over: Partial<AuditStat>): AuditStat => ({
  tenantId: DEMO,
  clientName: "Demo client",
  agentId: null,
  agentName: null,
  queued: 4,
  audited: 2,
  problems: 1,
  lastAuditedAt: "2026-11-04T09:00:00.000Z",
  ...over,
});

const STATS = {
  clients: [
    stat({}),
    stat({
      tenantId: SANDBOX,
      clientName: "Sandbox",
      queued: 1,
      audited: 0,
      problems: 0,
      lastAuditedAt: null,
    }),
  ],
  agents: [
    stat({ agentId: BILLS, agentName: "Bills" }),
    stat({ agentId: CLERK, agentName: "Records clerk", queued: 2, audited: 1, problems: 0 }),
  ],
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

describe("ops audit queue", () => {
  it("lists runs to audit, filters by client, agent and state, and opens a run", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/run-audit/queue": ({ url }) => {
        queries.push(url.searchParams);
        const state = url.searchParams.get("state");
        return {
          runs:
            state === "problem"
              ? [queued(RUN_2, { reason: "sampled", latest: problem, marks: 2 })]
              : [queued(RUN_1)],
          counts: { unaudited: 3, audited: 2, problem: 1 },
        };
      },
      "GET /api/ops/run-audit/stats": () => STATS,
    });
    const user = userEvent.setup();
    renderAt("/ops/run-audit", api);
    expect(await screen.findByRole("heading", { name: "Audit queue" })).toBeInTheDocument();
    const row = await screen.findByTestId(`ops-run-audit-row-${RUN_1}`);
    expect(row).toHaveTextContent("Demo client");
    expect(row).toHaveTextContent("Wrote to their tools");
    expect(within(row).getByTestId(`ops-run-audit-open-${RUN_1}`)).toHaveAttribute(
      "href",
      `/ops/runs/${RUN_1}`,
    );
    expect(queries[0]?.get("state")).toBe("unaudited");
    expect(screen.getByTestId("ops-run-audit-state-filter-unaudited")).toHaveTextContent(
      "To audit · 3",
    );
    expect(screen.getByTestId("ops-nav-run-audit")).toHaveAttribute("href", "/ops/run-audit");

    // Client, then agent: each reaches the request.
    await user.selectOptions(screen.getByTestId("ops-run-audit-client"), DEMO);
    await waitFor(() => expect(queries.at(-1)?.get("client")).toBe(DEMO));
    expect(screen.getByTestId("ops-run-audit-rule-link")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/settings/audit`,
    );
    await user.selectOptions(screen.getByTestId("ops-run-audit-agent"), CLERK);
    await waitFor(() => expect(queries.at(-1)?.get("agent")).toBe(CLERK));
    expect(queries.at(-1)?.get("client")).toBe(DEMO);

    // Problems: the latest mark, its note and who made it.
    await user.click(screen.getByTestId("ops-run-audit-state-filter-problem"));
    await waitFor(() => expect(queries.at(-1)?.get("state")).toBe("problem"));
    const bad = await screen.findByTestId(`ops-run-audit-row-${RUN_2}`);
    expect(within(bad).getByTestId(`ops-run-audit-verdict-${RUN_2}`)).toHaveTextContent("Problem");
    expect(bad).toHaveTextContent("Freight posted twice");
    expect(bad).toHaveTextContent("2 marks");

    await user.click(screen.getByTestId("ops-run-audit-clear"));
    await waitFor(() => expect(queries.at(-1)?.get("client")).toBeNull());
    expect(queries.at(-1)?.get("agent")).toBeNull();
  });

  it("shows per client and per agent: queued, audited, problems and last audited", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/run-audit/queue": () => ({
        runs: [],
        counts: { unaudited: 0, audited: 0, problem: 0 },
      }),
      "GET /api/ops/run-audit/stats": () => STATS,
    });
    renderAt("/ops/run-audit", api);
    expect(
      await screen.findByText("Nothing to audit. Runs join the queue as they finish."),
    ).toBeInTheDocument();
    const demo = await screen.findByTestId(`ops-run-audit-stat-client-${DEMO}`);
    expect(
      within(demo)
        .getAllByRole("cell")
        .slice(1, 4)
        .map((c) => c.textContent),
    ).toEqual(["4", "2", "1"]);
    expect(
      within(screen.getByTestId(`ops-run-audit-stat-client-${SANDBOX}`)).getByText("Never"),
    ).toBeInTheDocument();
    const clerk = screen.getByTestId(`ops-run-audit-stat-agent-${CLERK}`);
    expect(clerk).toHaveTextContent("Records clerk");
    expect(
      within(clerk)
        .getAllByRole("cell")
        .slice(1, 4)
        .map((c) => c.textContent),
    ).toEqual(["2", "1", "0"]);
  });
});

describe("client settings: run audit", () => {
  const view = (over: Partial<AuditSettingsView> = {}): AuditSettingsView => ({
    clientId: DEMO,
    default: { writes: true, percent: 5 },
    rule: null,
    effective: { writes: true, percent: 5 },
    agents: [
      { agentId: BILLS, name: "Bills", rule: null, effective: { writes: true, percent: 5 } },
      {
        agentId: CLERK,
        name: "Records clerk",
        rule: { writes: false, percent: 20 },
        effective: { writes: false, percent: 20 },
      },
    ],
    ...over,
  });

  function setup() {
    let current = view();
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/run-audit`]: () => current,
      [`PUT /api/ops/clients/${DEMO}/run-audit`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        if ("rule" in body) {
          current = {
            ...current,
            rule: body.rule,
            effective: body.rule ?? current.default,
          };
        }
        for (const [id, rule] of Object.entries(body.agents ?? {})) {
          current = {
            ...current,
            agents: current.agents.map((a) =>
              a.agentId === id
                ? {
                    ...a,
                    rule: rule as AuditSettingsView["agents"][number]["rule"],
                    effective: (rule as AuditSettingsView["effective"] | null) ?? current.effective,
                  }
                : a,
            ),
          };
        }
        return current;
      },
    });
    renderAt(`/ops/clients/${DEMO}/settings/audit`, api);
    return puts;
  }

  it("words a rule and reads a percent", () => {
    expect(ruleWords({ writes: true, percent: 5 })).toBe(
      "Every run that wrote to their tools, and 5% of the rest",
    );
    expect(ruleWords({ writes: false, percent: 0 })).toBe("No runs");
    expect(ruleWords({ writes: false, percent: 12.5 })).toBe("12.5% of runs");
    expect(parsePercent("12.5")).toBe(12.5);
    expect(parsePercent("101")).toBeNull();
    expect(parsePercent("1.234")).toBeNull();
    expect(parsePercent("")).toBeNull();
  });

  it("saves the client's rule and goes back to our default", async () => {
    const puts = setup();
    const user = userEvent.setup();
    expect(await screen.findByTestId("ops-client-run-audit-source")).toHaveTextContent(
      "Our default",
    );
    expect(screen.getByTestId("ops-client-settings-nav-audit")).toHaveTextContent("Run audit");
    const percent = screen.getByTestId("ops-client-run-audit-percent");
    await user.clear(percent);
    await user.type(percent, "150");
    expect(screen.getByTestId("ops-client-run-audit-save")).toBeDisabled();
    await user.clear(percent);
    await user.type(percent, "10");
    await user.click(screen.getByTestId("ops-client-run-audit-save"));
    await waitFor(() => expect(puts).toEqual([{ rule: { writes: true, percent: 10 } }]));
    expect(await screen.findByTestId("ops-client-run-audit-effective")).toHaveTextContent(
      "Every run that wrote to their tools, and 10% of the rest.",
    );
    expect(screen.getByTestId("ops-client-run-audit-source")).toHaveTextContent("Its own");
    await user.click(screen.getByTestId("ops-client-run-audit-reset"));
    await waitFor(() => expect(puts.at(-1)).toEqual({ rule: null }));
    expect(await screen.findByTestId("ops-client-run-audit-source")).toHaveTextContent(
      "Our default",
    );
    expect(screen.getByTestId("ops-client-run-audit-percent")).toHaveValue("5");
  });

  it("sets an agent's own rule and clears another's", async () => {
    const puts = setup();
    const user = userEvent.setup();
    const bills = `ops-client-run-audit-agent-${BILLS}`;
    const clerk = `ops-client-run-audit-agent-${CLERK}`;
    expect(await screen.findByTestId(`${clerk}-effective`)).toHaveTextContent("20% of runs");
    expect(screen.getByTestId(clerk)).toHaveTextContent("Its own rule");
    await user.click(screen.getByTestId(`${bills}-edit`));
    await user.click(screen.getByTestId(`${bills}-writes`));
    const percent = screen.getByTestId(`${bills}-percent`);
    await user.clear(percent);
    await user.type(percent, "50");
    await user.click(screen.getByTestId(`${bills}-save`));
    await waitFor(() =>
      expect(puts).toEqual([{ agents: { [BILLS]: { writes: false, percent: 50 } } }]),
    );
    expect(await screen.findByTestId(`${bills}-effective`)).toHaveTextContent("50% of runs");
    await user.click(screen.getByTestId(`${clerk}-clear`));
    await waitFor(() => expect(puts.at(-1)).toEqual({ agents: { [CLERK]: null } }));
    expect(await screen.findByTestId(clerk)).toHaveTextContent("The client's rule");
  });
});
