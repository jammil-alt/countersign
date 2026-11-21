// Connections (owner, 2026-11-14) in the builder, on a fake API: each step's inspector shows its
// "Prior step" and "Next step"; a pick that breaks nothing moves the step and says so; one that
// would leave a step without data it reads says what and offers a place where it fits, or hands
// the move to the Builder; each picker can open the palette to add a new step right there.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  type SkillDefinition,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeChartRects, keyboardDrag, rootOrder } from "../../test/chart";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000c301";
const V1 = "00000000-0000-4000-8000-0000000f0c01";
const V2 = "00000000-0000-4000-8000-0000000f0c02";
const BASE = "/ops/templates/vendor-clerk";

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

const READ = skill("docs.read", "Read document", io({}), io({ vendorName: { type: "string" } }));
const CHECK = skill(
  "vendors.check",
  "Check vendor",
  io({ vendor: { type: "string" } }, ["vendor"]),
  io({ ok: { type: "boolean" } }),
);
const NOTE = skill("docs.note", "Note it", io({}), io({}));

const CATALOG: BuilderCatalog = {
  skills: [READ, CHECK, NOTE].map((definition) => ({
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
  automations: [],
};

const STEPS = [
  { id: "read", kind: "skill", name: "Read document", skill: READ.id, input: {} },
  {
    id: "check",
    kind: "skill",
    name: "Check vendor",
    skill: CHECK.id,
    input: { vendor: "{{steps.read.output.vendorName}}" },
  },
  { id: "note", kind: "skill", name: "Note it", skill: NOTE.id, input: {} },
];

const BUNDLE = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Vendor clerk", role: "Vendors", mission: "Check vendors" },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
    instructions: "Check vendors.",
    skills: [READ, CHECK, NOTE].map((s) => ({ skill: s.id, settings: {} })),
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
        steps: STEPS,
      },
    },
  ],
} as AnyAgentBundleInput;

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: null,
  kind: "template",
  slug: "vendor-clerk",
  name: "Vendor clerk",
  role: "Vendors",
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
  createdAt: "2026-11-14T00:00:00.000Z",
};

const VERSION = {
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
  createdAt: "2026-11-14T00:00:00.000Z",
  publishedAt: null,
  bundle: AnyAgentBundle.parse(BUNDLE),
} as unknown as VersionDetail;

function setup() {
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: () => ({
      version: { ...VERSION, id: V2, version: 2, parentVersionId: V1, bundle: undefined },
      errors: [],
    }),
  });
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={AGENT}
        from={VERSION}
        bundle={AnyAgentBundle.parse(BUNDLE)}
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
  return { user: userEvent.setup(), api };
}

/** The chart's steps, top to bottom: their ids, a new step's as "new". */
function order(): string[] {
  return rootOrder().map((id) => (["read", "check", "note"].includes(id) ? id : "new"));
}

const SESSION = "00000000-0000-4000-8000-0000000c6001";
/** The Builder's conversation, on the draft it was started from. */
const session = (bundle: unknown, turns: unknown[] = []) => ({
  session: {
    id: SESSION,
    kind: "agent",
    clientId: null,
    clientName: null,
    agentId: AGENT_ID,
    skillId: null,
    baseVersionId: V1,
    status: "open",
    bundle,
    errors: [],
    closest: [],
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
  },
  turns,
});
const ANSWER = {
  id: "00000000-0000-4000-8000-0000000c6102",
  seq: 2,
  role: "builder",
  text: "Check vendor reads the vendor name from Read document, which now runs after it.",
  command: null,
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0.01",
  undoneAt: null,
  createdAt: "2026-11-14T10:00:00.000Z",
};

describe("a step's connections in the builder", () => {
  it("shows the steps it is connected to now", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-check"));
    const box = screen.getByTestId("builder-connections");
    // In the step's side panel they read "Comes after" and "Goes to".
    expect(within(box).getByText("Comes after")).toBeTruthy();
    expect(within(box).getByText("Goes to")).toBeTruthy();
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe(
      "read",
    );
    expect((screen.getByTestId("builder-connection-next") as HTMLSelectElement).value).toBe("note");
  });

  it("moves the step at once when nothing breaks", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-note"));
    await user.selectOptions(screen.getByTestId("builder-connection-next"), "read");
    expect(order()).toEqual(["note", "read", "check"]);
    expect(screen.getByTestId("builder-connection-notice").textContent).toContain(
      "none loses data it needs",
    );
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe("");
  });

  it("says what a move would break and moves it where it fits instead", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-check"));
    // First: the vendor it reads from "Read document" would come after it.
    await user.selectOptions(screen.getByTestId("builder-connection-prior"), "");
    const review = screen.getByTestId("builder-connection-review");
    expect(within(review).getByTestId("builder-connection-issue-reads")).toBeTruthy();
    expect(review.textContent).toContain("Data a step reads would no longer come before it");
    expect(order()).toEqual(["read", "check", "note"]);
    await user.click(within(review).getByText("Put it after “Note it”, last instead"));
    expect(order()).toEqual(["read", "note", "check"]);
    expect(screen.queryByTestId("builder-connection-review")).toBeNull();
  });

  it("keeps the step where it was when asked", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-check"));
    await user.selectOptions(screen.getByTestId("builder-connection-prior"), "");
    await user.click(screen.getByTestId("builder-connection-keep"));
    expect(order()).toEqual(["read", "check", "note"]);
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe(
      "read",
    );
  });

  it("adds a new step right before this one from the prior step's list", async () => {
    const { user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-check"));
    await user.selectOptions(screen.getByTestId("builder-connection-prior"), "new step");
    expect(screen.getByTestId("builder-palette-target").textContent).toContain(
      "before “Check vendor”",
    );
    await user.click(screen.getByTestId(`flow-rail-item-skill:${NOTE.id}`));
    expect(order()).toEqual(["read", "new", "check", "note"]);
  });

  it("moves the step and asks the Builder to resolve all it breaks", async () => {
    const { user, api } = setup();
    const texts: string[] = [];
    // The draft is saved with the move first, and the Builder starts from it.
    let draft: unknown = null;
    api.on(`POST /api/ops/agents/${AGENT_ID}/versions`, ({ init }) => {
      draft = (JSON.parse(String(init.body)) as { bundle: unknown }).bundle;
      return {
        version: { ...VERSION, id: V2, version: 2, parentVersionId: V1, bundle: undefined },
        errors: [],
      };
    });
    api.on("POST /api/ops/builder/sessions", () => session(draft));
    api.on(`POST /api/ops/builder/sessions/${SESSION}/turns`, ({ init }) => {
      texts.push((JSON.parse(String(init.body)) as { text: string }).text);
      return { ...session(draft, [ANSWER]), turn: ANSWER };
    });
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-check"));
    await user.selectOptions(screen.getByTestId("builder-connection-prior"), "");
    await user.click(screen.getByTestId("builder-connection-ask"));
    expect(order()).toEqual(["check", "read", "note"]);
    const dialog = screen.getByRole("dialog", { name: "Fix “Check vendor”" });
    expect(within(dialog).getByTestId("builder-fix-problem").textContent).toContain(
      "Moved “Check vendor” to run first, before “Read document”",
    );
    expect(await within(dialog).findByText(ANSWER.text)).toBeTruthy();
    await waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain("Resolve a move in “Main”");
    expect(texts[0]).toContain("it ran between “Read document” and “Note it”");
    expect(texts[0]).toContain("step check, field input.vendor (template_scope)");
    expect(texts[0]).toContain("Don't change the workflow yet.");
  });

  // F6: the dot under a step dragged onto another makes that one come next, checked the same way.
  describe("from the chart", () => {
    let restore = () => {};
    beforeEach(() => {
      restore = fakeChartRects();
    });
    afterEach(() => restore());

    it("makes the step under the dot's target come next at once when nothing breaks", async () => {
      const { user } = setup();
      await screen.findByTestId("flow-chart");
      await keyboardDrag(user, "flow-dot-read", "flow-box-note");
      await waitFor(() => expect(order()).toEqual(["read", "note", "check"]));
      // The step that moved is open, and its connections say what was checked.
      expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "note");
      expect(screen.getByTestId("builder-connection-notice").textContent).toContain(
        "none loses data it needs",
      );
    });

    it("reviews a connection that would break something before making it", async () => {
      const { user } = setup();
      await screen.findByTestId("flow-chart");
      // "Read document" after "Note it": "Check vendor" would read it before it ran.
      await keyboardDrag(user, "flow-dot-note", "flow-box-read");
      const review = await screen.findByTestId("builder-connection-review");
      expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "read");
      expect(within(review).getByTestId("builder-connection-issue-reads")).toBeTruthy();
      expect(order()).toEqual(["read", "check", "note"]);
      await user.click(screen.getByTestId("builder-connection-keep"));
      expect(order()).toEqual(["read", "check", "note"]);
    });
  });
});
