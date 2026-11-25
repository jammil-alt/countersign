// v0.18 (owner, 2026-11-15; docs/plan.md §1.103) in the builder, on a fake API: a missing step is a
// signal card with the word "Missing"; "What's left" lists it with what the client lacks (a pack
// that's off) and a test run, and a click selects the step; its inspector says what is missing and
// replaces it from the palette (keeping its id) or removes it, and the list empties as the draft is
// finished. Each step says what it reads and saves; the agent's data is summed up beside the list.
import { AgentBundle, type AgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b501";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const V1 = "00000000-0000-4000-8000-0000000f0501";
const BASE = `/ops/clients/${CLIENT_ID}/agents/card-clerk`;

const io = (props: Record<string, unknown> = {}) => ({ type: "object", properties: props });

const CATALOG = {
  skills: [],
  tools: [
    {
      id: "materials.vendor.match",
      description: "Finds the vendor a name means.",
      input: io({ name: { type: "string" } }),
      output: io({ vendorId: { type: "string" } }),
      sideEffect: "none",
      verb: "read",
      source: "materials",
      area: "shared",
      entity: "vendor",
    },
  ],
  connectors: [{ id: "qbo", name: "QuickBooks Online", icon: null }],
  stepTools: ["materials.vendor.match"],
  automations: [],
} as unknown as BuilderCatalog;

const BUNDLE: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Card clerk", role: "Expenses", mission: "Card receipts" },
    kind: "functional",
    model: { id: "test-model" },
    instructions: "Check card charges.",
    skills: [],
    extraTools: ["materials.vendor.match"],
    permissions: { mode: "suggest_only" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t1", on: { type: "manual", input: io({ name: { type: "string" } }) } }],
        steps: [
          {
            id: "m1",
            kind: "missing",
            name: "Read card charges",
            need: "There is no card feed connector, so it can't read card charges.",
            fill: "connector",
          },
          {
            id: "r1",
            kind: "read",
            name: "Find the vendor",
            tool: "materials.vendor.match",
            input: { name: "{{trigger.name}}" },
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
  slug: "card-clerk",
  name: "Card clerk",
  role: "Expenses",
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
  createdAt: "2026-11-15T00:00:00.000Z",
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
    createdAt: "2026-11-15T00:00:00.000Z",
    publishedAt: null,
    bundle: AgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup() {
  const sent: Record<string, unknown>[] = [];
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    [`GET /api/ops/clients/${CLIENT_ID}/handoff-agents`]: () => ({ agents: [] }),
    [`GET /api/ops/clients/${CLIENT_ID}/packs`]: () => ({
      packs: [
        {
          id: "materials",
          name: "Materials",
          description: "",
          enabled: false,
          enabledAt: null,
          screens: [],
        },
      ],
    }),
    "GET /api/ops/runs": () => ({ runs: [], agents: [] }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({
      clients: [
        {
          id: CLIENT_ID,
          name: "Millwork",
          timezone: "UTC",
          createdAt: "2026-11-01T00:00:00.000Z",
          agents: 1,
          openInbox: 0,
          sandbox: false,
        },
      ],
    }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return { version: { ...version(), id: V1, bundle: undefined }, errors: [] };
    },
  });
  const bundle = AgentBundle.parse(BUNDLE);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={AGENT}
        from={version()}
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

describe("a missing step in the builder", () => {
  it("shows the hole, lists what's left, and empties the list as it is filled", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("flow-chart");

    // The chart: the missing step in its place, flagged in words (never colour alone), and
    // counted on the bar with what else is left to settle.
    expect(screen.getByTestId("flow-box-m1")).toHaveTextContent("Missing");
    expect(screen.getByTestId("flow-flag-m1")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-bar-issues")).toHaveTextContent("1 issue");

    // What's left: the missing step, the pack that's off, a test run; not "Valid".
    const left = screen.getByTestId("builder-whats-left");
    expect(left).toHaveTextContent("What's left");
    expect(screen.getByTestId("builder-left-missing-m1")).toHaveTextContent(
      "Read card charges: There is no card feed connector, so it can't read card charges.",
    );
    expect(await screen.findByTestId("builder-left-pack-r1")).toHaveTextContent(
      "Turn on the Materials pack for Millwork: 1 step needs it",
    );
    expect(await screen.findByTestId("builder-left-test")).toHaveTextContent("Test-run it");
    expect(screen.queryByTestId("builder-valid")).toBeNull();
    expect(screen.queryByTestId("builder-problems")).toBeNull();
    // A new agent's action is Turn on (F4), held like Publish until the draft is valid.
    expect(screen.getByTestId("flow-bar-turn-on")).toBeDisabled();

    // The agent's data at a glance.
    expect(screen.getByTestId("builder-data-summary-reads")).toHaveTextContent("vendors");
    expect(screen.getByTestId("builder-data-summary-saves")).toHaveTextContent("Nothing");

    // A click on the item selects the step: the inspector says what is missing.
    await user.click(screen.getByTestId("builder-left-missing-m1"));
    const inspector = screen.getByTestId("builder-inspector");
    expect(within(inspector).getByTestId("builder-missing-need")).toHaveTextContent(
      "There is no card feed connector",
    );
    expect(screen.getByTestId("flow-panel-settle")).toHaveTextContent(
      "Nothing in the library does this yet",
    );

    // Renamed, a draft with a missing step is saved as it is.
    await user.type(screen.getByTestId("flow-panel-name"), " daily");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const saved = AgentBundle.parse(sent.at(-1)?.bundle).workflows[0]?.workflow;
    expect(saved?.schemaVersion === 4 && saved.steps[0]).toMatchObject({
      kind: "missing",
      name: "Read card charges daily",
    });
    expect(within(inspector).getByTestId("builder-missing-connections")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT_ID}/connections`,
    );

    // Replace it with a step from the palette: it takes the missing step's place and id.
    await user.click(within(inspector).getByTestId("builder-missing-replace"));
    await user.click(await screen.findByTestId("flow-rail-item-logic:wait"));
    expect(screen.queryByTestId("flow-flag-m1")).toBeNull();
    expect(screen.getByTestId("flow-box-m1")).toHaveTextContent("Wait");
    expect(screen.queryByTestId("builder-left-missing")).toBeNull();
  });

  it("removes it, and says what each step reads and keeps", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-m1"));
    expect(screen.getByTestId("flow-panel-remove")).toHaveTextContent("Remove it");
    await user.click(screen.getByTestId("flow-panel-remove"));
    expect(screen.queryByTestId("flow-box-m1")).toBeNull();
    expect(screen.queryByTestId("builder-left-missing")).toBeNull();

    // The read step: what it reads and where that comes from, that it keeps nothing, and the
    // pack the client hasn't turned on.
    await user.click(screen.getByTestId("flow-box-r1"));
    const data = await screen.findByTestId("builder-data");
    const lines = within(data)
      .getAllByTestId("builder-data-line")
      .map((l) => l.textContent);
    expect(lines).toEqual([
      "Reads vendors (filled by QuickBooks, uploads, invoices or the directory)",
      "Saves nothing; kept in this run only",
    ]);
    await waitFor(() =>
      expect(within(data).getByTestId("builder-data-warning")).toHaveTextContent(
        "The Materials pack is off for Millwork",
      ),
    );
    // What the client lacks for it is a question on the step, in the client's words.
    expect(screen.getByTestId("flow-flag-r1")).toHaveTextContent("1 question");
    expect(screen.getByTestId("flow-panel-settle")).toHaveTextContent(
      "Turn on the Materials pack for Millwork",
    );
  });
});
