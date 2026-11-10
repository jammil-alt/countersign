// Wave 5: the builder's words for how a step ended, the routes a step offers, and "Add a route for
// this" (an if right after the step; the continue setting the route needs; approvals stay on).
import { evaluateRules, processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { Process, Step } from "./model";
import {
  addRouteAfter,
  approvalRouteNames,
  goOnWhenNoAnswer,
  labelPaths,
  outcomeRules,
  plainOutcomeProblem,
  routeOptions,
  takesOnError,
  testRunApprovalNote,
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
          // The run used to stop on a no: the route still ends it, as a no always did.
          steps: [
            { id: expect.any(String), kind: "stop", name: "Stop the run", status: "cancelled" },
          ],
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

  it("sets onError: continue for a failure route, which ends the run as a failure did", () => {
    const failed = routeOptions(step("find")).find((o) => o.key === "failed");
    if (!failed) throw new Error("no route");
    expect(failed.stop).toBe("failed");
    const out = addRouteAfter(PROCESS, "find", failed, newId);
    expect(out?.process.steps[0]).toMatchObject({ id: "find", onError: "continue" });
    expect(out?.process.steps[1]).toMatchObject({ kind: "if", name: "If failed" });
    const path = out?.process.steps[1]?.kind === "if" ? out.process.steps[1].paths[0] : undefined;
    expect(path?.steps).toMatchObject([{ kind: "stop", status: "failed" }]);
  });

  it("adds no stop where the run already went on with the outcome", () => {
    const done = routeOptions(step("approve")).find((o) => o.key === "done");
    const drop = routeOptions(step("ask")).find((o) => o.key === "choice:drop");
    expect([done?.stop, drop?.stop]).toEqual([null, null]);
    if (!done) throw new Error("no route");
    const out = addRouteAfter(PROCESS, "approve", done, newId);
    const route = out?.process.steps[2];
    expect(route?.kind === "if" ? route.paths[0]?.steps : null).toEqual([]);
  });

  it("never runs past a person's no by default: the route ends the run before the payment", () => {
    // "OK to pay?" then a payment the connection lets run unsigned. A route on the no must not
    // let the payment run after it.
    const pay: Process = {
      schemaVersion: 4,
      triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
      steps: [
        {
          id: "ok",
          kind: "person",
          name: "OK to pay?",
          mode: "approve",
          assignee: "client_admin",
          title: "OK to pay?",
          payload: {},
          deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
          channel: "inbox",
          onReject: "stop",
        },
        { id: "pay", kind: "write", name: "Pay", tool: "testkit.record.update", input: {} },
      ],
    };
    const ok = processes.findStep(pay, "ok")?.step as Step;
    const saidNo = routeOptions(ok).find((o) => o.key === "said_no");
    if (!saidNo) throw new Error("no route");
    const out = addRouteAfter(pay, "ok", saidNo, newId);
    if (!out) throw new Error("not added");
    const [person, route, after] = out.process.steps;
    expect(person).toMatchObject({ id: "ok", onReject: "continue" });
    expect(after?.id).toBe("pay");
    if (route?.kind !== "if") throw new Error("no if");
    // The run after a no: the path the if takes, and the steps it runs before the payment.
    const scope = { steps: { ok: { output: { approved: false }, outcome: "answered" } } };
    const taken = route.paths.find((p) => evaluateRules(p.when, scope));
    expect(taken?.name).toBe("Said no");
    expect(taken?.steps.at(-1)).toMatchObject({ kind: "stop", status: "cancelled" });
    // A yes takes otherwise and goes on to pay, as before.
    const yes = { steps: { ok: { output: { approved: true }, outcome: "answered" } } };
    expect(route.paths.find((p) => evaluateRules(p.when, yes))).toBeUndefined();
    expect(processes.validateProcess(out.process, {}).errors).toEqual([]);
  });
});

describe("a failure route opens the step's other failures, and stops the run on them", () => {
  // Each step, then a payment the connection lets run unsigned. A route on one failure sets
  // onError: continue, which opens every failure of the step; none may go on to the payment.
  const pay: Step = {
    id: "pay",
    kind: "write",
    name: "Pay",
    tool: "testkit.record.update",
    input: {},
  };
  const withPay = (first: Step): Process => ({
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
    steps: [first, pay],
  });
  const check: Step = {
    id: "check",
    kind: "process",
    name: "Check the bill",
    process: "check-the-bill@1",
    input: {},
  };
  const draft: Step = {
    id: "draft",
    kind: "skill",
    name: "Draft the bill",
    skill: "testkit.draft",
    input: {},
  };
  const each: Step = {
    id: "each",
    kind: "for_each",
    name: "Each line",
    over: "{{trigger.lines}}",
    concurrency: 1,
    steps: [{ id: "line", kind: "read", name: "Line", tool: "testkit.record.query", input: {} }],
  };

  /** The added if, and the steps a run takes after the step ended with this record. */
  function routed(first: Step, word: string, record: Record<string, unknown>) {
    const process = withPay(first);
    const option = routeOptions(first).find((o) => o.key === word);
    if (!option) throw new Error(`no route on ${word}`);
    const out = addRouteAfter(process, first.id, option, newId);
    if (!out) throw new Error("not added");
    const [changed, route, next] = out.process.steps;
    expect(changed?.onError).toBe("continue");
    expect(next?.id).toBe("pay");
    if (route?.kind !== "if") throw new Error("no if");
    return {
      option,
      route,
      process: out.process,
      taken(rec: Record<string, unknown>) {
        const scope = { steps: { [first.id]: { output: null, ...record, ...rec } } };
        const path = route.paths.find((p) => evaluateRules(p.when, scope));
        return { path, scope };
      },
    };
  }

  /** How the path ends the run: its last stop's status, through an if on how a stop ended. */
  function endOf(steps: readonly Step[] | undefined, scope: Record<string, unknown>): string {
    const last = steps?.at(-1);
    if (last?.kind === "stop") return last.status;
    if (last?.kind === "if") {
      const inner = last.paths.find((p) => evaluateRules(p.when, scope));
      return endOf(inner ? inner.steps : last.otherwise.steps, scope);
    }
    return "goes on";
  }

  it("a process routed on failed stops the run when it stopped, as the stop inside did", () => {
    const { option, taken, process } = routed(check, "failed", {});
    expect(option.others).toEqual(["stopped"]);
    expect(option.change?.says).toMatch(/also lets it carry on when it stopped/);
    expect(option.change?.says).toMatch(/“Stopped”/);
    const failed = taken({ outcome: "failed" });
    expect(failed.path?.name).toBe("Failed");
    expect(endOf(failed.path?.steps, failed.scope)).toBe("failed");
    // "Amount over limit" ended the sub-process with a cancelling stop: the run ends cancelled,
    // and the payment never runs.
    for (const status of ["cancelled", "succeeded", "failed"]) {
      const stopped = taken({ outcome: "stopped", stopStatus: status });
      expect(stopped.path?.name).toBe("Stopped");
      expect(endOf(stopped.path?.steps, stopped.scope)).toBe(status);
    }
    // A run stored before the detail was kept still stops, as a failure.
    const old = taken({ outcome: "stopped" });
    expect(endOf(old.path?.steps, old.scope)).toBe("failed");
    // A completed process takes otherwise and goes on to pay, as before.
    expect(taken({ outcome: "completed" }).path).toBeUndefined();
    const mine = (e: { stepId: string | null }) => !!e.stepId?.startsWith("id-");
    const result = processes.validateProcess(process, {});
    expect(result.errors.filter(mine)).toEqual([]);
    expect(result.warnings.filter(mine)).toEqual([]);
  });

  it("a process routed on stopped ends the run as the stop inside did, and stops on failed", () => {
    const { option, taken } = routed(check, "stopped", {});
    expect(option.stop).toBe("as_inside");
    expect(option.others).toEqual(["failed"]);
    const stopped = taken({ outcome: "stopped", stopStatus: "cancelled" });
    expect(stopped.path?.name).toBe("Stopped");
    expect(endOf(stopped.path?.steps, stopped.scope)).toBe("cancelled");
    const failed = taken({ outcome: "failed" });
    expect(failed.path?.name).toBe("Failed");
    expect(endOf(failed.path?.steps, failed.scope)).toBe("failed");
  });

  it("a skill routed on failed stops the run when it needed help", () => {
    const { option, taken, process } = routed(draft, "failed", {});
    expect(option.others).toEqual(["needs_help"]);
    const helped = taken({ outcome: "needs_help" });
    expect(helped.path?.name).toBe("Needed help");
    expect(helped.path?.when.rules).toEqual([
      { field: "{{steps.draft.outcome}}", op: "in", value: ["needs_help"] },
    ]);
    expect(endOf(helped.path?.steps, helped.scope)).toBe("failed");
    expect(taken({ outcome: "done" }).path).toBeUndefined();
    const mine = (e: { stepId: string | null }) => !!e.stepId?.startsWith("id-");
    expect(processes.validateProcess(process, {}).errors.filter(mine)).toEqual([]);
  });

  it("a loop routed on some failed stops the run when all failed, and the reverse", () => {
    const some = routed(each, "some_failed", {});
    expect(some.option.others).toEqual(["all_failed"]);
    const all = some.taken({ outcome: "all_failed", counts: { items: 2, failed: 2 } });
    expect(all.path?.name).toBe("All failed");
    expect(endOf(all.path?.steps, all.scope)).toBe("failed");
    const reverse = routed(each, "all_failed", {});
    const someFailed = reverse.taken({ outcome: "some_failed", counts: { items: 2, failed: 1 } });
    expect(someFailed.path?.name).toBe("Some failed");
    expect(endOf(someFailed.path?.steps, someFailed.scope)).toBe("failed");
    expect(reverse.taken({ outcome: "done" }).path).toBeUndefined();
  });

  it("opens nothing more where the step already goes on past a failure", () => {
    const failed = routeOptions({ ...check, onError: "continue" }).find((o) => o.key === "failed");
    expect(failed).toMatchObject({ change: null, stop: null, others: [] });
  });
});

describe("test runs and routes on an approval", () => {
  it("names the ifs that read an approval, which reads “needed no approval” in a test", () => {
    expect(approvalRouteNames(PROCESS)).toEqual([]);
    expect(testRunApprovalNote([])).toBeNull();
    const approved = routeOptions(step("approve")).find((o) => o.key === "done");
    if (!approved) throw new Error("no route");
    const withRoute = addRouteAfter(
      PROCESS,
      "approve",
      {
        ...approved,
        rule: { field: "{{steps.approve.approval.outcome}}", op: "=", value: "approved" },
      },
      newId,
    );
    if (!withRoute) throw new Error("not added");
    expect(approvalRouteNames(withRoute.process)).toEqual(["If done"]);
    expect(testRunApprovalNote(["If done"])).toBe(
      "“If done” routes on an approval. In a test run nobody signs, so each write's approval reads “needed no approval” and the route goes the way it would with none.",
    );
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
