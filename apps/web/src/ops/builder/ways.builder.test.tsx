// Triggers and outputs in the builder (owner, 2026-11-23; the mock-up "Ways in, ways out"), on a
// fake API: a template whose main workflow is fed by a nightly scan (a trigger) and hands its
// result to a bill workflow (an output). The tabs say which is which; the main workflow's chart
// has its triggers above and its outputs below, each opening its tab; a trigger's and an output's
// tab lead back to the main workflow; and the rail places a hand-in already pointed at it.
import {
  AgentBundle,
  type AgentBundleInput,
  type BuilderCatalog,
  type steps,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { blankBundle } from "../agents/definition-form";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b501";
const V1 = "00000000-0000-4000-8000-0000000f0501";
const V2 = "00000000-0000-4000-8000-0000000f0502";
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

const BUNDLE: AgentBundleInput = {
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
    bundle: AgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

// What the builder saves becomes the agent's latest version when it reloads (as the agent screen
// does on `onChanged`), so a workflow saved here opens in its builder.
function setup(start = "check", stored: AgentBundleInput = BUNDLE) {
  const sent: { bundle: AgentBundle; changeNote?: string }[] = [];
  let current = AgentBundle.parse(stored);
  const listeners = new Set<() => void>();
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    [`GET /api/ops/agents/${AGENT_ID}/action-catalog`]: () => ({ groups: [] }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { bundle: unknown; changeNote?: string };
      current = AgentBundle.parse(body.bundle);
      sent.push({ ...body, bundle: current });
      return {
        version: {
          ...version(),
          id: V2,
          agentId: AGENT_ID,
          version: sent.length + 1,
          authorType: "operator",
          mergedFromVersionIds: null,
          bundle: undefined,
        },
        errors: [],
      };
    },
  });
  function Page() {
    const { workflow = "" } = useParams();
    const [bundle, setBundle] = useState(current);
    useEffect(() => {
      const reload = () => setBundle(current);
      listeners.add(reload);
      return () => {
        listeners.delete(reload);
      };
    }, []);
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
        onChanged={() => {
          for (const reload of listeners) reload();
        }}
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
  return { user: userEvent.setup(), sent };
}

/** A wait added before a v5 workflow's End, then the draft saved: what that save sent. */
async function addWaitAndSave(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId("steps-builder");
  await user.click(await screen.findByTestId("flow-insert-root-0"));
  await user.click(await screen.findByTestId("palette-wait"));
  await user.click(screen.getByTestId("flow-bar-save"));
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

  // All ways in, in one place (owner, 2026-11-24).
  it("shows the main workflow's own starts with its trigger workflows, and adds one", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    const band = screen.getByTestId("ways-triggers");
    const start = within(band).getByTestId("way-start-t-check");
    expect(start).toHaveTextContent("Started by hand");
    expect(start).toHaveTextContent("Starts this workflow · no steps of its own");
    // The starts come first, then the trigger workflows.
    expect(band.firstElementChild).toBe(start);
    expect(within(band).getByTestId("way-card-scan")).toBeInTheDocument();

    // A start opens its settings in the side panel.
    await user.click(within(start).getByTestId("way-start-t-check-settings"));
    expect(await screen.findByTestId("builder-trigger-type")).toHaveValue("manual");
    expect(within(start).getByTestId("way-start-t-check-open")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // "Add a trigger" adds a start, opened to pick how it starts.
    await user.click(within(band).getByTestId("ways-add-trigger"));
    expect(within(band).getAllByTestId(/^way-start-.*-open$/)).toHaveLength(2);
    expect(screen.getByTestId("builder-trigger-type")).toBeInTheDocument();
  });

  it("gives a start steps by moving it to a new v5 workflow, saved and opened in the steps builder", async () => {
    const { user, sent } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("way-start-t-check-steps"));
    // Saved at once: the main workflow starts by hand, and the start's own workflow is in the step
    // model, handing into the main one at its first step, its End delivering "Nothing to do".
    await waitFor(() => expect(sent).toHaveLength(1));
    const saved = sent[0]?.bundle.workflows ?? [];
    expect(saved.map((w) => [w.slug, w.workflow.schemaVersion])).toEqual([
      ["check", 4],
      ["scan", 4],
      ["bill", 4],
      ["loose", 4],
      ["started-by-hand", 5],
    ]);
    const moved = saved[4]?.workflow as steps.Workflow;
    expect(moved.triggers.map((t) => t.id)).toEqual(["t-check"]);
    expect(moved.steps.map((x) => x.kind)).toEqual(["handoff", "end"]);
    expect(moved.steps[0]).toMatchObject({
      to: { agent: "@self", workflow: "check", step: "save" },
    });
    expect(moved.outputs).toMatchObject([{ name: "Nothing to do", kind: "nothing" }]);
    const main = saved[0]?.workflow as { triggers: { id: string }[] };
    expect(main.triggers.map((t) => t.id)).not.toContain("t-check");

    // It opens in the steps builder, and a draft of it saves with the processes kept as they are.
    await addWaitAndSave(user);
    await waitFor(() => expect(sent).toHaveLength(2));
    const again = sent[1]?.bundle.workflows ?? [];
    expect(again.slice(0, 4)).toEqual(saved.slice(0, 4));
    expect((again[4]?.workflow as steps.Workflow | undefined)?.steps.map((x) => x.kind)).toEqual([
      "wait",
      "handoff",
      "end",
    ]);
  });

  it("adds a new workflow as v5, saved and opened in the steps builder", async () => {
    const { user, sent } = setup("loose");
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("builder-workflow-add"));
    await user.type(screen.getByTestId("builder-workflow-name"), "Weekly digest");
    await user.selectOptions(screen.getByTestId("builder-workflow-trigger"), "schedule");
    await user.click(screen.getByTestId("builder-workflow-create"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const added = sent[0]?.bundle.workflows.find((w) => w.slug === "weekly-digest");
    expect(added?.workflow).toMatchObject({
      schemaVersion: 5,
      triggers: [{ on: { type: "schedule" } }],
      outputs: [{ name: "Nothing to do", kind: "nothing" }],
      steps: [{ kind: "end" }],
    });
    expect(sent[0]?.changeNote).toBe("Added the workflow Weekly digest");

    await addWaitAndSave(user);
    await waitFor(() => expect(sent).toHaveLength(2));
    const again = sent[1]?.bundle.workflows ?? [];
    expect(again.filter((w) => w.workflow.schemaVersion === 4).map((w) => w.slug)).toEqual([
      "check",
      "scan",
      "bill",
      "loose",
    ]);
    const saved = again.find((w) => w.slug === "weekly-digest")?.workflow as steps.Workflow;
    expect(saved.steps.map((x) => x.kind)).toEqual(["wait", "end"]);
  });

  it("adds and switches workflows inside the steps builder, for an agent of v5 workflows only", async () => {
    const blank = blankBundle({
      name: "Card receipts",
      role: "Expenses",
      mission: "Chase receipts",
      instructions: "",
      modelId: "",
    });
    const { user, sent } = setup("main", blank as AgentBundleInput);
    await screen.findByTestId("steps-builder");
    // One workflow: no switcher tabs yet, only "+ Workflow".
    expect(screen.queryByTestId("builder-workflow-main-select")).toBeNull();
    await user.click(screen.getByTestId("builder-workflow-add"));
    await user.type(screen.getByTestId("builder-workflow-name"), "Weekly digest");
    await user.selectOptions(screen.getByTestId("builder-workflow-trigger"), "schedule");
    await user.click(screen.getByTestId("builder-workflow-create"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.bundle.workflows.map((w) => [w.slug, w.workflow.schemaVersion])).toEqual([
      ["main", 5],
      ["weekly-digest", 5],
    ]);
    // It opens on the new workflow, and the switcher goes back and forth.
    // The tab shows as soon as the save lands; it is current once the builder has moved to it.
    await waitFor(() =>
      expect(screen.getByTestId("builder-workflow-weekly-digest-select")).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await addWaitAndSave(user);
    await waitFor(() => expect(sent).toHaveLength(2));
    const saved = sent[1]?.bundle.workflows ?? [];
    expect((saved[1]?.workflow as steps.Workflow | undefined)?.steps.map((x) => x.kind)).toEqual([
      "wait",
      "end",
    ]);
    expect(saved[0]).toEqual(sent[0]?.bundle.workflows[0]);
    await user.click(screen.getByTestId("builder-workflow-main-select"));
    await waitFor(() =>
      expect(screen.getByTestId("builder-workflow-main-select")).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(screen.getByTestId("steps-builder")).toBeTruthy();
  });

  it("opens a new agent's blank workflow in the steps builder, and its draft saves", async () => {
    const blank = blankBundle({
      name: "Card receipts",
      role: "Expenses",
      mission: "Chase receipts",
      instructions: "",
      modelId: "",
    });
    const { user, sent } = setup("main", blank as AgentBundleInput);
    await addWaitAndSave(user);
    await waitFor(() => expect(sent).toHaveLength(1));
    const saved = sent[0]?.bundle.workflows[0]?.workflow as steps.Workflow;
    expect(saved.schemaVersion).toBe(5);
    expect(saved.steps.map((x) => x.kind)).toEqual(["wait", "end"]);
    expect(saved.outputs).toMatchObject([{ name: "Nothing to do", kind: "nothing" }]);
  });
});
