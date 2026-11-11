// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the run view shows the owner's check on each
// attempt at a step (clean, flagged, reviewed, not watched), the run's audit with its marks, takes
// a reviewer's mark (a problem needs a note), and offers the trail as HTML or JSON.
import {
  type AuditMarkView,
  type OwnerCheckView,
  ownerCheckWords,
  type RunAuditState,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const RUN_ID = "00000000-0000-4000-8000-0000000f1001";
const TENANT = "00000000-0000-4000-8000-00000000a001";
const AGENT = "00000000-0000-4000-8000-00000000b001";
const VERSION = "00000000-0000-4000-8000-0000000e0001";
const R = (n: number) => `00000000-0000-4000-8000-0000000f8${String(n).padStart(3, "0")}`;

const PROCESS = {
  schemaVersion: 4,
  triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
  steps: [
    { id: "look", name: "Look the PO up", kind: "read", tool: "testkit.record.query", input: {} },
    { id: "find", name: "Find the vendor", kind: "read", tool: "testkit.record.query", input: {} },
    {
      id: "post",
      name: "Post the bill",
      kind: "write",
      tool: "testkit.record.update",
      input: {},
    },
  ],
};

const step = (id: string, nodeId: string, nodeType: string) => ({
  id,
  nodeId,
  nodeType,
  skillRef: null,
  status: "succeeded",
  input: null,
  output: null,
  summary: null,
  costUsd: "0",
  tokensIn: 0,
  tokensOut: 0,
  startedAt: "2026-11-03T10:00:10.000Z",
  finishedAt: "2026-11-03T10:00:12.000Z",
});

function check(
  id: string,
  nodeId: string,
  attempt: number,
  over: Partial<OwnerCheckView> & Pick<OwnerCheckView, "result">,
): OwnerCheckView {
  const base = {
    id,
    nodeId,
    attempt,
    attemptOutcome: "succeeded" as const,
    signals: [],
    reason: null,
    cause: null,
    verdict: null,
    reviewDue: null,
    decisionId: null,
    createdAt: "2026-11-03T10:00:12.000Z",
    ...over,
  };
  return { ...base, words: ownerCheckWords(base) };
}

const CHECKS: OwnerCheckView[] = [
  check(R(1), "look", 1, { result: "clean" }),
  check(R(2), "find", 1, { result: "not_watched", reason: "step_off" }),
  check(R(3), "post", 1, { result: "flagged", attemptOutcome: "failed", reason: "limit" }),
  check(R(4), "post", 2, {
    result: "reviewed",
    signals: [
      {
        kind: "total_outlier",
        field: "total",
        amount: "4000",
        currency: "USD",
        median: "1000",
        runs: 12,
      },
    ],
    cause: "failed",
    verdict: "continue",
    decisionId: R(30),
  }),
];

const mark = (
  id: string,
  verdict: AuditMarkView["verdict"],
  note: string | null,
  at: string,
): AuditMarkView => ({
  id,
  runId: RUN_ID,
  verdict,
  note,
  markedBy: { id: OPERATOR_SESSION.user.id, name: "Operator", email: "operator@example.com" },
  inboxItemId: null,
  createdAt: at,
});

function runDetail(audit: RunAuditState, status = "succeeded", mode = "live") {
  return {
    run: {
      id: RUN_ID,
      tenantId: TENANT,
      agentId: AGENT,
      agentVersionId: VERSION,
      workflowSlug: "post-bill",
      mode,
      status,
      trigger: { by: "operator" },
      costUsd: "0.0100",
      error: null,
      startedAt: "2026-11-03T10:00:00.000Z",
      finishedAt: status === "succeeded" ? "2026-11-03T10:00:20.000Z" : null,
      createdAt: "2026-11-03T10:00:00.000Z",
    },
    steps: [step(R(11), "look", "read"), step(R(12), "find", "read"), step(R(13), "post", "write")],
    toolCalls: [],
    actions: [],
    inbox: [],
    agent: { id: AGENT, tenantId: TENANT, slug: "bills", name: "Bills", serviceName: null },
    version: 2,
    workflow: { slug: "post-bill", name: "Post a bill", definition: PROCESS },
    oversight: [],
    ownerChecks: CHECKS,
    audit,
  };
}

function renderRun(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[`/ops/runs/${RUN_ID}?tab=timeline`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const QUEUED: RunAuditState = {
  queued: {
    reason: "sampled",
    rule: { writes: true, percent: 5, source: "default", bucket: 120 },
    createdAt: "2026-11-03T10:00:20.000Z",
  },
  marks: [],
  latest: null,
};

describe("run view: the owner's check on each step", () => {
  it("shows each attempt's check in plain words, linking a review to its note", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => runDetail(QUEUED),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
    });
    renderRun(api);
    const look = await screen.findByTestId(`ops-run-owner-check-${R(1)}`);
    expect(look).toHaveTextContent("Owner checked: nothing off");
    expect(look).toHaveAttribute("data-result", "clean");
    expect(screen.getByTestId(`ops-run-owner-check-${R(2)}`)).toHaveTextContent(
      "Not watched: the owner's review is off for this step",
    );
    // Two attempts at one step: each is named.
    const post = screen.getByTestId(`ops-run-owner-checks-${R(13)}`);
    const lines = within(post)
      .getAllByRole("listitem")
      .map((l) => l.textContent);
    expect(lines).toEqual([
      "Attempt 1: Failed → not reviewed: the review limit was reached",
      "Attempt 2: Flagged: total 4× its usual → reviewed → carried on · the owner's note",
    ]);
    expect(screen.getByTestId(`ops-run-owner-check-decision-${R(4)}`)).toHaveAttribute(
      "href",
      `/ops/runs/${RUN_ID}?tab=details`,
    );
    // A step's checks stay with that step.
    expect(
      within(screen.getByTestId(`ops-run-step-${R(11)}`)).queryByTestId(
        `ops-run-owner-check-${R(3)}`,
      ),
    ).toBeNull();
  });
});

describe("run view: the audit and the export", () => {
  it("says why it was queued, and records a problem only with a note", async () => {
    const posted: unknown[] = [];
    let audit: RunAuditState = QUEUED;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => runDetail(audit),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
      [`POST /api/ops/runs/${RUN_ID}/audit-marks`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        const m = mark(R(40), body.verdict, body.note ?? null, "2026-11-04T09:00:00.000Z");
        audit = { ...audit, marks: [m, ...audit.marks], latest: m };
        return { mark: m, audit };
      },
    });
    const user = userEvent.setup();
    renderRun(api);
    expect(await screen.findByTestId("ops-run-audit-queued")).toHaveTextContent(
      "Queued: sampled, 5% of runs without a write",
    );
    await user.click(screen.getByTestId("ops-run-audit-problem"));
    const save = screen.getByTestId("ops-run-audit-save");
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId("ops-run-audit-note"), "Freight posted twice");
    await user.click(save);
    await waitFor(() =>
      expect(posted).toEqual([{ verdict: "problem", note: "Freight posted twice" }]),
    );
    expect(await screen.findByTestId("ops-run-audit-latest")).toHaveTextContent("Problem");
    expect(screen.getByTestId(`ops-run-audit-mark-${R(40)}`)).toHaveTextContent(
      "Freight posted twice",
    );
  });

  it("keeps earlier marks, newest first, and marks looks right without a note", async () => {
    const older = mark(R(41), "problem", "Wrong vendor", "2026-11-03T12:00:00.000Z");
    const newer = mark(R(42), "looks_right", null, "2026-11-04T12:00:00.000Z");
    const posted: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () =>
        runDetail({ queued: null, marks: [newer, older], latest: newer }),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
      [`POST /api/ops/runs/${RUN_ID}/audit-marks`]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return new Reply(409, { error: "run_not_finished" });
      },
    });
    const user = userEvent.setup();
    renderRun(api);
    expect(await screen.findByTestId("ops-run-audit-latest")).toHaveTextContent("Looks right");
    expect(screen.getByTestId("ops-run-audit-queued")).toHaveTextContent(
      "Not in the audit queue. Marking it adds it.",
    );
    expect(screen.getByTestId(`ops-run-audit-mark-${R(41)}`)).toHaveTextContent("superseded");
    await user.click(screen.getByTestId("ops-run-audit-looks_right"));
    await user.click(screen.getByTestId("ops-run-audit-save"));
    await waitFor(() => expect(posted).toEqual([{ verdict: "looks_right" }]));
    // The server's answer shows; the marks stay as they were.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("offers no mark while the run goes", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => runDetail(QUEUED, "running"),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
    });
    renderRun(api);
    expect(await screen.findByTestId("ops-run-audit")).toHaveTextContent(
      "You can mark it once it is over.",
    );
    expect(screen.queryByTestId("ops-run-audit-form")).toBeNull();
  });

  it("offers no audit on a test run, only its export", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () =>
        runDetail({ queued: null, marks: [], latest: null }, "succeeded", "test"),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
    });
    renderRun(api);
    expect(await screen.findByTestId("ops-run-export")).toBeInTheDocument();
    expect(screen.queryByTestId("ops-run-audit")).toBeNull();
  });

  it("downloads the trail as HTML or JSON, with AI calls only when ticked", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/runs/${RUN_ID}`]: () => runDetail(QUEUED),
      [`GET /api/ops/runs/${RUN_ID}/model-calls`]: () => ({ modelCalls: [], unrecorded: 0 }),
    });
    const user = userEvent.setup();
    renderRun(api);
    const html = await screen.findByTestId("ops-run-export-html");
    const json = screen.getByTestId("ops-run-export-json");
    expect(html).toHaveAttribute("href", `/api/ops/runs/${RUN_ID}/export?format=html`);
    expect(json).toHaveAttribute("href", `/api/ops/runs/${RUN_ID}/export?format=json`);
    expect(html).toHaveAttribute("download");
    await user.click(screen.getByTestId("ops-run-export-model-calls"));
    expect(html).toHaveAttribute("href", `/api/ops/runs/${RUN_ID}/export?format=html&modelCalls=1`);
    expect(json).toHaveAttribute("href", `/api/ops/runs/${RUN_ID}/export?format=json&modelCalls=1`);
  });
});
