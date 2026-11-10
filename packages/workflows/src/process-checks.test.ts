// R3 (docs/plan.md §1.86, §9): the executor's checks after wave 2's review. One approval engine
// for a write's gate approval and a sign-off; an `all` approval that can't ask everyone fails
// closed; a native skill's proposed writes signed in the v4 check's mode, after its confer; away
// approvers skipped only for native v4 checks; customizations checked and never dropped
// silently; a sign-off nobody answered is a timeout; the lead's help only for native skills.
import { processes, type SkillDefinition } from "@countersign/core";
import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
import type { AskApproverRequest, HoursPort, OversightRequest } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const write = (over: Record<string, unknown> = {}) => ({
  id: "write",
  kind: "write",
  name: "Update the record",
  tool: WRITE_TOOL.id,
  input: { name: "{{trigger.what}}" },
  ...over,
});

const TWO = [
  { who: "amy", deadline: { after: "1 day" } },
  { who: "ben", deadline: { after: "1 day" } },
];

/** An hours port that reports `who` as away today. */
function awayToday(...who: string[]): HoursPort {
  const today = new Date().toISOString().slice(0, 10);
  return {
    hoursFor: async (req) => ({
      client: processes.defaultBusinessHours("UTC"),
      person: { away: who.includes(req.who) ? [{ from: today, to: today }] : [] },
    }),
  };
}

describe("an `all` approval", () => {
  it("fails closed when the port can't ask more than the gate's one approver", async () => {
    const h = new Harness();
    // Amy has already approved the gate's item: one signature must not stand for two.
    const first = h.approvalItem({ approved: true, by: "amy" });
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: first } });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([write({ checks: { approval: { mode: "all", approvers: TWO } } })]),
      { what: "x" },
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "write" });
    expect(result.reason).toMatch(/all 2 approvers/);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.items.get(first)?.expired).toBe(true);
  });

  it("asks one approver alone when only one is present", async () => {
    const h = new Harness();
    const first = h.approvalItem({ approved: true, by: "ben" });
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: first } });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ hours: awayToday("amy") }),
      proc([write({ checks: { approval: { mode: "all", approvers: TWO } } })]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "ben" });
  });
});

describe("a native skill that proposes a write", () => {
  const writer: SkillDefinition = {
    ...SKILL,
    id: "test.post-bill",
    tools: [WRITE_TOOL.id],
  } as SkillDefinition;

  it("confers first, signs the write in the check's mode, and asks for no second sign-off", async () => {
    const h = new Harness();
    const asked: AskApproverRequest[] = [];
    const order: string[] = [];
    h.agent.askApprover = async (req) => {
      asked.push(req);
      order.push(`ask ${req.who}`);
      return { inboxItemId: h.approvalItem({ approved: true, by: req.who }) };
    };
    const first = h.approvalItem({ approved: true, by: "amy" });
    h.handlers.post = (req) => {
      order.push("propose");
      // The gate asks the first approver, on their own clock deadline.
      expect(req.approval).toMatchObject({ approver: "amy", timeout: "1 day" });
      return {
        kind: "approval",
        pending: { inboxItemId: first },
        output: { proposed: { total: "12.00" } },
      };
    };
    h.resumeHandler = (req) => {
      order.push("write");
      return { kind: "done", output: { posted: req.resolution.approved === true } };
    };
    const reviewed: unknown[] = [];
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "block" }),
      h.context({
        catalog: { skills: { [writer.id]: writer }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } },
        confer: {
          ai: async (req) => {
            order.push("confer");
            reviewed.push(req.output);
            return { verdict: "agree", note: "" };
          },
        },
      }),
      proc([
        {
          id: "post",
          kind: "skill",
          name: "Post the bill",
          skill: writer.id,
          checks: {
            confer: { with: [{ ai: { focus: "does it add up" } }] },
            approval: {
              mode: "all",
              approvers: TWO,
              ifNoAnswer: { escalate: { to: "boss", deadline: { after: "1 hour" } } },
            },
          },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["propose", "confer", "ask ben", "write"]);
    expect(reviewed).toEqual([{ proposed: { total: "12.00" } }]);
    expect(asked.map((a) => [a.who, a.nodeId])).toEqual([["ben", "post:approval:1:a1"]]);
    expect(h.resumeCalls[0]?.resolution.approved).toBe(true);
    // No sign-off item: the write was signed through the gate.
    expect([...h.items.values()].some((v) => v.item?.nodeId.includes("signoff"))).toBe(false);
  });

  it("asks for a sign-off of its output when it proposed no write", async () => {
    const h = new Harness();
    h.handlers.post = () => ({ kind: "done", output: { nothing: true } });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { approved: true, by: "amy" });
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: { skills: { [writer.id]: writer } } }),
      proc([
        {
          id: "post",
          kind: "skill",
          name: "Post the bill",
          skill: writer.id,
          checks: { approval: { approvers: [{ who: "amy" }] } },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect([...h.items.values()].some((v) => v.item?.nodeId === "post:signoff:a0")).toBe(true);
  });
});

describe("away approvers", () => {
  it("are never skipped on a converted v3 step: the run waits for the stored approver", async () => {
    const h = new Harness();
    const item = h.approvalItem({ approved: true, by: "dana" });
    h.handlers.a = (req) => {
      expect(req.approval.approver).toBe("dana");
      return { kind: "approval", pending: { inboxItemId: item } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ hours: awayToday("dana") }),
      wf([
        {
          id: "a",
          kind: "action",
          name: "Update",
          tool: WRITE_TOOL.id,
          input: {},
          approval: { required: "required", approver: "dana", onReject: "stop" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.get(item)?.expired).toBe(false);
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "dana" });
    expect(runner.names()).not.toContain("a:approvers");
  });

  it("are skipped on a native v4 check: everyone away takes ifNoAnswer at once", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "block" }),
      h.context({ hours: awayToday("amy", "ben") }),
      proc([write({ checks: { approval: { approvers: TWO, ifNoAnswer: "skip" } } })]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.get(item)?.expired).toBe(true);
    expect(h.row("write")?.status).toBe("skipped");
  });
});

describe("customizations", () => {
  const def: SkillDefinition = {
    ...SKILL,
    mode: "task",
    model: { id: "m" },
    instructions: "Draft a note.",
    output: { type: "object", properties: { text: {} } },
  } as unknown as SkillDefinition;
  const step = (customize: unknown) => ({
    id: "s",
    kind: "skill",
    name: "Draft",
    skill: def.id,
    customize,
  });

  it("fail the step when the port doesn't apply added instructions or rule rows", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: { skills: { [def.id]: def } } }),
      proc([step({ addInstructions: "Be short." })]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "s" });
    expect(result.reason).toMatch(/doesn't apply them/);
    expect(h.agentCalls).toHaveLength(0);
  });

  it("fail the step when the skill isn't in the catalog to check them against", async () => {
    const h = new Harness();
    h.agent.appliesCustomization = true;
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([step({ keep: ["text"] })]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "s" });
    expect(h.agentCalls).toHaveLength(0);
  });
});

describe("a sign-off nobody answers", () => {
  it("ends the run as a timeout, its row failed, never as a rejection", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { total: 1 } });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context(),
      proc([
        {
          id: "get",
          kind: "read",
          name: "Get the bill",
          tool: "testkit.thing.get",
          checks: { approval: { approvers: [{ who: "amy", deadline: { after: "1 hour" } }] } },
        },
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout", nodeId: "get" });
    expect(h.row("get")).toMatchObject({
      status: "failed",
      summary: "Get the bill: no answer in time",
    });
  });
});

describe("needs help", () => {
  const helpOutput = {
    kind: "done" as const,
    output: {
      needsHelp: {
        question: "Where is the list?",
        tried: [],
        remember: "[browse-help skill=web.browse sites=acme]",
      },
    },
  };

  it("is only a native skill's: a converted v3 skill's output is its output", async () => {
    const h = new Harness();
    h.handlers.s = () => helpOutput;
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([{ id: "s", kind: "skill", name: "S", skill: "web.browse", input: {} }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.size).toBe(0);
    expect(h.agentCalls).toHaveLength(1);
  });

  it("has the port keep the answer under the skill's tag, and says on the row when it couldn't", async () => {
    const h = new Harness();
    let runs = 0;
    h.handlers.find = () => (++runs === 1 ? helpOutput : { kind: "done", output: { ok: true } });
    const kept: unknown[] = [];
    h.agent.keepHelp = async (req) => {
      kept.push(req);
      throw new Error("memory is full");
    };
    const written: unknown[] = [];
    const original = h.agent.runAction;
    h.agent.runAction = async (req) => {
      if (req.step.tool === "memory.write") written.push(req.input);
      return original(req);
    };
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { answer: "Under Reports" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([{ id: "find", kind: "skill", name: "Find", skill: "web.browse", input: {} }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(kept).toEqual([
      expect.objectContaining({
        nodeId: "find:help:memory",
        remember: "[browse-help skill=web.browse sites=acme]",
        question: "Where is the list?",
        answer: "Under Reports",
      }),
    ]);
    // Never in the agent's own memory, which its model can write.
    expect(written).toEqual([]);
    expect(h.row("find")?.error).toMatch(/wasn't kept: memory is full/);
    expect(h.row("find")?.status).toBe("succeeded");
  });

  it("without the port's keep, the answer is an ordinary note with no tag", async () => {
    const h = new Harness();
    let runs = 0;
    h.handlers.find = () => (++runs === 1 ? helpOutput : { kind: "done", output: { ok: true } });
    const notes: unknown[] = [];
    const original = h.agent.runAction;
    h.agent.runAction = async (req) => {
      if (req.step.tool !== "memory.write") return original(req);
      notes.push(req.input);
      return { kind: "done", output: { memoryNoteId: "m-1" } };
    };
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { answer: "Under Reports" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([{ id: "find", kind: "skill", name: "Find", skill: "web.browse", input: {} }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(notes).toEqual([
      { note: 'Asked "Where is the list?", the lead answered: Under Reports' },
    ]);
  });

  // Wave 4 (docs/plan.md §1.86 "Scripts (wave 4)"): a recorded script whose page changed.
  const scriptHelp = {
    kind: "done" as const,
    output: {
      needsHelp: { question: "The script couldn't find #stock on /orders/lookup", tried: [] },
    },
  };

  it("is a native read step's too: the lead is asked and the step runs again with the answer", async () => {
    const h = new Harness();
    let runs = 0;
    h.handlers.stock = () => (++runs === 1 ? scriptHelp : { kind: "done", output: { stock: 42 } });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { answer: "Re-recorded it" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "stock",
          kind: "read",
          name: "Check stock",
          tool: "browser.script.read",
          input: { site: "supplier", script: "stock", inputs: { sku: "OAK-1" } },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls).toHaveLength(3);
    expect(h.agentCalls[1]).toMatchObject({ step: { tool: "memory.write" } });
    expect(h.agentCalls[2]?.input).toMatchObject({ script: "stock", help: "Re-recorded it" });
    expect([...h.items.values()][0]?.item?.title).toMatch(/couldn.t find #stock/);
  });

  it("is never a converted v3 action's", async () => {
    const h = new Harness();
    h.handlers.stock = () => scriptHelp;
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "stock",
          kind: "action",
          name: "Check stock",
          tool: "browser.script.read",
          input: {},
          approval: { required: "not_required" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.size).toBe(0);
  });
});

describe("the owner (R6)", () => {
  const settings = { review: "failures", maxPerRun: 5, maxCostUsd: "1" } as never;

  it("reviews a native v4 step as itself, with the watch's signals and the confer's verdicts", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [] } });
    const reviews: OversightRequest[] = [];
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        confer: { ai: async () => ({ verdict: "disagree", note: "nothing came back" }) },
        oversight: {
          port: {
            review: async (req) => {
              reviews.push(req);
              return { action: "continue", note: "fine" };
            },
          },
          settings,
          watch: {},
        },
      }),
      proc([
        {
          id: "get",
          kind: "read",
          name: "Get the lines",
          tool: "testkit.thing.get",
          checks: { confer: { with: [{ ai: { focus: "anything there" } }] } },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      cause: "checkpoint",
      step: { id: "get", kind: "read", tool: "testkit.thing.get" },
      errorKey: "",
    });
    expect(reviews[0]?.signals?.map((s) => s.kind)).toEqual(["empty_output", "confer_disagreed"]);
    // The confer ran once, before the review.
    expect(h.row("get:confer:0")?.status).toBe("succeeded");
  });

  it("without the watch, a v4 step that succeeded is reviewed exactly as v0.13 decides", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: { lines: [] } });
    const reviews: OversightRequest[] = [];
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        oversight: {
          port: {
            review: async (req) => {
              reviews.push(req);
              return { action: "continue", note: "" };
            },
          },
          settings,
        },
      }),
      proc([{ id: "get", kind: "read", name: "Get", tool: "testkit.thing.get" }]),
      {},
    );
    expect(reviews).toHaveLength(0);
  });

  it("names a failed native step's error by its own kind and tool", async () => {
    const h = new Harness();
    h.handlers.write = () => ({ kind: "failed", error: "rate_limited" });
    const reviews: OversightRequest[] = [];
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        oversight: {
          port: {
            review: async (req) => {
              reviews.push(req);
              return { action: "none", reason: "" };
            },
          },
          settings,
        },
      }),
      proc([write()]),
      { what: "x" },
    );
    expect(reviews[0]).toMatchObject({ cause: "failed", step: { kind: "write" } });
    expect(reviews[0]?.errorKey).toMatch(/^testkit\.thing\.update:/);
  });
});

// ── Wave 2c: the executor's review findings ─────────────────────────────────────────────────────

describe("an automation's approval override (wave 2c)", () => {
  const SEND = {
    schemaVersion: 1,
    slug: "s",
    name: "S",
    description: "",
    input: {},
    output: {},
    steps: [
      {
        id: "send",
        kind: "action",
        name: "Send",
        tool: WRITE_TOOL.id,
        input: {},
        approval: { required: "required", onReject: "stop" },
      },
    ],
    requires: { connectors: [], packs: [] },
  } as never;

  it("on a stored v3 use_automation is decided as v3 did: an away approver is waited for", async () => {
    const h = new Harness();
    const item = h.approvalItem({ approved: true, by: "dana" });
    h.handlers.send = (req) => {
      expect(req.approval).toMatchObject({ required: "required", approver: "dana" });
      return { kind: "approval", pending: { inboxItemId: item } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ hours: awayToday("dana"), automations: { "s@1": SEND } }),
      wf([
        {
          id: "u",
          kind: "use_automation",
          name: "Use",
          automation: "s@1",
          input: {},
          approvals: { send: { required: "required", approver: "dana", onReject: "stop" } },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.get(item)?.expired).toBe(false);
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "dana" });
    expect(runner.names()).not.toContain("u/send:approvers");
  });

  it("set by a native v4 process step is a v4 check: an away approver is skipped", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.send = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const result = await executeWorkflow(
      new FakeStepRunner({ onWait: "block" }),
      h.context({ hours: awayToday("dana"), automations: { "s@1": SEND } }),
      proc([
        {
          id: "u",
          kind: "process",
          name: "Use",
          process: "s@1",
          input: {},
          approvals: { send: { approvers: [{ who: "dana" }], ifNoAnswer: "skip" } },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.get(item)?.expired).toBe(true);
  });
});

describe("an approval's `when` on a writing skill (wave 2c)", () => {
  const writer = { ...SKILL, id: "test.post-bill", tools: [WRITE_TOOL.id] } as SkillDefinition;
  const catalog = { skills: { [writer.id]: writer }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } };
  const post = (when: unknown, confer = true) => ({
    id: "post",
    kind: "skill",
    name: "Post the bill",
    skill: writer.id,
    input: {},
    checks: {
      ...(confer ? { confer: { with: [{ ai: { focus: "f" } }] } } : {}),
      approval: { approvers: [{ who: "amy" }], when },
    },
  });
  const onVerdict = {
    match: "all",
    rules: [{ field: "{{confer.0.verdict}}", op: "=", value: "disagree" }],
  };

  async function gateFor(when: unknown, trigger: unknown, confer = true) {
    const h = new Harness();
    const item = h.approvalItem({ approved: true, by: "amy" });
    const gates: unknown[] = [];
    h.handlers.post = (req) => {
      gates.push(req.approval);
      return { kind: "approval", pending: { inboxItemId: item }, output: { total: "1" } };
    };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog,
        confer: { ai: async () => ({ verdict: "disagree", note: "wrong total" }) },
      }),
      proc([post(when, confer)]),
      trigger,
    );
    return { result, gates, h };
  }

  it("never reads its verdicts before the confer: the gate keeps the approval required", async () => {
    const { result, gates, h } = await gateFor(onVerdict, {});
    expect(result.status).toBe("succeeded");
    expect(gates).toEqual([expect.objectContaining({ required: "required", approver: "amy" })]);
    // The confer ran on the proposal, and the write was signed.
    expect(h.row("post:confer:0")?.output).toMatchObject({ verdict: "disagree" });
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "amy" });
  });

  it("treats a reference that doesn't resolve as approval required", async () => {
    const over = { match: "all", rules: [{ field: "{{trigger.amount}}", op: ">", value: 100 }] };
    const flagged = {
      match: "all",
      rules: [{ field: "{{steps.check.output.flagged}}", op: "is", value: true }],
    };
    // `null > 100` would say the approval is off: a missing amount never loosens it, nor a step
    // that never ran.
    expect((await gateFor(over, {}, false)).gates).toEqual([
      expect.objectContaining({ required: "required" }),
    ]);
    expect((await gateFor(flagged, {}, false)).gates).toEqual([
      expect.objectContaining({ required: "required" }),
    ]);
    // A value that is there but null or empty doesn't decide either (`null < 100` is true).
    const under = { match: "all", rules: [{ field: "{{trigger.amount}}", op: "<", value: 100 }] };
    const unless = { match: "all", rules: [{ field: "{{trigger.amount}}", op: ">", value: 100 }] };
    for (const amount of [null, ""]) {
      expect((await gateFor(under, { amount }, false)).gates).toEqual([
        expect.objectContaining({ required: "required" }),
      ]);
      expect((await gateFor(unless, { amount }, false)).gates).toEqual([
        expect.objectContaining({ required: "required" }),
      ]);
    }
    // Resolved, it still decides.
    expect((await gateFor(over, { amount: 50 }, false)).gates).toEqual([
      expect.objectContaining({ required: "not_required" }),
    ]);
    expect((await gateFor(over, { amount: 500 }, false)).gates).toEqual([
      expect.objectContaining({ required: "required" }),
    ]);
  });
});

describe("a native skill's confer (wave 2c)", () => {
  const writer = { ...SKILL, id: "test.post-bill", tools: [WRITE_TOOL.id] } as SkillDefinition;
  const catalog = { skills: { [writer.id]: writer }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } };
  const post = {
    id: "post",
    kind: "skill",
    name: "Post the bill",
    skill: writer.id,
    input: { bill: "b-1" },
    checks: {
      confer: { with: [{ ai: { focus: "does it add up" } }] },
      approval: { approvers: [{ who: "amy" }] },
    },
  };

  it("runs on each write the skill proposes, before that write's approval", async () => {
    const h = new Harness();
    const order: string[] = [];
    h.handlers.post = () => {
      order.push("propose 1");
      return {
        kind: "approval",
        pending: { inboxItemId: h.approvalItem({ approved: true, by: "amy" }) },
        output: { line: 1 },
      };
    };
    let resumes = 0;
    h.resumeHandler = () => {
      order.push(`write ${++resumes}`);
      if (resumes === 1) {
        order.push("propose 2");
        return {
          kind: "approval",
          pending: { inboxItemId: h.approvalItem({ approved: true, by: "amy" }) },
          output: { line: 2 },
        };
      }
      return { kind: "done", output: { posted: true } };
    };
    const reviewed: unknown[] = [];
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog,
        confer: {
          ai: async (req) => {
            order.push("confer");
            reviewed.push(req.output);
            return { verdict: "agree", note: "" };
          },
        },
      }),
      proc([post]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["propose 1", "confer", "write 1", "propose 2", "confer", "write 2"]);
    expect(reviewed).toEqual([{ line: 1 }, { line: 2 }]);
    expect(h.row("post:confer:0")).toBeDefined();
    expect(h.row("post:approval:2:confer:0")).toBeDefined();
  });

  it("runs again on the write a corrected retry proposes, with the corrected input", async () => {
    const h = new Harness();
    let runs = 0;
    h.handlers.post = () =>
      ++runs === 1
        ? { kind: "failed", error: "bad vendor" }
        : {
            kind: "approval",
            pending: { inboxItemId: h.approvalItem({ approved: true, by: "amy" }) },
            output: { line: 1 },
          };
    const inputs: unknown[] = [];
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog,
        confer: {
          ai: async (req) => {
            inputs.push(req.input);
            return { verdict: "agree", note: "" };
          },
        },
        oversight: {
          port: {
            review: async () => ({ action: "retry_with", input: { bill: "b-2" }, note: "" }),
          },
          settings: { review: "failures", maxPerRun: 5, maxCostUsd: "1" } as never,
        },
      }),
      proc([post]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(inputs).toEqual([{ bill: "b-2" }]);
    expect(h.row("post:retry:1:approval:1:confer:0")).toBeDefined();
  });
});

describe("the owner's ask on a native step (wave 2c)", () => {
  const settings = { review: "failures", maxPerRun: 5, maxCostUsd: "1" } as never;
  const read = (approvers: unknown) => ({
    id: "get",
    kind: "read",
    name: "Get the bill",
    tool: "testkit.thing.get",
    checks: { approval: { approvers } },
  });

  async function ask(approvers: unknown, hours?: HoursPort) {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "failed", error: "not found" });
    const item = h.approvalItem();
    const reviews: OversightRequest[] = [];
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({
        ...(hours ? { hours } : {}),
        oversight: {
          port: {
            review: async (req) => {
              reviews.push(req);
              return { action: "ask", inboxItemId: item, note: "" };
            },
          },
          settings,
        },
      }),
      proc([read(approvers)]),
      {},
    );
    const wait = runner.calls.find((c) => c.name === "get:oversee:1:ask:wait") as
      | { timeout: string }
      | undefined;
    return { reviews, timeout: wait?.timeout };
  }

  it("waits on the first approver's business-hours deadline, on their hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Friday 5pm UTC: four business hours (8 to 6, Monday to Friday) end Monday at 11am.
      vi.setSystemTime(new Date("2026-11-06T17:00:00Z"));
      const { timeout } = await ask([
        { who: "amy", deadline: { after: "4 hours", hours: "business" } },
      ]);
      expect(timeout).toBe(`${66 * 3600} seconds`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the first approver present, on their deadline", async () => {
    const { reviews, timeout } = await ask(
      [
        { who: "amy", deadline: { after: "1 hour" } },
        { who: "ben", deadline: { after: "3 hours" } },
      ],
      awayToday("amy"),
    );
    const step = reviews[0]?.step as { checks?: { approval?: { approvers?: unknown[] } } };
    expect(step.checks?.approval?.approvers).toEqual([
      expect.objectContaining({
        who: "ben",
        deadline: expect.objectContaining({ after: "3 hours" }),
      }),
    ]);
    expect(timeout).toBe("3 hours");
  });
});
