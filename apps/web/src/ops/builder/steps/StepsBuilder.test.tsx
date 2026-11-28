// The step-model builder on one screen, on a fake API (docs/step-model-plan.md §2 principle 6, §9,
// §13a): it opens a `schemaVersion: 5` workflow in the same chart and panel, shows what stops
// Publish on the steps in plain words and refuses while any remain, adds a step from the palette of
// eight kinds, and fills an End from the workflow's outputs.

import { steps } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../../api/routes";
import { ApiProvider } from "../../../api/useApi";
import { rootOrder } from "../../../test/chart";
import { fakeApi, Reply } from "../../../test/fixtures";
import StepsBuilder from "./StepsBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000d501";
const V1 = "00000000-0000-4000-8000-0000000f0d51";
const BASE = "/ops/templates/invoice-clerk";
const at = "2026-11-25T10:00:00.000Z";

const AGENT: AgentSummary = {
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

const ACTIONS = {
  groups: [
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks Online",
      actions: [
        {
          id: "qbo.bill.create",
          label: "qbo.bill.create",
          description: "Creates a bill.",
          kind: "change",
          input: [{ name: "vendorId", type: "text", required: true }],
          output: [{ name: "billId", type: "text", required: true }],
        },
      ],
    },
  ],
};

const workflow = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 5,
  triggers: [{ id: "t1", on: { type: "manual", input: { type: "object", properties: {} } } }],
  outputs: [{ id: "o_done", name: "Bill entered", kind: "nothing", fields: [] }],
  steps: [
    {
      id: "enter",
      kind: "do",
      name: "Enter the bill",
      doneBy: "rules",
      uses: { type: "action", action: "qbo.bill.create" },
      input: {},
      checks: {
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      },
    },
    {
      id: "end",
      kind: "end",
      name: "Done",
      outputs: [],

      status: "succeeded",
    },
  ],
  ...over,
});

function bundle(w: unknown, oversight?: unknown) {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Invoice clerk", role: "Purchasing", mission: "Read" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "x",
      skills: [],
      extraTools: [],
      permissions: { mode: "suggest_only" },
      ...(oversight ? { oversight } : {}),
    },
    workflows: [{ slug: "main", name: "Main", workflow: w }],
  };
}

/**
 * The server's check of a draft, as `opsWorkflowCheck` answers it: core's step check with what the
 * server knows of the one action here (it needs `vendorId`), as bundle errors.
 */
function serverCheck(body: { slug: string; workflow: unknown }) {
  const w = steps.Workflow.parse(body.workflow);
  const issues = steps.validateWorkflow(w, {
    sideEffect: (a) => (a === "qbo.bill.create" ? "external" : undefined),
    requiredInput: (u) =>
      u.type === "action" && u.action === "qbo.bill.create" ? ["vendorId"] : undefined,
  });
  return {
    errors: issues.map((i) => ({
      stepId: i.at ?? null,
      field: "",
      code: "step_model",
      stepCode: i.code,
      message: i.message,
      workflow: body.slug,
    })),
  };
}

const CHECK = `POST /api/ops/agents/${AGENT_ID}/workflow-check`;

function setup(w: unknown, more: Parameters<typeof fakeApi>[0] = {}, oversight?: unknown) {
  const sent: Record<string, unknown>[] = [];
  const stored: Record<string, unknown>[] = [];
  const checked: { slug: string; workflow: unknown; parentVersionId?: string }[] = [];
  const { [CHECK]: answer, ...rest } = more;
  const api = fakeApi({
    ...rest,
    [CHECK]: (req) => {
      const body = JSON.parse(String(req.init.body));
      checked.push(body);
      return answer ? answer(req) : serverCheck(body);
    },
    [`GET /api/ops/agents/${AGENT_ID}/action-catalog`]: () => ACTIONS,
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => ({
      skills: [],
      tools: [],
      connectors: [],
      automations: [],
    }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/step-skills`]: ({ init }) => {
      stored.push(JSON.parse(String(init.body)));
      return {
        skills: [
          {
            stepId: "enter",
            ref: `custom:step-${AGENT_ID}-enter`,
            version: 3,
            pin: `custom:step-${AGENT_ID}-enter@3`,
            changed: true,
          },
        ],
      };
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return {
        version: {
          id: V1,
          agentId: AGENT_ID,
          version: 2,
          status: "draft",
          bundleHash: "h",
          changeNote: null,
          releaseNote: null,
          authorType: "operator",
          authorId: null,
          parentVersionId: null,
          basedOnTemplateVersionId: null,
          mergedFromVersionIds: null,
          createdAt: at,
        },
        errors: [],
      };
    },
  });
  const from = {
    id: V1,
    agentId: AGENT_ID,
    version: 1,
    status: "draft",
    bundle: bundle(w, oversight),
    createdAt: at,
  } as unknown as VersionDetail;
  function Page() {
    const { workflow: slug = "" } = useParams();
    return (
      <StepsBuilder
        agent={AGENT}
        from={from}
        bundle={from.bundle as never}
        workflow={slug}
        base={BASE}
        tabs={<nav aria-label="Sections" />}
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
  return { sent, stored, checked, calls: api.calls, user: userEvent.setup() };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the step-model builder", () => {
  it("opens a version 5 workflow on the same chart", async () => {
    setup(workflow());
    await screen.findByTestId("flow-chart");
    expect(rootOrder()).toEqual(["enter", "end"]);
    expect(screen.getByTestId("steps-builder")).toBeTruthy();
    // The line under a card says who does it and what it uses; an End says what it delivers.
    expect(screen.getByTestId("flow-box-enter").textContent).toContain(
      "Rules · QuickBooks Online › Create a bill",
    );
    expect(screen.getByTestId("flow-cap-end").textContent).toBe("Not filled in yet");
  });

  // Staging, 2026-11-28: opening "Invoice price review" worked out a step's input, dropped it,
  // marked the workflow Unsaved, and a Save stored the broken version.
  it("opens a stored workflow as it is: nothing changes, nothing is Unsaved", async () => {
    // "Read the bill" gives the vendorId "Enter the bill" needs: worked out, it would fill the input.
    const read = {
      id: "read",
      kind: "do",
      name: "Read the bill",
      doneBy: "ai",
      input: {},
      ai: { text: "Read the bill." },
      output: [{ name: "vendorId", type: "text", required: true }],
    };
    const w = workflow() as { steps: unknown[] };
    const stored = { ...w, steps: [read, ...w.steps] };
    const { user, sent, checked } = setup(stored);
    await screen.findByTestId("flow-chart");
    await waitFor(() => expect(checked.length).toBeGreaterThan(0));
    // What is checked is what is stored, on the version it opened.
    expect(checked[0]?.workflow).toEqual(stored);
    expect(checked[0]).toMatchObject({ slug: "main", parentVersionId: V1 });
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v1");
    // Opening the step offers what it works out; the step stays as stored until asked.
    await user.click(screen.getByTestId("flow-box-enter"));
    expect(await screen.findByTestId("do-input-offer")).toBeTruthy();
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v1");
    expect(window.localStorage.length).toBe(0);
    await user.keyboard("{Escape}");
    expect(sent).toHaveLength(0);
    // Asked, it fills the input in: that is the person's edit, and it is Unsaved.
    await user.click(screen.getByTestId("flow-box-enter"));
    await user.click(await screen.findByTestId("do-input-offer-apply"));
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    expect(screen.queryByTestId("do-input-offer")).toBeNull();
  });

  it("shows the server's issues, not its own, and Try it follows them", async () => {
    const errors = [
      {
        stepId: "enter",
        field: "",
        code: "step_model",
        stepCode: "input_missing",
        message: "The server's own words about this step.",
        workflow: "main",
      },
      // Another workflow's issue isn't this one's.
      {
        stepId: "x",
        field: "",
        code: "step_model",
        stepCode: "goal_missing",
        message: "Another workflow's issue.",
        workflow: "other",
      },
    ];
    let answer: unknown[] = errors;
    const { user } = setup(workflow(), { [CHECK]: () => ({ errors: answer }) });
    const issues = await screen.findByTestId("publish-issues");
    expect(within(issues).getByText("The server's own words about this step.")).toBeTruthy();
    expect(within(issues).getAllByTestId("publish-issue")).toHaveLength(1);
    // What the browser alone would have said (the End delivers nothing) isn't shown.
    expect(within(issues).queryByText(/Pick what this End delivers/)).toBeNull();
    expect(screen.getByTestId("flow-bar-try")).toBeDisabled();
    // The server finds nothing after an edit: nothing stops Publish or Try it.
    answer = [];
    await user.click(screen.getByTestId("flow-box-enter"));
    await user.type(await screen.findByRole("textbox", { name: "Goal" }), " now");
    await waitFor(() => expect(screen.queryByTestId("publish-issues")).toBeNull());
    expect(screen.getByTestId("flow-bar-try")).toBeEnabled();
  });

  it("checks the draft again a moment after an edit", async () => {
    const { user, checked } = setup(workflow());
    await screen.findByTestId("publish-issues");
    const before = checked.length;
    await user.click(screen.getByTestId("flow-box-enter"));
    await user.type(await screen.findByRole("textbox", { name: "Goal" }), " now");
    const lastName = () =>
      (checked.at(-1)?.workflow as { steps: { name: string }[] } | undefined)?.steps[0]?.name;
    await waitFor(() => expect(lastName()).toBe("Enter the bill now"));
    // One check once the typing stops, not one per key.
    expect(checked.length - before).toBeLessThan(4);
  });

  it("says quietly when the check fails, and Save still works", async () => {
    const { user, sent } = setup(workflow(), {
      [CHECK]: () => new Reply(500, { error: "internal", message: "down" }),
    });
    expect(await screen.findByTestId("steps-check-failed")).toBeTruthy();
    await user.click(screen.getByTestId("flow-box-enter"));
    await user.type(await screen.findByRole("textbox", { name: "Goal" }), " now");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it("says what stops Publish on its steps, in words, and refuses while any remain", async () => {
    const { user, sent } = setup(workflow());
    await screen.findByTestId("flow-chart");
    const issues = await screen.findByTestId("publish-issues");
    expect(within(issues).getByText(/Pick what this End delivers/)).toBeTruthy();
    expect(within(issues).getByText(/No End delivers "Bill entered"/)).toBeTruthy();
    expect(within(issues).getAllByText(/vendorId/).length).toBeGreaterThan(0);
    await user.click(screen.getByTestId("steps-publish"));
    expect(sent).toHaveLength(0);
    // Each line says whether it is a step or an output, and opens it (feedback, 2026-11-26).
    expect(within(issues).getByText(/Output “Bill entered”:/)).toBeTruthy();
    // An output no End delivers points to the End that should: opening it opens that step.
    const line = within(issues)
      .getAllByTestId("publish-issue")
      .find((l) => l.textContent?.includes("Output “Bill entered”")) as HTMLElement;
    expect(within(line).getByTestId("publish-issue-elsewhere")).toHaveTextContent(
      "For this to work, an End has to deliver “Bill entered”",
    );
    await user.click(within(line).getByTestId("publish-issue-show"));
    expect(await screen.findByTestId("flow-panel")).toHaveAttribute("data-step", "end");
    await user.keyboard("{Escape}");
    // Try it waits on them too: a test run is checked as a publish is.
    expect(screen.getByTestId("flow-bar-try")).toBeDisabled();
    expect(screen.getByTestId("flow-bar-builder")).toBeEnabled();
  });

  it("folds the Builder to a tab on a click outside, and opens it again from the tab", async () => {
    const { user } = setup(workflow());
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-bar-builder"));
    expect(await screen.findByTestId("builder-chat")).toBeTruthy();
    await user.type(
      within(screen.getByTestId("builder-chat")).getAllByRole("textbox")[0] as HTMLElement,
      "Half a thought",
    );
    // A click outside it folds it; nothing is lost.
    await user.click(screen.getByTestId("flow-bar-counts"));
    await waitFor(() => expect(screen.getByTestId("builder-chat")).not.toBeVisible());
    await user.click(screen.getByTestId("steps-drawer-tab"));
    expect(screen.getByTestId("builder-chat")).toBeVisible();
    // What was being typed is still there.
    expect(
      within(screen.getByTestId("builder-chat")).getAllByRole("textbox")[0] as HTMLElement,
    ).toHaveValue("Half a thought");
    // A step opened while it is open comes up beside it, the Builder about that step.
    await user.click(screen.getByTestId("flow-box-end"));
    const pair = await screen.findByTestId("steps-drawer");
    expect(within(pair).getByTestId("flow-panel")).toBeTruthy();
    expect(within(pair).getByTestId("builder-chat")).toBeTruthy();
    expect(within(pair).getByTestId("builder-chat-focus")).toHaveTextContent("On “Done”");
    // Done closes the step; the Builder stays open.
    await user.click(within(pair).getByTestId("flow-panel-done"));
    await waitFor(() => expect(screen.queryByTestId("steps-drawer")).toBeNull());
    expect(screen.getByTestId("builder-chat")).toBeVisible();
  });

  it("asks the Builder from an open step, and marks what its answer changed", async () => {
    const { user } = setup(workflow());
    await user.click(await screen.findByTestId("flow-box-enter"));
    const drawer = await screen.findByTestId("steps-drawer");
    expect(within(drawer).queryByTestId("builder-chat")).toBeNull();
    await user.click(within(drawer).getByTestId("flow-panel-ask-builder"));
    expect(within(screen.getByTestId("steps-drawer")).getByTestId("builder-chat")).toBeTruthy();
    // Next and Previous walk the steps in reading order.
    expect(within(drawer).getByTestId("flow-panel-previous")).toBeDisabled();
    await user.click(within(drawer).getByTestId("flow-panel-next"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "end");
  });

  it("offers back edits kept in this browser from before a reload", async () => {
    const w = workflow() as { steps: { id: string; name: string }[] };
    const kept = structuredClone(w);
    (kept.steps[0] as { name: string }).name = "Enter the bill again";
    window.localStorage.setItem(
      `countersign:steps-unsaved:${AGENT_ID}:main`,
      JSON.stringify({ baseId: V1, workflow: kept, at: "2026-11-26T15:00:00.000Z" }),
    );
    const { user } = setup(w);
    await user.click(await screen.findByTestId("steps-kept-restore"));
    await waitFor(() =>
      expect(screen.getByTestId("flow-box-enter").textContent).toContain("Enter the bill again"),
    );
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    expect(screen.queryByTestId("steps-kept")).toBeNull();
    window.localStorage.clear();
  });

  it("comes back to your open conversation, and lists past ones to open", async () => {
    const S1 = "00000000-0000-4000-8000-00000000e101";
    const S2 = "00000000-0000-4000-8000-00000000e102";
    const summary = (id: string, title: string, mine: boolean, status = "open") => ({
      id,
      kind: "agent",
      clientId: null,
      clientName: null,
      agentId: AGENT_ID,
      skillId: null,
      baseVersionId: V1,
      status,
      createdAt: "2026-11-26T10:00:00.000Z",
      updatedAt: "2026-11-26T11:00:00.000Z",
      title,
      turns: 2,
      mine,
    });
    const detail = (id: string, text: string, status = "open") => ({
      session: {
        ...summary(id, text, true, status),
        bundle: bundle(workflow()),
        errors: [],
        closest: [],
      },
      turns: [
        {
          id: `${id}-t1`,
          seq: 1,
          role: "operator",
          text,
          command: null,
          changes: [],
          questions: [],
          gaps: [],
          notes: [],
          errors: [],
          savedVersionId: null,
          costUsd: "0",
          undoneAt: null,
          createdAt: "2026-11-26T10:00:00.000Z",
        },
      ],
    });
    const { user } = setup(workflow(), {
      "GET /api/ops/builder/sessions": ({ url }) => ({
        sessions:
          url.searchParams.get("status") === "open"
            ? [summary(S2, "Someone else's", false), summary(S1, "Add a check on totals", true)]
            : [
                summary(S1, "Add a check on totals", true),
                summary(S2, "Someone else's", false, "closed"),
              ],
      }),
      [`GET /api/ops/builder/sessions/${S1}`]: () => detail(S1, "Add a check on totals"),
      [`GET /api/ops/builder/sessions/${S2}`]: () => detail(S2, "Someone else's", "closed"),
    });
    await screen.findByTestId("flow-chart");
    await user.click(screen.getByTestId("flow-bar-builder"));
    // Your own open conversation, not another operator's, from the server.
    expect(await screen.findByText("Add a check on totals")).toBeTruthy();
    await user.click(screen.getByTestId("builder-chat-past"));
    const list = await screen.findByTestId("builder-chat-past-list");
    expect(within(list).getByTestId(`builder-chat-past-${S2}`)).toHaveTextContent(
      "another operator's · closed",
    );
    await user.click(within(list).getByTestId(`builder-chat-past-${S2}`));
    expect(await screen.findByTestId("builder-chat-closed")).toBeTruthy();
    window.sessionStorage.clear();
  });

  it("opens a step's settings in the side drawer, and Escape closes it", async () => {
    const { user } = setup(workflow());
    await user.click(await screen.findByTestId("flow-box-end"));
    const drawer = await screen.findByTestId("steps-drawer");
    expect(within(drawer).getByTestId("flow-panel")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("steps-drawer")).toBeNull());
    // A click outside it closes it too.
    await user.click(await screen.findByTestId("flow-box-end"));
    await screen.findByTestId("steps-drawer");
    await user.click(screen.getByTestId("steps-drawer-scrim"));
    await waitFor(() => expect(screen.queryByTestId("steps-drawer")).toBeNull());
  });

  it("offers a fix in one click, what has to change elsewhere, and the Builder", async () => {
    const { user } = setup(workflow());
    const issues = await screen.findByTestId("publish-issues");
    const lines = within(issues).getAllByTestId("publish-issue");
    // The End with nothing picked, and only one output: one click delivers it.
    const end = lines.find((l) => l.textContent?.includes("Pick what this End delivers"));
    expect(within(end as HTMLElement).getByTestId("publish-issue-fix")).toHaveTextContent(
      "Deliver “Bill entered”",
    );
    // A field nothing gives: what has to change elsewhere, in words.
    const input = lines.find((l) => l.textContent?.includes("vendorId"));
    expect(within(input as HTMLElement).getByTestId("publish-issue-elsewhere")).toHaveTextContent(
      "For this to work, an earlier step has to give “vendorId”",
    );
    // Ask the Builder opens it beside that step, the issue in its box to read over and send.
    await user.click(within(input as HTMLElement).getByTestId("publish-issue-ask"));
    const pair = await screen.findByTestId("steps-drawer");
    expect(within(pair).getByTestId("flow-panel")).toHaveAttribute("data-step", "enter");
    expect(within(within(pair).getByTestId("builder-chat")).getAllByRole("textbox")[0]).toHaveValue(
      `Fix this: Doesn't fit: nothing gives "vendorId", which this step needs.`,
    );
    await user.keyboard("{Escape}");
    await user.click(within(end as HTMLElement).getByTestId("publish-issue-fix"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("publish-issues")).queryByText(/Pick what this End delivers/),
      ).toBeNull(),
    );
    expect(within(screen.getByTestId("publish-issues")).queryByText(/No End delivers/)).toBeNull();
  });

  it("fills an End from the outputs, and the issue goes", async () => {
    const { user } = setup(workflow());
    await user.click(await screen.findByTestId("flow-box-end"));
    await user.click(await screen.findByRole("checkbox", { name: /Bill entered/ }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("publish-issues")).queryByText(/Pick what this End delivers/),
      ).toBeNull(),
    );
    expect(within(screen.getByTestId("publish-issues")).queryByText(/No End delivers/)).toBeNull();
  });

  it("adds a step of one of the eight kinds before the End", async () => {
    const { user } = setup(workflow());
    await screen.findByTestId("flow-chart");
    await user.click(await screen.findByTestId("flow-insert-root-1"));
    const palette = await screen.findByTestId("steps-palette");
    expect(
      within(palette)
        .getAllByRole("button")
        .filter((b) => b.dataset.testid?.startsWith("palette-")),
    ).toHaveLength(8);
    await user.click(screen.getByTestId("palette-wait"));
    await waitFor(() => expect(rootOrder()).toHaveLength(3));
    expect(rootOrder()[2]).toBe("end");
    expect(screen.getByTestId("form-wait")).toBeTruthy();
  });

  it("saves the workflow into the bundle as a new version", async () => {
    const { user, sent } = setup(workflow());
    await screen.findByTestId("flow-chart");
    await user.click(await screen.findByTestId("flow-box-enter"));
    const name = await screen.findByRole("textbox", { name: "Goal" });
    await user.type(name, " now");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as {
      bundle: { workflows: { workflow: { schemaVersion: number; steps: { name: string }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.schemaVersion).toBe(5);
    expect(body.bundle.workflows[0]?.workflow.steps[0]?.name).toBe("Enter the bill now");
  });

  it("sets the supervisor from the bar, marks the steps it checks, and saves it with the draft", async () => {
    const oversight = { review: "failures", verify: "writes", maxPerRun: 5, maxCostUsd: "0.25" };
    const { user, sent } = setup(workflow(), {}, oversight);
    await screen.findByTestId("flow-chart");
    expect(screen.getByTestId("steps-supervisor-level")).toHaveTextContent("Review failures");
    // Under failures, no step is checked after it succeeds.
    expect(screen.queryByTestId("flow-supervisor-enter")).toBeNull();
    await user.click(screen.getByTestId("steps-supervisor"));
    const menu = screen.getByTestId("steps-supervisor-menu");
    expect(menu.textContent).toContain("area's owner agent");
    await user.click(within(menu).getByTestId("steps-supervisor-all"));
    expect(screen.getByTestId("steps-supervisor-level")).toHaveTextContent("Review every step");
    expect(screen.getByTestId("flow-supervisor-enter")).toHaveAttribute(
      "title",
      "Supervisor checks this step: it checks every step",
    );
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Unsaved");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as { bundle: { definition: { oversight: unknown } } };
    expect(body.bundle.definition.oversight).toEqual({ ...oversight, review: "all" });
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v2");
  });

  it("starts the supervisor from the new-agent default when none is saved", async () => {
    const { user, sent } = setup(workflow());
    await screen.findByTestId("flow-chart");
    expect(screen.getByTestId("steps-supervisor-level")).toHaveTextContent("Review failures");
    await user.click(screen.getByTestId("steps-supervisor"));
    await user.click(screen.getByTestId("steps-supervisor-checkpoints"));
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as { bundle: { definition: { oversight: Record<string, unknown> } } };
    expect(body.bundle.definition.oversight).toMatchObject({
      review: "checkpoints",
      verify: "writes",
    });
  });

  it("sets a step's own supervisor setting in its panel", async () => {
    const { user, sent } = setup(workflow());
    await screen.findByTestId("flow-chart");
    await user.click(await screen.findByTestId("flow-box-enter"));
    const field = await screen.findByTestId("step-supervisor");
    expect(field).toHaveValue("auto");
    await user.selectOptions(field, "always");
    expect(screen.getByTestId("flow-supervisor-enter")).toHaveAttribute(
      "title",
      "Supervisor always checks this step",
    );
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as {
      bundle: { workflows: { workflow: { steps: { review?: string }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.steps[0]?.review).toBe("always");
  });

  it("stores rules written in a step behind it when the workflow is saved", async () => {
    const written = workflow();
    (written.steps[0] as Record<string, unknown>).uses = undefined;
    Object.assign(written.steps[0] as Record<string, unknown>, {
      checks: undefined,
      rules: {
        rows: [{ id: "r1", when: { match: "all", rules: [] }, set: { account: "Materials" } }],
      },
    });
    const { user, sent, stored } = setup(written);
    await screen.findByTestId("flow-chart");
    await user.click(await screen.findByTestId("flow-box-enter"));
    await user.type(await screen.findByRole("textbox", { name: "Goal" }), " now");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(stored).toHaveLength(1));
    const body = stored[0] as { workflow: { steps: { id: string; rules?: unknown }[] } };
    expect(body.workflow.steps[0]?.id).toBe("enter");
    expect(body.workflow.steps[0]?.rules).toBeTruthy();
    // The saved version pins the draft it was just given, so what ran is what it says.
    const saved = sent[0] as { bundle: { definition: { skills: { skill: string }[] } } };
    expect(saved.bundle.definition.skills.map((s) => s.skill)).toEqual([
      `custom:step-${AGENT_ID}-enter@3`,
    ]);
  });

  it("makes no extra call when no step writes anything in itself", async () => {
    const { user, sent, stored } = setup(workflow());
    await screen.findByTestId("flow-chart");
    await user.click(await screen.findByTestId("flow-box-enter"));
    await user.type(await screen.findByRole("textbox", { name: "Goal" }), " now");
    await user.click(screen.getByTestId("flow-bar-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(stored).toHaveLength(0);
  });
});
