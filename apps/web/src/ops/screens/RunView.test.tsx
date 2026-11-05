// The back-office run view: the checklist names steps from the workflow that ran, with cost; the
// change waiting on the operator shows now / after and approves through the ops resolve route.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
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
    expect(screen.getByTestId("ops-run-waiting")).toHaveTextContent("Waiting on you · 1");
    expect(screen.getByText("Records clerk", { selector: "h1" })).toBeInTheDocument();

    const panel = screen.getByTestId("ops-run-action-00000000-0000-4000-8000-0000000f4001");
    expect(panel).toHaveTextContent("Testkit · r1 · Oak board");
    expect(within(panel).getByTestId("change-now-row-amount")).toHaveTextContent("10.00");
    expect(within(panel).getByTestId("change-after-row-amount")).toHaveTextContent("12.00");
    await userEvent.click(within(panel).getByTestId("ops-run-action-approve"));
    expect(resolved).toEqual([{ decision: "approve" }]);
    expect(await within(panel).findByTestId("ops-run-action-status")).toHaveTextContent("Approved");
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
    expect(screen.getByTestId("ops-run-waiting")).toHaveTextContent("Waiting on you · 1");
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
    const watched = await screen.findByTestId(
      "ops-run-action-00000000-0000-4000-8000-0000000f4001",
    );
    expect(within(watched).queryByTestId("ops-run-action-approve")).toBeNull();
    expect(screen.queryByTestId("ops-run-waiting")).toBeNull();
  });

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
