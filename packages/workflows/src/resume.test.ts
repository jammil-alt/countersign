// v0.12 W1-E: a retry from the failed step (ARCHITECTURE §10.10; docs/plan.md §1.40).

import { describe, expect, it } from "vitest";
import { executeWorkflow, resumePoint } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL, wf } from "./fakes.test-helper";

const steps = [
  { id: "read", kind: "skill", name: "Read", skill: "x.read", input: {} },
  {
    id: "route",
    kind: "fork",
    name: "Route",
    paths: [
      {
        id: "big",
        name: "Big",
        when: { rules: [{ field: "{{steps.read.output.total}}", op: ">", value: 100 }] },
        steps: [{ id: "check", kind: "skill", name: "Check", skill: "x.check", input: {} }],
      },
    ],
    otherwise: { id: "small", steps: [] },
  },
  {
    id: "send",
    kind: "action",
    name: "Send the email",
    tool: WRITE_TOOL.id,
    input: { total: "{{steps.read.output.total}}" },
  },
  { id: "after", kind: "skill", name: "After", skill: "x.after", input: {} },
];

describe("retry from the failed step", () => {
  it("reuses the steps before it, records them as reused, and runs on from it", async () => {
    const h = new Harness();
    h.handlers.send = (req) => ({ kind: "done", output: { sent: req.input } });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({
        resume: {
          from: "send",
          of: "R-0a0b0c",
          reused: {
            read: { status: "succeeded", output: { total: 250 } },
            route: { status: "succeeded", output: { pathId: "big", pathName: "Big" } },
          },
        },
      }),
      wf(steps),
      {},
    );
    expect(result).toEqual({ status: "succeeded" });
    // Only the failed step and what follows it ran; the earlier outputs fed its input.
    expect(h.agentCalls.map((c) => [c.nodeId, c.input])).toEqual([
      ["send", { total: 250 }],
      ["after", {}],
    ]);
    expect(h.row("read")).toMatchObject({
      status: "succeeded",
      output: { total: 250 },
      summary: "reused from R-0a0b0c",
    });
    expect(h.row("route")).toMatchObject({ status: "succeeded", summary: "reused from R-0a0b0c" });
    expect(h.row("check")).toBeUndefined();
    expect(runner.names()).toEqual(["read:reused", "route:reused", "send", "after"]);
  });

  it("runs a step again when the run retried has no row to reuse for it", async () => {
    const h = new Harness();
    h.handlers.read = () => ({ kind: "done", output: { total: 5 } });
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({ resume: { from: "send", of: "R-0a0b0c", reused: {} } }),
      wf(steps),
      {},
    );
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["read", "send", "after"]);
  });

  it("names the failed action's tool in the error key", async () => {
    const h = new Harness();
    h.handlers.send = () => ({ kind: "failed", error: "HTTP 401: invalid_grant" });
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), wf(steps), {});
    expect(result).toMatchObject({
      status: "failed",
      nodeId: "send",
      errorKey: `${WRITE_TOOL.id}:unauthorized`,
    });
  });

  it("resumes a failure inside a fork path or a loop at that fork or loop", () => {
    const w = wf([
      ...steps,
      {
        id: "each",
        kind: "for_each",
        name: "Each",
        over: "{{trigger.items}}",
        concurrency: 1,
        steps: [{ id: "line", kind: "skill", name: "Line", skill: "x.line", input: {} }],
      },
    ]);
    expect(resumePoint(w, "send")).toBe("send");
    expect(resumePoint(w, "check")).toBe("route");
    expect(resumePoint(w, "each:3:line")).toBe("each");
    expect(resumePoint(w, "send:failed")).toBe("send");
    expect(resumePoint(w, null)).toBeNull();
    expect(resumePoint(w, "nowhere")).toBeNull();
  });
});
