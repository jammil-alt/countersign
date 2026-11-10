// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14) in the builder, on a fake API: a skill
// step says its kind, the model it runs on and where that came from, its parameters as the agent
// sets them with a step's own override, the version it pins and "Move to vN" (compatible in one
// click; breaking only once each downstream reference is remapped); a write to our own records
// reads "Save to records" with approval off, which the operator may turn on.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  processes,
  type SkillDefinition,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b201";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const SKILL_ID = "00000000-0000-4000-8000-00000000e201";
const V1 = "00000000-0000-4000-8000-0000000f0101";
const BASE = `/ops/clients/${CLIENT_ID}/agents/line-matcher`;

const io = (props: Record<string, unknown>) => ({ type: "object", properties: props });

function matchLine(version: 1 | 2): SkillDefinition {
  return {
    schemaVersion: 1,
    id: "custom:match-line",
    name: "Match a line",
    description: "The catalog item a line is",
    category: "data",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    tools: [],
    input: io({ line: { type: "string" } }),
    output:
      version === 1
        ? io({ itemId: { type: "string" }, confidence: { type: "number" } })
        : io({ catalogItemId: { type: "string" }, confidence: { type: "number" } }),
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
    parameters: [{ name: "floor", label: "Lowest confidence", type: "number", default: 0.8 }],
  } as SkillDefinition;
}

const CATALOG: BuilderCatalog = {
  skills: [
    {
      ref: "custom:match-line@1",
      source: "pinned",
      version: 1,
      definition: matchLine(1),
      kind: "ai",
      palette: false,
    },
    {
      ref: "custom:match-line",
      source: "client",
      version: 1,
      definition: matchLine(1),
      kind: "ai",
      palette: true,
    },
  ],
  tools: [
    {
      id: "alerts.raise",
      description: "Raises an alert",
      input: io({ title: { type: "string" } }),
      output: io({}),
      sideEffect: "internal",
      verb: "create",
      source: "platform",
    },
  ],
  connectors: [],
  stepTools: ["alerts.raise"],
  automations: [],
};

const BUNDLE: AnyAgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Line matcher", role: "Purchasing", mission: "Match lines" },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
    instructions: "Match lines.",
    skills: [
      {
        skill: "custom:match-line",
        settings: {},
        parameters: { floor: 0.9 },
        model: { id: "claude-sonnet-5-5" },
      },
    ],
    extraTools: [],
    permissions: { mode: "act" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t1", on: { type: "manual", input: io({ line: { type: "string" } }) } }],
        steps: [
          {
            id: "match",
            kind: "skill",
            name: "Match",
            skill: "custom:match-line@1",
            input: { line: "{{trigger.line}}" },
          },
          {
            id: "tell",
            kind: "notify",
            name: "Tell",
            notify: {
              to: ["client_admin"],
              channel: "inbox",
              message: "Matched {{steps.match.output.itemId}}",
            },
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
  slug: "line-matcher",
  name: "Line matcher",
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
  createdAt: "2026-11-10T00:00:00.000Z",
};

const LIST_ITEM = {
  id: SKILL_ID,
  ref: "custom:match-line",
  name: "Match a line",
  description: "The catalog item a line is",
  category: "data",
  source: "client",
  clientId: CLIENT_ID,
  clientName: "Oak & Co",
  status: "active",
  liveVersion: 1,
  latestVersion: 2,
  latestStatus: "draft",
  inputs: ["line"],
  outputs: ["itemId", "confidence"],
  tools: [],
  connectors: [],
  usedBy: 1,
};

const skillVersion = (n: 1 | 2) => ({
  id: `00000000-0000-4000-8000-00000000e30${n}`,
  version: n,
  status: n === 1 ? "live" : "draft",
  definition: matchLine(n),
  changeNote: null,
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-10T00:00:00.000Z",
});

const BREAKING = {
  from: "custom:match-line@1",
  to: "custom:match-line@2",
  compatible: false,
  breaks: [
    {
      kind: "removed",
      side: "output",
      field: "itemId",
      renamedTo: "catalogItemId",
      message: "itemId is no longer given back (catalogItemId may be it, renamed)",
    },
  ],
  references: [
    { stepId: "tell", at: "notify.message", expr: "steps.match.output.itemId", field: "itemId" },
  ],
  errors: [
    { stepId: "tell", field: "notify.message", message: "no field itemId", code: "template_path" },
  ],
  definition: matchLine(2),
  facts: {
    kind: "ai",
    kindLabel: "AI",
    modelTools: [],
    parameters: matchLine(2).parameters,
    recommendedModel: { id: "claude-haiku-5-5" },
  },
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
    createdAt: "2026-11-10T00:00:00.000Z",
    publishedAt: null,
    bundle: AnyAgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup(move: unknown = BREAKING) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({
      models: [
        { id: "claude-haiku-5-5", label: "Haiku", inputPerMtok: "1", outputPerMtok: "5" },
        { id: "claude-sonnet-5-5", label: "Sonnet", inputPerMtok: "3", outputPerMtok: "15" },
      ],
    }),
    "GET /api/ops/skills": () => ({ skills: [LIST_ITEM], tools: [], connectors: [] }),
    [`GET /api/ops/skills/${SKILL_ID}`]: () => ({
      skill: LIST_ITEM,
      versions: [skillVersion(2), skillVersion(1)],
      usedBy: [],
    }),
    [`POST /api/ops/agents/${AGENT_ID}/skill-move`]: ({ init }) => {
      sent.push({ path: "skill-move", body: JSON.parse(String(init.body)) });
      return move;
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push({ path: "save", body: JSON.parse(String(init.body)) });
      return { version: { ...version(), bundle: undefined }, errors: [] };
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
      <MemoryRouter initialEntries={[`${BASE}/workflows/main`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { sent, user: userEvent.setup() };
}

function savedProcess(sent: { path: string; body: Record<string, unknown> }[]) {
  const body = sent.filter((s) => s.path === "save").at(-1)?.body;
  const bundle = AnyAgentBundle.parse(body?.bundle);
  const w = bundle.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("not a process");
  return w;
}

describe("the builder under the skill model", () => {
  it("says the step's kind, the model it runs on and where from, and its parameters", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("builder-canvas");
    expect(screen.getByTestId("builder-step-match-skill-kind")).toHaveTextContent("AI");
    // The canvas says the model it runs on too.
    expect(screen.getByTestId("builder-step-match")).toHaveTextContent("runs on claude-sonnet-5-5");
    await user.click(screen.getByTestId("builder-step-match-select"));
    const inspector = screen.getByTestId("builder-inspector");
    expect(inspector).toHaveTextContent("Step 1 · Skill · AI");
    // The agent's setting for this skill wins over the skill's recommendation.
    await waitFor(() =>
      expect(screen.getByTestId("builder-inspector-runs-on")).toHaveTextContent(
        "Runs on: Sonnet (set for this skill in the agent)",
      ),
    );
    // The agent's value, inherited; the step's own over it.
    expect(screen.getByTestId("builder-parameter-floor-inherited")).toHaveTextContent(
      "The agent's: 0.9",
    );
    await user.type(screen.getByTestId("builder-parameter-floor"), "0.95");
    expect(screen.getByTestId("builder-parameter-floor-own")).toHaveTextContent("This step's");
    // A step's own model wins over the agent's.
    await user.selectOptions(screen.getByTestId("builder-inspector-model"), "claude-haiku-5-5");
    expect(screen.getByTestId("builder-inspector-runs-on")).toHaveTextContent(
      "Runs on: Haiku (set on this step)",
    );
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    const step = processes.findStep(savedProcess(sent), "match")?.step;
    expect(step).toMatchObject({
      skill: "custom:match-line@1",
      model: { id: "claude-haiku-5-5" },
      customize: { parameters: { floor: 0.95 } },
    });
  });

  it("moves a step to a breaking version only once each reference is remapped", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-match-select"));
    expect(await screen.findByTestId("builder-skill-version")).toHaveTextContent("Pinned to v1.");
    await user.click(await screen.findByTestId("builder-skill-move-2"));
    expect(await screen.findByTestId("builder-skill-move-breaking")).toBeInTheDocument();
    expect(sent.find((s) => s.path === "skill-move")?.body).toMatchObject({
      stepId: "match",
      to: "custom:match-line@2",
    });
    const ref = screen.getByTestId("builder-skill-move-ref-0");
    expect(ref).toHaveTextContent("Tell");
    // The renamed field is picked to start with; nothing moves until the operator says so.
    const pick = within(ref).getByTestId("builder-skill-move-ref-0-to");
    expect(pick).toHaveValue("catalogItemId");
    await user.selectOptions(pick, "");
    expect(screen.getByTestId("builder-skill-move-apply")).toBeDisabled();
    await user.selectOptions(pick, "catalogItemId");
    await user.click(screen.getByTestId("builder-skill-move-apply"));
    expect(await screen.findByTestId("builder-skill-version")).toHaveTextContent("Pinned to v2");
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    const process = savedProcess(sent);
    expect(processes.findStep(process, "match")?.step).toMatchObject({
      skill: "custom:match-line@2",
    });
    expect(processes.findStep(process, "tell")?.step).toMatchObject({
      notify: { message: "Matched {{steps.match.output.catalogItemId}}" },
    });
  });

  it("moves a step to a compatible version in one click", async () => {
    const { sent, user } = setup({
      ...BREAKING,
      compatible: true,
      breaks: [],
      references: [],
      errors: [],
      definition: matchLine(1),
    });
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-match-select"));
    await user.click(await screen.findByTestId("builder-skill-move-2"));
    expect(await screen.findByTestId("builder-skill-move-compatible")).toBeInTheDocument();
    await user.click(screen.getByTestId("builder-skill-move-apply"));
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    expect(processes.findStep(savedProcess(sent), "match")?.step).toMatchObject({
      skill: "custom:match-line@2",
    });
  });

  it("adds a Save to records step with approval off, and lets the operator turn it on", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-add-step"));
    const item = screen.getByTestId("builder-palette-item-write:alerts.raise");
    expect(item).toHaveTextContent("Save to records");
    await user.click(screen.getByTestId("builder-palette-item-write:alerts.raise-add"));
    const inspector = screen.getByTestId("builder-inspector");
    expect(inspector).toHaveTextContent("Save to records");
    expect(inspector).toHaveTextContent("Approval is off by default");
    expect(screen.getByTestId("builder-approval-none")).toHaveTextContent("saves to our records");
    await user.click(screen.getByTestId("builder-approval-add"));
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    const added = savedProcess(sent).steps.at(-1);
    expect(added).toMatchObject({ kind: "write", tool: "alerts.raise" });
    expect(added?.checks?.approval?.required).toBe("required");
  });
});
