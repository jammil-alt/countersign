// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's check on every attempt at a native
// v4 step, recorded in a durable step of its own: clean, flagged (and why no review followed),
// reviewed (the verdict) or not watched. A replay records nothing twice; a v3 run records nothing.

import type { OversightSettingsInput, OwnerCheckEntry, processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, wf } from "./fakes.test-helper";
import type { OversightPort, OversightRequest, OversightVerdict, OwnerCheckLog } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const read = (over: Record<string, unknown> = {}) => ({
  id: "get",
  kind: "read",
  name: "Get the lines",
  tool: "testkit.thing.get",
  ...over,
});

function checks() {
  const entries: OwnerCheckEntry[] = [];
  const log: OwnerCheckLog = {
    async record(entry) {
      entries.push(entry);
    },
  };
  return { log, entries };
}

function reviewer(...verdicts: OversightVerdict[]) {
  const requests: OversightRequest[] = [];
  const port: OversightPort = {
    async review(req) {
      requests.push(req);
      const next = verdicts.shift();
      if (!next) throw new Error("the review failed");
      return next;
    },
  };
  return { port, requests };
}

const settings = (review: string, over: Record<string, unknown> = {}) =>
  ({ review, maxPerRun: 5, maxCostUsd: "1", ...over }) as OversightSettingsInput as never;

describe("the owner's check on every v4 step (wave 6)", () => {
  it("records a clean step once, and a replay reuses it", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
    const c = checks();
    const runner = new FakeStepRunner();
    const ctx = h.context({
      ownerChecks: c.log,
      oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
    });
    expect((await executeWorkflow(runner, ctx, proc([read()]), {})).status).toBe("succeeded");
    expect(c.entries).toEqual([
      {
        runId: h.run.id,
        nodeId: "get",
        attempt: 1,
        result: "clean",
        attemptOutcome: "succeeded",
        signals: [],
      },
    ]);
    expect(runner.names("do")).toEqual(["get", "get:owner:1"]);
    runner.replay();
    await executeWorkflow(runner, ctx, proc([read()]), {});
    expect(c.entries).toHaveLength(1);
  });

  it("records a flagged step as reviewed, with the signal and what the owner did", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [] } });
    const c = checks();
    const o = reviewer({ action: "continue", note: "Nothing to post today." });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        ownerChecks: c.log,
        oversight: { port: o.port, settings: settings("failures"), watch: {} },
      }),
      proc([read()]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(c.entries).toEqual([
      expect.objectContaining({
        attempt: 1,
        result: "reviewed",
        attemptOutcome: "succeeded",
        signals: [{ kind: "empty_output" }],
        cause: "checkpoint",
        verdict: "continue",
      }),
    ]);
    // No model cost of its own: the one review is the one the owner already made.
    expect(o.requests).toHaveLength(1);
  });

  it("records each attempt: a failure reviewed and retried, then the retry clean", async () => {
    const h = new Harness();
    let calls = 0;
    h.handlers.get = () =>
      ++calls === 1
        ? { kind: "failed", error: "rate limited" }
        : { kind: "done", output: { lines: [1] } };
    const c = checks();
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({
        ownerChecks: c.log,
        oversight: {
          port: reviewer({ action: "retry", after: "30 seconds", note: "A rate limit." }).port,
          settings: settings("failures"),
          watch: {},
        },
      }),
      proc([read()]),
      {},
    );
    expect(c.entries.map((e) => [e.attempt, e.result, e.attemptOutcome, e.verdict])).toEqual([
      [1, "reviewed", "failed", "retry"],
      [2, "clean", "succeeded", undefined],
    ]);
    expect(runner.names("do")).toEqual([
      "get",
      "get:oversee:1",
      "get:owner:1",
      "get:retry:1",
      "get:owner:2",
    ]);
  });

  it("records why a flag went unreviewed: the review failed, gave no decision, or the limit", async () => {
    for (const [verdicts, reason, extra] of [
      [[], "review_failed", {}],
      [[{ action: "none", reason: "over the cost limit" }], "no_decision", {}],
      [[], "limit", { maxPerRun: 0 }],
    ] as const) {
      const h = new Harness();
      h.handlers.get = () => ({ kind: "failed", error: "not found" });
      const c = checks();
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({
          ownerChecks: c.log,
          oversight: {
            port: reviewer(...([...verdicts] as OversightVerdict[])).port,
            settings: settings("failures", extra),
            watch: {},
          },
        }),
        proc([read()]),
        {},
      );
      expect(result.status).toBe("failed");
      expect(c.entries).toEqual([
        expect.objectContaining({ result: "flagged", attemptOutcome: "failed", reason }),
      ]);
    }
  });

  it("records a step the owner doesn't watch: the owner off, or the step's review off", async () => {
    for (const [ctx, step, reason] of [
      [{}, read(), "owner_off"],
      [{ settings: settings("off") }, read(), "owner_off"],
      [{ settings: settings("failures") }, read({ review: "off" }), "step_off"],
    ] as const) {
      const h = new Harness();
      h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
      const c = checks();
      await executeWorkflow(
        new FakeStepRunner(),
        h.context({ ownerChecks: c.log, oversight: { port: reviewer().port, ...ctx } }),
        proc([step]),
        {},
      );
      expect(c.entries).toEqual([
        expect.objectContaining({
          attempt: 1,
          result: "not_watched",
          attemptOutcome: "succeeded",
          reason,
        }),
      ]);
    }
  });

  it("never fails the run when the check can't be written", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        ownerChecks: {
          record: async () => {
            throw new Error("database down");
          },
        },
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      proc([read()]),
      {},
    );
    expect(result.status).toBe("succeeded");
  });

  it("records nothing for a v3 workflow: its run keeps the durable steps it had", async () => {
    const h = new Harness();
    h.handlers.lookup = () => ({ kind: "done", output: { name: "Acme" } });
    const c = checks();
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("failures") },
      }),
      wf([{ id: "lookup", kind: "skill", name: "Find", skill: SKILL.id, input: {} }]),
      {},
    );
    expect(c.entries).toEqual([]);
    expect(runner.names("do").some((n) => n.includes(":owner:"))).toBe(false);
  });
});
