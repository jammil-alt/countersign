// Hand off (owner, 2026-11-11; docs/plan.md §1.96) in the builder, on a fake API: the palette
// offers "Hand off to another agent" at the bottom; the inspector picks one of the client's other
// agents, then a step of its live version (numbered and named), then maps that step's input from
// this run; the canvas row says where the work goes.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  type processes,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b401";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const V1 = "00000000-0000-4000-8000-0000000f0401";
const BASE = `/ops/clients/${CLIENT_ID}/agents/ap-clerk`;

const io = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

const CATALOG = {
  skills: [],
  tools: [],
  connectors: [],
  stepTools: [],
  automations: [],
} as unknown as BuilderCatalog;

/** The client's agents as the server lists them: this one, and Price checker. */
const AGENTS: processes.HandoffAgent[] = [
  { slug: "ap-clerk", name: "AP bill clerk", workflow: "main", steps: [] },
  {
    slug: "price-checker",
    name: "Price checker",
    workflow: "main",
    steps: [
      { id: "pull", name: "Pull bills", kind: "read", reads: [], ids: ["pull"] },
      {
        id: "itemize",
        name: "Itemize the invoice",
        kind: "skill",
        input: io({ documentId: { type: "string" } }, ["documentId"]),
        reads: [],
        ids: ["itemize"],
      },
      { id: "check", name: "Check prices", kind: "skill", reads: ["itemize"], ids: ["check"] },
      { id: "done", name: "Stop", kind: "stop", reads: [], ids: ["done"] },
    ],
  },
];

const BUNDLE: AnyAgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "AP bill clerk", role: "Bills", mission: "Enter bills" },
    kind: "functional",
    model: { id: "test-model" },
    instructions: "Enter bills.",
    skills: [],
    extraTools: [],
    permissions: { mode: "act" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [
          { id: "t1", on: { type: "manual", input: io({ documentId: { type: "string" } }) } },
        ],
        steps: [
          {
            id: "tell",
            kind: "notify",
            name: "Tell",
            notify: { to: ["client_admin"], channel: "inbox", message: "Started" },
          },
        ],
      },
    },
  ],
};

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: CLIENT_ID,
  kind: "client",
  slug: "ap-clerk",
  name: "AP bill clerk",
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
  createdAt: "2026-11-11T00:00:00.000Z",
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
    createdAt: "2026-11-11T00:00:00.000Z",
    publishedAt: null,
    bundle: AnyAgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup(agent: AgentSummary = AGENT, input: AnyAgentBundleInput = BUNDLE) {
  const sent: Record<string, unknown>[] = [];
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    [`GET /api/ops/clients/${CLIENT_ID}/handoff-agents`]: () => ({ agents: AGENTS }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return { version: { ...version(), bundle: undefined }, errors: [] };
    },
  });
  const bundle = AnyAgentBundle.parse(input);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={agent}
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
      <MemoryRouter initialEntries={[`${BASE}/workflows/main`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { sent, user: userEvent.setup() };
}

describe("the hand-off step in the builder", () => {
  it("picks another agent and its step, maps the step's input, and reads as where it goes", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("flow-chart");
    const item = await screen.findByTestId("flow-rail-item-handoff");
    expect(item).toHaveTextContent("Hand off to another agent");
    await user.click(screen.getByTestId("flow-rail-item-handoff"));

    // The agent picker lists the client's other agents, never this one.
    const agentPicker = screen.getByTestId("builder-handoff-agent");
    const agentOptions = within(agentPicker)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(agentOptions).toEqual(["Choose an agent…", "This agent", "Price checker"]);
    await user.selectOptions(agentPicker, "price-checker");

    // The step picker numbers and names the live version's steps; a stop can't take an input.
    const stepPicker = screen.getByTestId("builder-handoff-step");
    const stepOptions = within(stepPicker).getAllByRole("option");
    expect(stepOptions.map((o) => o.textContent)).toEqual([
      "Choose a step…",
      "1 · Pull bills",
      "2 · Itemize the invoice",
      "3 · Check prices",
      "4 · Stop",
    ]);
    expect((stepOptions[4] as HTMLOptionElement).disabled).toBe(true);
    await user.selectOptions(stepPicker, "itemize");

    // Its input is the target step's: documentId, mapped from this run.
    const field = await screen.findByTestId("builder-input-documentId");
    await user.type(field, "{{{{trigger.documentId}}");

    // Its box on the chart says where the work goes.
    const row = screen
      .getAllByTestId(/^flow-box-/)
      .find((el) => el.textContent?.includes("Hand off to Price checker"));
    expect(row).toHaveTextContent("Hand off to Price checker at 2 · Itemize the invoice");

    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const saved = AnyAgentBundle.parse(sent.at(-1)?.bundle).workflows[0]?.workflow;
    if (saved?.schemaVersion !== 4) throw new Error("not a process");
    expect(saved.steps.at(-1)).toMatchObject({
      kind: "handoff",
      name: "Hand off to Price checker at 2 · Itemize the invoice",
      to: { agent: "price-checker", step: "itemize" },
      input: { documentId: "{{trigger.documentId}}" },
    });
  });
});

// Ways in, ways out (owner, 2026-11-23): "This agent" hands off to another of its own workflows,
// in a template too (no client): the scan's fork out into "Check an invoice" at its step 1.
describe("a hand-off to this agent's own workflow in the builder", () => {
  const TEMPLATE: AgentSummary = { ...AGENT, kind: "template", tenantId: null, slug: "invoices" };
  const TWO: AnyAgentBundleInput = {
    ...BUNDLE,
    workflows: [
      ...BUNDLE.workflows,
      {
        slug: "check",
        name: "Check an invoice",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t2", on: { type: "manual", input: io({}) } }],
          steps: [
            {
              id: "chk-read",
              kind: "skill",
              name: "Read the invoice",
              skill: "custom:read",
              input: {},
            },
            { id: "chk-stop", kind: "stop", name: "Stop", status: "succeeded" },
          ],
        },
      },
      {
        slug: "old",
        name: "Old scan",
        enabled: false,
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t3", on: { type: "manual", input: io({}) } }],
          steps: [{ id: "old-stop", kind: "stop", name: "Stop", status: "succeeded" }],
        },
      },
    ],
  };

  it("offers This agent, then the other workflows, then their steps, and names the step", async () => {
    const { sent, user } = setup(TEMPLATE, TWO);
    await screen.findByTestId("flow-chart");
    const item = await screen.findByTestId("flow-rail-item-handoff");
    // On the main workflow (the first enabled one), the hand-off starts one of its outputs.
    expect(item).toHaveTextContent("Hand off to an output");
    await user.click(item);

    const agentPicker = screen.getByTestId("builder-handoff-agent");
    expect(
      within(agentPicker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose an agent…", "This agent"]);
    await user.selectOptions(agentPicker, "@self");

    // The other workflows only: never the one open; one turned off can't be picked.
    const workflowPicker = screen.getByTestId("builder-handoff-workflow");
    const workflowOptions = within(workflowPicker).getAllByRole("option");
    expect(workflowOptions.map((o) => o.textContent)).toEqual([
      "Choose a workflow…",
      "Check an invoice",
      "Old scan (turned off)",
    ]);
    expect((workflowOptions[2] as HTMLOptionElement).disabled).toBe(true);
    await user.selectOptions(workflowPicker, "check");

    const stepPicker = screen.getByTestId("builder-handoff-step");
    expect(
      within(stepPicker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a step…", "1 · Read the invoice", "2 · Stop"]);
    await user.selectOptions(stepPicker, "chk-read");

    const row = screen
      .getAllByTestId(/^flow-box-/)
      .find((el) => el.textContent?.includes("Hand off to Check an invoice"));
    expect(row).toHaveTextContent("Hand off to Check an invoice at 1 · Read the invoice");

    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const saved = AnyAgentBundle.parse(sent.at(-1)?.bundle).workflows[0]?.workflow;
    if (saved?.schemaVersion !== 4) throw new Error("not a process");
    expect(saved.steps.at(-1)).toMatchObject({
      kind: "handoff",
      name: "Hand off to Check an invoice at 1 · Read the invoice",
      to: { agent: "@self", step: "chk-read", workflow: "check" },
    });
  });
});
