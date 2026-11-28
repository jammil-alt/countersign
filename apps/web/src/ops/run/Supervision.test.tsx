// What the supervisor verified and decided on a step (owner, 2026-11-27): two lines from the run's
// data, the note and its records folded, quiet on a clean step, nothing on one it doesn't watch.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import { SupervisionLines, shortReason, stepSupervision } from "./Supervision";

type RunData = ResponseOf<typeof apiRoutes.opsRun>;

const RUN_ID = "00000000-0000-4000-8000-0000000a0001";
const TENANT = "00000000-0000-4000-8000-0000000c0001";
const SOURCE = "00000000-0000-4000-8000-0000000e0001";

function check(nodeId: string, over: Record<string, unknown>) {
  return {
    id: `c-${nodeId}-${String(over.attempt ?? 1)}`,
    nodeId,
    attempt: 1,
    result: "clean",
    attemptOutcome: "succeeded",
    signals: [],
    reason: null,
    cause: null,
    verdict: null,
    reviewDue: null,
    decisionId: null,
    words: "Owner checked: nothing off",
    createdAt: "2026-11-27T10:00:00.000Z",
    ...over,
  };
}

function decision(stepRunId: string, nodeId: string, over: Record<string, unknown>) {
  return {
    id: `d-${stepRunId}`,
    runId: RUN_ID,
    stepRunId,
    nodeId,
    seq: 1,
    cause: "checkpoint",
    action: "continue",
    inputBefore: null,
    inputAfter: null,
    note: "The lines match the invoice. Each total adds up.",
    proposal: null,
    inboxItemId: null,
    sources: [SOURCE],
    model: "m",
    costUsd: "0.01",
    tokensIn: 1,
    tokensOut: 1,
    agentVersionId: "v",
    createdAt: "2026-11-27T10:00:00.000Z",
    ...over,
  };
}

const verification = {
  outcome: "disagreed",
  checked: 3,
  differences: [{ path: "TotalAmt", proposed: "120.00", derived: "210.00" }],
  reason: null,
  sources: [SOURCE],
};

const run = {
  run: { id: RUN_ID, tenantId: TENANT, status: "succeeded", error: null },
  workflow: { slug: "bills", name: "Bills", definition: { schemaVersion: 5 } },
  steps: [
    { id: "r-read", nodeId: "read", status: "succeeded", output: {} },
    { id: "r-check", nodeId: "check", status: "succeeded", output: {} },
    // A test run's write: its second check is on its output.
    {
      id: "r-enter",
      nodeId: "enter",
      status: "succeeded",
      output: { wouldHaveDone: true, verification },
    },
    { id: "r-tell", nodeId: "tell", status: "succeeded", output: {} },
    // A live run's write: its second check is on its approval card.
    { id: "r-live", nodeId: "live", status: "waiting", output: null },
    { id: "r-ask", nodeId: "ask", status: "waiting", output: null },
  ],
  ownerChecks: [
    check("read", {
      result: "reviewed",
      reviewDue: "checkpoint",
      cause: "checkpoint",
      verdict: "continue",
      decisionId: "d-r-read",
      words: "Checkpoint before a write → reviewed → carried on",
    }),
    check("check", {}),
    check("enter", {
      result: "reviewed",
      signals: [{ kind: "empty_output" }],
      cause: "failed",
      verdict: "retry_with",
      words: "Flagged: an empty result → reviewed → corrected the input and tried again",
    }),
    check("tell", { result: "not_watched", reason: "owner_off" }),
    check("ask", { result: "reviewed", cause: "failed", verdict: "ask" }),
  ],
  oversight: [
    decision("r-read", "read", {}),
    decision("r-enter", "enter", {
      cause: "failed",
      action: "retry_with",
      inputBefore: { vendor: "Acme", total: "120.00" },
      inputAfter: { vendor: "Acme", total: "210.00" },
      note: "The total was read from the wrong line.",
    }),
    decision("r-ask", "ask", {
      cause: "failed",
      action: "ask",
      inboxItemId: "i-ask",
      note: "The vendor isn't in QuickBooks.",
      sources: [],
    }),
  ],
  actions: [{ id: "a1", stepRunId: "r-live", status: "proposed", inboxItemId: "i-live" }],
  inbox: [
    {
      id: "i-live",
      title: "Create a bill",
      payload: { verification: { ...verification, outcome: "agreed", differences: [] } },
    },
    { id: "i-ask", title: "Which vendor is this?", payload: {} },
  ],
  sourceNames: { [SOURCE]: "Northline Panel Supply · 20418" },
} as unknown as RunData;

describe("stepSupervision", () => {
  it("says what it verified: rules, the write against the sources, the run's goal", () => {
    expect(stepSupervision(run, ["r-read"])?.verified.map((v) => v.text)).toEqual([
      "Rules: no issues",
      "Read against the run's goal",
    ]);
    expect(stepSupervision(run, ["r-enter"])?.verified).toEqual([
      { text: "Rules flagged an empty result", tone: "ink" },
      { text: "Write differs from the sources on TotalAmt", tone: "risk" },
      { text: "Read against the run's goal", tone: "ink" },
    ]);
    // A live write's check is on its card.
    expect(stepSupervision(run, ["r-live"])?.verified).toEqual([
      { text: "Write matches the sources (3 fields)", tone: "ink" },
    ]);
  });

  it("says what it decided, with a short reason, what it changed and what it asked", () => {
    expect(stepSupervision(run, ["r-read"])?.decisions[0]).toMatchObject({
      tag: "Continued",
      reason: "The lines match the invoice.",
      sources: [SOURCE],
    });
    expect(stepSupervision(run, ["r-enter"])?.decisions[0]).toMatchObject({
      tag: "Retried with a corrected input",
      changed: ["total"],
    });
    expect(stepSupervision(run, ["r-ask"])?.decisions[0]).toMatchObject({
      tag: "Asked a person",
      tone: "warning",
      question: "Which vendor is this?",
    });
  });

  it("stays quiet on a clean step, and says nothing on one it doesn't watch", () => {
    expect(stepSupervision(run, ["r-check"])).toEqual({
      verified: [{ text: "Rules: no issues", tone: "ink" }],
      quiet: true,
      decisions: [],
    });
    expect(stepSupervision(run, ["r-tell"])).toBeNull();
    expect(stepSupervision(run, ["nowhere"])).toBeNull();
  });

  it("cuts a long reason to about a line", () => {
    expect(shortReason("A. B.")).toBe("A.");
    expect(shortReason("x".repeat(200))).toHaveLength(118);
  });
});

describe("SupervisionLines", () => {
  it("shows Verified and Decided, with the note, the change and the records folded", () => {
    const enter = stepSupervision(run, ["r-enter"]);
    const read = stepSupervision(run, ["r-read"]);
    const clean = stepSupervision(run, ["r-check"]);
    if (!enter || !read || !clean) throw new Error("expected supervision");
    render(
      <MemoryRouter>
        <SupervisionLines supervision={read} run={run} testId="sup-read" />
        <SupervisionLines supervision={enter} run={run} testId="sup-enter" />
        <SupervisionLines
          supervision={clean}
          run={run}
          testId="sup-check"
          attempts={<span data-testid="attempts">Owner checked: nothing off</span>}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("sup-check-quiet")).toHaveTextContent("Checked by rules: no issues");
    expect(screen.getByTestId("attempts")).toBeTruthy();
    expect(screen.getByTestId("sup-enter-verified")).toHaveTextContent(
      "Verified Rules flagged an empty result · Write differs from the sources on TotalAmt · Read against the run's goal",
    );
    const decided = screen.getByTestId("sup-enter-decided-d-r-enter");
    expect(decided).toHaveTextContent("Retried with a corrected input");
    expect(decided).toHaveTextContent("The total was read from the wrong line.");
    expect(screen.getByTestId("sup-enter-changed-d-r-enter")).toHaveTextContent("Changed: total");
    expect(screen.getByTestId("sup-read-more")).toHaveTextContent("Note and sources");
    expect(
      screen.getByTestId("sup-read-sources-d-r-read").querySelector("a")?.getAttribute("href"),
    ).toBe(`/ops/clients/${TENANT}/records/${SOURCE}`);
  });
});
