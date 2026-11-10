// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): a v4 process forks on how a step ended, not only on
// data. Each step records its outcome beside its output (`steps.<id>.outcome`, `.approval`,
// `.confer`, `.error`, `.choice`, `.counts`), an `if` routes on it, `onError: continue` goes on
// past a failure the step reported, a replayed run takes the same path, and a converted v3
// workflow runs exactly as before.
import { outcomeOfStepRow, type processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL, wf } from "./fakes.test-helper";
import type { ConversationResult, InboxResolution } from "./ports";
import { conversationEventType } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

/** An `if` that takes `yes` when `{{field}} op value`, with a notify there saying what it read. */
function routeOn(field: string, value: unknown, op = "=", say = `{{${field}}}`) {
  return {
    id: "route",
    kind: "if",
    name: "Route",
    paths: [
      {
        id: "yes",
        name: "Recover",
        when: { match: "all", rules: [{ field: `{{${field}}}`, op, value }] },
        steps: [{ id: "fix", kind: "notify", name: "Fix", notify: { to: ["lead"], message: say } }],
      },
    ],
    otherwise: { id: "no", steps: [] },
  };
}

const read = (over: Record<string, unknown> = {}) => ({
  id: "find",
  kind: "read",
  name: "Find",
  tool: READ_TOOL.id,
  ...over,
});
const write = (over: Record<string, unknown> = {}) => ({
  id: "save",
  kind: "write",
  name: "Save",
  tool: WRITE_TOOL.id,
  input: { name: "x" },
  ...over,
});
const skill = (over: Record<string, unknown> = {}) => ({
  id: "think",
  kind: "skill",
  name: "Think",
  skill: "web.browse",
  input: { site: "x" },
  ...over,
});

const pathOf = (h: Harness) => (h.row("route")?.output as { pathId?: string } | undefined)?.pathId;
const said = (h: Harness) => h.sent.map((m) => m.text);

/** The outcome the run view reads back from a step's row. */
function rowOutcome(h: Harness, nodeId: string) {
  const row = h.row(nodeId);
  if (!row) throw new Error(`no row ${nodeId}`);
  return outcomeOfStepRow(row, []);
}

async function run(
  steps: unknown[],
  h = new Harness(),
  runner = new FakeStepRunner(),
  extra: Parameters<Harness["context"]>[0] = {},
) {
  const result = await executeWorkflow(runner, h.context(extra), proc(steps), {});
  return { h, runner, result };
}

/** An approval item the write's gate made, already answered (or not). */
function approvalWrite(h: Harness, resolution: InboxResolution | null) {
  const item = h.approvalItem(resolution);
  h.handlers.save = () => ({ kind: "approval", pending: { inboxItemId: item } });
  return item;
}

describe("each kind's outcome routes an if", () => {
  it("read: empty", async () => {
    const h = new Harness();
    h.handlers.find = () => ({ kind: "done", output: { items: [], next: null } });
    const { result } = await run([read(), routeOn("steps.find.outcome", "empty")], h);
    expect(result.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["empty"]);
    // The run view reads the same word back from the row.
    expect(rowOutcome(h, "find")).toBe("empty");
  });

  it("read: done is not empty", async () => {
    const h = new Harness();
    h.handlers.find = () => ({ kind: "done", output: { items: [1] } });
    await run([read(), routeOn("steps.find.outcome", "empty")], h);
    expect(pathOf(h)).toBe("no");
  });

  it("write: approved, with who signed", async () => {
    const h = new Harness();
    approvalWrite(h, { approved: true, by: "u-amy" });
    await run(
      [
        write({ checks: { approval: {} } }),
        routeOn("steps.save.approval.outcome", "approved", "=", "{{steps.save.approval.by}}"),
      ],
      h,
    );
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["u-amy"]);
  });

  it("write: not needed when the gate let it run", async () => {
    const h = new Harness();
    h.handlers.save = () => ({ kind: "done", output: { ok: true } });
    await run(
      [
        write(),
        routeOn("steps.save.approval.outcome", "not_needed", "=", "{{steps.save.outcome}}"),
      ],
      h,
    );
    expect(said(h)).toEqual(["done"]);
  });

  it("skill: done, and its confer's verdict", async () => {
    const h = new Harness();
    h.handlers.think = () => ({ kind: "done", output: { answer: 1 } });
    const confer = { ai: async () => ({ verdict: "disagree" as const, note: "odd" }) };
    const { result } = await run(
      [
        skill({ checks: { confer: { with: [{ ai: { focus: "Is it right?" } }] } } }),
        routeOn("steps.think.confer.verdict", "disagree", "=", "{{steps.think.outcome}}"),
      ],
      h,
      new FakeStepRunner(),
      { confer },
    );
    expect(result.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["done"]);
  });

  it("person: the quick answer chosen", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_n, type) => runner.deliver(type, { answer: "drop", by: "u-1" });
    await run(
      [
        {
          id: "ask",
          kind: "person",
          name: "Ask",
          mode: "ask",
          assignee: "client_admin",
          title: "Keep it?",
          deadline: { after: "1 day" },
          choices: [
            { value: "keep", label: "Keep" },
            { value: "drop", label: "Drop" },
          ],
        },
        routeOn("steps.ask.choice", "drop", "=", "{{steps.ask.outcome}}"),
      ],
      h,
      runner,
    );
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["answered"]);
  });

  it("person: no answer, skipped by its deadline", async () => {
    const h = new Harness();
    await run(
      [
        {
          id: "ask",
          kind: "person",
          name: "Ask",
          mode: "approve",
          assignee: "client_admin",
          title: "OK?",
          deadline: { after: "1 day", ifNoAnswer: "skip" },
        },
        routeOn("steps.ask.outcome", "no_answer"),
      ],
      h,
      new FakeStepRunner({ onWait: "timeout" }),
    );
    expect(pathOf(h)).toBe("yes");
  });

  it("conversation: not found", async () => {
    const h = new Harness();
    const conversation = {
      conversation: async (): Promise<ConversationResult> => ({
        status: "not_found",
        found: {},
        conversationId: "run-1:talk",
        summary: "They didn't know",
      }),
    };
    await run(
      [
        {
          id: "talk",
          kind: "conversation",
          name: "Ask the vendor",
          with: "c-vendor",
          channel: "email",
          goal: "Find the price",
          find: { price: "money" },
          deadline: { after: "2 days" },
        },
        routeOn("steps.talk.outcome", "not_found"),
      ],
      h,
      new FakeStepRunner(),
      { conversation },
    );
    expect(pathOf(h)).toBe("yes");
    expect(conversationEventType("run-1:talk")).toBeTruthy();
  });

  it("notify: skipped when its condition doesn't hold", async () => {
    const h = new Harness();
    await run(
      [
        {
          id: "tell",
          kind: "notify",
          name: "Tell",
          notify: {
            to: ["lead"],
            message: "hi",
            when: { match: "all", rules: [{ field: "{{trigger.big}}", op: "=", value: true }] },
          },
        },
        routeOn("steps.tell.outcome", "skipped"),
      ],
      h,
    );
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["skipped"]);
  });

  it("wait: timed out", async () => {
    const h = new Harness();
    await run(
      [
        { id: "w", kind: "wait", name: "Wait", for: "1 hour" },
        routeOn("steps.w.outcome", "timed_out"),
      ],
      h,
    );
    expect(pathOf(h)).toBe("yes");
    expect(rowOutcome(h, "w")).toBe("timed_out");
  });

  it("for each: some failed, with counts, when it goes on past an item's failure", async () => {
    const h = new Harness();
    h.handlers.r = (req) =>
      (req.input as { i: number }).i === 1
        ? { kind: "failed", error: "not found" }
        : { kind: "done", output: { ok: true } };
    const { result } = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.items}}",
          onError: "continue",
          steps: [
            { id: "r", kind: "read", name: "R", tool: READ_TOOL.id, input: { i: "{{item}}" } },
          ],
        },
        routeOn(
          "steps.each.outcome",
          "some_failed",
          "=",
          "{{steps.each.counts.failed}}/{{steps.each.counts.items}}",
        ),
      ]),
      { items: [1, 2, 3] },
    ).then((r) => ({ result: r }));
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls).toHaveLength(3);
    expect(said(h)).toEqual(["1/3"]);
    expect(rowOutcome(h, "each")).toBe("some_failed");
  });

  it("process: stopped by a stop step inside, the run going on", async () => {
    const h = new Harness();
    const automations = {
      "check@1": {
        schemaVersion: 2,
        slug: "check",
        name: "Check",
        description: "",
        input: {},
        output: {},
        steps: [{ id: "end", kind: "stop", name: "End", status: "succeeded" }],
        requires: { connectors: [], packs: [] },
      } as never,
    };
    const { result } = await run(
      [
        { id: "sub", kind: "process", name: "Check", process: "check@1", onError: "continue" },
        routeOn("steps.sub.outcome", "stopped"),
      ],
      h,
      new FakeStepRunner(),
      { automations },
    );
    expect(result.status).toBe("succeeded");
    expect(pathOf(h)).toBe("yes");
    expect(h.row("sub")?.status).toBe("skipped");
  });
});

describe("onError: continue", () => {
  it("on a read: records failed and why, and the run goes on", async () => {
    const h = new Harness();
    h.handlers.find = () => ({ kind: "failed", error: "401 unauthorized" });
    const { result } = await run(
      [
        read({ onError: "continue" }),
        routeOn("steps.find.outcome", "failed", "=", "{{steps.find.error.code}}"),
      ],
      h,
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("find")?.status).toBe("failed");
    expect(said(h)).toEqual(["unauthorized"]);
    expect(h.agentCalls).toHaveLength(1);
  });

  it("without it, the same failure ends the run as before", async () => {
    const h = new Harness();
    h.handlers.find = () => ({ kind: "failed", error: "401 unauthorized" });
    const { result } = await run([read(), routeOn("steps.find.outcome", "failed")], h);
    expect(result).toMatchObject({ status: "failed", nodeId: "find" });
    expect(h.row("route")).toBeUndefined();
  });

  it("on a write: a failed write is never retried, and its approval is kept", async () => {
    const h = new Harness();
    approvalWrite(h, { approved: true, by: "u-amy" });
    h.resumeHandler = () => ({ kind: "failed", error: "refused: the bill is closed" });
    const { result } = await run(
      [
        write({ onError: "continue", checks: { approval: {} } }),
        routeOn(
          "steps.save.outcome",
          "failed",
          "=",
          "{{steps.save.approval.outcome}} {{steps.save.error.code}}",
        ),
      ],
      h,
    );
    expect(result.status).toBe("succeeded");
    expect(said(h)).toEqual(["approved refused"]);
    expect(h.agentCalls).toHaveLength(1);
    expect(h.resumeCalls).toHaveLength(1);
  });

  it("on a write whose write may have happened: the run still fails", async () => {
    const h = new Harness();
    h.handlers.save = () => ({
      kind: "failed",
      error: "The text to Pat may have been sent; check before trying again: timed out",
    });
    const { result } = await run(
      [write({ onError: "continue" }), routeOn("steps.save.outcome", "failed")],
      h,
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "save" });
    expect(h.row("route")).toBeUndefined();
  });

  it("on a skill: help nobody gave is needs_help, and the run goes on", async () => {
    const h = new Harness();
    h.handlers.think = () => ({ kind: "done", output: { needsHelp: { question: "Where?" } } });
    const { result } = await run(
      [
        skill({ onError: "continue" }),
        routeOn("steps.think.outcome", "needs_help", "=", "{{steps.think.error.code}}"),
      ],
      h,
      new FakeStepRunner({ onWait: "timeout" }),
    );
    expect(result.status).toBe("succeeded");
    expect(said(h)).toEqual(["needs_help"]);
  });

  it("on a skill: an escalation (a budget hit) is a failure it goes on past", async () => {
    const h = new Harness();
    h.handlers.think = () => ({ kind: "escalated", reason: "budget" });
    const { result } = await run(
      [
        skill({ onError: "continue" }),
        routeOn("steps.think.outcome", "failed", "=", "{{steps.think.error.code}}"),
      ],
      h,
    );
    expect(result.status).toBe("succeeded");
    expect(said(h)).toEqual(["escalated"]);
  });

  it("on a notify step: a send that fails is stored as failed, never sent again on replay", async () => {
    const h = new Harness();
    let tries = 0;
    h.notify.send = async (m) => {
      if (m.nodeId !== "tell") {
        h.sent.push(m);
        return;
      }
      tries++;
      throw new Error("the mail service is down");
    };
    const runner = new FakeStepRunner();
    const steps = [
      {
        id: "tell",
        kind: "notify",
        name: "Tell",
        onError: "continue",
        notify: { to: ["lead"], message: "hi" },
      },
      routeOn("steps.tell.outcome", "failed", "=", "x"),
    ];
    const first = await executeWorkflow(runner, h.context(), proc(steps), {});
    expect(first.status).toBe("succeeded");
    expect(h.row("tell")?.status).toBe("failed");
    expect(pathOf(h)).toBe("yes");
    runner.replay();
    await executeWorkflow(runner, h.context(), proc(steps), {});
    expect(tries).toBe(1);
  });

  it("never goes on past a person's no", async () => {
    const h = new Harness();
    approvalWrite(h, { approved: false, by: "u-1" });
    const { result } = await run(
      [
        write({ onError: "continue", checks: { approval: { onReject: "stop" } } }),
        routeOn("steps.save.outcome", "rejected"),
      ],
      h,
    );
    expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
  });
});

describe("routing on a bad outcome", () => {
  it("a rejected write with onReject continue takes the recovery path", async () => {
    const h = new Harness();
    approvalWrite(h, { approved: false, by: "u-1" });
    const { result } = await run(
      [
        write({ checks: { approval: { onReject: "continue" } } }),
        routeOn("steps.save.outcome", "rejected", "=", "{{steps.save.approval.by}}"),
      ],
      h,
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("save")?.status).toBe("skipped");
    expect(pathOf(h)).toBe("yes");
    expect(said(h)).toEqual(["u-1"]);
  });

  it("nobody signing by the deadline with ifNoAnswer skip routes on no_answer", async () => {
    const h = new Harness();
    approvalWrite(h, null);
    const { result } = await run(
      [
        write({ checks: { approval: { ifNoAnswer: "skip" } } }),
        routeOn("steps.save.outcome", "no_answer", "=", "{{steps.save.approval.outcome}}"),
      ],
      h,
      new FakeStepRunner({ onWait: "timeout" }),
    );
    expect(result.status).toBe("succeeded");
    expect(said(h)).toEqual(["no_answer"]);
  });

  it("proceed on a write keeps it done, its approval no_answer", async () => {
    const h = new Harness();
    approvalWrite(h, null);
    await run(
      [
        write({ checks: { approval: { ifNoAnswer: "proceed" } } }),
        routeOn("steps.save.approval.outcome", "no_answer", "=", "{{steps.save.outcome}}"),
      ],
      h,
      new FakeStepRunner({ onWait: "timeout" }),
    );
    expect(said(h)).toEqual(["done"]);
  });
});

describe("replay", () => {
  it("a run restarted after the approval rebuilds the outcome from stored results", async () => {
    // The first execution "crashes" at the if (its durable step throws before running), after the
    // write's approval was stored. The restart replays every stored step, asks nobody again, and
    // routes on the outcome they hold, even though the inbox now says something else.
    class CrashingRunner extends FakeStepRunner {
      crash = true;
      override async do<T>(name: string, fn: () => Promise<T>, config?: never): Promise<T> {
        if (this.crash && name === "route") throw new Error("the worker restarted");
        return super.do(name, fn, config);
      }
    }
    const h = new Harness();
    const item = approvalWrite(h, { approved: false, by: "u-1" });
    const steps = [
      write({ checks: { approval: { onReject: "continue" } } }),
      routeOn("steps.save.outcome", "rejected"),
    ];
    const runner = new CrashingRunner();
    await executeWorkflow(runner, h.context(), proc(steps), {});
    expect(h.row("route")?.output).toBeUndefined();
    const asked = h.agentCalls.length;
    const resumed = h.resumeCalls.length;

    // The inbox changed meanwhile; the stored answer stands.
    const entry = h.items.get(item);
    if (entry) entry.resolution = { approved: true, by: "u-2" };
    runner.crash = false;
    runner.replay();
    const result = await executeWorkflow(runner, h.context(), proc(steps), {});
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls).toHaveLength(asked);
    expect(h.resumeCalls).toHaveLength(resumed);
    expect(pathOf(h)).toBe("yes");
    expect(runner.calls.filter((c) => c.kind === "do" && !c.cached).map((c) => c.name)).toEqual([
      "route",
      "fix",
    ]);
  });
});

describe("converted v3 workflows", () => {
  it("record nothing new: a v3 fork naming an outcome reads nothing, as before", async () => {
    const steps = (kind: "v3" | "v4") => [
      kind === "v3"
        ? {
            id: "save",
            kind: "action",
            name: "Save",
            tool: WRITE_TOOL.id,
            input: { name: "x" },
            approval: { required: "required", onReject: "continue" },
          }
        : write({ checks: { approval: { onReject: "continue" } } }),
      {
        id: "route",
        kind: kind === "v3" ? "fork" : "if",
        name: "Route",
        paths: [
          {
            id: "yes",
            name: "Recover",
            when: {
              match: "all",
              rules: [{ field: "{{steps.save.outcome}}", op: "=", value: "rejected" }],
            },
            steps: [],
          },
        ],
        otherwise: { id: "no", steps: [] },
      },
    ];
    const v3 = new Harness();
    approvalWrite(v3, { approved: false, by: "u-1" });
    const runner = new FakeStepRunner();
    const r3 = await executeWorkflow(runner, v3.context(), wf(steps("v3")), {});
    expect(r3.status).toBe("succeeded");
    expect(pathOf(v3)).toBe("no");
    // Same durable names, same rows as a v3 run always had.
    expect(runner.names()).toEqual([
      "save",
      "save:approval:1:check",
      "save:approval:1:received",
      "save:approval:1:resume",
      "route",
    ]);
    expect(v3.row("save")).toMatchObject({ nodeType: "action", status: "skipped" });

    const v4 = new Harness();
    approvalWrite(v4, { approved: false, by: "u-1" });
    await executeWorkflow(new FakeStepRunner(), v4.context(), proc(steps("v4")), {});
    expect(pathOf(v4)).toBe("yes");
  });
});
