// The back-office agent page: its bar (versions, status, Test run, Publish), the seven tabs, the
// old People tab's address, the Triggers tab and the Tests tab's test bench (run a suite, read a
// case's result, add a case).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, versionId } from "../../test/fixtures";
import { AgentScreen } from "./AgentScreen";

const ID = AGENT_SUMMARY.id;
const CLIENT = AGENT_SUMMARY.tenantId;
const BASE = `/ops/clients/${CLIENT}/agents/${AGENT_SUMMARY.slug}`;
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000f001";
const SUITE_ID = "00000000-0000-4000-8000-00000000d001";
const CASE_ID = "00000000-0000-4000-8000-00000000d101";

const TEMPLATE = { ...AGENT_SUMMARY, kind: "template" as const, tenantId: null, bindings: {} };

const SUITE = {
  id: SUITE_ID,
  clientId: null,
  targetKind: "template",
  targetId: TEMPLATE_ID,
  versionId: versionId(2),
  version: 2,
  status: "done",
  total: 4,
  passed: 3,
  failed: 1,
  metrics: { passRate: 0.75, precision: 0.971, costPerCase: "0.11" },
  costUsd: "0.44",
  startedBy: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  finishedAt: "2026-11-05T10:01:00.000Z",
};

const CASE = {
  id: CASE_ID,
  clientId: null,
  clientName: null,
  targetKind: "template",
  targetId: TEMPLATE_ID,
  name: "Hafele invoice",
  input: { workflow: "new-bill", payload: {} },
  fixtures: [],
  expected: { find: { found: true } },
  matcher: { kind: "subset", tolerances: {} },
  required: true,
  source: "manual",
  sourceRef: null,
  createdBy: null,
  createdAt: "2026-11-04T10:00:00.000Z",
  archivedAt: null,
};

function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function setup(path: string, routes: Parameters<typeof fakeApi>[0] = {}, base = BASE) {
  const api = fakeApi({
    [`GET /api/ops/agents/${ID}`]: () => AGENT_DETAIL,
    [`GET /api/ops/agents/${ID}/skills`]: () => ({ skills: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route
            path={`${base}/*`}
            element={<AgentScreen agentId={ID} base={base} clientName="Harbor Millwork" />}
          />
        </Routes>
        <Probe />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("AgentScreen", () => {
  it("shows the agent's bar and tabs, and publishes the newest draft", async () => {
    let published = false;
    const { api, user } = setup(BASE, {
      [`POST /api/ops/agents/${ID}/versions/${versionId(2)}/publish`]: () => {
        published = true;
        return { version: { ...AGENT_DETAIL.versions[0], status: "live" } };
      },
    });
    const bar = await screen.findByTestId("agent-bar");
    expect(within(bar).getByRole("heading", { name: "Material costs" })).toBeInTheDocument();
    expect(within(bar).getByTestId("agent-version-badges")).toHaveTextContent("Live · v1");
    expect(within(bar).getByTestId("agent-version-badges")).toHaveTextContent("Draft · v2");
    expect(within(bar).getByTestId("agent-bar-status")).toHaveTextContent("Running");
    expect(within(bar).getByTestId("agent-bar-line")).toHaveTextContent("Harbor Millwork");
    expect(
      within(within(bar).getByRole("navigation"))
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Overview", "Workflow", "Triggers", "Runs", "Versions2", "Tests", "Settings"]);
    expect(within(bar).getByTestId("agent-test-run")).toHaveAttribute("href", `${BASE}/tests`);

    await user.click(within(bar).getByTestId("agent-publish"));
    expect(await screen.findByTestId("agent-publish-done")).toHaveTextContent("v2 is live.");
    expect(published).toBe(true);
    expect(api.calls).toContain(`POST /api/ops/agents/${ID}/versions/${versionId(2)}/publish`);
  });

  it("sends the old People tab to Settings", async () => {
    setup(`${BASE}/people`);
    expect(await screen.findByTestId("agent-people")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`${BASE}/settings`);
  });

  it("lists a client agent's triggers", async () => {
    setup(`${BASE}/triggers`, {
      [`GET /api/ops/agents/${ID}/triggers`]: () => ({
        agentId: ID,
        versionId: versionId(1),
        live: true,
        commandName: "costs",
        address: null,
        triggers: [
          {
            workflow: "new-bill",
            workflowName: "New bill",
            enabled: true,
            triggerId: "t1",
            type: "event",
            first: true,
            summary: "When a bill is created",
            guards: {},
            lastFired: null,
          },
        ],
      }),
    });
    // The Triggers screen (O7) reads the latest version's triggers; last fired comes from the list.
    const row = await screen.findByTestId("trigger-row-t1");
    expect(row).toHaveTextContent("Event");
    expect(row).toHaveTextContent("When bill.created");
    expect(row).toHaveTextContent("New bill");
    expect(row).toHaveTextContent("Never");
    expect(row).toHaveTextContent("On");
  });

  it("runs a client agent's template cases on the template's live version, and shows each result", async () => {
    let ran: unknown = null;
    const agent = { ...AGENT_SUMMARY, templateId: TEMPLATE_ID };
    const { user } = setup(`${BASE}/tests`, {
      [`GET /api/ops/agents/${ID}`]: () => ({ ...AGENT_DETAIL, agent }),
      [`GET /api/ops/agents/${TEMPLATE_ID}`]: () => ({
        ...AGENT_DETAIL,
        agent: { ...TEMPLATE, id: TEMPLATE_ID },
      }),
      "GET /api/ops/tests": ({ url }) => {
        expect(url.searchParams.get("target")).toBe(`template:${TEMPLATE_ID}`);
        expect(url.searchParams.get("client")).toBe(CLIENT);
        return { cases: [CASE], runs: [SUITE], requireTests: null };
      },
      "POST /api/ops/tests/run": ({ init }) => {
        ran = JSON.parse(String(init.body));
        return { suiteRun: SUITE };
      },
      [`GET /api/ops/tests/runs/${SUITE_ID}`]: () => ({
        suiteRun: SUITE,
        results: [
          {
            id: "00000000-0000-4000-8000-00000000d201",
            testCaseId: CASE_ID,
            name: "Hafele invoice",
            required: true,
            status: "fail",
            got: { find: { found: false } },
            diff: { "find.found": { expected: true, got: false } },
            costUsd: "0.11",
            runId: null,
            createdAt: "2026-11-05T10:01:00.000Z",
          },
        ],
      }),
      "GET /api/ops/runs": () => ({ runs: [], agents: [] }),
    });
    const summary = await screen.findByTestId("agent-tests-summary");
    expect(summary).toHaveTextContent("3 of 4 pass");
    expect(summary).toHaveTextContent("97.1%");
    expect(summary).toHaveTextContent("$0.11");
    expect(screen.getByTestId(`agent-test-case-${CASE_ID}`)).toHaveTextContent("Hafele invoice");
    expect(screen.getByTestId("agent-test-runs")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Run v1" }));
    expect(ran).toEqual({
      targetKind: "template",
      targetId: TEMPLATE_ID,
      versionId: versionId(1),
      clientId: CLIENT,
    });
    expect(await screen.findByTestId(`agent-test-result-${CASE_ID}-status`)).toHaveTextContent(
      "Fail",
    );
  });

  it("adds a shared case to a template, checking it first", async () => {
    let created: unknown = null;
    const { user } = setup(
      "/ops/templates/material-costs/tests",
      {
        [`GET /api/ops/agents/${ID}`]: () => ({ ...AGENT_DETAIL, agent: TEMPLATE }),
        "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: null }),
        "POST /api/ops/tests": ({ init }) => {
          created = JSON.parse(String(init.body));
          return { case: { ...CASE, targetId: ID } };
        },
      },
      "/ops/templates/material-costs",
    );
    expect(await screen.findByTestId("agent-tests-summary")).toHaveTextContent(
      "No test cases yet.",
    );
    expect(screen.getByTestId("agent-tests-run")).toBeDisabled();
    expect(screen.queryByTestId("agent-test-runs")).toBeNull();

    await user.click(screen.getByTestId("agent-test-case-add"));
    await user.type(screen.getByTestId("agent-test-case-name-input"), "Hafele invoice");
    await user.click(screen.getByTestId("agent-test-case-save"));
    expect(screen.getByTestId("agent-test-case-problems")).toHaveTextContent(
      "A template case expects the outputs of one or more steps",
    );
    expect(created).toBeNull();

    await user.click(screen.getByTestId("agent-test-case-expected-input"));
    await user.paste('{"find": {"found": true}}');
    await user.click(screen.getByTestId("agent-test-case-save"));
    await screen.findByTestId("agent-test-case-add");
    expect(created).toEqual({
      targetKind: "template",
      targetId: ID,
      name: "Hafele invoice",
      input: { workflow: "new-bill", payload: {} },
      expected: { find: { found: true } },
      required: true,
    });
  });
});
