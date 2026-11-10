// v0.13 W2-I: run oversight in the executor (ARCHITECTURE §10.11; docs/plan.md §1.54, M31). The
// executor applies the agent's verdicts on the fake runner; it never calls a model.

import {
  ActionStep,
  OVERSIGHT_REVIEWS,
  OversightSettings,
  type OwnerWatchedStep,
  processes,
  reviewsAfterSuccess,
  reviewsFailures,
  SkillStep,
  STEP_REVIEWS,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
// R6
import {
  ownerAfterSuccess,
  ownerErrorKey,
  ownerReviewRequest,
  ownerReviewsFailureOf,
  ownerStepInput,
} from "./oversight";
import type { OversightPort, OversightRequest, OversightVerdict } from "./ports";
import { inboxEventType } from "./runner";

/** A port that answers from a script, in order, and records what it was asked. */
function port(...verdicts: OversightVerdict[]) {
  const requests: OversightRequest[] = [];
  const p: OversightPort = {
    async review(req) {
      requests.push(req);
      return verdicts.shift() ?? { action: "none", reason: "script ran out" };
    },
  };
  return { port: p, requests };
}

const settings = (over: Record<string, unknown> = {}) =>
  OversightSettings.parse({ review: "failures", ...over });

const lookup = (over: Record<string, unknown> = {}) => ({
  id: "lookup",
  kind: "skill",
  name: "Find the vendor",
  skill: SKILL.id,
  input: { name: "{{trigger.vendor}}" },
  ...over,
});

const write = (over: Record<string, unknown> = {}) => ({
  id: "write",
  kind: "action",
  name: "Update the record",
  tool: WRITE_TOOL.id,
  input: { name: "{{steps.lookup.output.name}}" },
  ...over,
});

/** A lookup that fails on a name with a trailing space and finds it without one. */
function trims(h: Harness) {
  h.handlers.lookup = (req) => {
    const name = (req.input as { name: string }).name;
    return name.endsWith(" ")
      ? { kind: "failed", error: `no vendor named "${name}"` }
      : { kind: "done", output: { name } };
  };
}

describe("run oversight on failures", () => {
  it("changes nothing without a port, or with review off", async () => {
    for (const ctx of [{}, { oversight: { ...port(), settings: settings({ review: "off" }) } }]) {
      const h = new Harness();
      trims(h);
      const runner = new FakeStepRunner();
      const result = await executeWorkflow(runner, h.context(ctx), wf([lookup()]), {
        vendor: "Acme ",
      });
      expect(result).toMatchObject({ status: "failed", reason: 'no vendor named "Acme "' });
      expect(result).not.toHaveProperty("diagnosis");
      expect(runner.names()).toEqual(["lookup", "lookup:failed"].slice(0, 1));
    }
  });

  it("retries a transient failure with the same input and key after a wait, and finishes", async () => {
    const h = new Harness();
    let calls = 0;
    h.handlers.lookup = () =>
      ++calls === 1
        ? { kind: "failed", error: "rate limited" }
        : { kind: "done", output: { name: "Acme" } };
    const o = port({ action: "retry", after: "30 seconds", note: "A rate limit: try again." });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf([lookup()]),
      { vendor: "Acme" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(o.requests).toEqual([
      expect.objectContaining({
        nodeId: "lookup",
        seq: 1,
        cause: "failed",
        input: { name: "Acme" },
        error: "rate limited",
        errorKey: "skill:rate_limited",
        attempts: 1,
      }),
    ]);
    expect(runner.calls.map((c) => [c.kind, c.name])).toEqual([
      ["do", "lookup"],
      ["do", "lookup:oversee:1"],
      ["sleep", "lookup:retry:1:sleep"],
      ["do", "lookup:retry:1"],
    ]);
    // The same input and the same keys: no key node of its own.
    expect(h.agentCalls.map((c) => [c.input, c.keyNode])).toEqual([
      [{ name: "Acme" }, undefined],
      [{ name: "Acme" }, undefined],
    ]);
    // One row for the step, its second attempt.
    expect([...h.rows.values()].filter((r) => r.nodeId === "lookup")).toHaveLength(1);
    expect(h.row("lookup")).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("runs a corrected input under its own keys, and the steps after it see the output", async () => {
    const h = new Harness();
    trims(h);
    h.handlers.write = (req) => ({ kind: "done", output: req.input });
    const o = port({
      action: "retry_with",
      input: { name: "Acme" },
      note: "The vendor name had a trailing space.",
    });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf([lookup(), write()]),
      { vendor: "Acme " },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls.map((c) => [c.nodeId, c.input, c.keyNode])).toEqual([
      ["lookup", { name: "Acme " }, undefined],
      ["lookup", { name: "Acme" }, "lookup:o1"],
      ["write", { name: "Acme" }, undefined],
    ]);
    expect(h.row("lookup")).toMatchObject({ input: { name: "Acme" }, attempt: 2 });
  });

  it("fails as before when the review makes no intervention, or the review itself fails", async () => {
    for (const p of [
      port({ action: "none", reason: "the answer did not validate" }).port,
      {
        review: async () => {
          throw new Error("database down");
        },
      } satisfies OversightPort,
    ]) {
      const h = new Harness();
      trims(h);
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({ oversight: { port: p, settings: settings() } }),
        wf([lookup(), write()]),
        { vendor: "Acme " },
      );
      expect(result).toEqual({
        status: "failed",
        reason: 'no vendor named "Acme "',
        nodeId: "lookup",
        errorKey: "skill:failed",
      });
      expect(h.agentCalls).toHaveLength(1);
    }
  });

  it("stops at two interventions per step, with the last note as the diagnosis", async () => {
    const h = new Harness();
    h.handlers.lookup = () => ({ kind: "failed", error: "timeout" });
    const o = port(
      { action: "retry", after: "1 second", note: "first" },
      { action: "retry", after: "1 second", note: "second" },
      { action: "retry", after: "1 second", note: "third" },
    );
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ oversight: { port: o.port, settings: settings({ maxPerRun: 5 }) } }),
      wf([lookup()]),
      { vendor: "Acme" },
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout", diagnosis: "second" });
    expect(o.requests.map((r) => r.seq)).toEqual([1, 2]);
    expect(h.agentCalls).toHaveLength(3);
  });

  it("stops at maxPerRun interventions in the run: the next failure fails as before", async () => {
    const h = new Harness();
    const seen = new Map<string, number>();
    const flaky = (id: string) => () => {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      return n === 1
        ? ({ kind: "failed", error: "timeout" } as const)
        : ({ kind: "done", output: { name: id } } as const);
    };
    for (const id of ["a", "b", "c", "d"]) h.handlers[id] = flaky(id);
    const o = port(
      ...["a", "b", "c", "d"].map(
        (id): OversightVerdict => ({ action: "retry", after: "1 second", note: id }),
      ),
    );
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf(["a", "b", "c", "d"].map((id) => lookup({ id, input: {} }))),
      {},
    );
    // The default is 3: the fourth failure in the run fails the step exactly as without oversight.
    expect(result).toEqual({
      status: "failed",
      reason: "timeout",
      nodeId: "d",
      errorKey: "skill:timeout",
    });
    expect(o.requests.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("reuses a stored verdict on a replay: no second review", async () => {
    const h = new Harness();
    trims(h);
    const o = port({ action: "retry_with", input: { name: "Acme" }, note: "Trimmed." });
    const runner = new FakeStepRunner();
    const ctx = h.context({ oversight: { port: o.port, settings: settings() } });
    const workflow = wf([lookup()]);
    expect(await executeWorkflow(runner, ctx, workflow, { vendor: "Acme " })).toEqual({
      status: "succeeded",
    });
    runner.replay();
    expect(await executeWorkflow(runner, ctx, workflow, { vendor: "Acme " })).toEqual({
      status: "succeeded",
    });
    expect(o.requests).toHaveLength(1);
    expect(h.agentCalls).toHaveLength(2);
    expect(runner.calls.every((c) => c.kind !== "do" || c.cached)).toBe(true);
  });

  it("reviews a thrown error too, and a stop fails the run with its diagnosis", async () => {
    const h = new Harness();
    h.handlers.lookup = () => {
      throw new Error("connection reset");
    };
    const o = port({ action: "stop", note: "The connection keeps failing; a person should look." });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf([lookup()]),
      {},
    );
    expect(result).toEqual({
      status: "failed",
      reason: "connection reset",
      nodeId: "lookup",
      errorKey: "skill:failed",
      diagnosis: "The connection keeps failing; a person should look.",
    });
    expect(o.requests[0]).toMatchObject({ stepRunId: "sr-1", error: "connection reset" });
    expect(h.row("lookup")?.status).toBe("failed");
  });

  it("asks a person first: approved, it tries again", async () => {
    const h = new Harness();
    let calls = 0;
    h.handlers.lookup = () =>
      ++calls === 1 ? { kind: "failed", error: "locked" } : { kind: "done", output: {} };
    const item = h.approvalItem({ approved: true, by: "u-1" });
    const o = port({ action: "ask", inboxItemId: item, note: "Ask whether it is unlocked." });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf([lookup()]),
      {},
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(runner.names()).toEqual([
      "lookup",
      "lookup:oversee:1",
      "lookup:oversee:1:ask:check",
      "lookup:oversee:1:ask:received",
      "lookup:retry:1",
    ]);
  });

  it("asks a person first: declined, the step's onReject decides", async () => {
    for (const onReject of ["continue", "stop"] as const) {
      const h = new Harness();
      h.handlers.lookup = () => ({ kind: "failed", error: "locked" });
      const item = h.approvalItem();
      const o = port({ action: "ask", inboxItemId: item, note: "Ask." });
      const runner = new FakeStepRunner({ onWait: "block" });
      runner.onWaitStarted = (_name, type) => {
        if (type === inboxEventType(item)) runner.deliver(type, { approved: false, by: "u-1" });
      };
      const result = await executeWorkflow(
        runner,
        h.context({ oversight: { port: o.port, settings: settings() } }),
        wf([
          lookup({ approval: { required: "required", onReject } }),
          { id: "after", kind: "skill", name: "After", skill: SKILL.id, input: {} },
        ]),
        {},
      );
      if (onReject === "continue") {
        expect(result).toEqual({ status: "succeeded" });
        expect(h.row("lookup")).toMatchObject({ status: "skipped" });
        expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["lookup", "after"]);
      } else {
        expect(result).toMatchObject({ status: "failed", reason: "locked", diagnosis: "Ask." });
        expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["lookup"]);
      }
    }
  });

  it("follows a step's own review: off skips the review, always reviews with the agent's off", async () => {
    const off = new Harness();
    trims(off);
    const o1 = port({ action: "retry_with", input: { name: "Acme" }, note: "n" });
    await executeWorkflow(
      new FakeStepRunner(),
      off.context({ oversight: { port: o1.port, settings: settings() } }),
      wf([lookup({ review: "off" })]),
      { vendor: "Acme " },
    );
    expect(o1.requests).toEqual([]);

    const always = new Harness();
    trims(always);
    const o2 = port({ action: "retry_with", input: { name: "Acme" }, note: "n" });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      always.context({ oversight: { port: o2.port } }),
      wf([lookup({ review: "always" })]),
      { vendor: "Acme " },
    );
    expect(result).toEqual({ status: "succeeded" });
    // v0.13 M32: `always` reviews the step after it succeeds too.
    expect(o2.requests.map((r) => r.cause)).toEqual(["failed", "checkpoint"]);
  });

  it("never reviews a write that waits for approval or an escalation", async () => {
    const h = new Harness();
    h.handlers.lookup = () => ({ kind: "escalated", reason: "max_cost" });
    const o = port({ action: "retry", after: "1 second", note: "n" });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ oversight: { port: o.port, settings: settings() } }),
      wf([lookup()]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "escalated: max_cost" });
    expect(o.requests).toEqual([]);
  });
});

// ── R6: the owner's watch (docs/plan.md §1.86, §9; ARCHITECTURE §10.14) ─────────────────────────

const v3Skill = SkillStep.parse(lookup());
const v3Action = ActionStep.parse(write());

/** A v4 process's watched steps, parsed (defaults applied). */
const v4 = processes.Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    { id: "find", kind: "read", name: "Find", tool: "testkit.thing.read", input: { q: "x" } },
    { id: "think", kind: "skill", name: "Think", skill: SKILL.id },
    {
      id: "each",
      kind: "for_each",
      name: "Each",
      over: "{{steps.find.output.items}}",
      steps: [{ id: "put", kind: "write", name: "Put", tool: WRITE_TOOL.id, input: { a: "1" } }],
    },
    {
      id: "talk",
      kind: "conversation",
      name: "Talk",
      with: "{{trigger.vendor}}",
      channel: "email",
      goal: "Get the price",
      deadline: { after: "1 day" },
    },
  ],
}).steps;

function step(id: string): OwnerWatchedStep {
  const all = [...v4, ...v4.flatMap((x) => (x.kind === "for_each" ? x.steps : []))];
  const s = all.find((x) => x.id === id);
  if (!s || s.kind === "for_each" || s.kind === "if") throw new Error(id);
  return s as OwnerWatchedStep;
}

describe("the owner's watch", () => {
  it("decides v3 steps exactly as the executor's v0.13 rule does (the regression guard)", () => {
    for (const review of OVERSIGHT_REVIEWS) {
      const s = settings({ review });
      for (const stepReview of [undefined, ...STEP_REVIEWS]) {
        for (const base of [v3Skill, v3Action]) {
          const st = stepReview ? { ...base, review: stepReview } : base;
          // The executor: a port, and the step's failures reviewed.
          expect(ownerReviewsFailureOf({ settings: s }, st)).toBe(reviewsFailures(s, st));
          expect(ownerReviewsFailureOf(undefined, st)).toBe(false);
          for (const checkpoint of [false, true]) {
            // No watch on a v3 run: an empty output asks for nothing.
            expect(
              ownerAfterSuccess({ settings: s }, st, { name: st.id, checkpoint, output: {} }),
            ).toEqual({ review: reviewsAfterSuccess(s, st, checkpoint), signals: [] });
          }
        }
      }
    }
  });

  it("watches v4 read, skill, write and conversation steps like v3 skill and action steps", () => {
    const owner = { settings: settings() };
    for (const id of ["find", "think", "put", "talk"]) {
      expect(ownerReviewsFailureOf(owner, step(id))).toBe(true);
      expect(ownerReviewsFailureOf(owner, { ...step(id), review: "off" })).toBe(false);
      const always = { ...step(id), review: "always" as const };
      expect(
        ownerAfterSuccess(owner, always, { name: id, checkpoint: false, output: { ok: true } })
          .review,
      ).toBe(true);
    }
    // Person, notify and logic steps are never the owner's.
    expect(ownerReviewsFailureOf(owner, { kind: "person" })).toBe(false);
    expect(ownerReviewsFailureOf(owner, { kind: "for_each", review: "always" })).toBe(false);
  });

  it("asks for a review of a v4 result that is plainly off, under failures, with the signals", () => {
    const owner = { settings: settings(), watch: {} };
    const at = (output: unknown) => ({ name: "find", checkpoint: false, output });
    expect(ownerAfterSuccess(owner, step("find"), at([]))).toEqual({
      review: true,
      signals: [{ kind: "empty_output" }],
    });
    expect(ownerAfterSuccess(owner, step("find"), at({ items: [1] }))).toEqual({
      review: false,
      signals: [],
    });
    // A confer that disagreed, on a conversation.
    expect(
      ownerAfterSuccess(owner, step("talk"), {
        name: "talk",
        checkpoint: false,
        output: { price: "4.00" },
        confer: ["disagree"],
      }),
    ).toEqual({ review: true, signals: [{ kind: "confer_disagreed", count: 1 }] });
    // Never under off, nor on a step set to off.
    for (const o of [{ settings: settings({ review: "off" }), watch: {} }, { watch: {} }]) {
      expect(ownerAfterSuccess(o, step("find"), at([])).review).toBe(false);
    }
    const off = { ...step("find"), review: "off" as const };
    expect(ownerAfterSuccess(owner, off, { ...at([]), checkpoint: true }).review).toBe(false);
  });

  it("compares a loop's write with that step's history, whatever the iteration", () => {
    const usual = ["100", "100", "100", "100", "100"].map((amount) => ({ amount, currency: null }));
    const owner = { settings: settings(), watch: { history: { "each:put": usual } } };
    expect(
      ownerAfterSuccess(owner, step("put"), {
        name: "each:7:put",
        checkpoint: false,
        output: { total: "5000" },
      }),
    ).toEqual({
      review: true,
      signals: [
        {
          kind: "total_outlier",
          field: "total",
          amount: "5000",
          currency: null,
          median: "100",
          runs: 5,
        },
      ],
    });
    expect(
      ownerAfterSuccess(owner, step("put"), {
        name: "each:8:put",
        checkpoint: false,
        output: { total: "120" },
      }).review,
    ).toBe(false);
  });

  it("builds the review request: v4 reads and writes key errors by tool, signals only after success", () => {
    expect(ownerErrorKey(step("put"), "rate limited")).toBe(`${WRITE_TOOL.id}:rate_limited`);
    expect(ownerErrorKey(step("think"), "rate limited")).toBe("skill:rate_limited");
    expect(ownerErrorKey(v3Action, "rate limited")).toBe(`${WRITE_TOOL.id}:rate_limited`);
    expect(ownerStepInput(step("talk"))).toEqual({
      with: "{{trigger.vendor}}",
      goal: "Get the price",
    });
    expect(ownerStepInput(step("find"))).toEqual({ q: "x" });
    const base = {
      run: RUN,
      step: step("put"),
      nodeId: "each:0:put",
      stepRunId: "sr",
      seq: 1,
      input: { a: "1" },
      attempts: 1,
    };
    const empty = [{ kind: "empty_output" as const }];
    const failed = ownerReviewRequest({ ...base, cause: "failed", error: "rate limited" }, empty);
    expect(failed).toMatchObject({ errorKey: `${WRITE_TOOL.id}:rate_limited` });
    expect(failed).not.toHaveProperty("signals");
    const watched = ownerReviewRequest(
      { ...base, cause: "checkpoint", error: "", output: {} },
      empty,
    );
    expect(watched).toMatchObject({ errorKey: "", signals: empty });
  });
});
