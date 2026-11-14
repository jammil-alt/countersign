// R6 (docs/plan.md §1.86, §9): the owner's cheap watch and which steps it watches.

import { describe, expect, it } from "vitest";
import { Process } from "../process/schema";
import { ActionStep, SkillStep } from "../schemas/workflow";
import {
  OVERSIGHT_ALLOWED,
  OVERSIGHT_REVIEWS,
  OversightSettings,
  ownerAllowedActions,
  ownerReviewsFailure,
  ownerReviewsSuccess,
  ownerStepApproval,
  ownerStepLabel,
  ownerWatches,
  reviewsAfterSuccess,
  reviewsFailures,
  STEP_REVIEWS,
} from "./decision";
import {
  anomalySignals,
  historyTotals,
  isEmptyOutput,
  OWNER_HISTORY_MAX,
  outputTotal,
  type TotalSample,
} from "./watch";

const samples = (...amounts: string[]): TotalSample[] =>
  amounts.map((amount) => ({ amount, currency: null }));

describe("the cheap watch's signals", () => {
  it("reads empty results, not zeros or falses", () => {
    for (const v of [null, undefined, "", "  ", [], {}, { items: [] }, { a: null, b: "" }]) {
      expect(isEmptyOutput(v)).toBe(true);
    }
    for (const v of [0, false, "x", [1], { count: 0 }, { items: [{}] }, { ok: false }]) {
      expect(isEmptyOutput(v)).toBe(false);
    }
  });

  it("flags an empty result for reads, skills and conversations, never a write's receipt", () => {
    for (const kind of ["read", "skill", "conversation"]) {
      expect(anomalySignals({ kind, output: { bills: [] } })).toEqual([{ kind: "empty_output" }]);
    }
    expect(anomalySignals({ kind: "write", output: {} })).toEqual([]);
    expect(anomalySignals({ kind: "action", output: null })).toEqual([]);
  });

  it("reads a total as a decimal string or a money object, never a JS number", () => {
    expect(outputTotal({ total: "120.50" })).toEqual({
      field: "total",
      amount: "120.50",
      currency: null,
    });
    expect(outputTotal({ amount: { amount: "9.99", currency: "USD" } })).toEqual({
      field: "amount",
      amount: "9.99",
      currency: "USD",
    });
    // In order: `total` before `amount`.
    expect(outputTotal({ amount: "1", total: "2" })?.field).toBe("total");
    expect(outputTotal({ total: 120.5 })).toBeNull();
    expect(outputTotal({ total: "lots" })).toBeNull();
    expect(outputTotal(["120"])).toBeNull();
  });

  it("flags a total ten times above or below the median of at least five earlier ones", () => {
    const history = samples("100", "110", "90", "105", "95");
    expect(anomalySignals({ kind: "skill", output: { total: "999.99" }, history })).toEqual([]);
    expect(anomalySignals({ kind: "skill", output: { total: "1000.01" }, history })).toEqual([
      {
        kind: "total_outlier",
        field: "total",
        amount: "1000.01",
        currency: null,
        median: "100",
        runs: 5,
      },
    ]);
    expect(anomalySignals({ kind: "write", output: { total: "9.99" }, history })).toHaveLength(1);
    expect(anomalySignals({ kind: "write", output: { total: "10" }, history })).toEqual([]);
    // A credit where the step usually bills is far outside too.
    expect(anomalySignals({ kind: "skill", output: { total: "-50" }, history })).toHaveLength(1);
  });

  it("says nothing about size with fewer than five earlier totals, another currency or a zero median", () => {
    expect(
      anomalySignals({ kind: "skill", output: { total: "5000" }, history: samples("1", "2") }),
    ).toEqual([]);
    const usd = ["1", "1", "1", "1", "1"].map((amount) => ({ amount, currency: "USD" }));
    expect(
      anomalySignals({
        kind: "skill",
        output: { total: { amount: "5000", currency: "EUR" } },
        history: usd,
      }),
    ).toEqual([]);
    expect(
      anomalySignals({
        kind: "skill",
        output: { total: { amount: "5000", currency: "USD" } },
        history: usd,
      }),
    ).toHaveLength(1);
    expect(
      anomalySignals({
        kind: "skill",
        output: { total: "5" },
        history: samples("0", "0", "0", "0", "0"),
      }),
    ).toEqual([]);
  });

  it("flags a confer that disagreed, and only that", () => {
    expect(
      anomalySignals({ kind: "write", output: {}, confer: ["agree", "disagree", "disagree"] }),
    ).toEqual([{ kind: "confer_disagreed", count: 2 }]);
    expect(anomalySignals({ kind: "write", output: {}, confer: ["unsure", "no_answer"] })).toEqual(
      [],
    );
  });

  it("keeps earlier totals by key, newest first, at most the cap, without totals left out", () => {
    const rows = [
      { key: "lookup", output: { total: "3" } },
      { key: "lookup", output: { nothing: true } },
      { key: "__proto__", output: { total: "7" } },
      { key: "lookup", output: { total: { amount: "2", currency: "USD" } } },
      ...Array.from({ length: OWNER_HISTORY_MAX + 5 }, () => ({
        key: "many",
        output: { total: "1" },
      })),
    ];
    const totals = historyTotals(rows);
    expect(totals.lookup).toEqual([
      { amount: "3", currency: null },
      { amount: "2", currency: "USD" },
    ]);
    expect(Object.hasOwn(totals, "__proto__")).toBe(true);
    expect(totals.many).toHaveLength(OWNER_HISTORY_MAX);
  });
});

// ── Which steps the owner watches ────────────────────────────────────────────────────────────

const v3Skill = SkillStep.parse({ id: "s", kind: "skill", name: "Find", skill: "x.find" });
const v3Action = ActionStep.parse({ id: "a", kind: "action", name: "Write", tool: "x.write" });
const process = Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: { type: "object" } } }],
  steps: [
    { id: "r", kind: "read", name: "Read", tool: "x.read" },
    { id: "k", kind: "skill", name: "Think", skill: "x.think" },
    {
      id: "w",
      kind: "write",
      name: "Write",
      tool: "x.write",
      client: { visible: true, label: "Wrote it" },
      checks: {
        approval: {
          approvers: [{ who: "lead", deadline: { after: "2 hours" } }, { who: "client_admin" }],
          onReject: "continue",
        },
      },
    },
    {
      id: "c",
      kind: "conversation",
      name: "Ask the vendor",
      with: "{{trigger.vendor}}",
      channel: "email",
      goal: "Get the price",
      deadline: { after: "2 days" },
    },
    {
      id: "p",
      kind: "person",
      name: "Check",
      mode: "ask",
      assignee: "lead",
      title: "Check",
      deadline: { after: "1 day" },
    },
    { id: "n", kind: "notify", name: "Tell", notify: { to: ["lead"], message: "Done" } },
  ],
});
type Step = (typeof process.steps)[number];
const [read, skill, write, conversation, person, notify] = process.steps as [
  Step,
  Step,
  Step,
  Step,
  Step,
  Step,
];

describe("the steps the owner watches", () => {
  it("watches v3 skill and action steps and v4 read, skill, write and conversation steps", () => {
    for (const s of [v3Skill, v3Action, read, skill, write, conversation]) {
      expect(ownerWatches(s as { kind: string })).toBe(true);
    }
    for (const s of [person, notify]) expect(ownerWatches(s as { kind: string })).toBe(false);
  });

  it("is v0.13's rule exactly for v3 steps (the regression guard)", () => {
    for (const review of OVERSIGHT_REVIEWS) {
      const settings = OversightSettings.parse({ review });
      for (const stepReview of [undefined, ...STEP_REVIEWS]) {
        for (const base of [v3Skill, v3Action]) {
          const step = stepReview ? { ...base, review: stepReview } : base;
          expect(ownerReviewsFailure(settings, step)).toBe(reviewsFailures(settings, step));
          for (const checkpoint of [false, true]) {
            expect(ownerReviewsSuccess(settings, step, checkpoint)).toBe(
              reviewsAfterSuccess(settings, step, checkpoint),
            );
          }
        }
      }
    }
    expect(ownerReviewsFailure(undefined, v3Skill)).toBe(false);
  });

  it("never reviews a person, notify or logic step, whatever its review says", () => {
    const settings = OversightSettings.parse({ review: "all" });
    const always = { ...person, review: "always" as const };
    expect(ownerReviewsFailure(settings, always)).toBe(false);
    expect(ownerReviewsSuccess(settings, always, true, [{ kind: "empty_output" }])).toBe(false);
  });

  it("reviews a signal under failures, checkpoints and all, never under off or a step's off", () => {
    const signals = [{ kind: "empty_output" as const }];
    for (const review of ["failures", "checkpoints", "all"] as const) {
      const settings = OversightSettings.parse({ review });
      expect(ownerReviewsSuccess(settings, read as { kind: string }, false, signals)).toBe(true);
    }
    const failures = OversightSettings.parse({ review: "failures" });
    expect(ownerReviewsSuccess(failures, read as { kind: string }, false)).toBe(false);
    expect(
      ownerReviewsSuccess(OversightSettings.parse({ review: "off" }), read, false, signals),
    ).toBe(false);
    expect(ownerReviewsSuccess(undefined, read, false, signals)).toBe(false);
    expect(ownerReviewsSuccess(failures, { kind: "read", review: "off" }, false, signals)).toBe(
      false,
    );
  });

  it("never offers a conversation a corrected input", () => {
    expect(ownerAllowedActions(conversation, "failed")).toEqual(["retry", "ask", "stop"]);
    expect(ownerAllowedActions(conversation, "checkpoint")).toEqual(["continue", "ask", "stop"]);
    expect(ownerAllowedActions(write, "failed")).toBe(OVERSIGHT_ALLOWED.failed);
    expect(ownerAllowedActions(v3Skill, "checkpoint")).toBe(OVERSIGHT_ALLOWED.checkpoint);
  });

  it("asks the v3 step's approver, or the v4 step's first approver on its deadline", () => {
    expect(ownerStepApproval(v3Skill)).toEqual({ required: "required", onReject: "stop" });
    expect(ownerStepApproval(v3Action)).toBe(v3Action.approval);
    expect(ownerStepApproval(write as never)).toEqual({
      required: "required",
      approver: "lead",
      timeout: "2 hours",
      onReject: "continue",
    });
    expect(ownerStepApproval(read as never)).toEqual({ required: "required", onReject: "stop" });
  });

  it("labels a step as people see it", () => {
    expect(ownerStepLabel(write as never)).toBe("Wrote it");
    expect(ownerStepLabel(read as never)).toBe("Read");
  });
});
