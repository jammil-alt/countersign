// v0.13 W2-I: run oversight in the executor (ARCHITECTURE §10.11; docs/plan.md §1.54, M31). The
// executor applies the agent's verdicts on the fake runner; it never calls a model.

import { OversightSettings } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
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
