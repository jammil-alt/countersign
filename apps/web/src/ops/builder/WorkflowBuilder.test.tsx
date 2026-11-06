// The workflow builder on a fake API: adding from the palette, reordering and moving into and out
// of fork paths with the keyboard (dnd-kit's keyboard sensor), deleting and undoing, the Approval
// control's enabled and disabled rules, invalid markers with a clickable summary, and the bundle
// it saves keeping every step, path and id.
import {
  AgentBundle,
  type AgentBundleInput,
  type BuilderCatalog,
  canonicalJson,
  nodeIds,
  type PermissionMatrix,
} from "@countersign/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
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
}

function setup(options: Setup = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const record = (path: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ path, body });
    return body;
  };
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => options.catalog ?? CATALOG,
    "GET /api/ops/catalog/events": () => EVENTS,
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
    const { workflow = "" } = useParams();
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
      />
    );
  }
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter initialEntries={[`${BASE}/workflows/new-bill`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
          <Route path="/ops/runs/:id" element={<p>The run page</p>} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, sent, changed: () => changed };
}

/** Top-level step ids as the canvas shows them, top to bottom. */
function rootOrder(): string[] {
  const list = screen.getByTestId("builder-list-root");
  return [...list.querySelectorAll(":scope > li > [data-testid^='builder-step-']")].map((el) =>
    (el.getAttribute("data-testid") ?? "").replace("builder-step-", ""),
  );
}

function listOrder(container: string): string[] {
  const list = screen.queryByTestId(`builder-list-${container}`);
  if (!list) return [];
  return [...list.querySelectorAll(":scope > li > [data-testid^='builder-step-']")].map((el) =>
    (el.getAttribute("data-testid") ?? "").replace("builder-step-", ""),
  );
}

// jsdom lays nothing out, so dnd-kit's keyboard sensor would see every droppable at 0,0. Give each
// draggable or droppable node a rect by its place in the document (one row of 50px each), and the
// drag overlay the rect of the step being dragged, where a browser would place it.
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // no storage in this environment
  }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const nodes = [...document.querySelectorAll("[data-dnd-node]")];
    let target: Element = this;
    if (this.matches("[data-drag-overlay]") || this.querySelector("[data-drag-overlay]")) {
      target = document.querySelector('[aria-pressed="true"]')?.closest("[data-dnd-node]") ?? this;
    }
    const i = nodes.indexOf(target);
    if (i === -1) return realRect.call(this);
    const top = i * 50;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 300,
      bottom: top + 40,
      width: 300,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  };
});
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

async function ready() {
  return screen.findByTestId("builder-canvas");
}

/** Picks a step up by its handle, presses the arrows, and drops it. */
async function keyboardMove(user: ReturnType<typeof userEvent.setup>, id: string, keys: string) {
  // After a drop dnd-kit gives focus back to the dropped step's handle on the next frame; let it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const handle = screen.getByTestId(`builder-step-${id}-handle`);
  act(() => handle.focus());
  await user.keyboard("[Space]");
  for (const key of keys.split(" ")) await user.keyboard(`[${key}]`);
  await user.keyboard("[Space]");
}

describe("WorkflowBuilder", () => {
  it("lays the workflow out with numbers, kinds and the header's counts", async () => {
    setup();
    await ready();
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.getByTestId("builder-step-find-number")).toHaveTextContent("1");
    expect(screen.getByTestId("builder-trigger")).toHaveTextContent("When transaction.created");
    expect(listOrder("path:low")).toEqual(["ask"]);
    expect(screen.getByTestId("builder-counts")).toHaveTextContent(
      "Purchasing · 5 steps · 1 fork · 1 change your tools · 1 need approval",
    );
    expect(screen.getByTestId("builder-version")).toHaveTextContent("Draft · v1");
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    expect(screen.getByTestId("builder-step-update-approval")).toHaveTextContent("Approval");
  });

  it("adds a step from the palette with +, approval on for a write, and marks what is invalid", async () => {
    setup();
    await ready();
    const user = userEvent.setup();

    // The agent's own skills come first, then the library; actions are grouped by tool.
    const skills = screen.getByTestId("builder-palette-skills");
    expect(
      within(skills)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("Read a document"),
      expect.stringContaining("Find supporting document"),
      expect.stringContaining("Track price changes"),
    ]);
    const actions = screen.getByTestId("builder-palette-actions");
    expect(within(actions).getByText("Update record")).toBeInTheDocument();
    expect(within(actions).queryByText(/query/i)).toBeNull();

    await user.click(screen.getByTestId("builder-palette-item-action:testkit.record.update-add"));
    const order = rootOrder();
    expect(order).toHaveLength(5);
    const added = order[4] as string;
    expect(screen.getByTestId(`builder-step-${added}-approval`)).toHaveTextContent("Approval");
    // Its required input is missing: the step is marked, and the summary names it.
    expect(screen.getByTestId(`builder-step-${added}-invalid`)).toBeInTheDocument();
    const problems = screen.getByTestId("builder-problems");
    expect(problems).toHaveTextContent('Update record: "id" is required');
    expect(screen.getByTestId("builder-publish")).toBeDisabled();
    expect(screen.getByTestId("builder-test-run")).toBeDisabled();

    // Clicking the problem selects the step and focuses the field.
    await user.click(screen.getByTestId("builder-problem-0"));
    const field = within(screen.getByTestId("builder-inspector")).getByTestId("builder-input-id");
    expect(field).toHaveFocus();
    await user.type(field, "r-1");
    expect(screen.queryByTestId(`builder-step-${added}-invalid`)).toBeNull();
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
      "Agent: skill docs.gone not found",
    );
    expect(screen.getByTestId("builder-publish")).toBeDisabled();
  });

  it("adds a library skill and the agent gains it; searching narrows the palette", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("builder-palette-search"), "price");
    expect(screen.queryByTestId("builder-palette-actions")).toBeNull();
    await user.click(screen.getByTestId("builder-palette-item-skill:custom:price-watch-add"));
    expect(screen.getByTestId("builder-valid")).toBeInTheDocument();
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const bundle = sent[0]?.body.bundle as AgentBundle;
    expect(bundle.definition.skills.map((s) => s.skill)).toEqual([
      "docs.find-support",
      "docs.extract",
      "custom:price-watch",
    ]);
  });

  it("reorders with the keyboard: pick up by the handle, arrow, drop", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await keyboardMove(user, "read", "ArrowUp");
    await waitFor(() => expect(rootOrder()).toEqual(["read", "find", "confidence", "update"]));
    expect(screen.getByTestId("builder-step-read-number")).toHaveTextContent("1");
    // Moving the reader above the step it reads from breaks its reference: marked invalid.
    expect(screen.getByTestId("builder-step-read-invalid")).toBeInTheDocument();
  });

  it("moves a step into a fork path and back out", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    // From the bottom: past otherwise's drop zone into the "Big change" path's.
    await keyboardMove(user, "update", "ArrowUp ArrowUp");
    await waitFor(() => expect(listOrder("path:big")).toEqual(["update"]));
    expect(rootOrder()).toEqual(["find", "read", "confidence"]);
    // A step inside a path has no number.
    expect(screen.queryByTestId("builder-step-update-number")).toBeNull();

    // And out of a path: down past the other path's step and the drop zones to the end of the list.
    await keyboardMove(user, "ask", "ArrowDown ArrowDown ArrowDown ArrowDown ArrowDown");
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence", "ask"]));
    expect(listOrder("path:low")).toEqual([]);
    expect(listOrder("path:big")).toEqual(["update"]);
    expect(screen.getByTestId("builder-step-ask-number")).toHaveTextContent("4");

    // Onto a top-level step from inside a path: it goes in just before that step.
    await keyboardMove(user, "update", "ArrowDown ArrowDown ArrowDown");
    await waitFor(() =>
      expect(rootOrder()).toEqual(["find", "read", "confidence", "update", "ask"]),
    );
  });

  it("deletes a step, then undoes and redoes it", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-read-delete"));
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
    expect(screen.getByTestId("builder-unsaved")).toBeInTheDocument();
    await user.click(screen.getByTestId("builder-undo"));
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.queryByTestId("builder-unsaved")).toBeNull();
    await user.click(screen.getByTestId("builder-redo"));
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
  });

  describe("approval control", () => {
    async function selectUpdate() {
      await ready();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("builder-step-update-select"));
      return { user, toggle: screen.getByTestId("builder-approval-toggle") };
    }

    it("lets a client agent run a step without approval where the connection allows auto", async () => {
      setup();
      const { user, toggle } = await selectUpdate();
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
      await user.click(toggle);
      expect(toggle).not.toBeChecked();
      expect(screen.getByTestId("builder-step-update-approval")).toHaveTextContent(
        "Runs automatically",
      );
      expect(screen.getByTestId("builder-counts")).toHaveTextContent(
        "1 change your tools · 0 need approval",
      );
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
      expect(screen.getByTestId("builder-step-update-invalid")).toBeInTheDocument();
      expect(screen.getByTestId("builder-step-update-approval")).toHaveTextContent("Approval");
      // Switching it back on is always allowed.
      expect(toggle).toBeEnabled();
      await user.click(toggle);
      expect(screen.queryByTestId("builder-step-update-invalid")).toBeNull();
      expect(toggle).toBeDisabled();
    });
  });

  it("edits a fork's paths as rule rows: add a condition and a path", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-confidence-select"));
    const big = screen.getByTestId("builder-path-big");
    await user.click(within(big).getByTestId("builder-path-big-add-condition"));
    // The new rule names no field yet: the path is invalid until it does.
    expect(screen.getByTestId("builder-step-confidence-invalid")).toBeInTheDocument();
    await user.click(within(big).getByTestId("builder-path-big-rule-1-field-pick"));
    await user.click(
      within(big).getByTestId("builder-path-big-rule-1-field-path-steps.read.output.total"),
    );
    await user.type(within(big).getByTestId("builder-path-big-rule-1-value"), "1000");
    expect(screen.queryByTestId("builder-step-confidence-invalid")).toBeNull();
    expect(screen.getByTestId("builder-fork-confidence-path-big")).toHaveTextContent(
      "if Read a document · total > 500 and Read a document · total = 1000",
    );

    await user.click(screen.getByTestId("builder-fork-add-path"));
    expect(
      within(screen.getByTestId("builder-fork-confidence")).getAllByRole("region"),
    ).toHaveLength(4);
  });

  it("saves the bundle with every step, path and id it had, as a draft of the version it opened", async () => {
    const { sent, changed } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-find-select"));
    const name = screen.getByTestId("builder-inspector-name");
    await user.clear(name);
    await user.type(name, "Find the invoice");
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0]?.body as { bundle: AgentBundle; parentVersionId: string };
    expect(body.parentVersionId).toBe(V1);
    const before = BUNDLE.workflows[0]?.workflow;
    const after = AgentBundle.parse(body.bundle).workflows[0]?.workflow;
    if (!before || !after) throw new Error("no workflow");
    expect(nodeIds(after)).toEqual(nodeIds(before));
    // Nothing but the name changed.
    const renamed = AgentBundle.parse(body.bundle);
    const step = renamed.workflows[0]?.workflow.steps[0];
    if (step) step.name = "Find supporting document";
    expect(canonicalJson(renamed)).toBe(canonicalJson(BUNDLE));
    expect(await screen.findByTestId("builder-notice")).toHaveTextContent("Saved v2 as a draft.");
    expect(screen.getByTestId("builder-version")).toHaveTextContent("Draft · v2");
    expect(changed()).toBe(1);
  });

  it("publishes the version it opened, or saves then publishes", async () => {
    const { sent } = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-publish"));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual([`publish ${V1}`]));
    expect(await screen.findByTestId("builder-notice")).toHaveTextContent("Published v1.");
    expect(screen.getByTestId("builder-publish")).toBeDisabled();

    await user.click(screen.getByTestId("builder-step-update-delete"));
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

  it("adds a workflow and switches to it, keeping the other's edits", async () => {
    setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-read-delete"));
    await user.click(screen.getByTestId("builder-workflow-add"));
    await user.type(screen.getByTestId("builder-workflow-name"), "Weekly digest");
    expect(screen.getByTestId("builder-workflow-slug")).toHaveValue("weekly-digest");
    await user.selectOptions(screen.getByTestId("builder-workflow-trigger"), "schedule");
    await user.click(screen.getByTestId("builder-workflow-create"));
    expect(await screen.findByTestId("builder-workflow-weekly-digest-select")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("builder-trigger")).toHaveTextContent("On a schedule");
    expect(rootOrder()).toEqual([]);

    await user.click(screen.getByTestId("builder-workflow-new-bill-select"));
    await waitFor(() => expect(rootOrder()).toEqual(["find", "confidence", "update"]));
  });

  it("keeps the session's rolling draft on this device and restores it", async () => {
    const first = setup();
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-read-delete"));
    await waitFor(
      () =>
        expect(screen.getByTestId("builder-draft-status")).toHaveTextContent(
          /Draft kept on this device/,
        ),
      { timeout: 3500 },
    );
    // Nothing became a version: that waits for Save draft, Test run or Publish.
    expect(first.sent).toHaveLength(0);

    cleanup();
    setup();
    await ready();
    expect(screen.getByTestId("builder-notice")).toHaveTextContent(/Restored your unsaved changes/);
    expect(rootOrder()).toEqual(["find", "confidence", "update"]);
    await user.click(screen.getByTestId("builder-discard-draft"));
    expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]);
    expect(screen.queryByTestId("builder-unsaved")).toBeNull();
  });

  it("treats the API's no-op answer as saved", async () => {
    const { api } = setup();
    api.on(
      `POST /api/ops/agents/${AGENT_ID}/versions`,
      () => new Reply(409, { error: { code: "no_op", message: "nothing changed" } }),
    );
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("builder-step-find-select"));
    await user.type(screen.getByTestId("builder-inspector-name"), "!");
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(screen.queryByTestId("builder-unsaved")).toBeNull());
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
    expect(screen.getByTestId("builder-step-follow")).toHaveTextContent("polite-follow-up@2");
    await user.click(screen.getByTestId("builder-step-follow-select"));
    expect(screen.getByTestId("builder-automation")).toHaveTextContent("Polite follow-up · v2");
    expect(screen.queryByTestId("builder-step-follow-invalid")).toBeNull();
  });
});

// UI-2c (O6): the Builder beside the canvas, "Save as automation", and a model per step.
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
    expect(screen.getByTestId("builder-chat-empty")).toBeInTheDocument();
    await user.type(screen.getByTestId("builder-chat-composer-input"), "Drop the update step");
    await user.click(screen.getByTestId("builder-chat-composer-send"));
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence"]));
    expect(bodies[0]).toEqual({ kind: "agent", agentId: AGENT_ID, fromVersionId: V1 });
    expect(bodies[1]).toEqual({ text: "Drop the update step" });
    expect(screen.getByTestId("builder-unsaved")).toBeInTheDocument();

    await user.click(screen.getByTestId("builder-change-undo"));
    await waitFor(() => expect(rootOrder()).toEqual(["find", "read", "confidence", "update"]));
    expect(bodies[2]).toEqual({ turnId: TURN, changeId: "step:update" });
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
    await user.click(screen.getByTestId("builder-step-find-select"));
    await user.type(screen.getByTestId("builder-inspector-name"), "!");
    await user.click(screen.getByTestId("builder-rail-builder"));
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
    await user.click(screen.getByTestId("builder-palette-item-automation:polite-follow-up@2-add"));
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
    await user.click(screen.getByTestId("builder-step-find-select"));
    const select = await screen.findByTestId("builder-inspector-model");
    await screen.findByText(/Fast · claude-haiku-4-5/);
    await user.selectOptions(select, "claude-haiku-4-5");
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const saved = AgentBundle.parse((sent[0]?.body as { bundle: unknown } | undefined)?.bundle);
    const find = saved.workflows[0]?.workflow.steps[0];
    expect(find?.kind === "skill" ? find.model : null).toEqual({ id: "claude-haiku-4-5" });
  });
});
