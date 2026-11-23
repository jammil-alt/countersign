// Ways in, ways out (owner, 2026-11-23) in the builder, on a fake API: a second workflow that
// repeats the main workflow's steps is advice on its chart ("Worth a look"), with its own line.
import { AnyAgentBundle, type AnyAgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { render, screen } from "@testing-library/react";
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

const BUNDLE: AnyAgentBundleInput = {
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
            kind: "read",
            name: "Find the vendor",
            tool: "materials.vendor.match",
            input: { name: "{{trigger.name}}" },
          },
          {
            id: "m2",
            kind: "read",
            name: "Find it again",
            tool: "materials.vendor.match",
            input: { name: "{{trigger.name}}" },
          },
          {
            id: "m3",
            kind: "notify",
            name: "Tell the team",
            notify: { to: ["client_admin"], channel: "inbox", message: "Done" },
          },
        ],
      },
    },
    {
      slug: "scan",
      name: "Scan",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t2", on: { type: "manual", input: io({ name: { type: "string" } }) } }],
        steps: [
          {
            id: "s1",
            kind: "read",
            name: "Find the vendor",
            tool: "materials.vendor.match",
            input: { name: "{{trigger.name}}" },
          },
          {
            id: "s2",
            kind: "read",
            name: "Find it again",
            tool: "materials.vendor.match",
            input: { name: "{{trigger.name}}" },
          },
          {
            id: "s3",
            kind: "notify",
            name: "Tell the team",
            notify: { to: ["client_admin"], channel: "inbox", message: "Done" },
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
    bundle: AnyAgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup(at: string) {
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
  const bundle = AnyAgentBundle.parse(BUNDLE);
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
      <MemoryRouter initialEntries={[`${BASE}/workflows/${at}`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { sent, user: userEvent.setup() };
}

describe("copied steps in the builder", () => {
  it("says, on the workflow that repeats them, to keep them in one place and hand off", async () => {
    setup("scan");
    await screen.findByTestId("flow-chart");
    expect(await screen.findByTestId("builder-advice-copy")).toHaveTextContent(
      '"scan" repeats 3 steps of "main", from "Find the vendor" on: keep them in "main" alone and end "scan" by handing off into "main" with "@self", one hand-off per item.',
    );
  });

  it("says nothing of it on the main workflow", async () => {
    setup("main");
    await screen.findByTestId("flow-chart");
    expect(screen.queryByTestId("builder-advice-copy")).toBeNull();
  });
});
