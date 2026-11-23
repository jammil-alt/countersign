// The workflow builder as the one screen (docs/builder-plan.md §12, F6), on a fake API: a loop
// opens its own steps in the frame and an automation opens in its editor; a client's agent shows
// whose it is under the bar, its Customized and Added marks, and the way back to the template's
// step; Try it marks the chart with what each step did; and Turn on is the bar's action while the
// agent is new.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  type SkillDefinition,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { listOrder, rootOrder } from "../../test/chart";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder, { type WorkflowBuilderProps } from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000d301";
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000d302";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const SANDBOX_ID = "00000000-0000-4000-8000-00000000a0ff";
const V1 = "00000000-0000-4000-8000-0000000f0d01";
const TV3 = "00000000-0000-4000-8000-0000000f0d03";
const RUN = "00000000-0000-4000-8000-0000000d0d01";
const AUTOMATION = "00000000-0000-4000-8000-0000000a0d01";
const BASE = "/ops/templates/invoice-clerk";
const at = "2026-11-21T10:00:00.000Z";

const io = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

const skill = (id: string, name: string, input: object, output: object) =>
  ({
    schemaVersion: 1,
    id,
    name,
    description: name,
    category: "documents",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    tools: [],
    input,
    output,
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  }) as SkillDefinition;

const READ = skill(
  "docs.read",
  "Read document",
  io({}),
  io({ lines: { type: "array", items: { type: "object" } } }),
);
const NOTE = skill("docs.note", "Note it", io({}), io({}));

const POLITE = {
  ref: "polite@1",
  slug: "polite",
  version: 1,
  name: "Polite follow-up",
  description: "Say a word",
  source: "shared" as const,
  status: "live",
  definition: {
    schemaVersion: 1 as const,
    slug: "polite",
    name: "Polite follow-up",
    description: "Say a word",
    input: { type: "object", properties: {} },
    output: {},
    steps: [
      {
        id: "say",
        kind: "notify" as const,
        name: "Say it",
        channel: "thread" as const,
        message: "Hi",
      },
    ],
    requires: { skills: [], tools: [], connectors: [] },
  },
  outputSchema: { type: "object" },
};

const CATALOG: BuilderCatalog = {
  skills: [READ, NOTE].map((definition) => ({
    ref: definition.id,
    source: "builtin" as const,
    version: null,
    definition,
    kind: "ai" as const,
    palette: true,
  })),
  tools: [],
  connectors: [],
  stepTools: [],
  automations: [POLITE],
};

const read = { id: "read", kind: "skill", name: "Read document", skill: READ.id, input: {} };
const note = { id: "note", kind: "skill", name: "Note it", skill: NOTE.id, input: {} };
const each = {
  id: "each",
  kind: "for_each",
  name: "Each line",
  over: "{{steps.read.output.lines}}",
  concurrency: 1,
  steps: [{ id: "line", kind: "skill", name: "Note the line", skill: NOTE.id, input: {} }],
};
const follow = { id: "follow", kind: "process", name: "Follow up", process: "polite@1", input: {} };

function bundle(steps: unknown[]): AnyAgentBundle {
  return AnyAgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Invoice clerk", role: "Purchasing", mission: "Read invoices" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "Read invoices.",
      skills: [READ, NOTE].map((s) => ({ skill: s.id, settings: {} })),
      extraTools: [],
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t1", on: { type: "manual", input: io({}) } }],
          steps,
        },
      },
    ],
  } as AnyAgentBundleInput);
}

const TEMPLATE: AgentSummary = {
  id: AGENT_ID,
  tenantId: null,
  kind: "template",
  slug: "invoice-clerk",
  name: "Invoice clerk",
  role: "Purchasing",
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
  createdAt: at,
};

function version(steps: unknown[], over: Partial<VersionDetail> = {}): VersionDetail {
  return {
    id: V1,
    agentId: AGENT_ID,
    version: 1,
    status: "draft",
    bundleHash: "h1",
    changeNote: null,
    releaseNote: null,
    authorType: "operator",
    authorId: null,
    mergedFromVersionIds: null,
    parentVersionId: null,
    basedOnTemplateVersionId: null,
    createdAt: at,
    bundle: bundle(steps),
    ...over,
  } as VersionDetail;
}

function setup(
  steps: unknown[],
  over: Partial<WorkflowBuilderProps> = {},
  routes: Parameters<typeof fakeApi>[0] = {},
) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/clients": () => ({
      clients: [
        { id: CLIENT_ID, name: "Harbor Millwork", sandbox: false },
        { id: SANDBOX_ID, name: "Sandbox", sandbox: true },
      ].map((c) => ({ ...c, timezone: "UTC", createdAt: at, agents: 1, openInbox: 0 })),
    }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push({ path: "save", body: JSON.parse(String(init.body)) });
      return {
        version: { ...version(steps), id: V1, bundle: undefined },
        errors: [],
      };
    },
    ...routes,
  });
  const from = over.from ?? version(steps);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={TEMPLATE}
        from={from}
        bundle={from.bundle as AnyAgentBundle}
        workflow={workflow}
        base={BASE}
        tabs={<nav aria-label="Sections" />}
        connections={[]}
        members={[]}
        onChanged={() => {}}
        {...over}
      />
    );
  }
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter initialEntries={[`${BASE}/workflows/main`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
          <Route
            path="/ops/skills/automations/:id/steps"
            element={<p data-testid="automation-editor">The automation's steps</p>}
          />
          <Route path="*" element={<p data-testid="elsewhere">Another page</p>} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, sent, user: userEvent.setup() };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("a loop in the same view", () => {
  it("opens its own steps in the frame, with what it starts with and gives back, and a way back", async () => {
    const { user } = setup([read, each, note]);
    await screen.findByTestId("flow-chart");
    expect(rootOrder()).toEqual(["read", "each", "note"]);
    expect(screen.queryByTestId("flow-crumb")).toBeNull();

    await user.click(screen.getByTestId("flow-open-each"));
    // The breadcrumb says where this is; the frame holds the loop's steps only.
    expect(screen.getByTestId("flow-crumb-back")).toHaveTextContent("Main");
    expect(screen.getByTestId("flow-crumb-here")).toHaveTextContent("Each line");
    expect(rootOrder()).toEqual(["line"]);
    expect(screen.queryByTestId("flow-box-read")).toBeNull();
    // It starts with its list, in words, and ends with what later steps can use from it.
    expect(screen.getByTestId("flow-start")).toHaveTextContent(
      "For each item of Read document · lines",
    );
    expect(screen.getByTestId("flow-gives-back")).toHaveTextContent("How many items it ran for");
    expect(screen.getByTestId("flow-gives-back")).toHaveTextContent("Gives back");

    // A step picked in the rail goes into the loop, not the whole flow.
    await user.click(screen.getByTestId(`flow-rail-item-skill:${NOTE.id}`));
    expect(rootOrder()).toHaveLength(2);
    // Its start opens the loop's own settings.
    await user.click(screen.getByTestId("flow-start"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "each");

    // Back to the whole flow: the new step is inside the loop, the flow's own list as it was.
    await user.click(screen.getByTestId("flow-crumb-back"));
    expect(screen.queryByTestId("flow-crumb")).toBeNull();
    expect(rootOrder()).toEqual(["read", "each", "note"]);
    expect(listOrder("loop:each")).toHaveLength(2);
    expect(listOrder("loop:each")[0]).toBe("line");
  });
});

describe("an automation step", () => {
  const automations = {
    automations: [
      {
        id: AUTOMATION,
        slug: "polite",
        name: "Polite follow-up",
        description: "Say a word",
        source: "shared",
        clientId: null,
        clientName: null,
        status: "live",
        liveVersion: 1,
        latestVersion: 1,
        latestStatus: "live",
        inputs: [],
        outputs: [],
        requires: { skills: [], tools: [], connectors: [] },
        usedBy: 1,
        health: { uses: 0, clean: 0, cleanRunRate: null },
      },
    ],
  };

  it("opens its automation's steps in its editor, found by its slug", async () => {
    const { user, api } = setup(
      [read, follow],
      {},
      { "GET /api/ops/automations": () => automations },
    );
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-open-follow"));
    expect(await screen.findByTestId("automation-editor")).toBeInTheDocument();
    expect(api.calls.filter((c) => c === "GET /api/ops/automations")).toHaveLength(1);
  });
});

describe("a client's agent on the one screen", () => {
  const CLIENT_AGENT: AgentSummary = {
    ...TEMPLATE,
    kind: "client",
    tenantId: CLIENT_ID,
    slug: "invoice-clerk",
    templateId: TEMPLATE_ID,
    linked: true,
    liveVersionId: V1,
    stage: "live",
  };
  // The template at the version the agent is based on: "Read document" under another name, and
  // no "Note it".
  const templateVersion = {
    ...version([{ ...read, name: "Read the document" }, each]),
    id: TV3,
    agentId: TEMPLATE_ID,
    version: 3,
    status: "live",
  };
  const mine = version([read, each, note], { status: "live", basedOnTemplateVersionId: TV3 });
  const props: Partial<WorkflowBuilderProps> = {
    agent: CLIENT_AGENT,
    from: mine,
    detail: { agent: CLIENT_AGENT, versions: [], live: mine, latest: mine, update: null },
    templateDetail: {
      agent: { ...TEMPLATE, id: TEMPLATE_ID, name: "Clerk", liveVersionId: TV3 },
      versions: [{ ...templateVersion, bundle: undefined }],
    },
  } as unknown as Partial<WorkflowBuilderProps>;
  const routes: Parameters<typeof fakeApi>[0] = {
    [`GET /api/ops/agents/${TEMPLATE_ID}/versions/${TV3}`]: () => ({ version: templateVersion }),
    [`GET /api/ops/agents/${AGENT_ID}/customizations`]: () => ({
      changes: [{ kind: "changed", entity: "step:read", path: "step:read#/name" }],
      labels: {},
      base: null,
      version: null,
    }),
  };

  it("says whose it is under the bar, marks what it changed and added, and puts a step back", async () => {
    const { user } = setup([read, each, note], props, routes);
    await screen.findByTestId("flow-chart");
    // The line under the bar: its template and the version it is based on.
    const strip = await screen.findByTestId("flow-lineage");
    expect(within(strip).getByTestId("flow-lineage-from")).toHaveTextContent("Clerk");
    expect(within(strip).getByTestId("flow-lineage-from")).toHaveTextContent("v3");
    // Against that version: one step changed, one added, each marked on its box.
    expect(await screen.findByTestId("flow-customized-read")).toHaveTextContent("Customized");
    expect(screen.getByTestId("flow-customized-note")).toHaveTextContent("Added");
    expect(screen.queryByTestId("flow-customized-each")).toBeNull();
    expect(within(strip).getByTestId("flow-lineage-customized")).toHaveTextContent(
      "1 step changed, 1 added",
    );

    // The step's panel says how it differs, first, and offers the way back: an ordinary edit.
    await user.click(screen.getByTestId("flow-box-read"));
    const diff = screen.getByTestId("flow-step-diff");
    expect(diff).toHaveTextContent("Changed from the template");
    expect(screen.getByTestId("flow-panel-customized")).toHaveTextContent(
      "Changed for this client",
    );
    await user.click(within(diff).getByTestId("flow-step-diff-put-back"));
    expect(screen.queryByTestId("flow-customized-read")).toBeNull();
    expect(screen.getByTestId("flow-panel-name")).toHaveValue("Read the document");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    await user.click(screen.getByTestId("flow-bar-undo"));
    expect(screen.getByTestId("flow-customized-read")).toBeInTheDocument();
    // Live, with nothing new: Publish is the action, and there is nothing to publish.
    expect(screen.queryByTestId("flow-bar-turn-on")).toBeNull();
  });

  it("saves unsaved changes as a draft before a link under the bar leaves for the merge screen", async () => {
    const update = {
      available: true,
      behind: 1,
      baseVersionId: TV3,
      templateLiveVersionId: "00000000-0000-4000-8000-0000000f0d04",
      releaseNote: null,
    };
    const { user, sent } = setup(
      [read, each, note],
      { ...props, detail: { ...props.detail, update } } as Partial<WorkflowBuilderProps>,
      routes,
    );
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-note"));
    await user.type(screen.getByTestId("flow-panel-name"), "!");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    await user.click(await screen.findByTestId("flow-lineage-review-update"));
    expect(await screen.findByTestId("elsewhere")).toBeInTheDocument();
    expect(sent.map((s) => s.path)).toEqual(["save"]);
  });
});

describe("Try it on the chart", () => {
  const row = (id: string, nodeId: string, status: string, summary: string | null = null) => ({
    id,
    nodeId,
    nodeType: "skill",
    skillRef: null,
    status,
    input: null,
    output: null,
    summary,
    costUsd: "0",
    tokensIn: 0,
    tokensOut: 0,
    startedAt: at,
    finishedAt: at,
  });
  const run = {
    run: {
      id: RUN,
      tenantId: SANDBOX_ID,
      agentId: AGENT_ID,
      agentVersionId: V1,
      workflowSlug: "main",
      mode: "test",
      status: "succeeded",
      trigger: {},
      costUsd: "0",
      error: null,
      startedAt: at,
      finishedAt: at,
      createdAt: at,
    },
    steps: [row("00000000-0000-4000-8000-000000002001", "read", "succeeded", "Read 3 lines")],
    toolCalls: [],
    actions: [],
    inbox: [],
    agent: null,
    version: 1,
    workflow: null,
  };

  it("runs the saved draft once and marks each step with what it did", async () => {
    const { user, sent } = setup(
      [read, note],
      {},
      {
        [`POST /api/ops/agents/${AGENT_ID}/versions/${V1}/test-run`]: ({ init }) => {
          sent.push({ path: "test-run", body: JSON.parse(String(init.body)) });
          return { runId: RUN, agentId: AGENT_ID, versionId: V1 };
        },
        [`GET /api/ops/runs/${RUN}`]: () => run,
      },
    );
    await screen.findByTestId("flow-chart");
    expect(screen.queryByTestId("flow-try")).toBeNull();
    await user.click(screen.getByTestId("flow-bar-try"));
    // The try's panel opens in the side column, beside the chart; the chart stays.
    const bar = within(screen.getByTestId("builder-side")).getByTestId("flow-try");
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "try");
    expect(screen.getByTestId("flow-chart")).toBeInTheDocument();
    // A manual start's sample is already there as the input.
    expect(within(bar).getByTestId("flow-try-input")).toHaveValue("{}");
    await user.click(within(bar).getByTestId("flow-try-input-start"));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual(["test-run"]));
    expect(sent[0]?.body).toMatchObject({ workflow: "main", payload: {} });
    // What the run did, read back onto the boxes: the step it reached, and the one it never did.
    expect(await screen.findByTestId("flow-tried-read")).toHaveTextContent("Did");
    expect(screen.queryByTestId("flow-tried-note")).toBeNull();
    expect(screen.getByTestId("flow-box-note")).toHaveClass("is-off");
    // A step opened meanwhile covers the try; closed, the try is back as it was left.
    await user.click(screen.getByTestId("flow-box-read"));
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "step");
    expect(screen.getByTestId("builder-try")).toHaveClass("hidden");
    expect(screen.getByTestId("flow-tried-read")).toHaveTextContent("Did");
    await user.click(screen.getByTestId("flow-bar-try"));
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "try");
    expect(screen.getByTestId("flow-try")).toHaveTextContent("Tried it on");
    expect(screen.getByTestId("flow-tried-read")).toHaveTextContent("Did");
    // Closing it takes the panel and the marks away.
    await user.click(screen.getByTestId("flow-try-done"));
    expect(screen.queryByTestId("flow-try")).toBeNull();
    expect(screen.queryByTestId("flow-tried-read")).toBeNull();
    expect(screen.getByTestId("builder-side")).not.toHaveAttribute("data-side");
  });
});

describe("Turn on", () => {
  const preview = {
    agentId: null,
    clientId: CLIENT_ID,
    clientName: "Harbor Millwork",
    versionId: V1,
    version: 1,
    started: false,
    stage: "bench",
    items: [
      {
        key: "tried",
        kind: "tried",
        title: "Not tried yet",
        owner: "operator",
        holds: true,
      },
    ],
  };

  it("is the bar's action while the agent is new, and opens the sheet on the saved version", async () => {
    const asked: string[] = [];
    const { user } = setup(
      [read, note],
      {},
      {
        [`GET /api/ops/agents/${AGENT_ID}/turn-on`]: ({ url }) => {
          asked.push(url.searchParams.get("client") ?? "");
          return preview;
        },
        [`POST /api/ops/agents/${AGENT_ID}/versions/${V1}/test-run`]: () => ({
          runId: RUN,
          agentId: AGENT_ID,
          versionId: V1,
        }),
      },
    );
    await screen.findByTestId("flow-chart");
    // A template never published: Turn on, not Publish.
    expect(screen.queryByTestId("builder-publish")).toBeNull();
    await user.click(screen.getByTestId("flow-bar-turn-on"));
    const sheet = await screen.findByTestId("flow-turn-on");
    // A template is turned on for a client the operator picks (never the Sandbox).
    const picker = within(sheet).getByTestId("flow-turn-on-client");
    await within(picker).findByText("Harbor Millwork");
    expect(within(picker).queryByText("Sandbox")).toBeNull();
    await user.selectOptions(picker, CLIENT_ID);
    expect(await within(sheet).findByTestId("flow-turn-on-item-tried")).toHaveTextContent(
      "Not tried yet",
    );
    expect(asked).toEqual([CLIENT_ID]);
    expect(within(sheet).getByTestId("flow-turn-on-start")).toBeDisabled();
    // Its Try it closes the sheet and starts the try on the chart, at that client.
    await user.click(within(sheet).getByTestId("flow-turn-on-try"));
    expect(screen.queryByTestId("flow-turn-on")).toBeNull();
    expect(screen.getByTestId("flow-try")).toBeInTheDocument();
  });

  it("is Publish once the agent is live or in its trial", async () => {
    setup([read, note], { agent: { ...TEMPLATE, liveVersionId: V1 } });
    await screen.findByTestId("flow-chart");
    expect(screen.queryByTestId("flow-bar-turn-on")).toBeNull();
    expect(screen.getByTestId("builder-publish")).toBeInTheDocument();
  });
});
