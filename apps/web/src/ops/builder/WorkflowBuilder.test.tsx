// The workflow builder on a fake API, on its one-screen view (docs/builder-plan.md §12, F6): adding
// from the rail, reordering and moving into and out of a decision's paths with the keyboard
// (dnd-kit's keyboard sensor, on the chart's boxes), removing and undoing, the Approval control's
// enabled and disabled rules, issues on their steps with a clickable summary, and the bundle it
// saves keeping every step, path and id. R8: the fixture is a stored v3 version; the builder
// opens it as a v4 process and saves processes (schemaVersion 4) as a new version.
import {
  AgentBundle,
  type AgentBundleInput,
  AnyAgentBundle,
  type BuilderCatalog,
  canonicalJson,
  nodeIds,
  type PermissionMatrix,
  processes,
  type SessionResponse,
} from "@countersign/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { BUILDER_DRAFT_PREFIX, builderDraftKey } from "../../session/drafts";
import { SessionProvider, useOptionalSession } from "../../session/session";
import { fakeChartRects, keyboardDrag, listOrder, rootOrder } from "../../test/chart";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { typingContext } from "./catalog";
import { readProcessBundle } from "./model";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b101";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const CONNECTION_ID = "00000000-0000-4000-8000-00000000c101";
const V1 = "00000000-0000-4000-8000-0000000f0001";
const V2 = "00000000-0000-4000-8000-0000000f0002";
const RUN_ID = "00000000-0000-4000-8000-0000000d0001";
const BASE = `/ops/clients/${CLIENT_ID}/agents/material-costs`;

const CATALOG: BuilderCatalog = {
  skills: [
    {
      ref: "docs.extract",
      source: "builtin",
      version: null,
      definition: {
        schemaVersion: 1,
        id: "docs.extract",
        name: "Read a document",
        description: "Reads an invoice's lines",
        category: "documents",
        mode: "agent",
        tools: [],
        input: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            pages: { type: "integer" },
            careful: { type: "boolean" },
            mode: { enum: ["fast", "careful"] },
          },
          required: ["documentId"],
        },
        output: {
          type: "object",
          properties: {
            total: { type: "number" },
            confidence: { type: "number" },
            lines: { type: "array", items: { type: "object" } },
          },
        },
        settings: [
          {
            key: "min_confidence",
            label: "Minimum confidence",
            type: "number",
            default: 0.8,
            clientSpecific: false,
          },
        ],
        requiresConnectors: [],
        requiresPacks: [],
        producesAlerts: false,
      },
    },
    {
      ref: "docs.find-support",
      source: "builtin",
      version: null,
      definition: {
        schemaVersion: 1,
        id: "docs.find-support",
        name: "Find supporting document",
        description: "Finds the invoice for a bill",
        category: "documents",
        mode: "agent",
        tools: [],
        input: { type: "object", properties: { billId: { type: "string" } } },
        output: { type: "object", properties: { documentId: { type: "string" } } },
        settings: [],
        requiresConnectors: [],
        requiresPacks: [],
        producesAlerts: false,
      },
    },
    {
      ref: "custom:price-watch",
      source: "shared",
      version: 2,
      definition: {
        schemaVersion: 1,
        id: "custom:price-watch",
        name: "Track price changes",
        description: "Flags price changes",
        category: "custom",
        mode: "agent",
        tools: [],
        input: { type: "object" },
        output: { type: "object" },
        settings: [],
        requiresConnectors: [],
        requiresPacks: [],
        producesAlerts: false,
      },
    },
  ],
  tools: [
    {
      id: "testkit.record.update",
      description: "Updates a record",
      input: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "string" } },
        required: ["id"],
      },
      output: { type: "object" },
      sideEffect: "external",
      verb: "update",
      source: "testkit",
      connector: "testkit",
    },
    {
      id: "testkit.record.query",
      description: "Reads records",
      input: { type: "object" },
      output: { type: "object" },
      sideEffect: "none",
      verb: "read",
      source: "testkit",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit", icon: null }],
  automations: [],
};

const EVENTS = {
  events: [
    {
      type: "transaction.created",
      description: "A bill or purchase was created",
      subjectType: "transaction",
      payload: {
        type: "object",
        properties: { billId: { type: "string" }, total: { type: "number" } },
      },
      sample: { billId: "b-1", total: 120 },
    },
  ],
};

const BUNDLE_INPUT: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Material costs", role: "Purchasing", mission: "Keep bills itemized" },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
    instructions: "Itemize bills.",
    skills: [{ skill: "docs.find-support" }, { skill: "docs.extract" }],
    extraTools: ["testkit.record.update"],
    permissions: { mode: "act" },
  },
  workflows: [
    {
      slug: "new-bill",
      name: "New bill",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "event", event: "transaction.created" } },
        steps: [
          {
            id: "find",
            kind: "skill",
            name: "Find supporting document",
            skill: "docs.find-support",
            input: { billId: "{{trigger.billId}}" },
          },
          {
            id: "read",
            kind: "skill",
            name: "Read a document",
            skill: "docs.extract",
            input: { documentId: "{{steps.find.output.documentId}}" },
          },
          {
            id: "confidence",
            kind: "fork",
            name: "Match confidence",
            paths: [
              {
                id: "low",
                name: "Any line below 90%",
                when: {
                  rules: [{ field: "{{steps.read.output.confidence}}", op: "<", value: 0.9 }],
                },
                steps: [
                  {
                    id: "ask",
                    kind: "person",
                    name: "Ask Jammil",
                    mode: "ask",
                    assignee: "client_admin",
                    title: "Check the match",
                    timeout: "2 days",
                    onTimeout: "stop",
                  },
                ],
              },
              {
                id: "big",
                name: "Big change",
                when: { rules: [{ field: "{{steps.read.output.total}}", op: ">", value: 500 }] },
                steps: [],
              },
            ],
            otherwise: { id: "else", steps: [] },
          },
          {
            id: "update",
            kind: "action",
            name: "Update the record",
            tool: "testkit.record.update",
            input: { id: "{{trigger.billId}}" },
          },
        ],
      },
    },
  ],
};
const BUNDLE = AgentBundle.parse(BUNDLE_INPUT);

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: CLIENT_ID,
  kind: "client",
  slug: "material-costs",
  name: "Material costs",
  role: "Purchasing",
  templateId: null,
  linked: true,
  liveVersionId: V1,
  status: "active",
  runStatus: "active",
  serviceName: null,
  serviceDescription: null,
  bindings: { testkit: CONNECTION_ID },
  approver: null,
  testCopy: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function version(id: string, n: number, status: string, bundle: unknown): VersionDetail {
  return {
    id,
    agentId: AGENT_ID,
    version: n,
    status,
    bundleHash: `hash-${n}`,
    changeNote: null,
    releaseNote: null,
    authorType: "operator",
    authorId: null,
    parentVersionId: null,
    basedOnTemplateVersionId: null,
    mergedFromVersionIds: null,
    createdAt: "2026-11-02T10:00:00.000Z",
    bundle,
  };
}

function connection(update: PermissionMatrix["update"]) {
  return {
    id: CONNECTION_ID,
    tenantId: CLIENT_ID,
    connector: "testkit",
    status: "connected",
    externalAccountId: null,
    config: {},
    permissions: {
      read: "auto" as const,
      create: "approval" as const,
      update,
      delete: "off" as const,
    },
    lastSyncAt: null,
    connectedBy: null,
    createdAt: "2026-11-01T00:00:00.000Z",
  };
}

/** A recent `transaction.created` of a client, as GET /api/ops/clients/:id/events answers. */
const eventId = (n: string) => `00000000-0000-4000-8000-0000000e00${n.slice(1).padStart(2, "0")}`;
const eventPayload = (n: string) => ({
  transactionId: `00000000-0000-4000-8000-0000000b00${n.slice(1).padStart(2, "0")}`,
  source: "upload",
  vendorId: null,
  total: { amount: "1250.0000", currency: "USD" },
  txnDate: "2026-11-02",
});
function recentEvent(n: string, vendorName: string) {
  return {
    id: eventId(n),
    type: "transaction.created",
    createdAt: "2026-11-04T10:00:00.000Z",
    payload: eventPayload(n),
    label: "Purchase dated 2026-11-02",
    vendorName,
    total: { amount: "1250.0000", currency: "USD" },
  };
}

interface Setup {
  agent?: Partial<AgentSummary>;
  bundle?: AgentBundle;
  status?: string;
  update?: PermissionMatrix["update"];
  // v0.12 W2-B
  catalog?: BuilderCatalog;
  /** Whether the agent's client is the Sandbox (the Testkit is offered only there). */
  sandbox?: boolean;
  /** The client's People list (GET /api/ops/clients/:id/hours). */
  people?: { kind: "user" | "contact"; id: string; name: string; hours: null }[];
  /** More routes, answering from the first render. */
  routes?: Parameters<typeof fakeApi>[0];
  /** §1.108: the Steps tab opens the builder on its List. */
  view?: "canvas" | "steps";
  /** Who is signed in; the builder then shows only once the session has answered, as in the app. */
  session?: SessionResponse;
}

function setup(options: Setup = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const record = (path: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ path, body });
    return body;
  };
  const api = fakeApi({
    ...options.routes,
    ...(options.session ? { "GET /api/session": () => options.session } : {}),
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => options.catalog ?? CATALOG,
    "GET /api/ops/catalog/events": () => EVENTS,
    ...(options.people
      ? {
          [`GET /api/ops/clients/${CLIENT_ID}/hours`]: () => ({
            business: {
              hours: { tz: "UTC", week: { mon: [{ from: "08:00", to: "18:00" }] } },
              isDefault: true,
            },
            people: options.people,
          }),
        }
      : {}),
    "GET /api/ops/clients": () => ({
      clients: [
        {
          id: CLIENT_ID,
          name: options.sandbox === false ? "Oak & Co" : "Sandbox",
          timezone: "UTC",
          createdAt: "2026-11-01T00:00:00.000Z",
          agents: 1,
          openInbox: 0,
          sandbox: options.sandbox !== false,
        },
      ],
    }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      record("save", init);
      return { version: { ...version(V2, 2, "draft", null), bundle: undefined }, errors: [] };
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions/${V1}/publish`]: ({ init }) => {
      record(`publish ${V1}`, init);
      return { version: version(V1, 1, "live", null) };
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions/${V2}/publish`]: ({ init }) => {
      record(`publish ${V2}`, init);
      return { version: version(V2, 2, "live", null) };
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions/${V1}/test-run`]: ({ init }) => {
      record(`test-run ${V1}`, init);
      return { runId: RUN_ID, agentId: AGENT_ID, versionId: V1 };
    },
  });
  const agent = { ...AGENT, ...options.agent };
  const bundle = options.bundle ?? BUNDLE;
  const from = version(V1, 1, options.status ?? "draft", bundle);
  let changed = 0;

  function Page() {
    const { workflow = "", tab } = useParams();
    return (
      <WorkflowBuilder
        agent={agent}
        from={from}
        bundle={bundle}
        workflow={workflow}
        base={BASE}
        tabs={<nav aria-label="Sections" />}
        connections={[connection(options.update ?? "auto")]}
        members={[]}
        onChanged={() => {
          changed += 1;
        }}
        view={tab === "steps" ? "steps" : "canvas"}
      />
    );
  }
  function SignedIn({ children }: { children: ReactNode }) {
    return useOptionalSession() ? children : null;
  }
  const routes = (
    <Routes>
      <Route path={`${BASE}/:tab/:workflow`} element={<Page />} />
      <Route path="/ops/runs/:id" element={<p>The run page</p>} />
    </Routes>
  );
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter
        initialEntries={[`${BASE}/${options.view === "steps" ? "steps" : "workflows"}/new-bill`]}
      >
        {options.session ? (
          <SessionProvider>
            <SignedIn>{routes}</SignedIn>
          </SessionProvider>
        ) : (
          routes
        )}
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, sent, changed: () => changed };
}

let restoreRects = () => {};
beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // no storage in this environment
  }
  restoreRects = fakeChartRects();
});
afterEach(() => restoreRects());

async function ready() {
  return screen.findByTestId("flow-chart");
}

/** The builder's draft keys in this browser's localStorage. */
function builderKeys(): string[] {
  return Object.keys(window.localStorage).filter((k) => k.startsWith(BUILDER_DRAFT_PREFIX));
}

/** Picks a step's box up with the keyboard, moves it onto another box or a +, and drops it. */
const keyboardMove = (user: ReturnType<typeof userEvent.setup>, id: string, onto: string) =>
  keyboardDrag(user, `flow-box-${id}`, onto);

/** A box's details, shown once the pointer has rested on it. */
async function tipOf(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.hover(screen.getByTestId(`flow-box-${id}`));
  return screen.findByTestId("flow-tip");
}

describe("WorkflowBuilder", () => {
  it("lays the workflow out with numbers, kinds and the bar's counts", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.getByTestId("flow-box-find")).toHaveAttribute("data-number", "1");
    // Labels, never ids: the event, the tool and its connector, the person a step asks.
    expect(screen.getByTestId("flow-start")).toHaveTextContent("When a bill or purchase arrives");
    expect(screen.getByTestId("flow-start")).not.toHaveTextContent("transaction.created");
    // A box is two short lines; what the step does reads in full once the pointer rests on it.
    expect(await tipOf(user, "update")).toHaveTextContent(
      "Testkit · Update a record · needs approval",
    );
    await user.unhover(screen.getByTestId("flow-box-update"));
    expect(await tipOf(user, "ask")).toHaveTextContent("Ask · client admin · 2 days");
    await user.unhover(screen.getByTestId("flow-box-ask"));
    expect(screen.queryByTestId("flow-tip")).toBeNull();
    expect(screen.getByTestId("flow-box-find")).not.toHaveTextContent("docs.find-support");
    expect(listOrder("path:low")).toEqual(["ask"]);
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent(
      "5 steps · 1 decision · 1 writes to a tool · 1 needs approval",
    );
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v1");
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    expect(screen.getByTestId("flow-box-update")).toHaveTextContent("needs approval");
  });

  it("draws a decision as lettered paths that end or come back, on the chart and the List", async () => {
    // Otherwise stops the run: that path ends instead of rejoining the line.
    const input = structuredClone(BUNDLE_INPUT);
    const steps = input.workflows?.[0]?.workflow.steps as { id: string; otherwise?: unknown }[];
    const fork = steps.find((s) => s.id === "confidence");
    if (fork) {
      fork.otherwise = {
        id: "else",
        steps: [{ id: "halt", kind: "stop", name: "Stop here", status: "succeeded" }],
      };
    }
    setup({ bundle: AgentBundle.parse(input) });
    await ready();
    const user = userEvent.setup();

    // Each path's label carries its letter, in order; Otherwise comes last.
    expect(screen.getByTestId("flow-path-low")).toHaveTextContent("AAny line below 90%");
    expect(screen.getByTestId("flow-path-big")).toHaveTextContent("BBig change");
    expect(screen.getByTestId("flow-path-else")).toHaveTextContent("Otherwise");
    // A path's steps are numbered by the decision's number and the path's letter (feedback,
    // 2026-11-15: "5 A1"); top-level numbers stay as they were.
    const forkNumber = screen.getByTestId("flow-box-confidence").getAttribute("data-number");
    expect(forkNumber).toBe("3");
    expect(screen.getByTestId("flow-box-ask")).toHaveAttribute("data-number", `${forkNumber} A1`);
    expect(screen.getByTestId("flow-box-halt")).toHaveAttribute("data-number", `${forkNumber} C1`);
    expect(screen.getByTestId("flow-box-update")).toHaveAttribute("data-number", "4");
    // Otherwise ends at its Stop.
    expect(screen.getByTestId("flow-box-halt")).toHaveTextContent("Stop");

    // Zooming keeps every box; a click on one still opens it.
    await user.click(screen.getByTestId("flow-zoom-out"));
    expect(screen.getByTestId("flow-zoom-level")).toHaveTextContent("90%");
    await user.click(screen.getByTestId("flow-box-ask"));
    expect(screen.getByTestId("flow-box-ask")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "ask");

    // The List says it in words: Otherwise ends; the paths that carry on come back.
    await user.click(screen.getByTestId("flow-bar-view-list"));
    const list = await screen.findByTestId("flow-list");
    expect(within(list).getByTestId("flow-list-otherwise:else")).toHaveTextContent(
      "otherwise · ends there",
    );
    expect(within(list).getByTestId("flow-list-path:low")).toHaveTextContent("comes back");
  });

  it("shows the selected step on the chart and opens it in the side panel", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    expect(screen.queryByTestId("flow-panel")).toBeNull();
    await user.click(screen.getByTestId("flow-box-read"));
    const box = screen.getByTestId("flow-box-read");
    expect(box).toHaveAttribute("aria-pressed", "true");
    expect(box).toHaveClass("is-sel");
    expect(screen.getByTestId("flow-box-find")).toHaveAttribute("aria-pressed", "false");
    const panel = screen.getByTestId("flow-panel");
    expect(panel).toHaveAttribute("data-step", "read");
    expect(screen.getByTestId("flow-panel-eyebrow")).toHaveTextContent("Skill · AI · step 2 of 4");
    // Where the panel sits below the chart (jsdom lays nothing out), the inspector takes focus.
    await waitFor(() => expect(screen.getByTestId("builder-inspector")).toHaveFocus());
    // The skill reads by its name, not its reference.
    expect(screen.getByTestId("flow-panel-name")).toHaveValue("Read a document");
    expect(panel).not.toHaveTextContent("docs.extract");
    // Closing it clears the selection.
    await user.click(screen.getByTestId("flow-panel-close"));
    expect(screen.queryByTestId("flow-panel")).toBeNull();
    expect(screen.getByTestId("flow-box-read")).toHaveAttribute("aria-pressed", "false");
  });

  it("adds where a + was pressed, into that path, and forgets the place on a pick or Escape", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    expect(screen.queryByTestId("builder-palette-target")).toBeNull();
    await user.click(screen.getByTestId("flow-insert-path:big-0"));
    expect(screen.getByTestId("builder-palette-target")).toHaveTextContent("to “Big change”");
    await waitFor(() => expect(screen.getByTestId("flow-rail-search")).toHaveFocus());
    await user.keyboard("[Escape]");
    expect(screen.queryByTestId("builder-palette-target")).toBeNull();

    await user.click(screen.getByTestId("flow-insert-path:big-0"));
    await user.click(screen.getByTestId("flow-rail-item-logic:wait"));
    expect(listOrder("path:big")).toHaveLength(1);
    expect(rootOrder()).toHaveLength(4);
    // The pick is made: the place is forgotten and the new step opens in the side panel.
    expect(screen.queryByTestId("builder-palette-target")).toBeNull();
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", listOrder("path:big")[0]);
    // With no place chosen, a pick goes to the end.
    await user.click(screen.getByTestId("flow-rail-item-logic:stop"));
    expect(rootOrder()).toHaveLength(5);
  });

  // v0.17: a repeat from the palette, its steps in its own block.
  it("adds a repeat and sets its most passes, its wait and what happens at the limit", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-logic:repeat"));
    const added = rootOrder()[4] as string;
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("up to 3 times");
    expect(screen.getByTestId("flow-panel-eyebrow")).toHaveTextContent("Repeat · step 5 of 5");
    // A controlled number field: one change, as typing digit by digit would clamp on the way.
    fireEvent.change(screen.getByTestId("builder-repeat-max"), { target: { value: "5" } });
    await user.type(screen.getByTestId("builder-repeat-between"), "1 hour");
    await user.selectOptions(screen.getByTestId("builder-repeat-on-limit"), "proceed");
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("up to 5 times");
    expect(screen.getByTestId("builder-repeat-between")).toHaveValue("1 hour");
    expect(screen.getByTestId("builder-repeat-on-limit")).toHaveValue("proceed");
  });

  it("opens a decision from a click on one of its paths (feedback, 2026-11-15)", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    expect(screen.getByTestId("flow-box-confidence")).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByTestId("flow-path-low"));
    expect(screen.getByTestId("flow-box-confidence")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "confidence");
  });

  // M61: an if the agent decides, each path saying when to take it.
  it("lets the agent choose an if's path, asking when to take each one", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-confidence"));
    expect(screen.queryByTestId("builder-path-low-describe")).toBeNull();
    await user.click(screen.getByTestId("builder-if-agent"));
    await user.type(screen.getByTestId("builder-path-low-describe"), "a line looks wrong");
    await user.selectOptions(screen.getByTestId("builder-if-unsure"), "ask");
    expect(screen.getByTestId("builder-path-low-describe")).toHaveValue("a line looks wrong");
    expect(screen.getByTestId("builder-if-unsure")).toHaveValue("ask");
    await user.click(screen.getByTestId("builder-if-agent"));
    expect(screen.queryByTestId("builder-if-unsure")).toBeNull();
  });

  it("offers another start, in plain names, while the start is open", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    // The rail is for steps until the start is opened.
    expect(screen.queryByTestId("flow-rail-triggers")).toBeNull();
    await user.click(screen.getByTestId("flow-start"));
    expect(screen.getByTestId("flow-panel-eyebrow")).toHaveTextContent("Starts when");
    const triggers = screen.getByTestId("flow-rail-triggers");
    expect(within(triggers).getByText("When a bill or purchase arrives")).toBeInTheDocument();
    expect(within(triggers).getByText("On a schedule")).toBeInTheDocument();
    expect(triggers).not.toHaveTextContent("transaction.created");
    // A pick replaces how it starts: the trigger keeps its id.
    await user.click(within(triggers).getByText("On a schedule"));
    expect(screen.getByTestId("flow-start")).toHaveTextContent("On a schedule");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const saved = AnyAgentBundle.parse(sent[0]?.body.bundle).workflows[0]?.workflow;
    expect(saved?.schemaVersion === 4 ? saved.triggers.map((t) => t.id) : null).toEqual(["t1"]);
  });

  it("adds a step from the rail, approval on for a write, and marks what is invalid", async () => {
    setup();
    await ready();
    const user = userEvent.setup();

    // The agent's own skills come first, then the library; reads and writes are grouped by tool.
    const skills = screen.getByTestId("flow-rail-skills");
    expect(
      within(skills)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining("Read a document"),
      expect.stringContaining("Find supporting document"),
      expect.stringContaining("Track price changes"),
    ]);
    // Each connected tool has its own group, by its name, with its reads and writes counted.
    const tool = screen.getByTestId("flow-rail-tool-testkit");
    expect(tool).toHaveTextContent("Testkit");
    expect(screen.getByTestId("flow-rail-tool-testkit-line")).toHaveTextContent("1 read · 1 write");
    expect(within(tool).getByText("Update a record")).toBeInTheDocument();
    expect(tool).not.toHaveTextContent("testkit.record.update");
    // R8: reads are offered too, as read steps.
    expect(within(tool).getByTestId("flow-rail-item-read:testkit.record.query")).toHaveTextContent(
      "Read",
    );

    await user.click(screen.getByTestId("flow-rail-item-write:testkit.record.update"));
    const order = rootOrder();
    expect(order).toHaveLength(5);
    const added = order[4] as string;
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("needs approval");
    // Its required input is missing: the step is flagged, the bar counts it, the panel and the
    // summary name it.
    expect(screen.getByTestId(`flow-flag-${added}`)).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-bar-issues")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-panel-settle")).toHaveTextContent("Id is required.");
    const problems = screen.getByTestId("builder-problems");
    expect(problems).toHaveTextContent("Update a record: Id is required.");
    expect(screen.getByTestId("builder-publish")).toBeDisabled();
    expect(screen.getByTestId("flow-bar-try")).toBeDisabled();

    // Clicking the problem selects the step and focuses the field.
    await user.click(screen.getByTestId("builder-problem-0"));
    const field = within(screen.getByTestId("builder-inspector")).getByTestId("builder-input-id");
    expect(field).toHaveFocus();
    await user.type(field, "r-1");
    expect(screen.queryByTestId(`flow-flag-${added}`)).toBeNull();
    expect(screen.queryByTestId("flow-bar-issues")).toBeNull();
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
  });

  it("refuses publish while the agent names a skill that doesn't exist, as the server does", async () => {
    setup({
      bundle: {
        ...BUNDLE,
        definition: {
          ...BUNDLE.definition,
          skills: [...BUNDLE.definition.skills, { skill: "docs.gone", settings: {} }],
        },
      },
    });
    await ready();
    expect(screen.getByTestId("builder-problems")).toHaveTextContent(
      "Agent: Skill docs.gone not found.",
    );
    expect(screen.getByTestId("builder-publish")).toBeDisabled();
  });

  it("offers only connected tools, and the Testkit only in the Sandbox", async () => {
    const zoho = {
      id: "zoho_crm.record.create",
      description: "Create a record",
      input: { type: "object" },
      output: { type: "object" },
      sideEffect: "external" as const,
      verb: "create" as const,
      source: "zoho_crm",
      connector: "zoho_crm",
    };
    setup({
      sandbox: false,
      catalog: {
        ...CATALOG,
        tools: [...CATALOG.tools, zoho],
        connectors: [...CATALOG.connectors, { id: "zoho_crm", name: "Zoho CRM", icon: null }],
      },
    });
    await ready();
    // The client connected the Testkit, but it isn't the Sandbox; Zoho isn't connected at all.
    await waitFor(() => expect(screen.queryByTestId("flow-rail-tool-testkit")).toBeNull());
    expect(screen.queryByTestId("flow-rail-tool-zoho_crm")).toBeNull();
    expect(screen.getByTestId("builder-palette-connected")).toHaveTextContent(
      "Only the tools this client has connected show here.",
    );
  });

  it("adds a library skill and the agent gains it; searching narrows the palette", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("flow-rail-search"), "price");
    expect(screen.queryByTestId("flow-rail-tool-testkit")).toBeNull();
    await user.click(screen.getByTestId("flow-rail-item-skill:custom:price-watch"));
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const bundle = sent[0]?.body.bundle as AgentBundle;
    expect(bundle.definition.skills.map((s) => s.skill)).toEqual([
      "docs.find-support",
      "docs.extract",
      "custom:price-watch",
    ]);
  });

  it("reorders with the keyboard: pick up a box, arrow to a +, drop", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await keyboardMove(user, "read", "flow-insert-root-0");
    await waitFor(() => expect(rootOrder()).toEqual(["read", "find", "confidence", "update"]));
    expect(screen.getByTestId("flow-box-read")).toHaveAttribute("data-number", "1");
    // Moving the reader above the step it reads from breaks its reference: marked invalid.
    expect(screen.getByTestId("flow-flag-read")).toBeInTheDocument();
  });

  it("moves a step into a decision's path and back out", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    // Onto the + of the empty "Big change" path.
    await keyboardMove(user, "update", "flow-insert-path:big-0");
    await waitFor(() => expect(listOrder("path:big")).toEqual(["update"]));
    expect(rootOrder()).toEqual(["find", "read", "confidence"]);
    // A step on a path is numbered by its decision and its path's letter.
    expect(screen.getByTestId("flow-box-update")).toHaveAttribute("data-number", "3 B1");

    // And out of a path: onto "Add a step" under the last step.
    await keyboardMove(user, "ask", "flow-tail");
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence", "ask"]));
    expect(listOrder("path:low")).toEqual([]);
    expect(listOrder("path:big")).toEqual(["update"]);
    expect(screen.getByTestId("flow-box-ask")).toHaveAttribute("data-number", "4");

    // Onto a top-level box from inside a path: it comes right after that step.
    await keyboardMove(user, "update", "flow-box-confidence");
    await waitFor(() =>
      expect(rootOrder()).toEqual(["find", "read", "confidence", "update", "ask"]),
    );
  });

  it("folds the rail and remembers it, and opens one side at a time: a step, or the Builder", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-fold"));
    expect(screen.getByTestId("flow-rail")).toHaveAttribute("data-folded");
    expect(window.localStorage.getItem("mezonas.builder.rail")).toBe("folded");
    // Pressing a + on the chart shows it again, to pick from.
    await user.click(screen.getByTestId("flow-insert-root-0"));
    expect(screen.getByTestId("flow-rail")).not.toHaveAttribute("data-folded");
    expect(window.localStorage.getItem("mezonas.builder.rail")).toBe("shown");

    // Nothing is open on the right until asked for.
    expect(screen.getByTestId("builder-side")).not.toHaveAttribute("data-side");
    await user.click(screen.getByTestId("flow-box-read"));
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "step");
    expect(screen.getByTestId("builder-inspector")).toBeInTheDocument();
    // "Ask the Builder" takes the side; a click on a step takes it back.
    await user.click(screen.getByTestId("flow-bar-builder"));
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "builder");
    expect(screen.queryByTestId("builder-inspector")).toBeNull();
    await user.click(screen.getByTestId("flow-box-find"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "find");
    await user.click(screen.getByTestId("flow-bar-builder"));
    await user.click(screen.getByTestId("builder-side-close"));
    expect(screen.getByTestId("builder-side")).not.toHaveAttribute("data-side");
    window.localStorage.removeItem("mezonas.builder.rail");
  });

  it("deletes a step, then undoes and redoes it", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-read"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    await user.click(screen.getByTestId("flow-bar-undo"));
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.getByTestId("flow-bar-version")).not.toHaveTextContent("Unsaved");
    await user.click(screen.getByTestId("flow-bar-redo"));
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
  });

  describe("approval control", () => {
    async function selectUpdate() {
      await ready();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("flow-box-update"));
      return { user, toggle: screen.getByTestId("builder-approval-toggle") };
    }

    it("lets a client agent run a step without approval where the connection allows auto", async () => {
      setup();
      const { user, toggle } = await selectUpdate();
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
      await user.click(toggle);
      expect(toggle).not.toBeChecked();
      expect(screen.getByTestId("flow-box-update")).toHaveTextContent("on its own");
      // Nothing waits for approval now: the bar's line leaves that part out.
      expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent(
        "5 steps · 1 decision · 1 writes to a tool",
      );
      expect(screen.getByTestId("flow-bar-counts")).not.toHaveTextContent("approval");
    });

    it("keeps it on where the connection requires approval, and says why", async () => {
      setup({ update: "approval" });
      const { toggle } = await selectUpdate();
      expect(toggle).toBeChecked();
      expect(toggle).toBeDisabled();
      expect(screen.getByTestId("builder-approval-reason")).toHaveTextContent(
        "The Testkit connection requires approval for updates.",
      );
    });

    it("keeps it on while the agent only suggests, and on every template", async () => {
      setup({
        bundle: {
          ...BUNDLE,
          definition: { ...BUNDLE.definition, permissions: { mode: "suggest_only" } },
        },
      });
      const first = await selectUpdate();
      expect(first.toggle).toBeDisabled();
      expect(screen.getByTestId("builder-approval-reason")).toHaveTextContent(/suggest only/);
    });

    it("keeps it on in templates", async () => {
      setup({ agent: { kind: "template", tenantId: null, bindings: {} } });
      const { toggle } = await selectUpdate();
      expect(toggle).toBeDisabled();
      expect(screen.getByTestId("builder-approval-reason")).toHaveTextContent(
        /Templates keep approval on/,
      );
    });

    it("marks a step set to skip approval where the connection no longer allows it", async () => {
      const off = AgentBundle.parse({
        ...BUNDLE_INPUT,
        workflows: [
          {
            ...BUNDLE_INPUT.workflows[0],
            workflow: {
              ...BUNDLE.workflows[0]?.workflow,
              steps: BUNDLE.workflows[0]?.workflow.steps.map((s) =>
                s.id === "update" ? { ...s, approval: { required: "not_required" } } : s,
              ),
            },
          },
        ],
      });
      setup({ bundle: off, update: "approval" });
      const { user, toggle } = await selectUpdate();
      expect(screen.getByTestId("flow-flag-update")).toBeInTheDocument();
      expect(screen.getByTestId("flow-box-update")).toHaveTextContent("needs approval");
      // Switching it back on is always allowed.
      expect(toggle).toBeEnabled();
      await user.click(toggle);
      expect(screen.queryByTestId("flow-flag-update")).toBeNull();
      expect(toggle).toBeDisabled();
    });
  });

  it("edits a fork's paths as rule rows: add a condition and a path", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-confidence"));
    const big = screen.getByTestId("builder-path-big");
    await user.click(within(big).getByTestId("builder-path-big-add-condition"));
    // The new rule names no field yet: the path is invalid until it does.
    expect(screen.getByTestId("flow-flag-confidence")).toBeInTheDocument();
    await user.click(within(big).getByTestId("builder-path-big-rule-1-field-pick"));
    await user.click(
      within(big).getByTestId("builder-path-big-rule-1-field-path-steps.read.output.total"),
    );
    await user.type(within(big).getByTestId("builder-path-big-rule-1-value"), "1000");
    expect(screen.queryByTestId("flow-flag-confidence")).toBeNull();
    expect(within(big).getByTestId("builder-path-big-rule-1-value")).toHaveDisplayValue("1000");

    // A path added in the panel, then one from the chart's "+ Add a path": each its own column.
    const paths = () => document.querySelectorAll('[data-testid^="flow-path-"]');
    expect(paths()).toHaveLength(3);
    await user.click(screen.getByTestId("builder-fork-add-path"));
    expect(paths()).toHaveLength(4);
    await user.click(screen.getByTestId("flow-add-path-confidence"));
    expect(paths()).toHaveLength(5);
    // It asks what the new path is first: its name is ready to type over, and when a run takes
    // it is a question on the decision (gold), not an issue (owner, 2026-11-21).
    await waitFor(() => expect(document.activeElement).toHaveDisplayValue("Path 4"));
    const name = document.activeElement as HTMLInputElement;
    expect(name.selectionEnd).toBe("Path 4".length);
    const flag = screen.getByTestId("flow-flag-confidence");
    expect(flag).toHaveTextContent("2 questions");
    expect(flag).not.toHaveTextContent("issue");
    expect(screen.getByTestId("flow-panel")).toHaveTextContent("When does a run take “Path 4”?");
  });

  it("saves the bundle with every step, path and id it had, as a draft of the version it opened", async () => {
    const { sent, changed } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-find"));
    const name = screen.getByTestId("flow-panel-name");
    await user.clear(name);
    await user.type(name, "Find the invoice");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0]?.body as { bundle: AgentBundle; parentVersionId: string };
    expect(body.parentVersionId).toBe(V1);
    const before = BUNDLE.workflows[0]?.workflow;
    // R8: saved as a v4 process (a new version; v1 stays v3), every id kept.
    const after = AnyAgentBundle.parse(body.bundle).workflows[0]?.workflow;
    if (!before || after?.schemaVersion !== 4) throw new Error("no process");
    expect(processes.nodeIds(after)).toEqual(nodeIds(before));
    // Nothing but the name changed from the stored version read as a process.
    const renamed = AnyAgentBundle.parse(body.bundle);
    const step = renamed.workflows[0]?.workflow.steps[0];
    if (step) step.name = "Find supporting document";
    const ctx = typingContext({ catalog: CATALOG, events: EVENTS.events });
    expect(canonicalJson(renamed)).toBe(canonicalJson(readProcessBundle(BUNDLE, ctx)));
    expect(await screen.findByTestId("builder-notice")).toHaveTextContent("Saved v2 as a draft.");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v2");
    expect(changed()).toBe(1);
  });

  it("says Publishing at once and shows nothing published before the answer (1.8)", async () => {
    let answer: (v: unknown) => void = () => {};
    const { api } = setup();
    api.on(
      `POST /api/ops/agents/${AGENT_ID}/versions/${V1}/publish`,
      () => new Promise((r) => (answer = r)),
    );
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-publish"));
    const publish = screen.getByTestId("builder-publish");
    expect(publish).toHaveTextContent("Publishing…");
    expect(publish).toBeDisabled();
    expect(screen.getByTestId("flow-bar-version")).not.toHaveTextContent("Live");
    answer({ version: version(V1, 1, "live", null) });
    expect(await screen.findByTestId("builder-notice")).toHaveTextContent("Published v1.");
  });

  it("publishes the version it opened, or saves then publishes", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-publish"));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual([`publish ${V1}`]));
    expect(await screen.findByTestId("builder-notice")).toHaveTextContent("Published v1.");
    // Live with nothing new: the bar says Live and offers no publish.
    expect(screen.queryByTestId("builder-publish")).toBeNull();
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Live · v1");

    await user.click(screen.getByTestId("flow-box-update"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    await user.click(screen.getByTestId("builder-publish"));
    await waitFor(() =>
      expect(sent.map((s) => s.path)).toEqual([`publish ${V1}`, "save", `publish ${V2}`]),
    );
  });

  it("test-runs with the trigger's sample payload and links to the run", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-test-run"));
    expect(screen.getByTestId("builder-test-payload")).toHaveValue(
      JSON.stringify({ billId: "b-1", total: 120 }, null, 2),
    );
    await user.click(screen.getByTestId("builder-test-run-start"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      path: `test-run ${V1}`,
      body: { workflow: "new-bill", payload: { billId: "b-1", total: 120 } },
    });
    await user.click(await screen.findByTestId("builder-test-run-link"));
    expect(await screen.findByText("The run page")).toBeInTheDocument();
  });

  it("test-runs a template on the Sandbox by default, or on a client the operator chooses", async () => {
    const { api, sent } = setup({ agent: { kind: "template", tenantId: null, bindings: {} } });
    const client = (id: string, name: string, sandbox: boolean) => ({
      id,
      name,
      timezone: "America/Chicago",
      createdAt: "2026-11-01T00:00:00.000Z",
      agents: 0,
      openInbox: 0,
      sandbox,
    });
    api.on("GET /api/ops/clients", () => ({
      clients: [
        client("00000000-0000-4000-8000-00000000c001", "Millwork demo", false),
        client("00000000-0000-4000-8000-00000000c002", "Sandbox", true),
      ],
    }));
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-test-run"));
    const picker = screen.getByTestId("builder-test-client");
    await within(picker).findByText("Millwork demo");
    // The Sandbox is the default, listed once.
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["The Sandbox client (fixture data)", "Millwork demo"]);
    await user.click(screen.getByTestId("builder-test-run-start"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).not.toHaveProperty("clientId");

    await user.selectOptions(picker, "00000000-0000-4000-8000-00000000c001");
    await user.click(screen.getByTestId("builder-test-run-start"));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body).toMatchObject({ clientId: "00000000-0000-4000-8000-00000000c001" });
  });

  it("test-runs with one of the client's recent events of the trigger's type", async () => {
    const { api, sent } = setup();
    const asked: string[] = [];
    api.on(`GET /api/ops/clients/${CLIENT_ID}/events`, ({ url }) => {
      asked.push(url.searchParams.get("type") ?? "");
      return { events: [recentEvent("e1", "Oak & Co"), recentEvent("e2", "Maple Mill")] };
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-test-run"));
    const source = screen.getByTestId("builder-test-source");
    await within(source).findByText(/Oak & Co/);
    expect(asked).toEqual(["transaction.created"]);
    // The sample stays first; the events are labelled with what they are about.
    const options = within(source)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options[0]).toBe("Sample trigger payload");
    expect(options[1]).toMatch(/^Purchase dated 2026-11-02 · Oak & Co · \$1,250\.00 · /);
    expect(options.at(-1)).toBe("Manual input");
    expect(within(source).getByRole("group")).toHaveAttribute("label", "Use a recent event");

    await user.selectOptions(source, `event:${eventId("e2")}`);
    expect(
      JSON.parse(String((screen.getByTestId("builder-test-payload") as HTMLTextAreaElement).value)),
    ).toEqual(eventPayload("e2"));
    await user.click(screen.getByTestId("builder-test-run-start"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ workflow: "new-bill", payload: eventPayload("e2") });
  });

  it("lists a template's recent events from the Sandbox, or from the client chosen", async () => {
    const { api } = setup({ agent: { kind: "template", tenantId: null, bindings: {} } });
    const MILLWORK = "00000000-0000-4000-8000-00000000c001";
    const SANDBOX = "00000000-0000-4000-8000-00000000c002";
    const client = (id: string, name: string, sandbox: boolean) => ({
      id,
      name,
      timezone: "America/Chicago",
      createdAt: "2026-11-01T00:00:00.000Z",
      agents: 0,
      openInbox: 0,
      sandbox,
    });
    api.on("GET /api/ops/clients", () => ({
      clients: [client(MILLWORK, "Millwork demo", false), client(SANDBOX, "Sandbox", true)],
    }));
    api.on(`GET /api/ops/clients/${SANDBOX}/events`, () => ({
      events: [recentEvent("e1", "Sandbox Supply")],
    }));
    api.on(`GET /api/ops/clients/${MILLWORK}/events`, () => ({
      events: [recentEvent("e3", "Millwork Lumber")],
    }));
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-test-run"));
    const source = screen.getByTestId("builder-test-source");
    await within(source).findByText(/Sandbox Supply/);
    expect(within(source).queryByText(/Millwork Lumber/)).not.toBeInTheDocument();
    await user.selectOptions(source, `event:${eventId("e1")}`);

    await user.selectOptions(screen.getByTestId("builder-test-client"), MILLWORK);
    await within(source).findByText(/Millwork Lumber/);
    expect(within(source).queryByText(/Sandbox Supply/)).not.toBeInTheDocument();
    // The Sandbox's event is not the chosen client's: back to the sample.
    expect(source).toHaveValue("sample");
    expect(screen.getByTestId("builder-test-payload")).toHaveValue(
      JSON.stringify({ billId: "b-1", total: 120 }, null, 2),
    );
  });

  it("says when the client has no recent events of the trigger's type", async () => {
    const { api } = setup();
    api.on(`GET /api/ops/clients/${CLIENT_ID}/events`, () => ({ events: [] }));
    await ready();
    await userEvent.setup().click(screen.getByTestId("builder-test-run"));
    const source = screen.getByTestId("builder-test-source");
    expect(await within(source).findByText("No transaction.created events yet")).toBeDisabled();
  });

  it("adds a workflow as v5, saving it at once with the other's edits", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-read"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    await user.click(screen.getByTestId("builder-workflow-add"));
    await user.type(screen.getByTestId("builder-workflow-name"), "Weekly digest");
    expect(screen.getByTestId("builder-workflow-slug")).toHaveValue("weekly-digest");
    await user.selectOptions(screen.getByTestId("builder-workflow-trigger"), "schedule");
    await user.click(screen.getByTestId("builder-workflow-create"));
    // A new workflow is in the step model, which opens from a saved version: saved at once, with
    // the unsaved edit to the other workflow (the removed step) in the same version.
    await waitFor(() => expect(sent.filter((s) => s.path === "save")).toHaveLength(1));
    const body = sent.find((s) => s.path === "save")?.body as {
      bundle: {
        workflows: { slug: string; workflow: { schemaVersion: number; steps: { id: string }[] } }[];
      };
    };
    const [main, added] = body.bundle.workflows;
    expect(main?.slug).toBe("new-bill");
    expect(main?.workflow.steps.map((x) => x.id)).toEqual(["find", "confidence", "update"]);
    expect(added?.slug).toBe("weekly-digest");
    expect(added?.workflow).toMatchObject({
      schemaVersion: 5,
      triggers: [{ on: { type: "schedule" } }],
      outputs: [{ name: "Nothing to do", kind: "nothing" }],
      steps: [{ kind: "end" }],
    });
  });

  it("keeps the session's rolling draft on this device and restores it", async () => {
    const first = setup({ session: OPERATOR_SESSION });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-read"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    await waitFor(
      () =>
        expect(screen.getByTestId("builder-draft-status")).toHaveTextContent(
          /Draft kept on this device/,
        ),
      { timeout: 3500 },
    );
    // Nothing became a version: that waits for Save draft, Test run or Publish.
    expect(first.sent).toHaveLength(0);
    // Kept under this person's key for this agent, and no other.
    expect(builderKeys()).toEqual([builderDraftKey(OPERATOR_SESSION.user.id, AGENT_ID)]);

    cleanup();
    setup({ session: OPERATOR_SESSION });
    await ready();
    expect(screen.getByTestId("builder-notice")).toHaveTextContent(/Restored your unsaved changes/);
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
    await user.click(screen.getByTestId("builder-discard-draft"));
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.getByTestId("flow-bar-version")).not.toHaveTextContent("Unsaved");
  });

  it("never shows one person's draft to another, and keeps none with no one signed in", async () => {
    setup({ session: OPERATOR_SESSION });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-read"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    await waitFor(() => expect(builderKeys()).toHaveLength(1), { timeout: 3500 });

    cleanup();
    const other = { ...OPERATOR_SESSION, user: { ...OPERATOR_SESSION.user, id: "someone-else" } };
    setup({ session: other });
    await ready();
    expect(document.body).not.toHaveTextContent(/Restored your unsaved changes/);
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);

    cleanup();
    window.localStorage.clear();
    setup();
    await ready();
    await user.click(screen.getByTestId("flow-box-read"));
    await user.click(screen.getByTestId("flow-panel-remove"));
    expect(screen.getByTestId("builder-draft-status")).toHaveTextContent("Unsaved changes");
    await new Promise((r) => setTimeout(r, 2200));
    expect(builderKeys()).toEqual([]);
    expect(screen.getByTestId("builder-draft-status")).toHaveTextContent("Unsaved changes");
  });

  it("treats the API's no-op answer as saved", async () => {
    const { api } = setup();
    api.on(
      `POST /api/ops/agents/${AGENT_ID}/versions`,
      () => new Reply(409, { error: { code: "no_op", message: "nothing changed" } }),
    );
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-find"));
    await user.type(screen.getByTestId("flow-panel-name"), "!");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() =>
      expect(screen.getByTestId("flow-bar-version")).not.toHaveTextContent("Unsaved"),
    );
    expect(screen.queryByTestId("builder-error")).toBeNull();
  });

  // v0.12 W2-B: the old builder renders a use step as a read-only card with an input form.
  it("shows a use step as its automation's name and version, with its input as a form", async () => {
    const user = userEvent.setup();
    const bundle = AgentBundle.parse({
      ...BUNDLE_INPUT,
      workflows: [
        {
          slug: "new-bill",
          name: "New bill",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "t1", on: { type: "event", event: "transaction.created" } },
            steps: [
              {
                id: "follow",
                kind: "use_automation",
                name: "Follow up",
                automation: "polite-follow-up@2",
                input: { note: "Hello" },
              },
            ],
          },
        },
      ],
    });
    const definition = {
      schemaVersion: 1 as const,
      slug: "polite-follow-up",
      name: "Polite follow-up",
      description: "Say a word, then correct the record",
      input: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      output: { said: "{{input.note}}" },
      steps: [
        {
          id: "say",
          kind: "notify" as const,
          name: "Say it",
          channel: "thread" as const,
          message: "{{input.note}}",
        },
      ],
      requires: { skills: [], tools: [], connectors: [] },
    };
    setup({
      bundle,
      catalog: {
        ...CATALOG,
        automations: [
          {
            ref: "polite-follow-up@2",
            slug: "polite-follow-up",
            version: 2,
            name: "Polite follow-up",
            description: definition.description,
            source: "shared",
            status: "live",
            definition,
            outputSchema: { type: "object", properties: { said: { type: "string" } } },
          },
        ],
      },
    });
    await ready();
    expect(await tipOf(user, "follow")).toHaveTextContent("Polite follow-up · v2");
    await user.unhover(screen.getByTestId("flow-box-follow"));
    await user.click(screen.getByTestId("flow-box-follow"));
    expect(screen.getByTestId("builder-automation")).toHaveTextContent("Polite follow-up · v2");
    expect(screen.queryByTestId("flow-flag-follow")).toBeNull();
  });
});

// UI-2c (O6): the Builder beside the canvas, "Save as automation", and a model per step.
describe("WorkflowBuilder's Steps tab", () => {
  it("lists the steps with their numbers, kinds and status, and opens one in the side panel", async () => {
    setup({ view: "steps" });
    const list = await screen.findByTestId("flow-list");
    expect(screen.queryByTestId("flow-chart")).toBeNull();
    expect(screen.getByTestId("flow-bar-view-list")).toHaveAttribute("aria-pressed", "true");
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual(
      expect.arrayContaining(["1", "2"]),
    );
    expect(list).toHaveTextContent("Ready");
    // Needs you narrows the list to the steps that aren't ready.
    await userEvent.click(within(list).getByTestId("flow-list-needs"));
    for (const badge of within(list).queryAllByText("Ready")) {
      expect(badge.closest("tr")).toBeNull();
    }
    await userEvent.click(within(list).getByTestId("flow-list-all"));
    await userEvent.click(within(list).getByTestId("flow-list-open-find"));
    expect(await screen.findByTestId("builder-inspector")).toHaveAttribute("data-node", "find");
    expect(within(list).getByTestId("flow-list-row-find").className).toContain("bg-slate-tint");
    // The bar switches to the chart, the same step still open.
    await userEvent.click(screen.getByTestId("flow-bar-view-chart"));
    expect(await screen.findByTestId("flow-box-find")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("WorkflowBuilder with the Builder", () => {
  const SESSION = "00000000-0000-4000-8000-0000000c5001";
  const TURN = "00000000-0000-4000-8000-0000000c5102";
  const builderTurn = (changes: unknown[]) => ({
    id: TURN,
    seq: 2,
    role: "builder",
    text: "Removed the update; the fork's paths end the run.",
    command: null,
    changes,
    questions: [],
    gaps: [],
    notes: [],
    errors: [],
    savedVersionId: null,
    costUsd: "0.01",
    undoneAt: null,
    createdAt: "2026-11-06T10:00:00.000Z",
  });
  const detail = (bundle: unknown, turns: unknown[] = []) => ({
    session: {
      id: SESSION,
      kind: "agent",
      clientId: CLIENT_ID,
      clientName: "Harbor Millwork",
      agentId: AGENT_ID,
      skillId: null,
      baseVersionId: V1,
      status: "open",
      bundle,
      errors: [],
      closest: [],
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T10:00:00.000Z",
    },
    turns,
  });
  const withoutUpdate = {
    ...BUNDLE,
    workflows: BUNDLE.workflows.map((w) => ({
      ...w,
      workflow: { ...w.workflow, steps: w.workflow.steps.filter((s) => s.id !== "update") },
    })),
  };

  it("starts from the version it opened, puts the Builder's draft on the canvas, and undoes a change", async () => {
    const { api } = setup();
    const bodies: Record<string, unknown>[] = [];
    const change = {
      id: "step:update",
      label: "step “Update the record”",
      before: {},
      undone: false,
    };
    api.on("POST /api/ops/builder/sessions", ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return detail(BUNDLE);
    });
    api.on(`POST /api/ops/builder/sessions/${SESSION}/turns`, ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ...detail(withoutUpdate, [builderTurn([change])]), turn: builderTurn([change]) };
    });
    api.on(`POST /api/ops/builder/sessions/${SESSION}/undo`, ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      const undone = builderTurn([{ ...change, undone: true }]);
      return { ...detail(BUNDLE, [undone]), turn: undone };
    });
    await ready();
    const user = userEvent.setup();
    // "Ask the Builder" opens the whole-flow Builder beside the chart.
    await user.click(screen.getByTestId("flow-bar-builder"));
    expect(screen.getByTestId("builder-side")).toHaveAttribute("data-side", "builder");
    expect(screen.getByTestId("builder-chat-empty")).toBeInTheDocument();
    await user.type(screen.getByTestId("builder-chat-composer-input"), "Drop the update step");
    await user.click(screen.getByTestId("builder-chat-composer-send"));
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence"]));
    expect(bodies[0]).toEqual({ kind: "agent", agentId: AGENT_ID, fromVersionId: V1 });
    expect(bodies[1]).toEqual({ text: "Drop the update step" });
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");

    await user.click(screen.getByTestId("builder-change-undo"));
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]));
    expect(bodies[2]).toEqual({ turnId: TURN, changeId: "step:update" });
  });

  it("brings the conversation back after a reload, for the browser session (feedback, 2026-11-15)", async () => {
    const operatorTurn = {
      ...builderTurn([]),
      id: "00000000-0000-4000-8000-0000000c5101",
      seq: 1,
      role: "operator",
      text: "What parts of this process are not ready today?",
      costUsd: "0",
    };
    window.sessionStorage.setItem(`countersign:builder-chat:${AGENT_ID}`, SESSION);
    setup({
      routes: {
        [`GET /api/ops/builder/sessions/${SESSION}`]: () =>
          detail(BUNDLE, [operatorTurn, builderTurn([])]),
      },
    });
    await ready();
    expect(
      await screen.findByText("What parts of this process are not ready today?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Removed the update; the fork's paths end the run."),
    ).toBeInTheDocument();
    // The canvas is as it opened.
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
  });

  it("starts fresh when the remembered conversation is gone", async () => {
    window.sessionStorage.setItem(`countersign:builder-chat:${AGENT_ID}`, SESSION);
    setup();
    await ready();
    expect(screen.getByTestId("builder-chat-empty")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.sessionStorage.getItem(`countersign:builder-chat:${AGENT_ID}`)).toBeNull(),
    );
  });

  it("opens Fix on a problem: says what's wrong, asks the Builder to explain and propose, then makes the fix", async () => {
    const { api } = setup({
      bundle: {
        ...BUNDLE,
        definition: {
          ...BUNDLE.definition,
          skills: [...BUNDLE.definition.skills, { skill: "docs.gone", settings: {} }],
        },
      },
    });
    const texts: string[] = [];
    api.on("POST /api/ops/builder/sessions", () => detail(BUNDLE));
    api.on(`POST /api/ops/builder/sessions/${SESSION}/turns`, ({ init }) => {
      texts.push((JSON.parse(String(init.body)) as { text: string }).text);
      const answer = {
        ...builderTurn([]),
        id: `00000000-0000-4000-8000-0000000c51${10 + texts.length}`,
        text: "The agent lists a skill that no longer exists. Remove it from the agent's skills.",
      };
      return { ...detail(BUNDLE, [answer]), turn: answer };
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-problem-0-fix"));
    const dialog = screen.getByRole("dialog", { name: "Fix “Agent”" });
    expect(within(dialog).getByTestId("builder-fix-problem")).toHaveTextContent(
      "Skill docs.gone not found.",
    );
    expect(
      await within(dialog).findByText(
        "The agent lists a skill that no longer exists. Remove it from the agent's skills.",
      ),
    ).toBeInTheDocument();
    expect(texts[0]).toContain("Fix: “Agent”");
    expect(texts[0]).toContain("Don't change the workflow yet.");
    expect(texts[0]).toContain("skill docs.gone not found");

    await user.click(within(dialog).getByTestId("builder-fix-apply"));
    await waitFor(() => expect(texts[1]).toBe("Go ahead and make the fix you proposed."));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("builder-fix")).toBeNull();
  });

  it("keeps focus in a field clicked before the panel's next frame", async () => {
    setup();
    await ready();
    // jsdom has no layout, so the panel counts as below the canvas: a step's click focuses the
    // panel on the next frame. A field focused before then keeps it, so typing isn't lost.
    act(() => screen.getByTestId("flow-box-find").click());
    const name = screen.getByTestId("flow-panel-name");
    act(() => name.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(name);
  });

  it("saves unsaved edits first and starts the conversation from that version", async () => {
    const { api, sent } = setup();
    const starts: unknown[] = [];
    api.on("POST /api/ops/builder/sessions", ({ init }) => {
      starts.push(JSON.parse(String(init.body)));
      return detail(BUNDLE);
    });
    api.on(`POST /api/ops/builder/sessions/${SESSION}/turns`, () => ({
      ...detail(BUNDLE, [builderTurn([])]),
      turn: builderTurn([]),
    }));
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-find"));
    await user.type(screen.getByTestId("flow-panel-name"), "!");
    await user.click(screen.getByTestId("flow-bar-builder"));
    await user.type(screen.getByTestId("builder-chat-composer-input"), "Why is the fork there?");
    await user.click(screen.getByTestId("builder-chat-composer-send"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(sent[0]?.path).toBe("save");
    expect(starts[0]).toEqual({ kind: "agent", agentId: AGENT_ID, fromVersionId: V2 });
  });

  it("saves selected steps as an automation, used in their place", async () => {
    const { api } = setup();
    let body: unknown = null;
    const used = {
      ...BUNDLE,
      workflows: BUNDLE.workflows.map((w) => ({
        ...w,
        workflow: {
          ...w.workflow,
          steps: [
            {
              id: "find-and-read",
              kind: "use_automation" as const,
              name: "Find and read",
              automation: "find-and-read@1",
              input: {},
            },
            ...w.workflow.steps.filter((s) => s.id !== "find" && s.id !== "read"),
          ],
        },
      })),
    };
    api.on("POST /api/ops/builder/sessions", () => detail(BUNDLE));
    api.on(`POST /api/ops/builder/sessions/${SESSION}/automation`, ({ init }) => {
      body = JSON.parse(String(init.body));
      return {
        ...detail(used, [builderTurn([])]),
        turn: builderTurn([]),
        automation: { id: SESSION, slug: "find-and-read", ref: "find-and-read@1" },
        automationVersion: { id: SESSION, version: 1 },
      };
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-select-steps"));
    await user.click(screen.getByTestId("builder-step-read-check"));
    await user.click(screen.getByTestId("builder-step-find-check"));
    expect(screen.getByTestId("builder-selection")).toHaveTextContent("2 selected");
    await user.click(screen.getByTestId("builder-save-automation"));
    await user.type(screen.getByTestId("builder-automation-name"), "Find and read");
    await user.click(screen.getByTestId("builder-automation-save"));
    await waitFor(() => expect(rootOrder()).toEqual(["find-and-read", "confidence", "update"]));
    expect(body).toEqual({
      stepIds: ["find", "read"],
      name: "Find and read",
      slug: "find-and-read",
    });
    expect(screen.getByTestId("builder-notice")).toHaveTextContent(/Saved “Find and read”/);
  });

  it("offers an automation in the palette as one use step", async () => {
    const definition = {
      schemaVersion: 1 as const,
      slug: "polite-follow-up",
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
          message: "Hello",
        },
      ],
      requires: { skills: [], tools: [], connectors: [] },
    };
    setup({
      catalog: {
        ...CATALOG,
        automations: [
          {
            ref: "polite-follow-up@2",
            slug: "polite-follow-up",
            version: 2,
            name: "Polite follow-up",
            description: "Say a word",
            source: "shared",
            status: "live",
            definition,
            outputSchema: { type: "object" },
          },
        ],
      },
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-process:polite-follow-up@2"));
    expect(rootOrder()).toHaveLength(5);
    expect(screen.getByTestId("builder-automation")).toHaveTextContent("Polite follow-up · v2");
  });

  it("sets a skill step's model from the models served", async () => {
    const { api, sent } = setup();
    api.on("GET /api/ops/models", () => ({
      models: [
        { id: "claude-haiku-4-5", label: "Fast", inputPerMtok: "1.00", outputPerMtok: "5.00" },
      ],
    }));
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-box-find"));
    const select = await screen.findByTestId("builder-inspector-model");
    await screen.findByText("Fast · $1.00 / $5.00");
    await user.selectOptions(select, "claude-haiku-4-5");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const saved = AnyAgentBundle.parse((sent[0]?.body as { bundle: unknown } | undefined)?.bundle);
    const find = saved.workflows[0]?.workflow.steps[0];
    expect(find?.kind === "skill" ? find.model : null).toEqual({ id: "claude-haiku-4-5" });
  });
});

// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14): v4 processes, checks, deadlines and a skill
// step's customization.
describe("WorkflowBuilder on processes", () => {
  /** The step as saved: the body's bundle read as v4, the step found anywhere in its process. */
  function savedStep(sent: { body: Record<string, unknown> }[], id: string) {
    const bundle = AnyAgentBundle.parse(sent.at(-1)?.body.bundle);
    const process = bundle.workflows[0]?.workflow;
    if (process?.schemaVersion !== 4) throw new Error("not saved as a process");
    return processes.findStep(process, id)?.step;
  }

  /** The last step of the saved process (a step added in the test). */
  function savedLast(sent: { body: Record<string, unknown> }[]) {
    const bundle = AnyAgentBundle.parse(sent.at(-1)?.body.bundle);
    const process = bundle.workflows[0]?.workflow;
    if (process?.schemaVersion !== 4) throw new Error("not saved as a process");
    return process.steps.at(-1);
  }

  async function select(user: ReturnType<typeof userEvent.setup>, id: string) {
    await ready();
    await user.click(screen.getByTestId(`flow-box-${id}`));
  }

  async function save(user: ReturnType<typeof userEvent.setup>, sent: unknown[]) {
    const before = sent.length;
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent.length).toBe(before + 1));
  }

  it("opens a stored v3 version as a process, says so, and saves it as v4 without editing it", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    expect(screen.getByTestId("builder-notice")).toHaveTextContent(
      "v1 is stored in the older workflow format",
    );
    // Reading it converted is not an edit: nothing to save until something changes.
    expect(screen.getByTestId("flow-bar-save")).toBeDisabled();
    expect(screen.getByTestId("flow-bar-version")).not.toHaveTextContent("Unsaved");
    // The v3 fork is an if, the action a write with its approval; the canvas words follow.
    expect(screen.getByTestId("flow-box-confidence")).toHaveAccessibleName(/: If$/);
    // Skill model (2026-11-10): a write to a client's tool reads "Change in <its name>".
    // On the box its badge says "Change"; where it writes is the badge's full words and the
    // line under the name (docs/plan.md §1.178).
    expect(screen.getByTestId("flow-badge-update")).toHaveTextContent("Change");
    expect(screen.getByTestId("flow-badge-update")).toHaveAttribute("title", "Change in Testkit");
    expect(screen.getByTestId("flow-box-update")).toHaveAccessibleName(/Change in Testkit/);
    await select(user, "find");
    await user.type(screen.getByTestId("flow-panel-name"), "!");
    await save(user, sent);
    const body = sent[0]?.body as {
      bundle: { workflows: { workflow: { schemaVersion: number } }[] };
      parentVersionId: string;
    };
    expect(body.parentVersionId).toBe(V1);
    expect(body.bundle.workflows.map((w) => w.workflow.schemaVersion)).toEqual([4]);
    expect(savedStep(sent, "confidence")?.kind).toBe("if");
    expect(savedStep(sent, "update")).toMatchObject({
      kind: "write",
      tool: "testkit.record.update",
      checks: { approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop" } },
    });
    expect(savedStep(sent, "ask")).toMatchObject({
      kind: "person",
      deadline: { after: "2 days", hours: "clock", ifNoAnswer: "stop" },
    });
    // The stored v1 is what it was: the builder sent a new version, never v1 changed.
    expect(BUNDLE.workflows[0]?.workflow.schemaVersion).toBe(3);
  });

  // Wave 3b: Publish sends the stored v3 version while nothing changed, and the server validates
  // it as v3; the builder's problem list and Publish button follow what would be sent.
  it("validates an unchanged stored v3 version as v3, as its publish will, and the edited process as v4", async () => {
    const suggesting = AgentBundle.parse({
      ...BUNDLE_INPUT,
      definition: { ...BUNDLE_INPUT.definition, permissions: { mode: "suggest_only" } },
      workflows: [
        {
          slug: "new-bill",
          name: "New bill",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "t1", on: { type: "event", event: "transaction.created" } },
            steps: [
              {
                id: "update",
                kind: "action",
                name: "Update the record",
                tool: "testkit.record.update",
                input: { id: "{{trigger.billId}}" },
                approval: { required: "not_required" },
              },
            ],
          },
        },
      ],
    });
    const { sent } = setup({ bundle: suggesting });
    await ready();
    const user = userEvent.setup();
    // v3 doesn't hold a suggest-only agent's loosened action at publish (the gate still asks).
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    expect(screen.getByTestId("builder-publish")).toBeEnabled();
    await user.click(screen.getByTestId("builder-publish"));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual([`publish ${V1}`]));
    // Once edited, the next save is a process, which v4 holds to an agent that acts.
    await select(user, "update");
    await user.type(screen.getByTestId("flow-panel-name"), "!");
    expect(screen.getByTestId("builder-problems")).toHaveTextContent("1 problem");
    expect(screen.getByTestId("builder-publish")).toBeDisabled();
  });

  it("says a process step's changes are approved inside it, and offers a conversation no approval", async () => {
    setup({
      catalog: {
        ...CATALOG,
        automations: [
          {
            ref: "correct@1",
            slug: "correct",
            version: 1,
            name: "Correct the record",
            description: "Corrects a record",
            source: "shared",
            status: "live",
            definition: {
              schemaVersion: 1 as const,
              slug: "correct",
              name: "Correct the record",
              description: "Corrects a record",
              input: { type: "object", properties: {} },
              output: {},
              steps: [
                {
                  id: "u",
                  kind: "action" as const,
                  name: "Update",
                  tool: "testkit.record.update",
                  input: { id: "x" },
                  approval: { required: "required" as const, onReject: "stop" as const },
                },
              ],
              requires: { skills: [], tools: ["testkit.record.update"], connectors: ["testkit"] },
            },
            outputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-process:correct@1"));
    expect(screen.getByTestId("builder-approval-none")).toHaveTextContent(
      "approved inside that automation",
    );
    expect(screen.getByTestId("builder-approval-none")).not.toHaveTextContent("changes nothing");
    await user.click(screen.getByTestId("flow-rail-item-conversation"));
    expect(screen.getByTestId("builder-approval-conversation")).toHaveTextContent(
      "signed under its message settings",
    );
    expect(screen.queryByTestId("builder-approval-add")).toBeNull();
  });

  it("offers the client's team as person reviewers, never a directory contact", async () => {
    const DANA = "00000000-0000-4000-8000-0000000c0001";
    const NORTHLINE = "00000000-0000-4000-8000-0000000c0002";
    setup({
      people: [
        { kind: "user", id: DANA, name: "Dana Reyes", hours: null },
        { kind: "contact", id: NORTHLINE, name: "Northline Supply", hours: null },
      ],
    });
    const user = userEvent.setup();
    await select(user, "update");
    await user.click(screen.getByTestId("builder-confer-add"));
    await user.click(screen.getByTestId("builder-confer-add-person"));
    const picker = screen.getByTestId("builder-confer-1-person");
    await waitFor(() => expect(within(picker).getByText("Dana Reyes")).toBeInTheDocument());
    // A conferee sees the step's result: a vendor is outside the team, so never offered.
    expect(within(picker).queryByText("Northline Supply")).toBeNull();
  });

  it("adds a second opinion: a model with a focus, then a person if it disagreed, in business hours", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "update");
    await user.click(screen.getByTestId("builder-confer-add"));
    // An AI reviewer's focus becomes its instructions: written here.
    await user.type(screen.getByTestId("builder-confer-0-focus"), "Do the amounts match?");
    await user.click(screen.getByTestId("builder-confer-add-person"));
    await user.selectOptions(screen.getByTestId("builder-confer-1-person"), "lead");
    await user.selectOptions(screen.getByTestId("builder-confer-1-deadline-after"), "4 hours");
    await user.selectOptions(screen.getByTestId("builder-confer-1-deadline-hours"), "business");
    expect(screen.getByTestId("builder-confer-1-deadline-business")).toHaveTextContent(
      "Counts only while the person asked is working",
    );
    // The person only when the model disagreed: its verdict is offered to the condition.
    await user.click(screen.getByTestId("builder-confer-1-when-add"));
    await user.click(screen.getByTestId("builder-confer-1-when-rule-0-field-pick"));
    await user.click(
      screen.getByTestId("builder-confer-1-when-rule-0-field-path-confer.0.verdict"),
    );
    await user.clear(screen.getByTestId("builder-confer-1-when-rule-0-value"));
    await user.type(screen.getByTestId("builder-confer-1-when-rule-0-value"), "disagree");
    expect(screen.getByTestId("flow-box-update")).toHaveTextContent("Checked with a person");
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    await save(user, sent);
    expect(savedStep(sent, "update")?.checks?.confer).toEqual({
      with: [
        { ai: { focus: "Do the amounts match?" } },
        {
          person: "lead",
          deadline: { after: "4 hours", hours: "business", ifNoAnswer: "stop" },
          when: {
            match: "all",
            rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "disagree" }],
          },
        },
      ],
    });
  });

  it("runs the AI reviewer on a model picked from the models served, with its provider", async () => {
    const { api, sent } = setup();
    api.on("GET /api/ops/models", () => ({
      models: [
        {
          id: "claude-haiku-5-5",
          label: "Fast (Haiku)",
          inputPerMtok: "0.10",
          outputPerMtok: "0.50",
        },
        {
          id: "xai:grok-4.7",
          label: "xAI (Grok 4.7)",
          inputPerMtok: "2.00",
          outputPerMtok: "6.00",
        },
        {
          id: "google:gemini-3.1-pro",
          label: "Google (Gemini 3.1 Pro)",
          inputPerMtok: "2.00",
          outputPerMtok: "12.00",
        },
      ],
    }));
    const user = userEvent.setup();
    await select(user, "update");
    await user.click(screen.getByTestId("builder-confer-add"));
    await user.type(screen.getByTestId("builder-confer-0-focus"), "Do the amounts match?");
    const picker = screen.getByTestId("builder-confer-0-model");
    await within(picker).findByText("xAI (Grok 4.7) · $2.00 / $6.00");
    expect(
      within(picker).getByText("Google (Gemini 3.1 Pro) · $2.00 / $12.00"),
    ).toBeInTheDocument();
    expect(picker).toHaveValue("");
    await user.selectOptions(picker, "google:gemini-3.1-pro");
    await save(user, sent);
    expect(savedStep(sent, "update")?.checks?.confer).toEqual({
      with: [{ ai: { focus: "Do the amounts match?", model: { id: "google:gemini-3.1-pro" } } }],
    });
  });

  it("names approvers who all must approve, with a deadline, and escalates when nobody answers", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "update");
    expect(screen.getByTestId("builder-approval-default")).toHaveTextContent(
      "The default approver",
    );
    await user.click(screen.getByTestId("builder-approval-add-approver"));
    await user.click(screen.getByTestId("builder-approval-add-approver"));
    await user.selectOptions(screen.getByTestId("builder-approver-1-who"), "lead");
    await user.selectOptions(screen.getByTestId("builder-approval-mode"), "all");
    await user.click(screen.getByTestId("builder-approver-0-has-deadline"));
    await user.selectOptions(screen.getByTestId("builder-approval-then"), "escalate");
    await user.selectOptions(screen.getByTestId("builder-approval-then-escalate-to"), "operator");
    await save(user, sent);
    expect(savedStep(sent, "update")?.checks?.approval).toEqual({
      required: "required",
      mode: "all",
      approvers: [
        { who: "client_admin", deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" } },
        { who: "lead" },
      ],
      ifNoAnswer: {
        escalate: {
          to: "operator",
          deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
        },
      },
      onReject: "stop",
    });
  });

  it("offers going ahead with no answer, or some runs only, only where a write may be loosened", async () => {
    setup({ update: "approval" });
    const user = userEvent.setup();
    await select(user, "update");
    const then = screen.getByTestId("builder-approval-then");
    expect(within(then).getByRole("option", { name: /Go ahead/ })).toBeDisabled();
    expect(screen.getByTestId("builder-approval-then-proceed-reason")).toHaveTextContent(
      "The Testkit connection requires approval for updates.",
    );
    expect(screen.queryByTestId("builder-approval-when-add")).toBeNull();
    expect(screen.getByTestId("builder-approval-toggle")).toBeDisabled();
  });

  it("lets the operator loosen a write where it may be, and the canvas says it runs on its own", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "update");
    const then = screen.getByTestId("builder-approval-then");
    expect(within(then).getByRole("option", { name: /Go ahead/ })).toBeEnabled();
    await user.selectOptions(then, "proceed");
    await user.click(screen.getByTestId("builder-approval-when-add"));
    expect(screen.getByTestId("builder-approval-when")).toBeInTheDocument();
    await user.click(screen.getByTestId("builder-approval-when-always"));
    await user.click(screen.getByTestId("builder-approval-toggle"));
    expect(screen.getByTestId("flow-box-update")).toHaveTextContent("on its own");
    await save(user, sent);
    expect(savedStep(sent, "update")?.checks?.approval).toMatchObject({
      required: "not_required",
      ifNoAnswer: "proceed",
    });
  });

  it("adds an urgent notice that must be seen in time", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "update");
    await user.click(screen.getByTestId("builder-notify-add"));
    await user.type(screen.getByTestId("builder-notify-0-message"), "The bill changed");
    await user.selectOptions(screen.getByTestId("builder-notify-0-to-add"), "lead");
    await user.click(screen.getByTestId("builder-notify-0-urgent"));
    await user.selectOptions(screen.getByTestId("builder-notify-0-ack"), "15 minutes");
    expect(screen.getByTestId("flow-box-update")).toHaveTextContent("Urgent notice");
    await save(user, sent);
    expect(savedStep(sent, "update")?.checks?.notify).toEqual([
      {
        to: ["client_admin", "lead"],
        channel: "inbox",
        message: "The bill changed",
        urgent: { ackWithin: "15 minutes", ifNoAnswer: "stop" },
      },
    ]);
  });

  it("edits a person step's deadline: business hours, reminders, skip, and who is told", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "ask");
    await user.selectOptions(screen.getByTestId("builder-person-deadline-hours"), "business");
    // Reminders that aren't evenly apart are written out.
    await user.selectOptions(screen.getByTestId("builder-person-deadline-remind-times"), "set");
    await user.type(screen.getByTestId("builder-person-deadline-remind"), "1 hour, 4 hours");
    await user.selectOptions(screen.getByTestId("builder-person-deadline-then"), "skip");
    await user.selectOptions(screen.getByTestId("builder-person-deadline-tell-add"), "operator");
    // Its deadline reads on its box, in full once the pointer rests on it.
    expect(await tipOf(user, "ask")).toHaveTextContent("2 days in business hours");
    await user.unhover(screen.getByTestId("flow-box-ask"));
    await save(user, sent);
    expect(savedStep(sent, "ask")).toMatchObject({
      deadline: {
        after: "2 days",
        hours: "business",
        remind: ["1 hour", "4 hours"],
        ifNoAnswer: "skip",
        tell: ["operator"],
      },
    });
  });

  // Owner, 2026-11-21 (docs/plan.md §1.177): "a time picker not an open field… custom should have
  // weeks, days, hours, minutes… how many times to remind them".
  it("picks a wait and its reminders: a common time, a custom one, so many times so far apart", async () => {
    const { sent } = setup();
    const user = userEvent.setup();
    await select(user, "ask");
    const after = screen.getByTestId("builder-person-deadline-after");
    // The stored "2 days" is one of the common times.
    expect(after).toHaveValue("2 days");
    expect(screen.queryByTestId("builder-person-deadline-after-custom")).toBeNull();
    await user.selectOptions(after, "custom");
    await user.clear(screen.getByTestId("builder-person-deadline-after-days"));
    await user.type(screen.getByTestId("builder-person-deadline-after-days"), "1");
    await user.type(screen.getByTestId("builder-person-deadline-after-hours"), "12");
    // Five reminders, one every 30 minutes; then three, an hour apart.
    const times = screen.getByTestId("builder-person-deadline-remind-times");
    expect(times).toHaveValue("none");
    await user.selectOptions(times, "5");
    expect(screen.getByTestId("builder-person-deadline-remind-words")).toHaveTextContent(
      "Reminds them 5 times, every 30 minutes: the last 2 hours 30 minutes after asking.",
    );
    await user.selectOptions(times, "3");
    await user.selectOptions(screen.getByTestId("builder-person-deadline-remind-every"), "1 hour");
    await save(user, sent);
    expect(savedStep(sent, "ask")).toMatchObject({
      deadline: { after: "36 hours", remind: ["1 hour", "2 hours", "3 hours"] },
    });
  });

  it("customizes a skill step against the skill's own values, and says what can't apply", async () => {
    const when = {
      match: "all" as const,
      rules: [{ field: "{{input.vendor}}", op: "=" as const, value: "Home Depot" }],
    };
    const categorize = {
      ref: "custom:categorize",
      source: "shared" as const,
      version: 1,
      definition: {
        schemaVersion: 1 as const,
        id: "custom:categorize",
        name: "Pick the account",
        description: "Rules first, then a model",
        category: "custom",
        mode: "agent" as const,
        method: "rules_then_ai" as const,
        instructions: "Pick the account for each line.",
        tools: [],
        input: { type: "object", properties: { vendor: { type: "string" } } },
        output: {
          type: "object",
          properties: { account: { type: "string" }, confidence: { type: "number" } },
        },
        settings: [
          {
            key: "threshold",
            label: "Threshold",
            type: "number" as const,
            default: 0.8,
            clientSpecific: false,
          },
        ],
        rules: [{ id: "home-depot", name: "Home Depot", when, set: { account: "Materials" } }],
        requiresConnectors: [],
        requiresPacks: [],
        producesAlerts: false,
      },
    };
    const { sent } = setup({ catalog: { ...CATALOG, skills: [...CATALOG.skills, categorize] } });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-skill:custom:categorize"));
    expect(screen.getByTestId("builder-customize-method")).toHaveTextContent(
      "Rules, then AI for what they leave open",
    );
    expect(screen.getByTestId("builder-setting-threshold-template")).toHaveTextContent(
      "The skill's default: 0.8",
    );
    await user.type(screen.getByTestId("builder-setting-threshold"), "0.9");
    await user.type(screen.getByTestId("builder-customize-instructions"), "Prefer Materials.");
    expect(screen.getByTestId("builder-customize-own-instructions")).toHaveTextContent(
      "Pick the account for each line.",
    );
    await user.click(screen.getByTestId("builder-rule-home-depot-edit"));
    await user.click(screen.getByTestId("builder-rule-add"));
    await user.click(screen.getByTestId("builder-customize-keep-confidence"));
    // A row that sets a field the step no longer passes on can't apply: core says why.
    const set = screen.getByTestId("builder-rule-added-0-set");
    fireEvent.change(set, { target: { value: '{"confidence": 1}' } });
    expect(screen.getByTestId("builder-customize-problems")).toHaveTextContent(
      "rule “Rule 2” sets confidence, not an output field",
    );
    fireEvent.change(set, { target: { value: '{"account": "Tools"}' } });
    expect(screen.queryByTestId("builder-customize-problems")).toBeNull();
    await save(user, sent);
    const step = savedLast(sent);
    // Wave 3b: an added row's id is a uuidv7 (merged three-way by id, never a counter that a
    // template's and a client's rows could both take); its name is what people read.
    const added = step?.kind === "skill" ? step.customize?.rules?.add?.[0] : undefined;
    expect(added?.id).toMatch(
      /^rule-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(step?.kind === "skill" ? step.customize : null).toEqual({
      settings: { threshold: 0.9 },
      addInstructions: "Prefer Materials.",
      rules: {
        add: [
          {
            id: added?.id,
            name: "Rule 2",
            when: { match: "all", rules: [] },
            set: { account: "Tools" },
          },
        ],
        edit: [{ id: "home-depot", when, set: { account: "Materials" } }],
      },
      keep: ["account"],
    });
  });

  it("edits a conversation step: who, the channel, what to find, and who signs its messages", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-conversation"));
    await user.type(screen.getByTestId("builder-conversation-with"), "c-42");
    await user.selectOptions(screen.getByTestId("builder-conversation-channel"), "call");
    await user.type(screen.getByTestId("builder-conversation-goal"), "Confirm the delivery date");
    const name = screen.getByTestId("builder-conversation-find-0");
    await user.clear(name);
    await user.type(name, "deliveryDate");
    await user.selectOptions(screen.getByTestId("builder-conversation-find-0-type"), "date");
    // A client agent that acts, on a connection that allows auto: later messages may go under
    // the first yes.
    await user.selectOptions(screen.getByTestId("builder-conversation-later"), "within_goal");
    await save(user, sent);
    expect(savedLast(sent)).toMatchObject({
      kind: "conversation",
      with: "c-42",
      channel: "call",
      goal: "Confirm the delivery date",
      find: { deliveryDate: "date" },
      messages: { first: "required", later: "within_goal" },
      deadline: { after: "3 days", hours: "clock", ifNoAnswer: "stop" },
    });
  });

  it("holds a skill that contacts people to approval as a write is", async () => {
    const reach = {
      ref: "comms.reach-out",
      source: "builtin" as const,
      version: null,
      definition: {
        schemaVersion: 1 as const,
        id: "comms.reach-out",
        name: "Reach out",
        description: "Contact someone",
        category: "comms",
        mode: "agent" as const,
        tools: [],
        input: { type: "object" },
        output: { type: "object" },
        settings: [],
        requiresConnectors: [],
        requiresPacks: [],
        producesAlerts: false,
        reachesPeople: true,
      },
    };
    setup({
      agent: { kind: "template", tenantId: null, bindings: {} },
      catalog: { ...CATALOG, skills: [...CATALOG.skills, reach] },
    });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-skill:comms.reach-out"));
    expect(screen.getByTestId("builder-approval")).toHaveTextContent(
      "This step contacts people outside the client's team.",
    );
    expect(screen.getByTestId("builder-approval-toggle")).toBeChecked();
    expect(screen.getByTestId("builder-approval-toggle")).toBeDisabled();
    expect(screen.queryByTestId("builder-approval-remove")).toBeNull();
    expect(screen.getByTestId("builder-approval-reason")).toHaveTextContent(
      "Templates keep approval on",
    );
  });

  it("keeps a template's conversation messages signed", async () => {
    setup({ agent: { kind: "template", tenantId: null, bindings: {} } });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-conversation"));
    expect(screen.getByTestId("builder-conversation-first")).toBeDisabled();
    expect(
      within(screen.getByTestId("builder-conversation-later")).getByRole("option", {
        name: /Go under the first yes/,
      }),
    ).toBeDisabled();
    expect(screen.getByTestId("builder-conversation-messages-reason")).toHaveTextContent(
      "Templates keep approval on",
    );
  });

  // Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): fork on how a step ended.
  describe("forks on how a step ended", () => {
    it("offers earlier steps' outcomes in words in an if's conditions, never a later step's", async () => {
      const { sent } = setup();
      const user = userEvent.setup();
      await select(user, "confidence");
      await user.click(screen.getByTestId("builder-path-low-rule-0-field-pick"));
      const list = screen.getByTestId("builder-path-low-rule-0-field-paths");
      expect(
        within(list).getByTestId("builder-path-low-rule-0-field-path-steps.find.outcome"),
      ).toHaveTextContent("Find supporting document: how it ended");
      expect(
        within(list).queryByTestId("builder-path-low-rule-0-field-path-steps.update.outcome"),
      ).toBeNull();
      expect(
        within(list).queryByTestId("builder-path-low-rule-0-field-path-steps.confidence.outcome"),
      ).toBeNull();
      // One pick adds "how an earlier step ended", its value a dropdown in words.
      const add = screen.getByTestId("builder-path-low-add-outcome");
      expect(within(add).queryByRole("option", { name: /Update the record/ })).toBeNull();
      await user.selectOptions(add, "steps.read.outcome=done");
      await save(user, sent);
      expect(savedStep(sent, "confidence")).toMatchObject({
        paths: [
          {
            id: "low",
            when: {
              rules: [
                { field: "{{steps.read.output.confidence}}", op: "<", value: 0.9 },
                { field: "{{steps.read.outcome}}", op: "=", value: "done" },
              ],
            },
          },
          { id: "big" },
        ],
      });
      const value = screen.getByTestId("builder-path-low-rule-1-value");
      expect(within(value).getByRole("option", { name: "was rejected" })).toBeInTheDocument();
      await user.selectOptions(value, "rejected");
      await save(user, sent);
      expect(
        (savedStep(sent, "confidence") as processes.IfStep).paths[0]?.when.rules[1]?.value,
      ).toBe("rejected");
    });

    it("adds a route right after a step, sets what it needs and says so, approval on", async () => {
      const { sent } = setup();
      const user = userEvent.setup();
      await select(user, "update");
      expect(screen.getByTestId("builder-routes-now")).toHaveTextContent(
        "Later steps can route on: was done.",
      );
      await user.click(screen.getByTestId("builder-route-rejected-add"));
      expect(screen.getByTestId("builder-route-added")).toHaveTextContent(
        "Added “If rejected” right after this step.",
      );
      expect(screen.getByTestId("builder-route-added-change")).toHaveTextContent(
        "If rejected: When a person rejects it, the step is skipped and the run goes on to the route. Approval stays on.",
      );
      // The route still ends the run after a no, as a no always did, and says so.
      expect(screen.getByTestId("builder-route-added-stop")).toHaveTextContent(
        "The route ends with a stop step, so nothing below it runs, as before. Remove that stop to carry on below.",
      );
      expect(screen.getByTestId("builder-routes-now")).toHaveTextContent("was rejected");
      await save(user, sent);
      expect(savedStep(sent, "update")?.checks?.approval).toEqual({
        required: "required",
        mode: "in_turn",
        ifNoAnswer: "stop",
        onReject: "continue",
      });
      expect(savedLast(sent)).toMatchObject({
        kind: "if",
        name: "If rejected",
        paths: [
          {
            name: "Rejected",
            when: {
              match: "all",
              rules: [{ field: "{{steps.update.outcome}}", op: "=", value: "rejected" }],
            },
            steps: [{ kind: "stop", name: "Stop the run", status: "cancelled" }],
          },
        ],
        otherwise: { steps: [] },
      });
      expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    });

    it("saves 'if this step fails: carry on' and takes it back off", async () => {
      const { sent } = setup();
      const user = userEvent.setup();
      await select(user, "find");
      expect(screen.getByTestId("builder-on-error")).toHaveValue("fail");
      await user.selectOptions(screen.getByTestId("builder-on-error"), "continue");
      await save(user, sent);
      expect(savedStep(sent, "find")?.onError).toBe("continue");
      // A failure is something later steps can now route on.
      expect(screen.getByTestId("builder-routes-now")).toHaveTextContent("failed");
      await user.selectOptions(screen.getByTestId("builder-on-error"), "fail");
      await save(user, sent);
      expect(savedStep(sent, "find")).not.toHaveProperty("onError");
      // A person step has no failure of its own to carry on past.
      await user.click(screen.getByTestId("flow-box-ask"));
      expect(screen.queryByTestId("builder-on-error")).toBeNull();
    });
  });
});

// Skill model (2026-11-10), Wave B item 9: action write steps in the builder.
describe("action write steps", () => {
  const PREPARE_BILL = {
    ref: "ap.prepare-bill",
    source: "builtin" as const,
    version: null,
    definition: {
      schemaVersion: 1 as const,
      id: "ap.prepare-bill",
      name: "Prepare bill",
      description: "Reads an invoice into a bill",
      category: "documents",
      mode: "agent" as const,
      tools: [],
      input: { type: "object", properties: { documentId: { type: "string" } } },
      output: {
        type: "object",
        properties: {
          vendorId: { type: "string" },
          invoiceNumber: { type: "string" },
          date: { type: "string" },
          currency: { type: "string" },
          total: { type: "string" },
          lines: { type: "array", items: { type: "object" } },
        },
      },
      settings: [],
      requiresConnectors: [],
      requiresPacks: [],
      producesAlerts: false,
    },
  };
  const catalog: BuilderCatalog = { ...CATALOG, skills: [...CATALOG.skills, PREPARE_BILL] };

  it("offers the four actions in their own group, each added with approval on", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    const group = screen.getByTestId("flow-rail-tool-actions");
    expect(group).toHaveTextContent("Actions");
    for (const [action, title] of [
      ["send_email", "Send email"],
      ["send_text", "Send text"],
      ["create_bill", "Create bill"],
      ["create_vendor", "Create vendor"],
    ]) {
      expect(within(group).getByTestId(`flow-rail-item-action:${action}`)).toHaveTextContent(
        title as string,
      );
    }
    await user.click(screen.getByTestId("flow-rail-item-action:create_bill"));
    const added = rootOrder()[4] as string;
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("needs approval");
    // The inspector says which tool it will use for this agent: it has no accounting connection.
    const inspector = screen.getByTestId("builder-inspector");
    expect(within(inspector).getByTestId("builder-action-target")).toHaveTextContent(
      "Create bill needs an accounting connection: bind QuickBooks or BILL",
    );
    expect(within(inspector).getByTestId("builder-input-invoiceNumber")).toBeInTheDocument();
  });

  it("after a skill whose output fits, offers the write with its fields mapped", async () => {
    setup({ catalog });
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("flow-rail-item-skill:ap.prepare-bill"));
    const prep = rootOrder()[4] as string;
    const offer = within(screen.getByTestId("builder-inspector")).getByTestId(
      "builder-offer-create_bill",
    );
    expect(offer).toHaveTextContent("Add: Create bill");
    expect(screen.queryByTestId("builder-offer-send_email")).toBeNull();
    await user.click(offer);
    const order = rootOrder();
    expect(order).toHaveLength(6);
    expect(order[4]).toBe(prep);
    const added = order[5] as string;
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("Create bill");
    expect(screen.getByTestId(`flow-box-${added}`)).toHaveTextContent("needs approval");
    // The new step is selected, its fields filled from the skill's result.
    const inspector = screen.getByTestId("builder-inspector");
    expect(within(inspector).getByTestId("builder-action-target")).toBeInTheDocument();
    expect(within(inspector).getByTestId("builder-input-total")).toHaveValue(
      `{{steps.${prep}.output.total}}`,
    );
  });
});
