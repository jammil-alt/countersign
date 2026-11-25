// Hand off (owner, 2026-11-11; docs/plan.md §1.96): a hand-off step starts another agent's run at
// one of its steps; a run so started skips its earlier steps and takes the input handed over.
import type { AgentBundle, processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN } from "./fakes.test-helper";
import type { HandoffPort, HandoffRequest } from "./ports";
import {
  type HandoffAsk,
  handoffRunRequest,
  type RoutableAgent,
  type SelfHandoffAsk,
  selfHandoffRunRequest,
} from "./router";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const skill = (id: string, input: Record<string, unknown> = {}) => ({
  id,
  kind: "skill",
  name: id,
  skill: "custom:thing",
  input,
});

/** Price checker: pull, itemize, check (reads itemize's output). */
const priceChecker = proc([
  skill("pull"),
  skill("itemize", { documentId: "{{trigger.documentId}}" }),
  skill("check", { lines: "{{steps.itemize.output.echo}}" }),
]);

describe("a run that starts at a step", () => {
  it("skips the steps before it and gives the entry step the input handed over", async () => {
    const h = new Harness();
    const input = { documentId: "doc-1", note: "{{trigger.secret}}" };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ start: { at: "itemize", input } }),
      priceChecker,
      { from: { runId: "r" }, input, at: "itemize", secret: "leak" },
    );
    expect(result.status).toBe("succeeded");
    // Only the entry step and those after it ran; nothing was logged for the step skipped.
    expect(h.agentCalls.map((c) => c.step.id)).toEqual(["itemize", "check"]);
    expect(h.row("pull")).toBeUndefined();
    // The input handed over is data: never rendered as a template.
    expect(h.agentCalls[0]?.input).toEqual(input);
    // Later steps read the entry step's output as usual.
    expect(h.agentCalls[1]?.input).toEqual({ lines: input });
  });

  it("fails rather than run from the top when the version has no such step", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ start: { at: "gone", input: {} } }),
      priceChecker,
      {},
    );
    expect(result.status).toBe("failed");
    expect(h.agentCalls).toEqual([]);
  });
});

describe("the hand-off step", () => {
  const sender = proc([
    skill("read"),
    {
      id: "hand",
      kind: "handoff",
      name: "Hand off",
      to: { agent: "price-checker", step: "itemize" },
      input: { documentId: "{{steps.read.output.echo}}" },
    },
    skill("after"),
  ]);

  function port(answer: Awaited<ReturnType<HandoffPort["start"]>>) {
    const calls: { start: HandoffRequest[]; names: HandoffRequest[] } = { start: [], names: [] };
    const p: HandoffPort = {
      names: async (req) => {
        calls.names.push(req);
        return { name: "Price checker", at: "2 · itemize" };
      },
      start: async (req) => {
        calls.start.push(req);
        return answer;
      },
    };
    return { p, calls };
  }

  it("starts the other run with the mapped input and goes on without waiting", async () => {
    const h = new Harness();
    const { p, calls } = port({
      runId: "0192f7a0-0000-7000-8000-0000000abcde",
      name: "Price checker",
      at: "2 · itemize",
    });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ handoff: p }),
      sender,
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(calls.start).toEqual([
      expect.objectContaining({
        nodeId: "hand",
        to: { agent: "price-checker", step: "itemize" },
        input: { documentId: {} },
      }),
    ]);
    expect(h.row("hand")).toMatchObject({
      nodeType: "handoff",
      status: "succeeded",
      output: {
        runId: "0192f7a0-0000-7000-8000-0000000abcde",
        agent: "price-checker",
        step: "itemize",
      },
      summary: "Handed off to Price checker (run R-0abcde)",
    });
    expect(h.agentCalls.map((c) => c.step.id)).toEqual(["read", "after"]);
  });

  it("in a test run starts nothing and says what it would have handed off", async () => {
    const h = new Harness({ ...RUN, mode: "test" });
    const { p, calls } = port({ refused: "should not be asked" });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ handoff: p }),
      sender,
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(calls.start).toEqual([]);
    expect(h.row("hand")).toMatchObject({
      status: "succeeded",
      input: { documentId: {} },
      summary: "Would hand off to Price checker at 2 · itemize (test run, nothing started)",
    });
  });

  it("fails plainly when the other agent isn't started", async () => {
    const h = new Harness();
    const { p } = port({
      refused: "Price checker isn't started, so the hand-off didn't run",
      notStarted: true,
      name: "Price checker",
    });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ handoff: p }),
      sender,
      {},
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "Price checker isn't started, so the hand-off didn't run",
      nodeId: "hand",
    });
    expect(h.row("hand")?.summary).toBe("Price checker isn't started, so the hand-off didn't run");
    expect(h.agentCalls.map((c) => c.step.id)).toEqual(["read"]);
  });
});

describe("handoffRunRequest", () => {
  const TENANT = RUN.tenantId;
  const bundle = {
    workflows: [{ slug: "main", enabled: true, workflow: priceChecker }],
  } as unknown as AgentBundle;
  const target = (over: Partial<RoutableAgent> = {}): RoutableAgent & { slug: string } => ({
    id: "agent-b",
    slug: "price-checker",
    tenantId: TENANT,
    kind: "client",
    status: "active",
    runStatus: "active",
    liveVersionId: "version-b",
    liveBundle: bundle,
    ...over,
  });
  const ask = (over: Partial<HandoffAsk["from"]> = {}, step = "itemize"): HandoffAsk => ({
    tenantId: TENANT,
    from: {
      runId: "run-a",
      agentId: "agent-a",
      agentSlug: "ap-clerk",
      workflowSlug: "main",
      nodeId: "hand",
      depth: 0,
      ...over,
    },
    to: { agent: "price-checker", step },
    input: { documentId: "d" },
  });

  it("asks for a live run of the target at the step, recorded as a handoff from the sender", async () => {
    const r = await handoffRunRequest(ask(), target());
    if (!("run" in r)) throw new Error(r.refused);
    expect(r.run).toMatchObject({
      tenantId: TENANT,
      agentId: "agent-b",
      agentVersionId: "version-b",
      workflowSlug: "main",
      mode: "live",
      trigger: {
        type: "handoff",
        fromRunId: "run-a",
        depth: 1,
        at: "itemize",
        fromAgentId: "agent-a",
      },
      payload: {
        from: { agentId: "agent-a", agentSlug: "ap-clerk", workflowSlug: "main", runId: "run-a" },
        depth: 1,
        at: "itemize",
        input: { documentId: "d" },
      },
    });
    // Asking twice derives the same run.
    const again = await handoffRunRequest(ask(), target());
    expect("run" in again && again.run.runId).toBe(r.run.runId);
  });

  it("holds the handoff rules: never the same agent, at most three deep, started, same client", async () => {
    expect(await handoffRunRequest(ask({ agentId: "agent-b" }), target())).toEqual({
      refused: "same_agent",
    });
    expect(await handoffRunRequest(ask({ depth: 3 }), target())).toEqual({ refused: "too_deep" });
    expect("run" in (await handoffRunRequest(ask({ depth: 2 }), target()))).toBe(true);
    expect(await handoffRunRequest(ask(), target({ runStatus: "paused" }))).toEqual({
      refused: "not_started",
    });
    expect(await handoffRunRequest(ask(), target({ tenantId: "other" }))).toEqual({
      refused: "unknown_agent",
    });
    expect(await handoffRunRequest(ask({}, "gone"), target())).toEqual({ refused: "unknown_step" });
  });
});

// ── Ways in, ways out (owner, 2026-11-23): a hand-off to this agent's own workflow ──────────────

describe("a hand-off to this agent's own workflow", () => {
  it("asks once per item inside a for each, each with its own node id", async () => {
    const h = new Harness();
    const calls: HandoffRequest[] = [];
    const p: HandoffPort = {
      names: async () => ({ name: "Check an invoice", at: "1 · read" }),
      start: async (req) => {
        calls.push(req);
        return {
          runId: `0192f7a0-0000-7000-8000-00000000000${calls.length}`,
          name: "Check an invoice",
          at: "1 · read",
        };
      },
    };
    const scan = proc([
      {
        id: "each",
        kind: "for_each",
        name: "For each bill",
        over: "{{trigger.bills}}",
        steps: [
          {
            id: "hand",
            kind: "handoff",
            name: "Hand off",
            to: { agent: "@self", step: "read", workflow: "check" },
            input: { documentId: "{{item.id}}" },
          },
        ],
      },
    ]);
    const result = await executeWorkflow(new FakeStepRunner(), h.context({ handoff: p }), scan, {
      bills: [{ id: "b1" }, { id: "b2" }],
    });
    expect(result.status).toBe("succeeded");
    expect(calls.map((c) => [c.nodeId, c.to, c.input])).toEqual([
      ["each:0:hand", { agent: "@self", step: "read", workflow: "check" }, { documentId: "b1" }],
      ["each:1:hand", { agent: "@self", step: "read", workflow: "check" }, { documentId: "b2" }],
    ]);
    expect(h.row("each:1:hand")).toMatchObject({
      status: "succeeded",
      output: { agent: "@self", step: "read", workflow: "check" },
      summary: "Handed off to Check an invoice (run R-000002)",
    });
  });
});

describe("selfHandoffRunRequest", () => {
  const TENANT = RUN.tenantId;
  const bundle = {
    workflows: [
      { slug: "check", name: "Check an invoice", enabled: true, workflow: priceChecker },
      { slug: "scan", name: "Scan bills", enabled: true, workflow: proc([skill("find")]) },
      { slug: "old", name: "Old", enabled: false, workflow: priceChecker },
    ],
  } as unknown as AgentBundle;
  const self = (over: Partial<RoutableAgent> = {}): RoutableAgent & { slug: string } => ({
    id: "agent-a",
    slug: "invoices",
    tenantId: TENANT,
    kind: "client",
    status: "active",
    runStatus: "active",
    liveVersionId: "version-live",
    liveBundle: null,
    ...over,
  });
  const ask = (
    over: Partial<SelfHandoffAsk["from"]> = {},
    to: Partial<SelfHandoffAsk["to"]> = {},
  ): SelfHandoffAsk => ({
    tenantId: TENANT,
    from: {
      runId: "run-a",
      agentId: "agent-a",
      agentSlug: "invoices",
      workflowSlug: "scan",
      nodeId: "each:0:hand",
      depth: 0,
      agentVersionId: "version-old",
      mode: "live",
      ...over,
    },
    to: { agent: "@self", step: "itemize", workflow: "check", ...to },
    input: { documentId: "d" },
  });

  it("asks for a run of the same agent and the sending run's version, in the named workflow", async () => {
    const r = await selfHandoffRunRequest(ask(), self(), bundle);
    if (!("run" in r)) throw new Error(r.refused);
    expect(r.workflowName).toBe("Check an invoice");
    expect(r.run).toMatchObject({
      agentId: "agent-a",
      // Not the live version: the one the sending run is on.
      agentVersionId: "version-old",
      workflowSlug: "check",
      mode: "live",
      trigger: {
        type: "handoff",
        fromRunId: "run-a",
        depth: 1,
        at: "itemize",
        fromAgentId: "agent-a",
        fromStep: "each:0:hand",
      },
      payload: {
        from: { agentId: "agent-a", workflowSlug: "scan", workflowName: "Scan bills" },
        at: "itemize",
        input: { documentId: "d" },
      },
    });
    const again = await selfHandoffRunRequest(ask(), self(), bundle);
    expect("run" in again && again.run.runId).toBe(r.run.runId);
    const other = await selfHandoffRunRequest(ask({ nodeId: "each:1:hand" }), self(), bundle);
    expect("run" in other && other.run.runId).not.toBe(r.run.runId);
  });

  it("holds the rules: three deep, started, another enabled workflow, a top-level step", async () => {
    const refused = async (a: SelfHandoffAsk, s = self()) => {
      const r = await selfHandoffRunRequest(a, s, bundle);
      return "refused" in r ? r.refused : "started";
    };
    expect(await refused(ask({ depth: 3 }))).toBe("too_deep");
    expect(await refused(ask({ depth: 2 }))).toBe("started");
    expect(await refused(ask(), self({ runStatus: "paused" }))).toBe("not_started");
    expect(await refused(ask(), self({ id: "agent-b" }))).toBe("unknown_agent");
    expect(await refused(ask(), self({ tenantId: "other" }))).toBe("unknown_agent");
    expect(await refused(ask({}, { workflow: "scan", step: "find" }))).toBe("same_workflow");
    expect(await refused(ask({}, { workflow: "gone" }))).toBe("unknown_workflow");
    expect(await refused(ask({}, { workflow: "old" }))).toBe("workflow_off");
    expect(await refused(ask({}, { step: "gone" }))).toBe("unknown_step");
  });
});
