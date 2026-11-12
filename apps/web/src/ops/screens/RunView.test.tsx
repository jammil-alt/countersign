// The back-office run view: the checklist names steps from the workflow that ran, with cost; the
// change waiting on the operator shows now / after and approves through the ops resolve route.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { BILL_BEFORE, BILL_INPUT, BILL_LINES_VIEW } from "../../test/changes";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
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
    // Skill model (2026-11-10): the write reads by where it writes.
    stepFacts: { update: { write: { kind: "change_in", text: "Change in Testkit" } } },
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

// R8 (ARCHITECTURE §10.14): a v4 process's run. A write's confers are rows of their own (with
// the second check's note: the back office sees it), its approvers in the check's mode, the write
// that went ahead with nobody answering, an urgent notice waiting for its Seen, and the owner.
describe("back-office run view: a v4 process", () => {
  const PROCESS = {
    schemaVersion: 4,
    triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
    steps: [
      {
        id: "post",
        name: "Post the bill",
        kind: "write",
        tool: "testkit.record.update",
        input: {},
        checks: {
          confer: {
            with: [
              { ai: { focus: "Do the lines add up?" } },
              {
                person: "client_admin",
                deadline: { after: "1 day", hours: "business", ifNoAnswer: "stop" },
              },
            ],
          },
          approval: {
            required: "required",
            mode: "all",
            approvers: [{ who: "client_admin" }, { who: "lead" }],
            ifNoAnswer: "proceed",
            onReject: "stop",
          },
        },
      },
      {
        id: "tell",
        name: "Tell the team",
        kind: "notify",
        notify: {
          to: ["client_admin"],
          channel: "inbox",
          message: "Posted",
          urgent: { ackWithin: "1 hour", ifNoAnswer: "stop" },
        },
      },
    ],
  };
  const R = (n: number) => `00000000-0000-4000-8000-0000000f7${String(n).padStart(3, "0")}`;
  const base = detail("resolved");
  const data = {
    ...base,
    run: { ...base.run, status: "running" },
    steps: [
      step(R(1), "post:confer:0", "confer", "succeeded", {
        input: { reviewer: "ai" },
        output: { verdict: "agree", note: "The lines add up to $9,742.35.", by: "ai" },
      }),
      step(R(2), "post:confer:1", "confer", "succeeded", {
        input: { reviewer: "client_admin" },
        output: { verdict: "disagree", note: "Freight is missing", by: "client_admin" },
      }),
      step(R(3), "post", "write", "succeeded", {
        output: { proceededWithoutAnswer: true },
        summary: "Posted the bill",
      }),
      step(R(4), "tell", "notify", "succeeded", {
        output: { urgent: { dueAt: "2026-11-03T11:00:00.000Z" } },
      }),
    ],
    actions: [],
    inbox: [
      {
        ...base.inbox[0],
        id: R(11),
        kind: "approval",
        assigneeRole: "client_admin",
        payload: { nodeId: "post:approval:1" },
        status: "expired",
      },
      {
        ...base.inbox[0],
        id: R(12),
        kind: "approval",
        assigneeRole: "operator",
        payload: { nodeId: "post:approval:1:a1" },
        status: "expired",
      },
    ],
    oversight: [
      {
        id: R(21),
        runId: RUN_ID,
        stepRunId: R(3),
        nodeId: "post",
        seq: 1,
        cause: "failed",
        action: "retry_with",
        inputBefore: { amount: "1,2" },
        inputAfter: { amount: "1.2" },
        note: "The amount used a comma.",
        proposal: null,
        inboxItemId: null,
        sources: [],
        model: "claude-opus-5-5",
        costUsd: "0.0010",
        tokensIn: 10,
        tokensOut: 5,
        agentVersionId: base.run.agentVersionId,
        createdAt: "2026-11-03T10:00:20.000Z",
      },
    ],
    workflow: { slug: "fix-record", name: "Fix a record", definition: PROCESS },
  };

  it("shows confers as their own rows, approvers in the mode, no-answer, Seen and the owner", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => data,
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const ai = await screen.findByTestId(`ops-run-step-${R(1)}`, {}, { timeout: 10_000 });
    expect(ai).toHaveTextContent("Confer");
    expect(ai).toHaveTextContent("A second check: agrees · Post the bill");
    // The back office reads the second check's note; the client never does.
    expect(ai).toHaveTextContent("“The lines add up to $9,742.35.”");
    const person = screen.getByTestId(`ops-run-step-${R(2)}`);
    expect(person).toHaveTextContent("Checked with client admin: disagrees");
    expect(person).toHaveAttribute("data-state", "person");

    const write = screen.getByTestId(`ops-run-step-${R(3)}`);
    expect(write).toHaveTextContent("Write");
    const approval = within(write).getByTestId(`ops-run-step-checks-${R(3)}-approval`);
    expect(approval).toHaveTextContent("Asked together; everyone must approve");
    expect(
      within(approval)
        .getAllByTestId(`ops-run-step-checks-${R(3)}-approver`)
        .map((a) => a.textContent),
    ).toEqual(["client admin: no answer in time", "operator: no answer in time"]);
    expect(within(write).getByTestId(`ops-run-step-checks-${R(3)}-no-answer`)).toHaveTextContent(
      "Went ahead: nobody answered in time",
    );
    expect(within(write).getByTestId(`ops-run-owner-${R(21)}`)).toHaveTextContent(
      "The owner corrected the input and tried again after a failed step.",
    );
    expect(
      within(screen.getByTestId(`ops-run-step-${R(4)}`)).getByTestId(
        `ops-run-step-checks-${R(4)}-urgent`,
      ),
    ).toHaveTextContent(/^Urgent: waiting for Seen until /);
  });

  // Wave 5: the route an if took and why, by step name; a failure the run carried on past.
  it("says which route an if took and why, and a step that failed and carried on", async () => {
    const forked = {
      schemaVersion: 4,
      triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
      steps: [
        {
          id: "look",
          name: "Look the PO up",
          kind: "read",
          tool: "testkit.record.query",
          input: {},
          onError: "continue",
        },
        {
          id: "post",
          name: "Approve the bill",
          kind: "write",
          tool: "testkit.record.update",
          input: {},
          checks: {
            approval: {
              required: "required",
              mode: "in_turn",
              ifNoAnswer: "stop",
              onReject: "continue",
            },
          },
        },
        {
          id: "route",
          name: "If rejected",
          kind: "if",
          paths: [
            {
              id: "p-rej",
              name: "Rejected",
              when: {
                match: "all",
                rules: [{ field: "{{steps.post.outcome}}", op: "=", value: "rejected" }],
              },
              steps: [],
            },
          ],
          otherwise: { id: "p-else", steps: [] },
        },
      ],
    };
    const runData = {
      ...data,
      steps: [
        step(R(31), "look", "read", "failed", {
          error: "The record service didn't answer",
          outcome: "failed",
        }),
        step(R(32), "post", "write", "skipped", { outcome: "rejected" }),
        step(R(33), "route", "if", "succeeded", {
          output: { pathId: "p-rej", pathName: "Rejected" },
        }),
      ],
      inbox: [],
      oversight: [],
      workflow: { slug: "fix-record", name: "Fix a record", definition: forked },
    };
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => runData,
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const fork = await screen.findByTestId(`ops-run-step-${R(33)}`, {}, { timeout: 10_000 });
    expect(within(fork).getByTestId(`ops-run-step-checks-${R(33)}-route`)).toHaveTextContent(
      "Took the route “Rejected”: Approve the bill was rejected",
    );
    const look = screen.getByTestId(`ops-run-step-${R(31)}`);
    expect(within(look).getByTestId(`ops-run-step-checks-${R(31)}-carried-on`)).toHaveTextContent(
      "Failed, and the run carried on",
    );
    expect(
      within(screen.getByTestId(`ops-run-step-${R(32)}`)).queryByTestId(
        `ops-run-step-checks-${R(32)}-carried-on`,
      ),
    ).toBeNull();
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
    expect(
      within(rows[1] as HTMLElement).getByTestId(
        "ops-run-step-00000000-0000-4000-8000-0000000f2001-kind",
      ),
    ).toHaveTextContent("Change in Testkit");
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
    expect(within(panel).getByTestId("change-row-amount-now")).toHaveTextContent("10.00");
    expect(within(panel).getByTestId("change-row-amount-after")).toHaveTextContent("12.00");
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

  it("says Sending on the pressed decision until the server answers, and never earlier done (1.8)", async () => {
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => detail("open"),
      [`POST /api/ops/inbox/${ITEM_ID}/resolve`]: () => new Promise((r) => (answer = r)),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const block = await screen.findByTestId("ops-run-waiting");
    await userEvent.click(within(block).getByTestId("ops-run-waiting-approve"));
    expect(within(block).getByTestId("ops-run-waiting-approve")).toHaveTextContent("Sending…");
    expect(within(block).getByTestId("ops-run-waiting-approve")).toBeDisabled();
    expect(within(block).getByTestId("ops-run-waiting-reject")).toBeDisabled();
    // Still waiting: nothing reads as approved before the server says so.
    expect(screen.getByTestId("ops-run-status")).toHaveTextContent("Waiting for approval");
    answer({ item: { ...detail("resolved").inbox[0] } });
    // Answered: the block stays shut until the run reloads without this wait, so a second press
    // can't send the decision again.
    await waitFor(() =>
      expect(within(block).getByTestId("ops-run-waiting-approve")).toHaveTextContent("Approved"),
    );
    expect(within(block).getByTestId("ops-run-waiting-approve")).toBeDisabled();
    expect(within(block).getByTestId("ops-run-waiting-reject")).toBeDisabled();
  });

  it("shows a refused decision beside the buttons (1.8)", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => detail("open"),
      [`POST /api/ops/inbox/${ITEM_ID}/resolve`]: () =>
        new Reply(409, { error: { code: "conflict", message: "Already decided." } }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const block = await screen.findByTestId("ops-run-waiting");
    await userEvent.click(within(block).getByTestId("ops-run-waiting-approve"));
    expect(await within(block).findByText(/Already decided/)).toBeInTheDocument();
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
    expect(within(panel).getByTestId("change-unchanged-total")).toHaveTextContent("$9,742.35");
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
    expect(decision).toHaveTextContent("Corrected the input and tried again after a failed step");
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
      "Testkit · Update a record · unauthorized",
    );
    await userEvent.click(await screen.findByTestId(`ops-run-model-call-${CALL}-open`));
    expect(await screen.findByTestId(`ops-model-body-${CALL}`)).toHaveTextContent(
      "Read the record",
    );
  });
});

// Step panel (docs/plan.md §1.95): a checklist row opens beside the run with what the step did,
// its tries, models, tokens and cost, what went in and came out as fields, each model call with
// its prompt and answer, its change before and after, and on Data what it touched, with links.
describe("back-office step panel", () => {
  const STEP_ID = "00000000-0000-4000-8000-0000000f2001";
  const CALL = "00000000-0000-4000-8000-0000000f5001";
  const RECORD = "00000000-0000-4000-8000-0000000f8001";
  const DOC = "00000000-0000-4000-8000-0000000d0001";
  const base = detail("resolved");
  const data = {
    ...base,
    steps: [
      step(STEP_ID, "update", "action", "succeeded", {
        skillRef: "testkit.record.update",
        input: { id: "r1", amount: "12.00", documentId: DOC },
        output: { id: "r1", updated: true, sources: [RECORD] },
        summary: "Updated record r1",
        costUsd: "0.0123",
        tokensIn: 1200,
        tokensOut: 80,
        attempts: 2,
        models: ["claude-opus-5-5"],
        finishedAt: "2026-11-03T10:00:40.000Z",
      }),
    ],
    actions: [
      {
        ...base.actions[0],
        status: "done",
        approvedBy: "00000000-0000-4000-8000-0000000aa001",
        approvedAt: "2026-11-03T10:00:30.000Z",
        executedAt: "2026-11-03T10:00:35.000Z",
      },
    ],
    sourceNames: { [RECORD]: "Oak board · r1" },
  };
  const modelCall = {
    id: CALL,
    runId: RUN_ID,
    stepRunId: STEP_ID,
    agentVersionId: null,
    provider: "anthropic",
    model: "claude-opus-5-5",
    tokensIn: 1200,
    tokensOut: 80,
    costUsd: "0.0123",
    durationMs: 900,
    stopReason: "end_turn",
    createdAt: "2026-11-03T10:00:20.000Z",
  };

  function renderRun(path: string) {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => data,
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [modelCall] }),
      [`GET /api/ops/model-calls/${CALL}`]: () => ({
        modelCall,
        body: { request: { system: "Read the record" }, answer: { text: "ok" }, error: null },
      }),
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    return api;
  }

  it("opens from a row with what it did, models, prompt and answer, and the change", async () => {
    const user = userEvent.setup();
    renderRun(`/ops/runs/${RUN_ID}?tab=timeline`);
    await user.click(await screen.findByTestId(`ops-run-step-${STEP_ID}-open`));
    const panel = await screen.findByTestId("ops-run-step-panel");
    expect(within(panel).getByRole("heading", { name: "Update the record" })).toHaveFocus();
    expect(within(panel).getByTestId("ops-run-step-panel-summary")).toHaveTextContent(
      "Updated record r1",
    );
    const facts = within(panel).getByTestId("ops-run-step-panel-facts");
    expect(facts).toHaveTextContent("2 (retried 1 time)");
    expect(facts).toHaveTextContent("claude-opus-5-5");
    expect(facts).toHaveTextContent("1.2k in / 80 out");
    expect(facts).toHaveTextContent("$0.01");
    expect(facts).toHaveTextContent("30 s");

    const input = within(panel).getByTestId("ops-run-step-panel-input");
    expect(input).toHaveTextContent("Amount");
    expect(input).toHaveTextContent("12");
    expect(input.textContent).not.toContain("{");

    const calls = await within(panel).findByTestId("ops-run-step-panel-model-calls");
    expect(calls).toHaveTextContent("anthropic · claude-opus-5-5");
    await user.click(within(calls).getByTestId(`ops-run-step-panel-call-${CALL}-open`));
    expect(await within(calls).findByTestId(`ops-model-body-${CALL}`)).toHaveTextContent(
      "Read the record",
    );

    const change = within(panel).getByTestId(
      "ops-run-step-panel-change-00000000-0000-4000-8000-0000000f4001",
    );
    expect(change).toHaveTextContent("Done");
    expect(change).toHaveTextContent("Approved");
    expect(within(change).getByTestId("change")).toHaveTextContent("12.00");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("ops-run-step-panel")).toBeNull());
  });

  it("opens from a shared address and lists on Data the change, record and document", async () => {
    const user = userEvent.setup();
    renderRun(`/ops/runs/${RUN_ID}?step=${STEP_ID}`);
    const panel = await screen.findByTestId("ops-run-step-panel");
    await user.click(within(panel).getByTestId("ops-run-step-panel-tab-data"));
    const list = within(panel).getByTestId("ops-run-step-data");
    expect(within(list).getByRole("link", { name: "Oak board · r1" })).toHaveAttribute(
      "href",
      `/ops/clients/${TENANT}/records/${RECORD}`,
    );
    expect(within(list).getByRole("link", { name: "Document ·0d0001" })).toHaveAttribute(
      "href",
      `/ops/clients/${TENANT}/documents/${DOC}`,
    );
    expect(within(list).getByTestId("ops-run-step-data-change")).toHaveTextContent("Done");
  });
});

// Hand off (owner, 2026-11-11; docs/plan.md §1.96): the sender's step links to the run it
// started; the run started says where it came from and the step it started at.
describe("back-office run view: hand-offs", () => {
  const OTHER = "00000000-0000-4000-8000-0000000f1abc";
  const FROM = "00000000-0000-4000-8000-0000000f1def";
  const STEP = "00000000-0000-4000-8000-0000000f2abc";
  const PROCESS = {
    schemaVersion: 4,
    triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
    steps: [
      {
        id: "hand",
        name: "Hand off to Price checker at 2 · Itemize the invoice",
        kind: "handoff",
        to: { agent: "price-checker", step: "itemize" },
        input: {},
      },
    ],
  };
  const base = detail("resolved");
  const data = {
    ...base,
    run: { ...base.run, status: "succeeded", trigger: { type: "handoff", fromRunId: FROM } },
    steps: [
      step(STEP, "hand", "handoff", "succeeded", {
        output: { runId: OTHER, agent: "price-checker", step: "itemize" },
        summary: "Handed off to Price checker (run R-0f1abc)",
      }),
    ],
    actions: [],
    inbox: [],
    workflow: { slug: "fix-record", name: "Fix a record", definition: PROCESS },
    handedOffFrom: { fromRunId: FROM, fromAgent: "AP bill clerk", at: "5 · Itemize the invoice" },
  };

  it("links the step to the run it started, and the header to the run that handed off", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => data,
    });
    render(
      <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId(`ops-run-step-${STEP}`, {}, { timeout: 10_000 });
    expect(row).toHaveTextContent("Handed off to Price checker (run R-0f1abc)");
    expect(within(row).getByTestId(`ops-run-step-handoff-${STEP}`)).toHaveAttribute(
      "href",
      `/ops/runs/${OTHER}`,
    );
    const from = screen.getByTestId("ops-run-handoff");
    expect(from).toHaveTextContent(
      "Handed off from AP bill clerk (run R-0f1def) · started at 5 · Itemize the invoice",
    );
    expect(within(from).getByRole("link")).toHaveAttribute("href", `/ops/runs/${FROM}`);
  });
});
