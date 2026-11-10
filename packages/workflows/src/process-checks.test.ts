// R3 (docs/plan.md §1.86, §9): the executor's checks after wave 2's review. One approval engine
// for a write's gate approval and a sign-off; an `all` approval that can't ask everyone fails
// closed; a native skill's proposed writes signed in the v4 check's mode, after its confer; away
// approvers skipped only for native v4 checks; customizations checked and never dropped
// silently; a sign-off nobody answered is a timeout; the lead's help only for native skills.
import { processes, type SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
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
