// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's check on every attempt at a native
// v4 step, recorded in a durable step of its own: clean, flagged (and why no review followed),
// reviewed (the verdict) or not watched. A replay records nothing twice; a v3 run records nothing.

import type {
  OversightSettingsInput,
  OwnerCheckEntry,
  processes,
  SkillDefinition,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
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

// ── Wave 6 review ───────────────────────────────────────────────────────────────────────────────

const write = (over: Record<string, unknown> = {}) => ({
  id: "put",
  kind: "write",
  name: "Put the bill",
  tool: WRITE_TOOL.id,
  input: { total: "{{steps.get.output}}" },
  ...over,
});

const CATALOG = { tools: { [WRITE_TOOL.id]: WRITE_TOOL } };

describe("the owner's check when a review was due on a clean step (wave 6 review)", () => {
  it("records why a clean step was reviewed: every step, always, or a checkpoint", async () => {
    for (const [review, step, due] of [
      ["all", read(), "all"],
      ["failures", read({ review: "always" }), "always"],
      ["checkpoints", read(), "checkpoint"],
    ] as const) {
      const h = new Harness();
      h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
      h.handlers.put = () => ({ kind: "done", output: { ok: true } });
      const c = checks();
      const o = reviewer({ action: "continue", note: "Fine." }, { action: "continue", note: "" });
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({
          catalog: CATALOG,
          ownerChecks: c.log,
          oversight: { port: o.port, settings: settings(review), watch: {} },
        }),
        proc([step, write()]),
        {},
      );
      expect(result.status).toBe("succeeded");
      expect(c.entries.find((e) => e.nodeId === "get")).toEqual(
        expect.objectContaining({
          result: "reviewed",
          attemptOutcome: "succeeded",
          signals: [],
          cause: "checkpoint",
          verdict: "continue",
          reviewDue: due,
        }),
      );
    }
  });

  it("keeps a clean step clean when its routine review wasn't made, and says why", async () => {
    for (const [verdicts, reason, extra] of [
      [[], "review_failed", {}],
      [[{ action: "none", reason: "over the cost limit" }], "no_decision", {}],
      [[], "limit", { maxPerRun: 0 }],
    ] as const) {
      const h = new Harness();
      h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
      const c = checks();
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({
          ownerChecks: c.log,
          oversight: {
            port: reviewer(...([...verdicts] as OversightVerdict[])).port,
            settings: settings("all", extra),
            watch: {},
          },
        }),
        proc([read()]),
        {},
      );
      expect(result.status).toBe("succeeded");
      expect(c.entries).toEqual([
        {
          runId: h.run.id,
          nodeId: "get",
          attempt: 1,
          result: "clean",
          attemptOutcome: "succeeded",
          signals: [],
          reason,
          cause: "checkpoint",
          reviewDue: "all",
        },
      ]);
    }
  });

  it("still flags a failure whose review wasn't made, with its cause", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "failed", error: "not found" });
    const c = checks();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("all"), watch: {} },
      }),
      proc([read()]),
      {},
    );
    expect(c.entries).toEqual([
      expect.objectContaining({
        result: "flagged",
        attemptOutcome: "failed",
        reason: "review_failed",
        cause: "failed",
      }),
    ]);
    expect(c.entries[0]?.reviewDue).toBeUndefined();
  });
});

describe("the owner's check names how an attempt ended (wave 6 review)", () => {
  it("an escalation is its own outcome, flagged", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "escalated", reason: "budget" });
    const c = checks();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      proc([read()]),
      {},
    );
    expect(result.status).toBe("failed");
    expect(c.entries).toEqual([
      expect.objectContaining({ result: "flagged", attemptOutcome: "escalated", signals: [] }),
    ]);
    expect(c.entries[0]?.reason).toBeUndefined();
  });

  it("a write a person turned down is `rejected`, whether the run goes on or stops", async () => {
    for (const onReject of ["continue", "stop"] as const) {
      const h = new Harness();
      const item = h.approvalItem({ approved: false, by: "u-3" });
      h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
      h.handlers.put = () => ({ kind: "approval", pending: { inboxItemId: item } });
      const c = checks();
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({
          ownerChecks: c.log,
          oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
        }),
        proc([read(), write({ checks: { approval: { onReject } } })]),
        {},
      );
      expect(result.status).toBe(onReject === "stop" ? "cancelled" : "succeeded");
      expect(c.entries.find((e) => e.nodeId === "put")).toEqual(
        expect.objectContaining({ attempt: 1, result: "clean", attemptOutcome: "rejected" }),
      );
    }
  });

  it("a write nobody answered is `unanswered`", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
    h.handlers.put = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const c = checks();
    await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      proc([read(), write({ checks: { approval: { ifNoAnswer: "skip" } } })]),
      {},
    );
    expect(c.entries.find((e) => e.nodeId === "put")).toEqual(
      expect.objectContaining({ result: "clean", attemptOutcome: "unanswered" }),
    );
  });

  it("records the check when a person ends the run during the attempt", async () => {
    // A read's confer, after it ran: nobody answered, and its deadline stops the run.
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [1] } });
    const c = checks();
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      proc([
        read({
          checks: {
            confer: {
              with: [{ person: "dana", deadline: { after: "1 day", ifNoAnswer: "stop" } }],
            },
          },
        }),
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(c.entries).toEqual([
      {
        runId: h.run.id,
        nodeId: "get",
        attempt: 1,
        result: "clean",
        attemptOutcome: "unanswered",
        signals: [],
        reason: "ended_by_person",
      },
    ]);
  });

  it("records it when the run ends inside the attempt itself (a skill's confer on its write)", async () => {
    const writer = { ...SKILL, id: "test.post-bill", tools: [WRITE_TOOL.id] } as SkillDefinition;
    for (const owner of [settings("failures"), undefined]) {
      const h = new Harness();
      h.handlers.post = () => ({
        kind: "approval",
        pending: { inboxItemId: h.approvalItem({ approved: true, by: "amy" }) },
        output: { line: 1 },
      });
      const c = checks();
      const result = await executeWorkflow(
        new FakeStepRunner({ onWait: "timeout" }),
        h.context({
          catalog: { skills: { [writer.id]: writer }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } },
          ownerChecks: c.log,
          oversight: {
            port: reviewer().port,
            ...(owner ? { settings: owner } : {}),
            watch: {},
          },
        }),
        proc([
          {
            id: "post",
            kind: "skill",
            name: "Post the bill",
            skill: writer.id,
            input: {},
            checks: {
              confer: {
                with: [{ person: "dana", deadline: { after: "1 day", ifNoAnswer: "stop" } }],
              },
            },
          },
        ]),
        {},
      );
      expect(result.status).toBe("failed");
      expect(c.entries).toEqual([
        expect.objectContaining(
          owner
            ? {
                attempt: 1,
                result: "clean",
                attemptOutcome: "unanswered",
                reason: "ended_by_person",
              }
            : {
                attempt: 1,
                result: "not_watched",
                attemptOutcome: "unanswered",
                reason: "owner_off",
              },
        ),
      ]);
    }
  });
});

describe("the owner's checks inside a loop (wave 6 review)", () => {
  const loop = () =>
    proc([
      {
        id: "each",
        kind: "for_each",
        name: "Each",
        over: "{{trigger.items}}",
        steps: [{ ...read({ id: "r", input: { i: "{{item}}" } }) }],
      },
    ]);

  it("writes a 50-item loop's checks in one durable step, not one per item", async () => {
    const h = new Harness();
    h.handlers.r = () => ({ kind: "done", output: { lines: [1] } });
    const c = checks();
    const runner = new FakeStepRunner();
    const ctx = h.context({
      ownerChecks: c.log,
      oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
    });
    const items = Array.from({ length: 50 }, (_, i) => i);
    const result = await executeWorkflow(runner, ctx, loop(), { items });
    expect(result.status).toBe("succeeded");
    const steps = runner.names("do");
    // The loop's start and end, one attempt per item, one step for all the checks.
    expect(steps).toHaveLength(1 + 50 + 1 + 1);
    expect(steps.filter((n) => n.includes(":owner"))).toEqual(["each:owner"]);
    expect(c.entries).toHaveLength(50);
    expect(new Set(c.entries.map((e) => e.nodeId))).toEqual(
      new Set(items.map((i) => `each:${i}:r`)),
    );
    expect(c.entries.every((e) => e.result === "clean")).toBe(true);
    // Well under Cloudflare Workflows' 1,024 steps an instance.
    expect(steps.length).toBeLessThan(1024);
    // A replay writes nothing twice.
    runner.replay();
    await executeWorkflow(runner, ctx, loop(), { items });
    expect(c.entries).toHaveLength(50);
  });

  it("uses one store call for the loop when the store takes many", async () => {
    const h = new Harness();
    h.handlers.r = () => ({ kind: "done", output: { lines: [1] } });
    const batches: number[] = [];
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({
        ownerChecks: {
          record: async () => {
            throw new Error("one at a time");
          },
          recordMany: async (entries) => {
            batches.push(entries.length);
          },
        },
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      loop(),
      { items: [1, 2, 3] },
    );
    expect(batches).toEqual([3]);
  });

  it("still writes the loop's checks when an item ends the run", async () => {
    const h = new Harness();
    h.handlers.r = (req) =>
      (req as { input?: { i?: number } }).input?.i === 1
        ? { kind: "failed", error: "not found" }
        : { kind: "done", output: { lines: [1] } };
    const c = checks();
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({
        ownerChecks: c.log,
        oversight: { port: reviewer().port, settings: settings("failures"), watch: {} },
      }),
      proc([
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.items}}",
          concurrency: 1,
          steps: [{ ...read({ id: "r", input: { i: "{{item}}" } }) }],
        },
      ]),
      { items: [0, 1, 2] },
    );
    expect(result.status).toBe("failed");
    expect(runner.names("do")).toContain("each:owner");
    expect(c.entries.map((e) => [e.nodeId, e.result])).toEqual([
      ["each:0:r", "clean"],
      ["each:1:r", "flagged"],
    ]);
  });
});
