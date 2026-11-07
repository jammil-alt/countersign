// The back-office run view: the checklist names steps from the workflow that ran, with cost; the
// change waiting on the operator shows now / after and approves through the ops resolve route.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { BILL_BEFORE, BILL_INPUT, BILL_LINES_VIEW } from "../../test/changes";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { checklistRows, parseNodeId } from "../run/checklist";

const RUN_ID = "00000000-0000-4000-8000-0000000f1001";
const ITEM_ID = "00000000-0000-4000-8000-0000000f3001";
const TENANT = "00000000-0000-4000-8000-00000000a001";

const WORKFLOW = {
  schemaVersion: 3,
  trigger: { id: "trg", on: { type: "manual", input: {} } },
  steps: [
    {
      id: "update",
      name: "Update the record",
      kind: "action",
      tool: "testkit.record.update",
      input: { id: "r1", amount: "12.00" },
      approval: { required: "required" },
    },
    {
      id: "confirm",
      name: "Confirm",
      kind: "person",
      mode: "approve",
      assignee: "client_admin",
      title: "Is it right?",
      timeout: "1 day",
      onTimeout: "stop",
    },
    {
      id: "internal",
      name: "Operator note",
      kind: "notify",
      channel: "thread",
      message: "done",
      client: { visible: false },
    },
  ],
};

const step = (id: string, nodeId: string, nodeType: string, status: string, extra = {}) => ({
  id,
  nodeId,
  nodeType,
  skillRef: null,
  status,
  input: null,
  output: null,
  summary: null,
  costUsd: "0",
  tokensIn: 0,
  tokensOut: 0,
  startedAt: "2026-11-03T10:00:10.000Z",
  finishedAt: null,
  ...extra,
});

function detail(
  itemStatus: "open" | "resolved",
  item: { assigneeRole: string; resolvableByOperator: boolean } = {
    assigneeRole: "operator",
    resolvableByOperator: true,
  },
) {
  return {
    run: {
      id: RUN_ID,
      tenantId: TENANT,
      agentId: "00000000-0000-4000-8000-00000000b001",
      agentVersionId: "00000000-0000-4000-8000-0000000e0001",
      workflowSlug: "fix-record",
      mode: "live",
      status: itemStatus === "open" ? "waiting" : "running",
      trigger: { by: "operator" },
      costUsd: "0.0900",
      error: null,
      startedAt: "2026-11-03T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-11-03T10:00:00.000Z",
    },
    steps: [
      step("00000000-0000-4000-8000-0000000f2001", "update", "action", "waiting", {
        costUsd: "0.0400",
      }),
    ],
    toolCalls: [],
    actions: [
      {
        id: "00000000-0000-4000-8000-0000000f4001",
        tool: "testkit.record.update",
        connectionId: "00000000-0000-4000-8000-00000000c001",
        stepRunId: "00000000-0000-4000-8000-0000000f2001",
        status: itemStatus === "open" ? "proposed" : "approved",
        input: { id: "r1", amount: "12.00" },
        before: { id: "r1", name: "Oak board", amount: "10.00", syncToken: "0" },
        result: null,
        error: null,
        inboxItemId: ITEM_ID,
        approvedBy: null,
        approvedAt: null,
        executedAt: null,
      },
    ],
    inbox: [
      {
        id: ITEM_ID,
        tenantId: TENANT,
        kind: "external_action",
        agentId: "00000000-0000-4000-8000-00000000b001",
        runId: RUN_ID,
        subjectType: "external_action",
        subjectId: "00000000-0000-4000-8000-0000000f4001",
        assigneeRole: item.assigneeRole,
        assigneeUserId: null,
        title: "Change a record",
        payload: {},
        status: itemStatus,
        resolution: null,
        resolvedBy: null,
        dueAt: null,
        createdAt: "2026-11-03T10:00:10.000Z",
        resolvedAt: null,
        resolvableByOperator: item.resolvableByOperator,
      },
    ],
    agent: {
      id: "00000000-0000-4000-8000-00000000b001",
      tenantId: TENANT,
      slug: "records-clerk",
      name: "Records clerk",
      serviceName: "Record keeping",
    },
    version: 3,
    workflow: { slug: "fix-record", name: "Fix a record", definition: WORKFLOW },
  };
}

describe("run checklist", () => {
  it("reads loop node ids", () => {
    expect(parseNodeId("each:2:child")).toEqual({ stepId: "child", index: 2 });
    expect(parseNodeId("update")).toEqual({ stepId: "update", index: null });
  });
});

describe("back-office run view", () => {
  it("lists what it did with step names and cost, and approves the waiting change", async () => {
    let status: "open" | "resolved" = "open";
    const resolved: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => detail(status),
      [`POST /api/ops/inbox/${ITEM_ID}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        status = "resolved";
        return { item: { ...detail("resolved").inbox[0] } };
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    // A change waits on us, so the page opens on Changes; the timeline is a tab away.
    expect(await screen.findByTestId("ops-run-tab-changes")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByTestId("ops-run-tab-timeline"));
    const checklist = await screen.findByTestId("ops-run-checklist");
    const rows = within(checklist).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "ops-run-step-trigger",
      "ops-run-step-00000000-0000-4000-8000-0000000f2001",
      "ops-run-step-pending:confirm",
      "ops-run-step-pending:internal",
    ]);
    expect(rows[0]).toHaveTextContent("Started by hand");
    expect(rows[1]).toHaveTextContent("Update the record");
    expect(rows[1]).toHaveTextContent("Waiting for approval");
    expect(rows[1]).toHaveTextContent("$0.04");
    expect(rows[3]).toHaveTextContent("hidden from client");
    expect(within(checklist).getByText("1 of 4 steps · $0.09")).toBeInTheDocument();
    // The wait, at the top and on the step, in the same words; the status is never "Running".
    expect(screen.getByTestId("ops-run-waiting")).toHaveTextContent("Waiting for approval");
    expect(screen.getByTestId("ops-run-waiting-line")).toHaveTextContent("you · since");
    expect(screen.getByTestId("ops-run-status")).toHaveTextContent("Waiting for approval · you");
    expect(rows[1]).toHaveTextContent("Waiting for approval · you");
    // Without a document or a subject from the API, the run is titled by its workflow.
    expect(screen.getByText("Fix a record", { selector: "h1" })).toBeInTheDocument();
    expect(screen.getByTestId("ops-run-about")).toHaveTextContent("Records clerk v3");

    await userEvent.click(screen.getByTestId("ops-run-tab-changes"));
    const panel = screen.getByTestId("ops-run-action-00000000-0000-4000-8000-0000000f4001");
    expect(panel).toHaveTextContent("Testkit · r1 · Oak board");
    expect(within(panel).getByTestId("change-now-row-amount")).toHaveTextContent("10.00");
    expect(within(panel).getByTestId("change-after-row-amount")).toHaveTextContent("12.00");
    await userEvent.click(within(panel).getByTestId("ops-run-action-approve"));
    expect(resolved).toEqual([{ decision: "approve" }]);
    expect(await within(panel).findByTestId("ops-run-action-status")).toHaveTextContent("Approved");
  });

  it("approves from the top of the page, through the same resolve route", async () => {
    const resolved: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => detail("open"),
      [`POST /api/ops/inbox/${ITEM_ID}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        return { item: { ...detail("resolved").inbox[0] } };
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const block = await screen.findByTestId("ops-run-waiting");
    expect(within(block).getByTestId("ops-run-waiting-approve")).toHaveTextContent(
      "Approve and update Testkit",
    );
    await userEvent.click(within(block).getByTestId("ops-run-waiting-reject"));
    expect(resolved).toEqual([{ decision: "reject" }]);
  });

  it("titles the run by what it is about, and names the records its steps cite", async () => {
    const base = detail("resolved");
    const VENDOR = "00000000-0000-4000-8000-00000000d001";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => ({
        ...base,
        run: {
          ...base.run,
          subject: {
            kind: "document",
            vendor: "Northline Panel Supply",
            number: "20418",
            filename: "northline-20418.pdf",
          },
        },
        steps: [
          {
            ...base.steps[0],
            status: "succeeded",
            output: { sources: [VENDOR] },
            summary: "Found 1 bill",
          },
        ],
        sourceNames: { [VENDOR]: "Northline Panel Supply" },
      }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Northline Panel Supply · Invoice 20418", { selector: "h1" }),
    ).toBeInTheDocument();
    const step = screen.getByTestId("ops-run-step-00000000-0000-4000-8000-0000000f2001");
    expect(within(step).getByTestId(`source-${VENDOR}`)).toHaveTextContent(
      "Northline Panel Supply",
    );
    expect(step.textContent).not.toContain("Record ·");
  });

  it("reads a QuickBooks change through the tool's display: lines, totals, names", async () => {
    const base = detail("open");
    const action = base.actions[0] as (typeof base.actions)[number];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => ({
        ...base,
        actions: [
          {
            ...action,
            tool: "qbo.bill.update_lines",
            input: BILL_INPUT,
            before: BILL_BEFORE,
            display: BILL_LINES_VIEW,
          },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId(`ops-run-action-${action.id}`);
    expect(within(panel).getByRole("heading", { level: 3 })).toHaveTextContent(
      "QuickBooks bill 20418 · Northline Panel Supply",
    );
    // No tool id: the heading names the tool as people know it.
    expect(panel.textContent).not.toContain("qbo.bill.update_lines");
    expect(within(panel).getByTestId("ops-run-action-description")).toHaveTextContent(
      "The total stays the same.",
    );
    // The total doesn't change: it folds under "fields unchanged".
    expect(within(panel).getByTestId("change-same-now-row-total")).toHaveTextContent("$9,742.35");
    expect(within(panel).getByTestId("change-lines-after-item-0")).toHaveTextContent(
      "60 × $142.50",
    );
    expect(within(panel).getByTestId("change-lines-after-total")).toHaveTextContent("$9,742.35");
    expect(panel.textContent).not.toContain("Replace line ids");
    expect(within(panel).getByTestId("ops-run-action-approve")).toHaveTextContent(
      "Approve and update QuickBooks Online",
    );
  });

  it("lets the operator sign the client admin's change only where the server says so", async () => {
    // The Sandbox: the server marks the client admin's item as the operator's to resolve.
    const sandbox = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () =>
        detail("open", { assigneeRole: "client_admin", resolvableByOperator: true }),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={sandbox.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId("ops-run-action-00000000-0000-4000-8000-0000000f4001");
    expect(within(panel).getByTestId("ops-run-action-approve")).toBeInTheDocument();
    expect(screen.getByTestId("ops-run-waiting-line")).toHaveTextContent("you · since");
    unmount();

    // A real client: the same item is the client admin's, and the operator only watches.
    const real = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () =>
        detail("open", { assigneeRole: "client_admin", resolvableByOperator: false }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={real.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByTestId("ops-run-tab-changes"));
    const watched = await screen.findByTestId(
      "ops-run-action-00000000-0000-4000-8000-0000000f4001",
    );
    expect(within(watched).queryByTestId("ops-run-action-approve")).toBeNull();
    // Every place says the same: waiting for the client admin's approval, and where to see it.
    expect(screen.getByTestId("ops-run-status")).toHaveTextContent(
      "Waiting for approval · client admin",
    );
    expect(watched).toHaveTextContent("Waiting for approval · client admin.");
    const block = screen.getByTestId("ops-run-waiting");
    expect(block).toHaveTextContent("Only the client admin can approve this.");
    expect(within(block).queryByTestId("ops-run-waiting-approve")).toBeNull();
    expect(within(block).getByTestId("ops-run-waiting-where")).toHaveAttribute(
      "href",
      `/ops/inbox?assigned=all&client=${TENANT}`,
    );
    await userEvent.click(screen.getByTestId("ops-run-tab-timeline"));
    expect(
      await screen.findByTestId("ops-run-step-00000000-0000-4000-8000-0000000f2001"),
    ).toHaveTextContent("Waiting for approval · client admin");
  });

  it("shows Done when the run is done, even when each answer takes longer than the poll", async () => {
    // Staging can take over 2 s to answer. Polling every 2 s regardless aborted each answer before
    // it landed, so the header kept saying "Running" after the run had finished.
    let n = 0;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: async () => {
        const first = n++ === 0;
        const d = detail("resolved");
        if (first) return d;
        await new Promise((r) => setTimeout(r, 2_300));
        return {
          ...d,
          run: { ...d.run, status: "succeeded", finishedAt: "2026-11-03T10:01:00.000Z" },
        };
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("ops-run-status")).toHaveTextContent("Running");
    await waitFor(() => expect(screen.getByTestId("ops-run-status")).toHaveTextContent("Done"), {
      timeout: 10_000,
    });
  }, 12_000);

  it("lists only reached steps once a run is over", () => {
    const rows = checklistRows({
      workflow: null,
      steps: [step("s1", "x", "skill", "succeeded")],
      runStartedAt: "2026-11-03T10:00:00.000Z",
      runCreatedAt: "2026-11-03T10:00:00.000Z",
      going: false,
    });
    expect(rows.map((r) => [r.key, r.title, r.internal])).toEqual([
      ["trigger", "Started", false],
      ["s1", "x", true],
    ]);
  });
});

// v0.12 W1-E: run controls and model calls.
describe("run controls", () => {
  it("retries a failed live run from its failed step and lists the run's model calls", async () => {
    const failed = detail("resolved");
    failed.run = {
      ...failed.run,
      status: "failed",
      error: { reason: "HTTP 401", nodeId: "update", key: "testkit.record.update:unauthorized" },
      finishedAt: "2026-11-03T10:01:00.000Z",
    } as unknown as typeof failed.run;
    const retried: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => failed,
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({
        modelCalls: [
          {
            id: "00000000-0000-4000-8000-0000000f5001",
            runId: RUN_ID,
            stepRunId: "00000000-0000-4000-8000-0000000f2001",
            agentVersionId: null,
            provider: "anthropic",
            model: "claude-opus-5-5",
            tokensIn: 1200,
            tokensOut: 80,
            costUsd: "0.0123",
            durationMs: 900,
            stopReason: "end_turn",
            createdAt: "2026-11-03T10:00:20.000Z",
          },
        ],
      }),
      [`POST /api/ops/runs/${RUN_ID}/retry`]: () => {
        retried.push(RUN_ID);
        return { runId: RUN_ID, shortId: "R-0f1001", resumeFrom: "update" };
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("ops-run-short-id")).toHaveTextContent("R-0f1001");
    // Failed runs are retried; a run that has ended isn't cancelled.
    expect(screen.queryByTestId("ops-run-cancel")).toBeNull();
    // The failed step is named, and the retry says where it starts.
    expect(screen.getByTestId("ops-run-status")).toHaveTextContent("Failed at step 1");
    expect(screen.getByTestId("ops-run-retry")).toHaveTextContent("Retry from step 1");
    // Model calls, oversight and the raw data are one Details tab.
    await userEvent.click(screen.getByTestId("ops-run-tab-details"));
    const calls = await screen.findByTestId("ops-run-model-calls");
    await waitFor(() => expect(calls).toHaveTextContent("anthropic · claude-opus-5-5"));
    expect(calls).toHaveTextContent("end_turn");
    await userEvent.click(screen.getByTestId("ops-run-retry"));
    await waitFor(() => expect(retried).toEqual([RUN_ID]));
  });
});

describe("run oversight and the same error elsewhere", () => {
  it("shows the oversight's decisions, other runs with the error, and a model call's body", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000f1009";
    const CALL = "00000000-0000-4000-8000-0000000f5001";
    const base = detail("resolved");
    const failed = {
      ...base,
      run: {
        ...base.run,
        status: "failed",
        error: { reason: "HTTP 401", nodeId: "update", key: "testkit.record.update:unauthorized" },
        finishedAt: "2026-11-03T10:01:00.000Z",
      },
      oversight: [
        {
          id: "00000000-0000-4000-8000-0000000f6001",
          runId: RUN_ID,
          stepRunId: "00000000-0000-4000-8000-0000000f2001",
          nodeId: "update",
          seq: 1,
          cause: "failed",
          action: "retry_with",
          inputBefore: { amount: "12,00" },
          inputAfter: { amount: "12.00" },
          note: "The amount used a comma.",
          proposal: { summary: "Normalise amounts before the update step", change: null },
          inboxItemId: null,
          sources: [],
          model: "claude-opus-5-5",
          costUsd: "0.0100",
          tokensIn: 900,
          tokensOut: 40,
          agentVersionId: "00000000-0000-4000-8000-0000000e0001",
          createdAt: "2026-11-03T10:00:30.000Z",
        },
      ],
    };
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => failed,
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({
        modelCalls: [
          {
            id: CALL,
            runId: RUN_ID,
            stepRunId: "00000000-0000-4000-8000-0000000f2001",
            agentVersionId: null,
            provider: "anthropic",
            model: "claude-opus-5-5",
            tokensIn: 1200,
            tokensOut: 80,
            costUsd: "0.0123",
            durationMs: 900,
            stopReason: "end_turn",
            createdAt: "2026-11-03T10:00:20.000Z",
          },
        ],
      }),
      [`GET /api/ops/model-calls/${CALL}`]: () => ({
        modelCall: {
          id: CALL,
          runId: RUN_ID,
          stepRunId: null,
          agentVersionId: null,
          provider: "anthropic",
          model: "claude-opus-5-5",
          tokensIn: 1200,
          tokensOut: 80,
          costUsd: "0.0123",
          durationMs: 900,
          stopReason: "end_turn",
          createdAt: "2026-11-03T10:00:20.000Z",
        },
        body: { request: { system: "Read the record" }, answer: { text: "ok" }, error: null },
      }),
      "GET /api/ops/runs": ({ url }) => ({
        runs:
          url.searchParams.get("errorKey") === "testkit.record.update:unauthorized"
            ? [failed.run, { ...failed.run, id: OTHER }]
            : [],
        agents: [],
      }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=oversight`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const decision = await screen.findByTestId(
      "ops-run-decision-00000000-0000-4000-8000-0000000f6001",
    );
    expect(decision).toHaveTextContent("Retried with a corrected input after a failed step");
    expect(decision).toHaveTextContent("The amount used a comma.");
    expect(decision).toHaveTextContent("Normalise amounts before the update step");
    expect(decision).toHaveTextContent("Corrected input");

    // The rail: the sign-in failed, so the client's connections; and the same error elsewhere.
    expect(screen.getByTestId("ops-run-next")).toHaveTextContent(
      "Only the client can sign in again",
    );
    const same = await screen.findByTestId("ops-run-same-error");
    expect(within(same).getAllByRole("link")).toHaveLength(1);
    expect(within(same).getByRole("link")).toHaveAttribute("href", `/ops/runs/${OTHER}`);

    // The old `?tab=oversight` address opens Details, which holds the model calls too.
    expect(screen.getByTestId("ops-run-tab-details")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("ops-run-same-error")).toHaveTextContent(
      "Testkit: record update · unauthorized",
    );
    await userEvent.click(await screen.findByTestId(`ops-run-model-call-${CALL}-open`));
    expect(await screen.findByTestId(`ops-model-body-${CALL}`)).toHaveTextContent(
      "Read the record",
    );
  });
});
