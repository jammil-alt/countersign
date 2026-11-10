// Wave 5: the builder's words for how a step ended, the routes a step offers, and "Add a route for
// this" (an if right after the step; the continue setting the route needs; approvals stay on).
import { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { Process, Step } from "./model";
import {
  addRouteAfter,
  goOnWhenNoAnswer,
  labelPaths,
  outcomeRules,
  plainOutcomeProblem,
  routeOptions,
  takesOnError,
} from "./outcomes";

const approval = {
  required: "required" as const,
  mode: "in_turn" as const,
  ifNoAnswer: "stop" as const,
  onReject: "stop" as const,
};

const STEPS: Step[] = [
  { id: "find", kind: "read", name: "Find the PO", tool: "testkit.record.query", input: {} },
  {
    id: "approve",
    kind: "write",
    name: "Approve the bill",
    tool: "testkit.record.update",
    input: {},
    checks: { approval },
  },
  {
    id: "ask",
    kind: "person",
    name: "Ask the vendor",
    mode: "ask",
    assignee: "client_admin",
    title: "Which one?",
    payload: {},
    deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
    channel: "inbox",
    onReject: "stop",
    choices: [
      { value: "keep", label: "Keep it" },
      { value: "drop", label: "Drop it" },
    ],
  },
  { id: "wait", kind: "wait", name: "Wait for the delivery", for: "2 days" },
  {
    id: "route",
    kind: "if",
    name: "If",
    paths: [{ id: "p1", name: "Path 1", when: { match: "all", rules: [] }, steps: [] }],
    otherwise: { id: "else", steps: [] },
  },
  { id: "later", kind: "read", name: "Later", tool: "testkit.record.query", input: {} },
];
const PROCESS: Process = {
  schemaVersion: 4,
  triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
  steps: STEPS,
};

const step = (id: string) => processes.findStep(PROCESS, id)?.step as Step;
let n = 0;
const newId = () => `id-${++n}`;

describe("the field picker's outcome fields", () => {
  const paths = labelPaths(PROCESS, processes.processPathsAt(PROCESS, "route"));

  it("offers how each earlier step ended, in words, and never a later step's", () => {
    const outcomes = paths.filter((p) => /^steps\.[^.]+\.outcome$/.test(p.path));
    expect(outcomes.map((p) => [p.path, p.label])).toEqual([
      ["steps.find.outcome", "Find the PO: how it ended"],
      ["steps.approve.outcome", "Approve the bill: how it ended"],
      ["steps.ask.outcome", "Ask the vendor: how it ended"],
      ["steps.wait.outcome", "Wait for the delivery: how it ended"],
    ]);
    expect(paths.some((p) => p.path.startsWith("steps.later."))).toBe(false);
    expect(paths.some((p) => p.path.startsWith("steps.route."))).toBe(false);
    // Outputs keep their paths, with no words.
    expect(paths.find((p) => p.path.startsWith("steps.ask.output"))?.label).toBeUndefined();
  });

  it("gives each its reachable values in words", () => {
    const at = (path: string) => paths.find((p) => p.path === path);
    expect(at("steps.find.outcome")?.values).toEqual({
      done: "found it",
      empty: "found nothing",
      skipped: "was skipped",
    });
    expect(at("steps.approve.approval.outcome")).toMatchObject({
      label: "Approve the bill: its approval",
      values: { rejected: "was rejected", no_answer: "nobody answered" },
    });
    expect(at("steps.ask.choice")?.values).toEqual({ keep: "“Keep it”", drop: "“Drop it”" });
    expect(at("steps.wait.outcome")?.values).toEqual({ timed_out: "timed out" });
  });

  it("makes one-pick rules of them", () => {
    const rules = outcomeRules(paths);
    expect(rules.map((r) => r.label)).toEqual(
      expect.arrayContaining([
        "Approve the bill: was rejected",
        "Ask the vendor: nobody answered",
        "Find the PO: found nothing",
        "Wait for the delivery: timed out",
      ]),
    );
    expect(rules.find((r) => r.label === "Approve the bill: was rejected")?.rule).toEqual({
      field: "{{steps.approve.outcome}}",
      op: "=",
      value: "rejected",
    });
  });
});

describe("routes a step offers", () => {
  it("says what a route needs the step to do, never loosening its approval", () => {
    const options = routeOptions(step("approve"));
    expect(options.map((o) => [o.key, o.label, o.change?.setting ?? null])).toEqual([
      ["done", "was done", null],
      ["rejected", "was rejected", "If rejected"],
      ["no_answer", "nobody answered", "If nobody answers"],
      ["needs_help", "needed help nobody gave", "If this step fails"],
      ["failed", "failed", "If this step fails"],
    ]);
    for (const o of options) {
      const after = o.apply(step("approve"));
      expect(processes.approvalLoosenings(after.checks?.approval, "a")).toEqual([]);
      expect(after.checks?.approval?.required).toBe("required");
    }
  });

  it("offers a person's quick answers and no failure", () => {
    const keys = routeOptions(step("ask")).map((o) => o.key);
    expect(keys).toEqual(["answered", "no_answer", "choice:keep", "choice:drop"]);
    expect(takesOnError(step("ask"))).toBe(false);
    expect(takesOnError(step("find"))).toBe(true);
  });

  it("goes on when nobody answers by skipping, an escalation's own deadline too", () => {
    expect(goOnWhenNoAnswer("stop")).toBe("skip");
    expect(goOnWhenNoAnswer("skip")).toBeNull();
    expect(goOnWhenNoAnswer("proceed")).toBeNull();
    expect(
      goOnWhenNoAnswer({
        escalate: {
          to: "lead",
          deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
        },
      }),
    ).toEqual({
      escalate: { to: "lead", deadline: { after: "1 day", hours: "clock", ifNoAnswer: "skip" } },
    });
  });
});

describe("addRouteAfter", () => {
  it("puts an if right after the step, routed on its outcome, and sets the step to go on", () => {
    const rejected = routeOptions(step("approve")).find((o) => o.key === "rejected");
    if (!rejected) throw new Error("no route");
    const out = addRouteAfter(PROCESS, "approve", rejected, newId);
    if (!out) throw new Error("not added");
    expect(out.process.steps.map((s) => s.id)).toEqual([
      "find",
      "approve",
      out.ifId,
      "ask",
      "wait",
      "route",
      "later",
    ]);
    expect(out.process.steps[2]).toEqual({
      id: out.ifId,
      kind: "if",
      name: "If rejected",
      paths: [
        {
          id: expect.any(String),
          name: "Rejected",
          when: {
            match: "all",
            rules: [{ field: "{{steps.approve.outcome}}", op: "=", value: "rejected" }],
          },
          steps: [],
        },
      ],
      otherwise: { id: expect.any(String), steps: [] },
    });
    expect(out.process.steps[1]?.checks?.approval).toEqual({ ...approval, onReject: "continue" });
    // The validator takes it: the if reads an earlier step's outcome it can reach.
    const result = processes.validateProcess(out.process, {});
    const mine = (e: { stepId: string | null }) =>
      e.stepId === out.ifId || !!e.stepId?.startsWith("id-");
    expect(result.errors.filter(mine)).toEqual([]);
    expect(result.warnings.filter(mine)).toEqual([]);
  });

  it("sets onError: continue for a failure route", () => {
    const failed = routeOptions(step("find")).find((o) => o.key === "failed");
    if (!failed) throw new Error("no route");
    const out = addRouteAfter(PROCESS, "find", failed, newId);
    expect(out?.process.steps[0]).toMatchObject({ id: "find", onError: "continue" });
    expect(out?.process.steps[1]).toMatchObject({ kind: "if", name: "If failed" });
  });
});

describe("the validator's outcome problems in words", () => {
  const routed = (value: string): Process => ({
    ...PROCESS,
    steps: PROCESS.steps.map((s) =>
      s.kind === "if"
        ? {
            ...s,
            paths: [
              {
                id: "p1",
                name: "Path 1",
                when: {
                  match: "all",
                  rules: [{ field: "{{steps.find.outcome}}", op: "=", value }],
                },
                steps: [],
              },
            ],
          }
        : s,
    ),
  });

  it("says a word the step never ends with, and offers the ones it does", () => {
    const process = routed("lost");
    const problem = processes
      .validateProcess(process, {})
      .errors.find((e) => e.code === "outcome_unknown");
    if (!problem) throw new Error("no problem");
    expect(plainOutcomeProblem(process, problem)).toBe(
      "“lost” isn't a way “Find the PO” can end. Pick one of: found it, found nothing, was rejected, nobody answered, was skipped, needed help nobody gave, failed.",
    );
  });

  it("says an outcome the step can't reach as set up, and how to reach it", () => {
    const process = routed("failed");
    const warning = processes
      .validateProcess(process, {})
      .warnings.find((w) => w.code === "outcome_unreachable");
    if (!warning) throw new Error("no warning");
    expect(plainOutcomeProblem(process, warning)).toBe(
      "As set up, “Find the PO” never ends “failed”, so this condition never holds: set “If this step fails” to carry on.",
    );
    expect(
      plainOutcomeProblem(process, { stepId: null, field: "", code: "other", message: "As is" }),
    ).toBe("As is");
  });
});
