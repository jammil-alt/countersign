// Wave 5 review (docs/plan.md §1.86 "Forks (wave 5)"): what a step recorded (`steps.<id>`) and
// what its stored rows and items read back agree, kind by kind, and a retry routes on the whole
// record of the steps it reuses, never running again a write that failed and was carried on past.
// The stored shapes are apps/api's: the step log merges a row's error into its output, and the
// gate's approval item names the step (`payload.stepId`), the others their node (`payload.nodeId`).
import { isPlainObject, outcomeOfStepRow, type processes, reusedStepOf } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow, type RunResume } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL } from "./fakes.test-helper";
import type { ConversationResult, InboxResolution } from "./ports";
import { inboxEventType } from "./runner";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

// ── What apps/api stores ──────────────────────────────────────────────────────────────────────

interface StoredRow {
  nodeId: string;
  nodeType: string;
  status: string;
  input?: unknown;
  output?: unknown;
}

/** The harness's rows as the step log stores them: an update's error merged into its output. */
function storedRows(h: Harness): StoredRow[] {
  return [...h.rows.values()].map((r) => {
    let output: unknown;
    for (const u of r.updates) {
      if (u.error !== undefined) {
        output = { ...(isPlainObject(u.output) ? u.output : {}), error: u.error };
      } else if (u.output !== undefined) output = u.output;
    }
    return { nodeId: r.nodeId, nodeType: r.nodeType, status: r.status, input: r.input, output };
  });
}

const at = (n: number) => `2026-11-10T10:00:${String(n).padStart(2, "0")}.000Z`;

/**
 * The harness's items as the inbox stores them. `extra` adds to an item's payload by id: the gate's
 * item names its step (`{ stepId }`), an urgent notice's its node and `urgent`.
 */
function storedItems(h: Harness, extra: Record<string, Record<string, unknown>> = {}) {
  return [...h.items.entries()].map(([id, v], n) => ({
    id,
    kind: v.item?.kind ?? "external_action",
    status: v.resolution ? "resolved" : v.expired ? "expired" : "open",
    payload: { ...(v.item ? { nodeId: v.item.nodeId } : {}), ...(extra[id] ?? {}) },
    resolution: v.resolution,
    resolvedBy: v.resolution?.by ?? null,
    resolvedAt: v.resolution ? at(n + 1) : null,
    createdAt: at(n),
  }));
}

/** A retry from `from`, as apps/api's `resumeOf` builds it from the run retried. */
function resumeOf(
  h: Harness,
  steps: unknown[],
  from: string,
  extra: Record<string, Record<string, unknown>> = {},
): RunResume {
  const rows = storedRows(h);
  const items = storedItems(h, extra);
  const reused: RunResume["reused"] = {};
  const list = steps as processes.Step[];
  for (const step of list.slice(
    0,
    list.findIndex((s) => s.id === from),
  )) {
    const row = rows.find((r) => r.nodeId === step.id);
    const found = row && reusedStepOf(step, row, rows, items);
    if (found) reused[step.id] = found;
  }
  return { from, of: "R-000001", reused };
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

const read = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "read",
  name: "X",
  tool: READ_TOOL.id,
  ...over,
});
const write = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "write",
  name: "X",
  tool: WRITE_TOOL.id,
  input: { name: "x" },
  ...over,
});
const skill = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "skill",
  name: "X",
  skill: "web.browse",
  input: { site: "x" },
  ...over,
});
const person = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "person",
  name: "X",
  mode: "ask",
  assignee: "client_admin",
  title: "Keep it?",
  deadline: { after: "1 day" },
  choices: [
    { value: "keep", label: "Keep" },
    { value: "drop", label: "Drop" },
  ],
  ...over,
});
const talk = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "conversation",
  name: "Ask the vendor",
  with: "c-vendor",
  channel: "email",
  goal: "Find the price",
  find: { price: "money" },
  deadline: { after: "2 days" },
  ...over,
});
const tell = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "notify",
  name: "Tell",
  notify: { to: ["lead"], message: "hi" },
  ...over,
});
const each = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "for_each",
  name: "Each",
  over: "{{trigger.items}}",
  onError: "continue",
  steps: [{ id: "r", kind: "read", name: "R", tool: READ_TOOL.id, input: { i: "{{item}}" } }],
  ...over,
});
const sub = (over: Record<string, unknown> = {}) => ({
  id: "x",
  kind: "process",
  name: "Check",
  process: "check@1",
  onError: "continue",
  ...over,
});

/** A sub-process whose steps are `steps`. */
const automation = (steps: unknown[]) => ({
  "check@1": {
    schemaVersion: 2,
    slug: "check",
    name: "Check",
    description: "",
    input: {},
    output: {},
    steps,
    requires: { connectors: [], packs: [] },
  } as never,
});

/** Reads back what the run recorded for `x`: a later step's input holds `steps.x` whole. */
const PROBE = {
  id: "probe",
  kind: "read",
  name: "Probe",
  tool: READ_TOOL.id,
  input: { rec: "{{steps.x}}" },
};

/** Answers every wait with `resolution`, as the inbox would store it. */
function answering(h: Harness, resolution: InboxResolution): FakeStepRunner {
  const runner = new FakeStepRunner({ onWait: "block" });
  runner.onWaitStarted = (_n, type) => {
    for (const [id, v] of h.items) {
      if (inboxEventType(id) === type) v.resolution = resolution;
    }
    runner.deliver(type, resolution);
  };
  return runner;
}

/** A conversation port that answers with `result`. */
const conversing = (result: Partial<ConversationResult>) => ({
  conversation: {
    conversation: async (): Promise<ConversationResult> => ({
      status: "done",
      found: {},
      conversationId: "run-1:x",
      summary: "",
      ...result,
    }),
  },
});

interface Case {
  name: string;
  step: Record<string, unknown>;
  /** Sets up the harness; returns extra payload for stored items by id. */
  setup?: (h: Harness) => Record<string, Record<string, unknown>> | undefined;
  runner?: (h: Harness) => FakeStepRunner;
  extra?: (h: Harness) => Parameters<Harness["context"]>[0];
  trigger?: unknown;
  /** The outcome both sides read. */
  outcome: string;
}

/** The gate's approval item, already answered (or not), named by its step as the gate names it. */
function gate(h: Harness, resolution: InboxResolution | null, id = "x") {
  const item = h.approvalItem(resolution);
  h.handlers[id] = () => ({ kind: "approval", pending: { inboxItemId: item } });
  return { [item]: { stepId: id } };
}

const CASES: Case[] = [
  { name: "read done", step: read(), outcome: "done" },
  {
    name: "read empty",
    step: read(),
    setup: (h) => {
      h.handlers.x = () => ({ kind: "done", output: { items: [] } });
      return undefined;
    },
    outcome: "empty",
  },
  {
    name: "read failed, carried on",
    step: read({ onError: "continue" }),
    setup: (h) => {
      h.handlers.x = () => ({ kind: "failed", error: "401 unauthorized" });
      return undefined;
    },
    outcome: "failed",
  },
  {
    name: "read signed off",
    step: read({ checks: { approval: { approvers: [{ who: "client_admin" }] } } }),
    runner: (h) => answering(h, { approved: true, by: "u-amy" }),
    outcome: "done",
  },
  {
    name: "write approved",
    step: write({ checks: { approval: {} } }),
    setup: (h) => gate(h, { approved: true, by: "u-amy" }),
    outcome: "done",
  },
  {
    name: "write not needed",
    step: write(),
    setup: (h) => {
      h.handlers.x = () => ({ kind: "done", output: { ok: true } });
      return undefined;
    },
    outcome: "done",
  },
  {
    name: "write rejected, onReject continue",
    step: write({ checks: { approval: { onReject: "continue" } } }),
    setup: (h) => gate(h, { approved: false, by: "u-1" }),
    outcome: "rejected",
  },
  {
    name: "write unanswered, ifNoAnswer skip",
    step: write({ checks: { approval: { ifNoAnswer: "skip" } } }),
    setup: (h) => gate(h, null),
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "no_answer",
  },
  {
    name: "write unanswered, ifNoAnswer proceed",
    step: write({ checks: { approval: { ifNoAnswer: "proceed" } } }),
    setup: (h) => gate(h, null),
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "done",
  },
  {
    name: "write failed after its approval, carried on",
    step: write({ onError: "continue", checks: { approval: {} } }),
    setup: (h) => {
      h.resumeHandler = () => ({ kind: "failed", error: "refused: the bill is closed" });
      return gate(h, { approved: true, by: "u-amy" });
    },
    outcome: "failed",
  },
  {
    name: "skill with a confer",
    step: skill({ checks: { confer: { with: [{ ai: { focus: "Right?" } }] } } }),
    extra: () => ({ confer: { ai: async () => ({ verdict: "disagree" as const, note: "odd" }) } }),
    outcome: "done",
  },
  {
    name: "skill's sign-off rejected, onReject continue",
    step: skill({
      checks: { approval: { approvers: [{ who: "client_admin" }], onReject: "continue" } },
    }),
    runner: (h) => answering(h, { approved: false, by: "u-2" }),
    outcome: "rejected",
  },
  {
    name: "skill needing help nobody gave, carried on",
    step: skill({ onError: "continue" }),
    setup: (h) => {
      h.handlers.x = () => ({ kind: "done", output: { needsHelp: { question: "Where?" } } });
      return undefined;
    },
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "needs_help",
  },
  {
    name: "skill escalated, carried on",
    step: skill({ onError: "continue" }),
    setup: (h) => {
      h.handlers.x = () => ({ kind: "escalated", reason: "budget" });
      return undefined;
    },
    outcome: "failed",
  },
  {
    name: "person's quick answer",
    step: person(),
    runner: (h) => answering(h, { approved: true, answer: "drop", by: "u-1" }),
    outcome: "answered",
  },
  {
    name: "person unanswered, skip",
    step: person({ mode: "approve", deadline: { after: "1 day", ifNoAnswer: "skip" } }),
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "no_answer",
  },
  {
    name: "person unanswered, proceed",
    step: person({ mode: "approve", deadline: { after: "1 day", ifNoAnswer: "proceed" } }),
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "no_answer",
  },
  { name: "conversation done", step: talk(), extra: () => conversing({}), outcome: "done" },
  {
    name: "conversation not found",
    step: talk(),
    extra: () => conversing({ status: "not_found" }),
    outcome: "not_found",
  },
  {
    name: "conversation declined",
    step: talk({ checks: { approval: { onReject: "continue" } } }),
    extra: () => conversing({ declined: true }),
    outcome: "declined",
  },
  {
    name: "conversation unanswered, skip",
    step: talk({ deadline: { after: "2 days", ifNoAnswer: "skip" } }),
    extra: () => conversing({ status: "no_answer" }),
    outcome: "no_answer",
  },
  {
    name: "conversation failed, carried on",
    step: talk({ onError: "continue" }),
    extra: () => conversing({ status: "failed", summary: "The mailbox bounced" }),
    outcome: "failed",
  },
  { name: "notify sent", step: tell(), outcome: "sent" },
  {
    name: "notify failed, carried on",
    step: tell({ onError: "continue" }),
    setup: (h) => {
      h.notify.send = async () => {
        throw new Error("the mail service is down");
      };
      return undefined;
    },
    outcome: "failed",
  },
  {
    name: "urgent notice not seen, proceed",
    step: tell({
      notify: {
        to: ["lead"],
        message: "hi",
        urgent: { ackWithin: "1 hour", ifNoAnswer: "proceed" },
      },
    }),
    setup: (h) => {
      const ack = h.approvalItem(null);
      h.notify.notify = async () => ({ ackItemId: ack });
      return { [ack]: { nodeId: "x", urgent: { dueAt: at(59) } } };
    },
    runner: () => new FakeStepRunner({ onWait: "timeout" }),
    outcome: "not_seen",
  },
  {
    name: "wait",
    step: { id: "x", kind: "wait", name: "Wait", for: "1 hour" },
    outcome: "timed_out",
  },
  { name: "for each done", step: each(), trigger: { items: [1, 2] }, outcome: "done" },
  {
    name: "for each some failed",
    step: each(),
    trigger: { items: [1, 2, 3] },
    setup: (h) => {
      h.handlers.r = (req) =>
        (req.input as { i: number }).i === 2
          ? { kind: "failed", error: "not found" }
          : { kind: "done", output: { ok: true } };
      return undefined;
    },
    outcome: "some_failed",
  },
  {
    name: "for each all failed",
    step: each(),
    trigger: { items: [1, 2] },
    setup: (h) => {
      h.handlers.r = () => ({ kind: "failed", error: "not found" });
      return undefined;
    },
    outcome: "all_failed",
  },
  {
    name: "process completed",
    step: sub(),
    extra: () => ({ automations: automation([]) }),
    outcome: "completed",
  },
  {
    name: "process stopped",
    step: sub(),
    extra: () => ({
      automations: automation([{ id: "end", kind: "stop", name: "End", status: "succeeded" }]),
    }),
    outcome: "stopped",
  },
  {
    // Wave 5 re-review: the stop's status is kept (`stopStatus`) and read back on a retry.
    name: "process stopped by a cancelling stop",
    step: sub(),
    extra: () => ({
      automations: automation([{ id: "end", kind: "stop", name: "End", status: "cancelled" }]),
    }),
    outcome: "stopped",
  },
  {
    name: "process failed",
    step: sub(),
    setup: (h) => {
      h.handlers.in = () => ({ kind: "failed", error: "401 unauthorized" });
      return undefined;
    },
    extra: () => ({
      automations: automation([
        { id: "in", kind: "read", name: "In", tool: READ_TOOL.id, onError: "fail" },
      ]),
    }),
    outcome: "failed",
  },
];

describe("the executor's record and what its rows read back agree", () => {
  it.each(CASES)("$name", async (c) => {
    const h = new Harness();
    const extra = c.setup?.(h) ?? {};
    const runner = c.runner?.(h) ?? new FakeStepRunner();
    const steps = [c.step, PROBE];
    const result = await executeWorkflow(
      runner,
      h.context(c.extra?.(h) ?? {}),
      proc(steps),
      c.trigger ?? {},
    );
    expect(result.status, JSON.stringify(result)).toBe("succeeded");
    const probe = h.agentCalls.find((call) => call.step.id === "probe");
    if (!probe) throw new Error("the probe never ran");
    const recorded = (probe.input as { rec: Record<string, unknown> }).rec;
    const { output, ...record } = recorded;
    expect(record.outcome).toBe(c.outcome);
    if (c.outcome === "stopped") {
      expect(record.stopStatus).toBe(c.name.includes("cancelling") ? "cancelled" : "succeeded");
    }

    const rows = storedRows(h);
    const items = storedItems(h, extra);
    const row = rows.find((r) => r.nodeId === "x");
    if (!row) throw new Error("no row for x");
    // The run view's word.
    expect(outcomeOfStepRow(row, items)).toBe(c.outcome);
    // A retry's whole record, and the output a later step reads.
    const reused = reusedStepOf(c.step as unknown as processes.Step, row, rows, items);
    expect(reused?.record).toEqual(record);
    expect(reused?.stepOutput).toEqual(output);
  });
});

describe("an if routes on each outcome", () => {
  // Every case above, routed: a conversation declined, failed or unanswered, a notice not seen, a
  // process failed, a loop whose every item failed, a skill's sign-off turned down, and the rest.
  it.each(CASES)("$name", async (c) => {
    const h = new Harness();
    c.setup?.(h);
    const runner = c.runner?.(h) ?? new FakeStepRunner();
    const route = {
      id: "route",
      kind: "if",
      name: "Route",
      paths: [
        {
          id: "yes",
          name: "This way",
          when: {
            match: "all",
            rules: [{ field: "{{steps.x.outcome}}", op: "=", value: c.outcome }],
          },
          steps: [],
        },
      ],
      otherwise: { id: "no", steps: [] },
    };
    const result = await executeWorkflow(
      runner,
      h.context(c.extra?.(h) ?? {}),
      proc([c.step, route]),
      c.trigger ?? {},
    );
    expect(result.status, JSON.stringify(result)).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
  });
});

// ── Retries ───────────────────────────────────────────────────────────────────────────────────

/**
 * An `if` on `field` whose `yes` path holds `boom`, a read that fails in the run retried and works
 * in the retry: the retry resumes at the `if` and must take the same path again.
 */
function routeThenBoom(field: string, value: unknown) {
  return {
    id: "route",
    kind: "if",
    name: "Route",
    paths: [
      {
        id: "yes",
        name: "Recover",
        when: { match: "all", rules: [{ field: `{{${field}}}`, op: "=", value }] },
        steps: [{ id: "boom", kind: "read", name: "Boom", tool: READ_TOOL.id }],
      },
    ],
    otherwise: {
      id: "no",
      steps: [{ id: "pay", kind: "notify", name: "Pay", notify: { to: ["lead"], message: "pay" } }],
    },
  };
}

const pathOf = (h: Harness) => (h.row("route")?.output as { pathId?: string } | undefined)?.pathId;

/**
 * Runs `steps` (it fails at `boom`), then retries from the `if`: returns the retry's harness. The
 * retry's agent answers `boom` and fails anything else, so a reused step that ran again shows.
 */
async function retried(
  steps: unknown[],
  first: { h: Harness; runner?: FakeStepRunner; extra?: Parameters<Harness["context"]>[0] },
  items: Record<string, Record<string, unknown>> = {},
  trigger: unknown = {},
) {
  first.h.handlers.boom = () => ({ kind: "failed", error: "the vendor's site is down" });
  const one = await executeWorkflow(
    first.runner ?? new FakeStepRunner(),
    first.h.context(first.extra ?? {}),
    proc(steps),
    trigger,
  );
  expect(one).toMatchObject({ status: "failed", nodeId: "boom" });
  expect(pathOf(first.h)).toBe("yes");

  const resume = resumeOf(first.h, steps, "route", items);
  const h = new Harness({ ...first.h.run, id: "0192f7a0-0000-7000-8000-00000000a002" });
  h.handlers.boom = () => ({ kind: "done", output: { ok: true } });
  for (const id of ["x", "save", "r"]) {
    h.handlers[id] = () => ({ kind: "failed", error: `${id} ran again` });
  }
  h.resumeHandler = () => ({ kind: "failed", error: "a write was made again" });
  const two = await executeWorkflow(
    new FakeStepRunner({ onWait: "timeout" }),
    h.context({ ...(first.extra ?? {}), resume }),
    proc(steps),
    trigger,
  );
  return { h, two, resume };
}

describe("a retry routes on the whole record of the steps it reuses", () => {
  it("a write that failed and was carried on past is reused, never made again", async () => {
    const first = new Harness();
    const items = gate(first, { approved: true, by: "u-amy" }, "save");
    first.resumeHandler = () => ({ kind: "failed", error: "refused: the bill is closed" });
    const steps = [
      write({ id: "save", onError: "continue", checks: { approval: {} } }),
      routeThenBoom("steps.save.error.code", "refused"),
    ];
    const { h, two, resume } = await retried(steps, { h: first }, items);
    expect(resume.reused.save?.status).toBe("failed");
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    // Not proposed, not made again: the reused row says what happened.
    expect(h.agentCalls.map((c) => c.step.id)).toEqual(["boom"]);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.row("save")).toMatchObject({ status: "failed", summary: "reused from R-000001" });
  });

  it("a person's quick answer", async () => {
    const first = new Harness();
    const steps = [person(), routeThenBoom("steps.x.choice", "drop")];
    const { h, two } = await retried(steps, {
      h: first,
      runner: answering(first, { approved: true, answer: "drop", by: "u-1" }),
    });
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(h.sent).toHaveLength(0);
  });

  it("a rejection the run went on past", async () => {
    const first = new Harness();
    const items = gate(first, { approved: false, by: "u-1" });
    const steps = [
      write({ checks: { approval: { onReject: "continue" } } }),
      routeThenBoom("steps.x.outcome", "rejected"),
    ];
    const { h, two } = await retried(steps, { h: first }, items);
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(h.row("x")?.status).toBe("skipped");
  });

  it("nobody answering", async () => {
    const first = new Harness();
    const items = gate(first, null);
    const steps = [
      write({ checks: { approval: { ifNoAnswer: "skip" } } }),
      routeThenBoom("steps.x.approval.outcome", "no_answer"),
    ];
    const { h, two } = await retried(
      steps,
      { h: first, runner: new FakeStepRunner({ onWait: "timeout" }) },
      items,
    );
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
  });

  it("a loop's counts", async () => {
    const first = new Harness();
    first.handlers.r = (req) =>
      (req.input as { i: number }).i === 2
        ? { kind: "failed", error: "not found" }
        : { kind: "done", output: { ok: true } };
    const steps = [each(), routeThenBoom("steps.x.counts.failed", 1)];
    const { h, two } = await retried(steps, { h: first }, {}, { items: [1, 2, 3] });
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(h.agentCalls.map((c) => c.step.id)).toEqual(["boom"]);
  });

  it("how the stop inside a process ended, on a retry of a retry", async () => {
    // Fix 3: the process's own row keeps `stopStatus`, which a retry copies; the retry has no
    // stop rows of its own under the process, so a retry of it reads the row.
    const first = new Harness();
    first.handlers.boom = () => ({ kind: "failed", error: "the vendor's site is down" });
    const steps = [sub(), routeThenBoom("steps.x.stopStatus", "cancelled")];
    const automations = automation([{ id: "end", kind: "stop", name: "End", status: "cancelled" }]);
    const one = await executeWorkflow(
      new FakeStepRunner(),
      first.context({ automations }),
      proc(steps),
      {},
    );
    expect(one).toMatchObject({ status: "failed", nodeId: "boom" });
    expect(pathOf(first)).toBe("yes");
    expect(first.row("x")?.output).toEqual({ stopStatus: "cancelled" });

    /** A retry of the run `of` ran in, from the `if`: `boom` answers with `boom`. */
    const retry = async (of: Harness, n: number, boom: Harness["handlers"][string]) => {
      const resume = resumeOf(of, steps, "route");
      expect(resume.reused.x?.record?.stopStatus).toBe("cancelled");
      expect(resume.reused.x?.stepOutput).toBeNull();
      const h = new Harness({ ...of.run, id: `0192f7a0-0000-7000-8000-00000000a00${n}` });
      h.handlers.boom = boom;
      h.handlers.end = () => ({ kind: "failed", error: "the process ran again" });
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context({ automations, resume }),
        proc(steps),
        {},
      );
      return { h, result };
    };
    const second = await retry(first, 2, () => ({ kind: "failed", error: "still down" }));
    expect(second.result).toMatchObject({ status: "failed", nodeId: "boom" });
    expect(pathOf(second.h)).toBe("yes");
    // The retry reused the process: its row is copied, and no stop ran inside it.
    expect(second.h.row("x")).toMatchObject({ summary: "reused from R-000001" });
    expect([...second.h.rows.values()].some((r) => r.nodeType === "stop")).toBe(false);

    const third = await retry(second.h, 3, () => ({ kind: "done", output: { ok: true } }));
    expect(third.result.status).toBe("succeeded");
    expect(pathOf(third.h)).toBe("yes");
  });

  it("a confer's verdict", async () => {
    const first = new Harness();
    const confer = { ai: async () => ({ verdict: "disagree" as const, note: "odd" }) };
    const steps = [
      skill({ checks: { confer: { with: [{ ai: { focus: "Right?" } }] } } }),
      routeThenBoom("steps.x.confer.verdict", "disagree"),
    ];
    const { h, two } = await retried(steps, { h: first, extra: { confer } });
    expect(two.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
  });
});

describe("an if inside a for each", () => {
  it("routes each item on that item's own outcome", async () => {
    const h = new Harness();
    h.handlers.r = (req) =>
      (req.input as { i: number }).i === 2
        ? { kind: "done", output: { items: [] } }
        : { kind: "done", output: { items: [1] } };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.items}}",
          steps: [
            { id: "r", kind: "read", name: "R", tool: READ_TOOL.id, input: { i: "{{item}}" } },
            {
              id: "route",
              kind: "if",
              name: "Route",
              paths: [
                {
                  id: "none",
                  name: "Found nothing",
                  when: {
                    match: "all",
                    rules: [{ field: "{{steps.r.outcome}}", op: "=", value: "empty" }],
                  },
                  steps: [
                    {
                      id: "say",
                      kind: "notify",
                      name: "Say",
                      notify: { to: ["lead"], message: "nothing for {{item}}" },
                    },
                  ],
                },
              ],
              otherwise: { id: "some", steps: [] },
            },
          ],
        },
      ]),
      { items: [1, 2, 3] },
    );
    expect(result.status).toBe("succeeded");
    const paths = [0, 1, 2].map(
      (i) => (h.row(`each:${i}:route`)?.output as { pathId?: string } | undefined)?.pathId,
    );
    expect(paths).toEqual(["some", "none", "some"]);
    expect(h.sent.map((m) => m.text)).toEqual(["nothing for 2"]);
  });
});
