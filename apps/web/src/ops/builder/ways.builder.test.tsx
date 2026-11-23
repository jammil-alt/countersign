// Triggers and outputs in the builder (owner, 2026-11-23; the mock-up "Ways in, ways out"), on a
// fake API: a template whose main workflow is fed by a nightly scan (a trigger) and hands its
// result to a bill workflow (an output). The tabs say which is which; the main workflow's chart
// has its triggers above and its outputs below, each opening its tab; a trigger's and an output's
// tab lead back to the main workflow; and the rail places a hand-in already pointed at it.
import { AnyAgentBundle, type AnyAgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b501";
const V1 = "00000000-0000-4000-8000-0000000f0501";
const BASE = "/ops/agents/invoice-intake";

const CATALOG = {
  skills: [],
  tools: [
    {
      id: "qbo.bill.query",
      source: "qbo",
      connector: "qbo",
      sideEffect: "none",
      verb: "read",
      description: "Find bills",
      input: { type: "object" },
      output: { type: "object" },
    },
  ],
  connectors: [{ id: "qbo", name: "QuickBooks Online", icon: null }],
  stepTools: [],
  automations: [],
} as unknown as BuilderCatalog;

const trigger = (id: string) => ({
  id,
  on: { type: "manual" as const, input: { type: "object", properties: {} } },
});

const BUNDLE: AnyAgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Invoice intake", role: "Bills", mission: "Check invoices" },
    kind: "functional",
    model: { id: "test-model" },
    instructions: "Check invoices.",
    skills: [],
    extraTools: [],
    permissions: { mode: "suggest_only" },
  },
  workflows: [
    {
      slug: "check",
      name: "Check an invoice",
      workflow: {
        schemaVersion: 4,
        triggers: [trigger("t-check")],
        steps: [
          { id: "save", kind: "read", name: "Save the reading", tool: "qbo.bill.query", input: {} },
          {
            id: "to-bill",
            kind: "handoff",
            name: "Hand off to Bill in QuickBooks at 1 · Lay out the bill",
            to: { agent: "@self", workflow: "bill", step: "lay" },
            input: {},
          },
        ],
      },
    },
    {
      slug: "scan",
      name: "Pull in QuickBooks bills each night",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t-scan", on: { type: "schedule", cron: "0 2 * * *" } }],
        steps: [
          { id: "find", kind: "read", name: "Find the bills", tool: "qbo.bill.query", input: {} },
          {
            id: "in",
            kind: "handoff",
            name: "Hand off to Check an invoice at 1 · Save the reading",
            to: { agent: "@self", workflow: "check", step: "save" },
            input: {},
          },
        ],
      },
    },
    {
      slug: "bill",
      name: "Bill in QuickBooks",
      workflow: {
        schemaVersion: 4,
        triggers: [trigger("t-bill")],
        steps: [
          { id: "lay", kind: "read", name: "Lay out the bill", tool: "qbo.bill.query", input: {} },
        ],
      },
    },
    {
      slug: "loose",
      name: "Something else",
      workflow: {
        schemaVersion: 4,
        triggers: [trigger("t-loose")],
        steps: [
          {
            id: "note",
            kind: "notify",
            name: "Tell",
            notify: { to: ["client_admin"], channel: "inbox", message: "Hi" },
          },
        ],
      },
    },
  ],
};

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: null,
  kind: "template",
  slug: "invoice-intake",
  name: "Invoice intake",
  role: "Bills",
  templateId: null,
  linked: false,
  liveVersionId: null,
  status: "active",
  runStatus: "active",
  serviceName: null,
  serviceDescription: null,
  bindings: {},
  approver: null,
  testCopy: false,
  createdAt: "2026-11-23T00:00:00.000Z",
};

function version(): VersionDetail {
  return {
    id: V1,
    version: 1,
    status: "draft",
    bundleHash: "h1",
    changeNote: null,
    releaseNote: null,
    authorId: null,
    parentVersionId: null,
    basedOnTemplateVersionId: null,
    createdAt: "2026-11-23T00:00:00.000Z",
    publishedAt: null,
    bundle: AnyAgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup(start = "check") {
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
  });
  const bundle = AnyAgentBundle.parse(BUNDLE);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={AGENT}
        from={{ ...version(), bundle } as VersionDetail}
        bundle={bundle}
        workflow={workflow}
        base={BASE}
        tabs={<nav aria-label="Sections" />}
        connections={[]}
        members={[]}
        onChanged={() => {}}
      />
    );
  }
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter initialEntries={[`${BASE}/workflows/${start}`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { user: userEvent.setup() };
}

describe("triggers and outputs in the builder", () => {
  it("marks the tabs, and shows the main workflow's triggers above and outputs below", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    // The tabs: the main workflow has no chip; the trigger and the output say what they are.
    expect(
      within(screen.getByTestId("builder-workflow-check-select")).queryByTestId(/role-chip/),
    ).toBeNull();
    expect(screen.getByTestId("builder-workflow-scan-select")).toHaveTextContent(
      "Pull in QuickBooks bills each nightTrigger",
    );
    expect(screen.getByTestId("builder-workflow-bill-select")).toHaveTextContent(
      "Bill in QuickBooksOutput",
    );
    expect(
      within(screen.getByTestId("builder-workflow-loose-select")).queryByTestId(/role-chip/),
    ).toBeNull();

    // Above the chart, the trigger: what starts it, its steps and the systems it reaches.
    const scan = within(screen.getByTestId("ways-triggers")).getByTestId("way-card-scan");
    expect(scan).toHaveTextContent("Pull in QuickBooks bills each night");
    expect(scan).toHaveTextContent("2 steps");
    expect(scan).toHaveTextContent("QuickBooks Online");
    expect(scan).toHaveAttribute("href", `${BASE}/workflows/scan`);
    // Below it, the output.
    const bill = within(screen.getByTestId("ways-outputs")).getByTestId("way-card-bill");
    expect(bill).toHaveTextContent("Bill in QuickBooks");
    expect(bill).toHaveAttribute("href", `${BASE}/workflows/bill`);
    // A workflow that is neither gets no card.
    expect(screen.queryByTestId("way-card-loose")).toBeNull();

    // Opening the trigger is opening its tab.
    await user.click(scan);
    const back = await screen.findByTestId("ways-back");
    expect(back).toHaveTextContent("TriggerHands work into Check an invoice ›");
    expect(back).toHaveTextContent("Uses QuickBooks Online");
    expect(screen.getByTestId("ways-back-link")).toHaveAttribute("href", `${BASE}/workflows/check`);
    expect(screen.queryByTestId("ways-triggers")).toBeNull();
  });

  it("starts an output from the main workflow, and offers a hand-in on any other workflow", async () => {
    const { user } = setup("bill");
    await screen.findByTestId("flow-chart");
    expect(screen.getByTestId("ways-back")).toHaveTextContent(
      "OutputTakes work from Check an invoice ›",
    );
    expect(screen.getByTestId("flow-start")).toHaveTextContent("Handed out by Check an invoice");
    expect(screen.getByTestId("flow-start")).toHaveTextContent("Starts from");

    // On a workflow that isn't the main one, the rail places a hand-in already pointed at it.
    await user.click(screen.getByTestId("builder-workflow-loose-select"));
    const handIn = await screen.findByTestId("flow-rail-item-handoff:in");
    expect(handIn).toHaveTextContent("Hand in to Check an invoice");
    await user.click(handIn);
    const named = await screen.findAllByText(
      "Hand off to Check an invoice at 1 · Save the reading",
    );
    expect(named.length).toBeGreaterThan(0);
  });

  it("calls the main workflow's open hand-off a hand-off to an output", async () => {
    setup();
    await screen.findByTestId("flow-chart");
    expect(await screen.findByTestId("flow-rail-item-handoff")).toHaveTextContent(
      "Hand off to an output",
    );
    expect(screen.queryByTestId("flow-rail-item-handoff:in")).toBeNull();
  });
});
