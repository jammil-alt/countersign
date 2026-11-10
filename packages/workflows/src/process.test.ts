// R3 (ARCHITECTURE §10.14; docs/plan.md §1.86, §9): the executor runs v4 processes. Converted v3
// workflows are covered by every other test in this package (unchanged); these cover what only
// v4 says: read and write steps, skill customization, checks in order (confer, approval, the
// write, notify), approval modes and `ifNoAnswer`, business-hours deadlines, conversations, the
// needs-help loop, urgent notifications, process and if steps, and the router's v4 triggers.
import { processes, type SkillDefinition } from "@countersign/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
import type {
  AskApproverRequest,
  ConferAiRequest,
  ConversationRequest,
  ConversationResult,
  HoursPort,
  V4Notice,
} from "./ports";
import { conversationEventType } from "./ports";
import { loadProcess } from "./process";
import { requestRun, triggersOfWorkflow } from "./router";
import { inboxEventType } from "./runner";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

/** A v4 process (parsed by the executor). */
function proc(steps: unknown[], triggers: unknown[] = [MANUAL]): processes.Process {
  return { schemaVersion: 4, triggers, steps } as unknown as processes.Process;
}

const write = (over: Record<string, unknown> = {}) => ({
  id: "write",
  kind: "write",
  name: "Update the record",
  tool: WRITE_TOOL.id,
  input: { name: "{{trigger.what}}" },
  ...over,
});

const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };

/** A harness whose agent port can ask more approvers, recording who was asked. */
function withApprovers(h: Harness) {
  const asked: AskApproverRequest[] = [];
  h.agent.askApprover = async (req) => {
    asked.push(req);
    return { inboxItemId: h.approvalItem() };
  };
  return asked;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("reads a v3 workflow as v4, every id kept, and runs converted steps through their v3 step", async () => {
    const lookup: processes.ConvertLookup = {
      wrappedTool: (id) => (id === "qbo.read-bill" ? "qbo.bill.get" : null),
      sideEffect: (id) => (id === "qbo.bill.get" ? "none" : null),
    };
    const v3 = wf([
      { id: "read", kind: "skill", name: "Read", skill: "qbo.read-bill", input: { id: "1" } },
      {
        id: "f",
        kind: "fork",
        name: "Big?",
        paths: [{ id: "big", name: "Big", when: { match: "all", rules: [] }, steps: [] }],
        otherwise: { id: "small", steps: [] },
      },
    ]);
    const loaded = loadProcess(v3, lookup);
    expect(loaded.process.steps.map((s) => [s.id, s.kind])).toEqual([
      ["read", "read"],
      ["f", "if"],
    ]);
    const h = new Harness();
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context({ lookup }), v3, {});
    expect(result.status).toBe("succeeded");
    // The tool-wrapper skill still runs as the skill it was stored as, with its skill_ref.
    expect(h.agentCalls[0]?.step).toMatchObject({ kind: "skill", skill: "qbo.read-bill" });
    expect(h.row("read")).toMatchObject({ nodeType: "skill", skillRef: "qbo.read-bill" });
    expect(h.row("f")?.nodeType).toBe("fork");
    expect(runner.names()).toEqual(["read", "f"]);
  });

  it("fails a v4 process that doesn't parse, before any step", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([{ id: "x", kind: "nope", name: "X" }]),
      {},
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/doesn't parse/);
    expect(h.rows.size).toBe(0);
  });
});

describe("read and write steps", () => {
  it("runs both through the tool-call path; a write's approval is on by default", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { name: "Acme" } });
    h.handlers.write = (req) => ({ kind: "done", output: req.input });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: { tools: { [WRITE_TOOL.id]: WRITE_TOOL, [READ_TOOL.id]: READ_TOOL } } }),
      proc([
        { id: "get", kind: "read", name: "Get", tool: READ_TOOL.id, input: { id: "1" } },
        write({ input: { name: "{{steps.get.output.name}}" } }),
      ]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.map((c) => [c.step.kind, c.nodeId, c.input])).toEqual([
      ["action", "get", { id: "1" }],
      ["action", "write", { name: "Acme" }],
    ]);
    expect(h.agentCalls[1]?.approval).toEqual({ required: "required", onReject: "stop" });
    expect(h.row("write")).toMatchObject({ nodeType: "write", summary: "Updated Acme" });
  });

  it("passes an approval limited to some runs as not required on the others", async () => {
    const h = new Harness();
    const when = { match: "all", rules: [{ field: "{{trigger.total}}", op: ">", value: 5000 }] };
    for (const total of [100, 9000]) {
      h.agentCalls.length = 0;
      await executeWorkflow(
        new FakeStepRunner(),
        h.context(),
        proc([write({ checks: { approval: { when } } })]),
        { what: "x", total },
      );
      expect(h.agentCalls[0]?.approval.required).toBe(total > 5000 ? "required" : "not_required");
    }
  });
});

describe("skill steps", () => {
  const def: SkillDefinition = {
    ...SKILL,
    mode: "task",
    model: { id: "claude-sonnet-4-5" },
    instructions: "Draft a note.",
    settings: [{ key: "tone", label: "Tone", type: "string", default: "plain" }],
    output: { type: "object", properties: { text: {}, debug: {} } },
  } as unknown as SkillDefinition;

  it("layers the customization's settings over the step's and keeps only its fields", async () => {
    const h = new Harness();
    h.agent.appliesCustomization = true;
    h.handlers.s = () => ({ kind: "done", output: { text: "hi", debug: "x" } });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: { skills: { [def.id]: def } } }),
      proc([
        {
          id: "s",
          kind: "skill",
          name: "Draft",
          skill: def.id,
          settings: { tone: "warm", other: 1 },
          customize: { settings: { tone: "brisk" }, addInstructions: "Be short.", keep: ["text"] },
        },
        {
          id: "next",
          kind: "skill",
          name: "Next",
          skill: "x.y",
          input: { v: "{{steps.s.output}}" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    const call = h.agentCalls[0] as { step: { settings?: unknown }; customize?: unknown };
    expect(call.step.settings).toEqual({ tone: "brisk", other: 1 });
    expect(call.customize).toMatchObject({ addInstructions: "Be short." });
    expect(h.agentCalls[1]?.input).toEqual({ v: { text: "hi" } });
  });

  it("fails the step when its customization doesn't fit the skill", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: { skills: { [def.id]: def } } }),
      proc([
        {
          id: "s",
          kind: "skill",
          name: "Draft",
          skill: def.id,
          customize: { settings: { nope: 1 } },
        },
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "s" });
    expect(result.reason).toMatch(/no setting nope/);
    expect(h.agentCalls).toHaveLength(0);
  });
});

describe("checks", () => {
  it("runs confer, then approval, then the write, then notify, in that order", async () => {
    const h = new Harness();
    const order: string[] = [];
    const item = h.approvalItem({ approved: true, by: "u-1" });
    h.handlers.write = () => {
      order.push("propose");
      return { kind: "approval", pending: { inboxItemId: item } };
    };
    h.resumeHandler = () => {
      order.push("write");
      return { kind: "done", output: { written: true } };
    };
    const reviews: ConferAiRequest[] = [];
    const notices: V4Notice[] = [];
    h.notify.notify = async (n) => {
      order.push("notify");
      notices.push(n);
      return {};
    };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        confer: {
          ai: async (req) => {
            order.push("confer");
            reviews.push(req);
            return { verdict: "disagree", note: "the lines don't add up" };
          },
        },
      }),
      proc([
        write({
          checks: {
            confer: { with: [{ ai: { focus: "do the lines add up for {{trigger.what}}" } }] },
            notify: [
              {
                to: ["lead"],
                message: "Written, though the check said {{confer.0.verdict}}",
                when: {
                  match: "all",
                  rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "disagree" }],
                },
              },
              {
                to: ["lead"],
                message: "never",
                when: {
                  match: "all",
                  rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "agree" }],
                },
              },
            ],
          },
        }),
      ]),
      { what: "bill 7" },
    );
    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["confer", "propose", "write", "notify"]);
    // The focus is the instruction, as written; what it references goes beside it as data.
    expect(reviews[0]).toMatchObject({
      focus: "do the lines add up for {{trigger.what}}",
      references: { "trigger.what": "bill 7" },
      input: { name: "bill 7" },
      stepId: "write",
    });
    expect(h.row("write:confer:0")).toMatchObject({
      nodeType: "confer",
      summary: "A second check: disagree",
      output: { verdict: "disagree", note: "the lines don't add up", by: "ai" },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      to: ["lead"],
      text: "Written, though the check said disagree",
    });
  });

  it("asks a person conferee with quick answers, after a read, and records their verdict", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { total: 12 } });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { answer: "disagree", by: "u-9" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "get",
          kind: "read",
          name: "Get the bill",
          tool: READ_TOOL.id,
          checks: {
            confer: {
              with: [{ person: "dana", deadline: { after: "1 day" } }],
            },
          },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    const asked = [...h.items.values()].find((v) => v.item?.nodeId === "get:confer:0")?.item;
    expect(asked).toMatchObject({
      kind: "request",
      title: "Check: Get the bill",
      payload: { value: { total: 12 } },
      step: { assignee: "dana", mode: "ask" },
    });
    expect(asked?.step.choices?.map((c) => c.value)).toEqual(["agree", "disagree", "unsure"]);
    expect(h.row("get:confer:0")).toMatchObject({
      status: "succeeded",
      summary: "Checked by dana: disagree",
      output: { verdict: "disagree", by: "u-9" },
    });
  });

  it("skips a conferee whose condition reads an earlier verdict that doesn't match", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ confer: { ai: async () => ({ verdict: "agree", note: "fine" }) } }),
      proc([
        write({
          checks: {
            confer: {
              with: [
                { ai: { focus: "check it" } },
                {
                  person: "dana",
                  deadline: { after: "1 day" },
                  when: {
                    match: "all",
                    rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "disagree" }],
                  },
                },
              ],
            },
          },
        }),
      ]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("write:confer:1")).toBeUndefined();
    expect([...h.items.values()].some((v) => v.item?.nodeId === "write:confer:1")).toBe(false);
  });
});

describe("approval modes", () => {
  const approvers = (mode: string, extra: Record<string, unknown> = {}) => ({
    checks: {
      approval: {
        mode,
        approvers: [
          { who: "amy", deadline: { after: "1 day" } },
          { who: "ben", deadline: { after: "2 days" } },
        ],
        ...extra,
      },
    },
  });

  it("in turn: asks the next approver once the first one's deadline passes", async () => {
    const h = new Harness();
    const asked = withApprovers(h);
    const first = h.approvalItem();
    h.handlers.write = (req) => {
      expect(req.approval.approver).toBe("amy");
      expect(req.approval.timeout).toBe("1 day");
      return { kind: "approval", pending: { inboxItemId: first, actionId: "ea-1" } };
    };
    const runner = new FakeStepRunner({ onWait: "timeout" });
    runner.onWaitStarted = (name, type) => {
      if (name.includes(":a1")) {
        runner.setOnWait("block");
        runner.deliver(type, { approved: true, by: "ben" });
      }
    };
    const result = await executeWorkflow(runner, h.context(), proc([write(approvers("in_turn"))]), {
      what: "x",
    });
    expect(result.status).toBe("succeeded");
    expect(asked.map((a) => [a.who, a.nodeId])).toEqual([["ben", "write:approval:1:a1"]]);
    expect(h.items.get(first)?.expired).toBe(true);
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "ben" });
    expect(
      runner.calls
        .filter((c) => c.kind === "wait")
        .map((c) => [c.name, (c as { timeout: string }).timeout]),
    ).toEqual([
      ["write:approval:1:wait", "1 day"],
      ["write:approval:1:a1:wait", "2 days"],
    ]);
  });

  it("any: asks everyone at once and takes the first answer", async () => {
    const h = new Harness();
    const asked = withApprovers(h);
    const first = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: first } });
    const runner = new FakeStepRunner({ onWait: "block" });
    let delivered = false;
    runner.onWaitStarted = (name, type) => {
      if (name.includes(":a1") && !delivered) {
        delivered = true;
        const second = asked[0]?.nodeId ? [...h.items.keys()].at(-1) : undefined;
        const entry = second ? h.items.get(second) : undefined;
        if (entry) entry.resolution = { approved: true, by: "ben" };
        runner.deliver(type, { approved: true, by: "ben" });
      }
    };
    const result = await executeWorkflow(runner, h.context(), proc([write(approvers("any"))]), {
      what: "x",
    });
    expect(result.status).toBe("succeeded");
    expect(asked.map((a) => a.who)).toEqual(["ben"]);
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "ben" });
    // The one who didn't answer is closed.
    expect(h.items.get(first)?.expired).toBe(true);
  });

  it("all: needs everyone; the first reject ends it", async () => {
    for (const second of [true, false]) {
      const h = new Harness();
      withApprovers(h);
      const first = h.approvalItem({ approved: true, by: "amy" });
      h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: first } });
      const runner = new FakeStepRunner({ onWait: "block" });
      runner.onWaitStarted = (name, type) => {
        if (!name.includes(":a1")) return;
        const id = [...h.items.keys()].at(-1) as string;
        const entry = h.items.get(id);
        if (entry) entry.resolution = { approved: second, by: "ben" };
        runner.deliver(type, {});
      };
      const result = await executeWorkflow(runner, h.context(), proc([write(approvers("all"))]), {
        what: "x",
      });
      if (second) {
        expect(result.status).toBe("succeeded");
        expect(h.resumeCalls[0]?.resolution.approved).toBe(true);
      } else {
        expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
        expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: false, by: "ben" });
      }
    }
  });

  it("proceed: goes ahead with nobody's answer and says so on the step's row", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.write = () => ({
      kind: "approval",
      pending: { inboxItemId: item, actionId: "ea-7" },
    });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context(),
      proc([write({ checks: { approval: { ifNoAnswer: "proceed" } } })]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.resumeCalls[0]?.resolution).toMatchObject({
      approved: true,
      by: null,
      proceeded: true,
    });
    expect(h.row("write")).toMatchObject({
      status: "succeeded",
      proceededWithoutAnswer: true,
      externalActionId: "ea-7",
    });
  });

  it("skip: the write is skipped and the run goes on, whatever onReject says", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context(),
      proc([
        write({ checks: { approval: { ifNoAnswer: "skip", onReject: "stop" } } }),
        { id: "n", kind: "notify", name: "N", notify: { to: ["lead"], message: "after" } },
      ]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("write")?.status).toBe("skipped");
    expect(h.sent).toHaveLength(1);
  });

  it("escalates to someone else with their own deadline", async () => {
    const h = new Harness();
    const asked = withApprovers(h);
    const item = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const runner = new FakeStepRunner({ onWait: "timeout" });
    runner.onWaitStarted = (name, type) => {
      if (name.includes(":esc1")) {
        runner.setOnWait("block");
        runner.deliver(type, { approved: true, by: "boss" });
      }
    };
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        write({
          checks: {
            approval: {
              ifNoAnswer: {
                escalate: { to: "boss", deadline: { after: "4 hours", ifNoAnswer: "stop" } },
              },
            },
          },
        }),
      ]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(asked.map((a) => [a.who, a.nodeId])).toEqual([["boss", "write:approval:1:esc1"]]);
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "boss" });
  });

  it("a replay of approvals, checks and an escalation repeats nothing", async () => {
    const h = new Harness();
    const asked = withApprovers(h);
    const first = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: first } });
    const reviews: unknown[] = [];
    const ctx = h.context({
      confer: {
        ai: async (req) => {
          reviews.push(req);
          return { verdict: "agree", note: "" };
        },
      },
    });
    const process = proc([
      write({
        checks: {
          confer: { with: [{ ai: { focus: "f" } }] },
          approval: {
            mode: "any",
            approvers: [{ who: "amy" }, { who: "ben" }],
            ifNoAnswer: { escalate: { to: "boss", deadline: { after: "1 hour" } } },
          },
          notify: [{ to: ["lead"], message: "done" }],
        },
      }),
    ]);
    const runner = new FakeStepRunner({ onWait: "timeout" });
    runner.onWaitStarted = (name, type) => {
      if (name.includes(":esc1")) {
        runner.setOnWait("block");
        runner.deliver(type, { approved: true, by: "boss" });
      }
    };
    const once = await executeWorkflow(runner, ctx, process, { what: "x" });
    expect(once.status).toBe("succeeded");
    const counts = () => [
      h.agentCalls.length,
      asked.length,
      h.resumeCalls.length,
      reviews.length,
      h.sent.length,
    ];
    const before = counts();
    expect(before).toEqual([1, 2, 1, 1, 1]);
    runner.replay();
    runner.setOnWait("timeout");
    const again = await executeWorkflow(runner, ctx, process, { what: "x" });
    expect(again).toEqual(once);
    expect(counts()).toEqual(before);
    expect(runner.calls.every((c) => c.kind !== "do" || c.cached)).toBe(true);
  });

  it("skips an approver who is away and asks the next one first", async () => {
    const h = new Harness();
    const item = h.approvalItem({ approved: true, by: "ben" });
    h.handlers.write = (req) => {
      expect(req.approval.approver).toBe("ben");
      return { kind: "approval", pending: { inboxItemId: item } };
    };
    const today = new Date().toISOString().slice(0, 10);
    const hours: HoursPort = {
      hoursFor: async ({ who }) => ({
        client: processes.defaultBusinessHours("UTC"),
        person: { away: who === "amy" ? [{ from: today, to: today }] : [] },
      }),
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ hours }),
      proc([write(approvers("in_turn"))]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(runner.names()).toContain("write:approvers");
  });
});

describe("sign-off of a read or a skill", () => {
  const signed = (when?: unknown) => ({
    id: "get",
    kind: "read",
    name: "Get the bill",
    tool: READ_TOOL.id,
    checks: { approval: { approvers: [{ who: "amy" }], ...(when ? { when } : {}) } },
  });

  it("asks the approver to sign the result; a reject cancels the run", async () => {
    for (const approved of [true, false]) {
      const h = new Harness();
      h.handlers.get = () => ({ kind: "done", output: { total: 9000 } });
      const runner = new FakeStepRunner({ onWait: "block" });
      runner.onWaitStarted = (_name, type) => runner.deliver(type, { approved, by: "amy" });
      const result = await executeWorkflow(runner, h.context(), proc([signed()]), {});
      const asked = [...h.items.values()].find((v) => v.item?.nodeId === "get:signoff:a0")?.item;
      expect(asked).toMatchObject({
        kind: "approval",
        payload: { value: { total: 9000 } },
        step: { assignee: "amy", mode: "approve" },
      });
      if (approved) expect(result.status).toBe("succeeded");
      else expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
    }
  });

  it("asks only when its condition, over the step's own output, holds", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { total: 12 } });
    const when = {
      match: "all",
      rules: [{ field: "{{steps.get.output.total}}", op: ">", value: 5000 }],
    };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([signed(when)]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.size).toBe(0);
  });
});

describe("deadlines", () => {
  it("waits on business hours: Friday 5:50pm plus 30 minutes is Monday 8:20am", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Friday 2026-11-13, 17:50 in Chicago (23:50 UTC).
    vi.setSystemTime(new Date("2026-11-13T23:50:00Z"));
    const h = new Harness({ ...RUN, timeZone: "America/Chicago" });
    const runner = new FakeStepRunner({ onWait: "timeout" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "ok",
          kind: "person",
          name: "Approve",
          mode: "approve",
          assignee: "client_admin",
          title: "Approve it",
          deadline: { after: "30 minutes", hours: "business", remind: ["10 minutes"] },
        },
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    const item = [...h.items.values()][0]?.item;
    // Monday 2026-11-16 08:20 in Chicago = 14:20 UTC.
    expect(item?.dueAt).toBe("2026-11-16T14:20:00.000Z");
    // Ten open minutes after 5:50pm is the close, 6pm Friday.
    expect(item?.remindAt).toEqual(["2026-11-14T00:00:00.000Z"]);
    const wait = runner.calls.find((c) => c.kind === "wait") as { timeout: string };
    expect(wait.timeout).toBe(`${(14 * 60 + 20 + 2 * 24 * 60 + 10) * 60} seconds`);
  });

  it("a person step escalates, and proceeds when nobody answers there either", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context(),
      proc([
        {
          id: "ok",
          kind: "person",
          name: "Approve",
          mode: "approve",
          assignee: "client_admin",
          title: "Approve it",
          deadline: {
            after: "1 day",
            tell: ["operator"],
            ifNoAnswer: {
              escalate: { to: "lead", deadline: { after: "1 hour", ifNoAnswer: "proceed" } },
            },
          },
        },
        {
          id: "n",
          kind: "notify",
          name: "N",
          notify: { to: ["lead"], message: "{{steps.ok.output.approved}}" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    const escalated = [...h.items.values()].find((v) => v.item?.nodeId === "ok:esc1")?.item;
    expect(escalated?.step.assignee).toBe("lead");
    expect(h.operatorNotices).toHaveLength(1);
    expect(h.row("ok")?.status).toBe("skipped");
    expect(h.sent[0]?.text).toBe("false");
  });
});

describe("conversation steps", () => {
  function port(results: ConversationResult[]) {
    const calls: ConversationRequest[] = [];
    return {
      calls,
      conversation: async (req: ConversationRequest) => {
        calls.push(req);
        return (
          results.shift() ?? { status: "failed", found: {}, conversationId: null, summary: "" }
        );
      },
    };
  }
  const talk = (over: Record<string, unknown> = {}) => ({
    id: "ask",
    kind: "conversation",
    name: "Ask the vendor",
    with: "{{trigger.vendor}}",
    channel: "email",
    goal: "Find the price of {{trigger.item}}",
    find: { price: "money" },
    deadline: { after: "2 days" },
    ...over,
  });

  it("waits on the conversation's event, then reads what it found", async () => {
    const p = port([
      { status: "pending", found: {}, conversationId: "c-1", summary: "" },
      { status: "done", found: { price: "4.20" }, conversationId: "c-1", summary: "Got the price" },
    ]);
    const h = new Harness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => {
      expect(type).toBe(conversationEventType("c-1"));
      runner.deliver(type, {});
    };
    const result = await executeWorkflow(
      runner,
      h.context({ conversation: p }),
      proc([
        talk(),
        {
          id: "n",
          kind: "notify",
          name: "N",
          notify: { to: ["lead"], message: "{{steps.ask.output.found.price}}" },
        },
      ]),
      { vendor: "c-vendor", item: "flour" },
    );
    expect(result.status).toBe("succeeded");
    expect(p.calls[0]?.step).toMatchObject({ with: "c-vendor", goal: "Find the price of flour" });
    expect(p.calls[0]).toMatchObject({ stepId: "ask", runId: RUN.id, mode: "live" });
    expect(h.row("ask")).toMatchObject({ status: "succeeded", summary: "Got the price" });
    expect(h.sent[0]?.text).toBe("4.20");
  });

  it("takes the deadline's ifNoAnswer when nobody answers", async () => {
    const p = port([
      { status: "pending", found: {}, conversationId: "c-2", summary: "" },
      { status: "pending", found: {}, conversationId: "c-2", summary: "" },
    ]);
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context({ conversation: p }),
      proc([talk({ deadline: { after: "2 days", ifNoAnswer: "skip" } })]),
      { vendor: "v", item: "i" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("ask")?.status).toBe("skipped");
  });

  it("fails without the conversation service", async () => {
    const h = new Harness();
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), proc([talk()]), {});
    expect(result).toMatchObject({ status: "failed", nodeId: "ask" });
  });
});

describe("needs help", () => {
  it("asks the lead, keeps the answer and runs the skill once more with it", async () => {
    const h = new Harness();
    let runs = 0;
    h.handlers.find = (req) => {
      runs++;
      if (runs === 1) {
        return {
          kind: "done",
          output: { needsHelp: { question: "Where is the invoice list?", tried: ["Billing"] } },
        };
      }
      return { kind: "done", output: { found: true, input: req.input } };
    };
    const memory: unknown[] = [];
    const original = h.agent.runAction;
    h.agent.runAction = async (req) => {
      if (req.step.tool === "memory.write") {
        memory.push(req.input);
        return { kind: "done", output: { memoryNoteId: "m-1" } };
      }
      return original(req);
    };
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { answer: "Under Reports" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "find",
          kind: "skill",
          name: "Find invoices",
          skill: "web.browse",
          input: { site: "x" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    const asked = [...h.items.values()].find((v) => v.item?.nodeId === "find:help")?.item;
    expect(asked).toMatchObject({
      title: "Where is the invoice list?",
      payload: { tried: ["Billing"] },
      step: { assignee: "lead", mode: "ask" },
    });
    expect(memory[0]).toMatchObject({ note: expect.stringContaining("Under Reports") });
    expect(h.agentCalls.at(-1)).toMatchObject({
      input: { site: "x", help: "Under Reports" },
      keyNode: "find:h1",
    });
    expect(h.row("find")?.output).toEqual({
      found: true,
      input: { site: "x", help: "Under Reports" },
    });
    expect(runner.names()).toContain("find:help:run");
  });

  it("stops the run when the lead doesn't answer in a business day", async () => {
    const h = new Harness();
    h.handlers.find = () => ({ kind: "done", output: { needsHelp: { question: "Where?" } } });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context(),
      proc([{ id: "find", kind: "skill", name: "Find", skill: "web.browse" }]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "needs_help", nodeId: "find" });
  });
});

describe("notify steps", () => {
  it("an urgent notice not seen in time stops the run", async () => {
    const h = new Harness();
    const ack = h.approvalItem();
    h.notify.notify = async (n) => {
      expect(n.urgent?.dueAt).toBeDefined();
      return { ackItemId: ack };
    };
    const runner = new FakeStepRunner({ onWait: "timeout" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "n",
          kind: "notify",
          name: "Tell",
          notify: {
            to: ["lead"],
            channel: "sms",
            message: "Now",
            urgent: { ackWithin: "15 minutes" },
          },
        },
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "not_seen", nodeId: "n" });
    expect(runner.calls.find((c) => c.kind === "wait")).toMatchObject({
      name: "n:seen:wait",
      type: inboxEventType(ack),
      timeout: "15 minutes",
    });
  });

  it("without the port's v4 notify, each recipient gets a v3 notice; a test run sends nothing", async () => {
    const h = new Harness();
    const step = {
      id: "n",
      kind: "notify",
      name: "Tell",
      notify: {
        to: ["lead", "client_admin"],
        message: "Hi {{trigger.who}}",
        sources: ["{{trigger.id}}"],
      },
    };
    await executeWorkflow(new FakeStepRunner(), h.context(), proc([step]), { who: "x", id: "r-1" });
    expect(h.sent.map((s) => [s.to, s.channel, s.text, s.sources])).toEqual([
      ["lead", "thread", "Hi x", ["r-1"]],
      ["client_admin", "thread", "Hi x", ["r-1"]],
    ]);
    const t = new Harness({ ...RUN, mode: "test" });
    await executeWorkflow(new FakeStepRunner(), t.context(), proc([step]), { who: "x" });
    expect(t.sent).toHaveLength(0);
    expect(t.row("n")?.summary).toBe("Would tell (test run, not sent)");
  });
});

describe("logic", () => {
  it("runs if, for_each, wait and stop as before", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "f",
          kind: "if",
          name: "Any?",
          paths: [
            {
              id: "yes",
              name: "Some",
              when: {
                match: "all",
                rules: [{ field: "{{trigger.items.length}}", op: ">", value: 0 }],
              },
              steps: [
                {
                  id: "each",
                  kind: "for_each",
                  name: "Each",
                  over: "{{trigger.items}}",
                  steps: [
                    {
                      id: "r",
                      kind: "read",
                      name: "R",
                      tool: READ_TOOL.id,
                      input: { i: "{{item}}" },
                    },
                  ],
                },
              ],
            },
          ],
          otherwise: { id: "none", steps: [] },
        },
        { id: "w", kind: "wait", name: "Wait", for: "1 hour" },
        { id: "end", kind: "stop", name: "End", status: "succeeded" },
        { id: "never", kind: "read", name: "Never", tool: READ_TOOL.id },
      ]),
      { items: [1, 2] },
    );
    expect(result).toEqual({ status: "succeeded", reason: "stop", nodeId: "end" });
    expect(h.row("f")).toMatchObject({ nodeType: "if", output: { pathId: "yes" } });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["each:0:r", "each:1:r"]);
    expect(runner.names("sleep")).toEqual(["w:sleep"]);
  });

  it("runs a process step from its pinned automation", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        automations: {
          "follow-up@1": {
            schemaVersion: 1,
            slug: "follow-up",
            name: "Follow up",
            description: "",
            input: {},
            output: { done: "{{steps.send.output.echo.to}}" },
            steps: [
              {
                id: "send",
                kind: "action",
                name: "Send",
                tool: WRITE_TOOL.id,
                input: { to: "{{input.who}}" },
                approval: { required: "required", onReject: "stop" },
              },
            ],
            requires: { connectors: [], packs: [] },
          } as never,
        },
      }),
      proc([
        {
          id: "use",
          kind: "process",
          name: "Follow up",
          process: "follow-up@1",
          input: { who: "{{trigger.who}}" },
          approvals: { send: { required: "required", approvers: [{ who: "amy" }] } },
        },
      ]),
      { who: "dana" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls[0]).toMatchObject({
      nodeId: "use/send",
      automation: "follow-up@1",
      approval: { required: "required", approver: "amy" },
    });
    expect(h.row("use")).toMatchObject({
      nodeType: "process",
      skillRef: "automation:follow-up@1",
      output: { done: "dana" },
    });
  });
});

describe("router", () => {
  it("routes and starts a v4 process by its triggers", () => {
    const process = proc([], [{ id: "go", on: { type: "manual", input: {} } }]);
    expect(triggersOfWorkflow(process).map((t) => t.id)).toEqual(["go"]);
    const request = requestRun({
      agent: {
        id: "a",
        tenantId: RUN.tenantId,
        kind: "client",
        status: "active",
        runStatus: "active",
        liveVersionId: "v",
        liveBundle: null,
      },
      workflowSlug: "p",
      payload: {},
      mode: "test",
      versionId: "v",
      bundle: {
        workflows: [{ slug: "p", name: "P", enabled: true, workflow: process }],
      } as never,
    });
    expect(request.trigger).toEqual({ triggerId: "go", type: "manual" });
  });
});
