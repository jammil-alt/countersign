// Connections (owner, 2026-11-14) in the builder, on a fake API: each step's inspector shows its
// "Prior step" and "Next step"; a pick that breaks nothing moves the step and says so; one that
// would leave a step without data it reads says what and offers a place where it fits.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  type SkillDefinition,
} from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000c301";
const V1 = "00000000-0000-4000-8000-0000000f0c01";
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
  version: 1,
  status: "draft",
  bundleHash: "h1",
  changeNote: null,
  releaseNote: null,
  authorId: null,
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
  return userEvent.setup();
}

/** The canvas's steps, top to bottom. */
function order(): string[] {
  return screen
    .getAllByTestId(/^builder-step-(read|check|note)-select$/)
    .map((el) => (el.dataset.testid ?? "").replace(/^builder-step-|-select$/g, ""));
}

describe("a step's connections in the builder", () => {
  it("shows the steps it is connected to now", async () => {
    const user = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-check-select"));
    const box = screen.getByTestId("builder-connections");
    expect(within(box).getByText("Prior step")).toBeTruthy();
    expect(within(box).getByText("Next step")).toBeTruthy();
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe(
      "read",
    );
    expect((screen.getByTestId("builder-connection-next") as HTMLSelectElement).value).toBe("note");
  });

  it("moves the step at once when nothing breaks", async () => {
    const user = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-note-select"));
    await user.selectOptions(screen.getByTestId("builder-connection-next"), "read");
    expect(order()).toEqual(["note", "read", "check"]);
    expect(screen.getByTestId("builder-connection-notice").textContent).toContain(
      "none loses data it needs",
    );
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe("");
  });

  it("says what a move would break and moves it where it fits instead", async () => {
    const user = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-check-select"));
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
    const user = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-check-select"));
    await user.selectOptions(screen.getByTestId("builder-connection-prior"), "");
    await user.click(screen.getByTestId("builder-connection-keep"));
    expect(order()).toEqual(["read", "check", "note"]);
    expect((screen.getByTestId("builder-connection-prior") as HTMLSelectElement).value).toBe(
      "read",
    );
  });
});
