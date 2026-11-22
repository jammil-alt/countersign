// v0.18 (owner, 2026-11-15; docs/plan.md §1.105) in the builder, on a fake API: working on steps
// with the Builder. F6 (docs/builder-plan.md §12.3): it sits under the step's setup in the side
// panel, its message box alone until it is given more room; the whole-flow Builder's turns name no
// step. With room, each turn carries the step that is open, the change shows in the setup at once
// and undoes on its own, and previous and next move the conversation from step to step, where
// what was said about another step is a folded thread.
import { AnyAgentBundle, type AnyAgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { STEP_CHAT_KEY } from "./step-chat";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b601";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const V1 = "00000000-0000-4000-8000-0000000f0601";
const SESSION = "00000000-0000-4000-8000-0000000c6001";
const TURN = "00000000-0000-4000-8000-0000000c6102";
const BASE = `/ops/clients/${CLIENT_ID}/agents/notes`;

const CATALOG = {
  skills: [],
  tools: [],
  connectors: [],
  stepTools: [],
  automations: [],
} as unknown as BuilderCatalog;

const notify = (id: string, name: string, message: string) => ({
  id,
  kind: "notify",
  name,
  notify: { to: ["client_admin"], channel: "inbox", message },
});

function bundleWith(first: { name: string; message: string }): AnyAgentBundleInput {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Notes", role: "Notes", mission: "Tell people" },
      kind: "functional",
      model: { id: "test-model" },
      instructions: "Tell people.",
      skills: [],
      extraTools: [],
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
          steps: [notify("tell", first.name, first.message), notify("wrap", "Wrap up", "All done")],
        },
      },
    ],
  };
}

const BUNDLE = bundleWith({ name: "Tell", message: "Started" });
const RENAMED = bundleWith({ name: "Say hello", message: "Hello" });

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: CLIENT_ID,
  kind: "client",
  slug: "notes",
  name: "Notes",
  role: "Notes",
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

const turn = (over: Record<string, unknown>) => ({
  id: TURN,
  seq: 2,
  role: "builder",
  text: "Renamed it and changed the message.",
  command: null,
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0.01",
  undoneAt: null,
  createdAt: "2026-11-15T10:00:00.000Z",
  ...over,
});

const detail = (bundle: unknown, turns: unknown[] = []) => ({
  session: {
    id: SESSION,
    kind: "agent",
    clientId: CLIENT_ID,
    clientName: "Millwork",
    agentId: AGENT_ID,
    skillId: null,
    baseVersionId: V1,
    status: "open",
    bundle,
    errors: [],
    closest: [],
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
  },
  turns,
});

const change = {
  id: "step:tell",
  label: "~ step “Say hello”",
  before: {},
  after: {},
  undone: false,
};

function setup() {
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  let asked: ReturnType<typeof turn> | null = null;
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    [`GET /api/ops/clients/${CLIENT_ID}/handoff-agents`]: () => ({ agents: [] }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
    "POST /api/ops/builder/sessions": () => detail(AnyAgentBundle.parse(BUNDLE)),
    [`POST /api/ops/builder/sessions/${SESSION}/turns`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ path: "turns", body });
      const operator = turn({
        id: "00000000-0000-4000-8000-0000000c6101",
        seq: 1,
        role: "operator",
        text: body.text,
        ...(body.focusStepId ? { focus: { stepId: body.focusStepId, name: "Tell" } } : {}),
      });
      asked = operator;
      const answer = turn({ changes: [change] });
      return { ...detail(AnyAgentBundle.parse(RENAMED), [operator, answer]), turn: answer };
    },
    [`POST /api/ops/builder/sessions/${SESSION}/undo`]: ({ init }) => {
      bodies.push({ path: "undo", body: JSON.parse(String(init.body)) });
      const undone = turn({ changes: [{ ...change, undone: true }] });
      // As the API answers: the whole conversation, with the undo as a turn of its own.
      const undo = turn({
        id: "00000000-0000-4000-8000-0000000c6103",
        seq: 3,
        role: "operator",
        text: "Undo: ~ step “Say hello”",
        command: "/undo",
        changes: [{ ...change, undone: false, undoes: { turnId: TURN, changeId: change.id } }],
      });
      return { ...detail(AnyAgentBundle.parse(BUNDLE), [asked, undone, undo]), turn: undo };
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
  return { bodies, user: userEvent.setup() };
}

const nameField = () => screen.getByTestId("flow-panel-name") as HTMLInputElement;

describe("working on steps with the Builder", () => {
  beforeEach(() => window.localStorage.clear());

  it("sits under the step's setup with room for the answer, and the whole-flow Builder names no step", async () => {
    const { bodies, user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-tell"));
    expect(nameField().value).toBe("Tell");
    // Under the setup, on this step: half the panel, the conversation above a small message box.
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-builder-size", "beside");
    const chat = within(screen.getByTestId("flow-panel-builder")).getByTestId("builder-step-chat");
    expect(chat).toHaveAttribute("data-step", "tell");
    expect(within(chat).getByTestId("builder-step-chat-composer-input")).toBeInTheDocument();
    expect(within(chat).getByTestId("builder-step-chat-composer")).toHaveClass(
      "ui-chat-composer--compact",
    );
    // No title row and no "Working on" banner: the panel's own title names the step.
    expect(within(chat).queryByText(/^Working on/)).toBeNull();
    // A browser that last chose the box-only size, which is gone, gets half.
    expect(window.localStorage.getItem(STEP_CHAT_KEY)).toBeNull();

    // "Ask the Builder" is the whole flow's: its turns name no step.
    await user.click(screen.getByTestId("flow-bar-builder"));
    await user.type(screen.getByTestId("builder-chat-composer-input"), "Rename the first step");
    await user.click(screen.getByTestId("builder-chat-composer-send"));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]?.body).toEqual({ text: "Rename the first step" });
  });

  it("talks about the open step, shows the change in its setup, undoes it and moves on", async () => {
    const { bodies, user } = setup();
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-box-tell"));
    // Given the whole panel; the size is remembered in this browser.
    await user.click(screen.getByTestId("flow-panel-builder-max"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-builder-size", "max");
    expect(window.localStorage.getItem(STEP_CHAT_KEY)).toBe("max");

    const chat = await screen.findByTestId("builder-step-chat");
    expect(chat).toHaveAttribute("data-step", "tell");
    expect(nameField().value).toBe("Tell");
    expect(screen.getByTestId("flow-panel-builder-previous")).toBeDisabled();

    // A turn carries the step; the change shows in the step's setup at once.
    await user.type(
      within(chat).getByTestId("builder-step-chat-composer-input"),
      "Say hello instead",
    );
    await user.click(within(chat).getByTestId("builder-step-chat-composer-send"));
    await waitFor(() =>
      expect(bodies[0]?.body).toEqual({ text: "Say hello instead", focusStepId: "tell" }),
    );
    // This step's thread is open, so the turn needs no "On Tell" over it.
    expect(await within(chat).findByTestId("builder-turn-1")).toHaveTextContent(
      "Say hello instead",
    );
    expect(within(chat).queryByTestId("builder-turn-1-focus")).toBeNull();
    expect(within(chat).queryByTestId("builder-thread")).toBeNull();
    await user.click(screen.getByTestId("flow-panel-builder-beside"));
    await waitFor(() => expect(nameField().value).toBe("Say hello"));

    // Each change undoes on its own.
    await user.click(within(chat).getByTestId("builder-change-undo"));
    await waitFor(() => expect(nameField().value).toBe("Tell"));
    expect(bodies[1]).toEqual({ path: "undo", body: { turnId: TURN, changeId: "step:tell" } });

    // Next, at the foot of the panel, moves the conversation and the setup to the next step, in
    // the same size.
    await user.click(screen.getByTestId("flow-panel-builder-next"));
    expect(screen.getByTestId("builder-step-chat")).toHaveAttribute("data-step", "wrap");
    // What was said about the step before is a folded thread with its name, opened by a click.
    const thread = within(screen.getByTestId("builder-step-chat")).getByTestId("builder-thread");
    expect(thread).toHaveAttribute("data-step", "tell");
    expect(thread).toHaveAttribute("data-open", "false");
    expect(within(thread).getByTestId("builder-thread-toggle")).toHaveTextContent("On “Tell”");
    expect(within(thread).queryByTestId("builder-turn-1")).toBeNull();
    expect(screen.getByTestId("builder-step-chat-empty")).toBeInTheDocument();
    await user.click(within(thread).getByTestId("builder-thread-toggle"));
    expect(within(thread).getByTestId("builder-turn-1")).toHaveTextContent("Say hello instead");
    expect(nameField().value).toBe("Wrap up");
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-builder-size", "beside");
    expect(screen.getByTestId("flow-panel-builder-next")).toBeDisabled();
    await user.click(screen.getByTestId("flow-panel-builder-previous"));
    expect(screen.getByTestId("builder-step-chat")).toHaveAttribute("data-step", "tell");

    // Folded to its line: the setup has the panel again, and the Builder keeps its place.
    await user.click(screen.getByTestId("flow-panel-builder-fold"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-builder-size", "line");
    expect(window.localStorage.getItem(STEP_CHAT_KEY)).toBe("line");
  });
});
