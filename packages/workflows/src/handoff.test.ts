// Hand off (owner, 2026-11-11; docs/plan.md §1.96): a hand-off step starts another agent's run at
// one of its steps; a run so started skips its earlier steps and takes the input handed over.
import type { AnyAgentBundle, processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN } from "./fakes.test-helper";
import type { HandoffPort, HandoffRequest } from "./ports";
import { type HandoffAsk, handoffRunRequest, type RoutableAgent } from "./router";

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
  } as unknown as AnyAgentBundle;
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
