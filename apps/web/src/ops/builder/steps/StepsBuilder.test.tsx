// The step-model builder on one screen, on a fake API (docs/step-model-plan.md §2 principle 6, §9,
// §13a): it opens a `schemaVersion: 5` workflow in the same chart and panel, shows what stops
// Publish on the steps in plain words and refuses while any remain, adds a step from the palette of
// eight kinds, and fills an End from the workflow's outputs.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../../api/routes";
import { ApiProvider } from "../../../api/useApi";
import { rootOrder } from "../../../test/chart";
import { fakeApi } from "../../../test/fixtures";
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

function bundle(w: unknown) {
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
    },
    workflows: [{ slug: "main", name: "Main", workflow: w }],
  };
}

function setup(w: unknown) {
  const sent: Record<string, unknown>[] = [];
  const stored: Record<string, unknown>[] = [];
  const api = fakeApi({
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
    bundle: bundle(w),
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
  return { sent, stored, user: userEvent.setup() };
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

  it("says what stops Publish on its steps, in words, and refuses while any remain", async () => {
    const { user, sent } = setup(workflow());
    await screen.findByTestId("flow-chart");
    const issues = screen.getByTestId("publish-issues");
    expect(within(issues).getByText(/Pick what this End delivers/)).toBeTruthy();
    expect(within(issues).getByText(/No End delivers "Bill entered"/)).toBeTruthy();
    expect(within(issues).getByText(/vendorId/)).toBeTruthy();
    await user.click(screen.getByTestId("steps-publish"));
    expect(sent).toHaveLength(0);
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
