// v0.17 (ARCHITECTURE §10.14 "Automations, repeat and the agent's choice"; docs/plan.md §1.99,
// M59): a repeat runs its steps pass by pass until its rules hold after one, at most `maxTimes`,
// waiting `between` before each pass after the first. Each pass's steps run under their own node
// names, so writes are per pass and a replay finds the passes it already ran.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL } from "./fakes.test-helper";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };
const CATALOG = { tools: { [WRITE_TOOL.id]: WRITE_TOOL, [READ_TOOL.id]: READ_TOOL } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

/** A repeat that reads until the read says `ready`. */
function repeat(over: Record<string, unknown> = {}, inner: unknown[] = []) {
  return {
    id: "rep",
    kind: "repeat",
    name: "Check until ready",
    steps: [
      {
        id: "get",
        kind: "read",
        name: "Check",
        tool: READ_TOOL.id,
        input: { pass: "{{loop.pass}}", before: "{{loop.previous.get.output.n}}" },
      },
      ...inner,
    ],
    until: {
      rules: {
        match: "all",
        rules: [{ field: "{{steps.get.output.ready}}", op: "=", value: true }],
      },
    },
    maxTimes: 3,
    ...over,
  };
}

/** A read that is ready on its `readyOn`th call. */
function countingRead(h: Harness, readyOn: number) {
  let n = 0;
  h.handlers.get = () => {
    n += 1;
    return { kind: "done", output: { n, ready: n >= readyOn } };
  };
}

describe("repeat", () => {
  it("runs pass by pass until its rules hold, with loop.pass and the pass before", async () => {
    const h = new Harness();
    countingRead(h, 2);
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG }),
      proc([
        repeat(),
        {
          id: "after",
          kind: "read",
          name: "After",
          tool: READ_TOOL.id,
          input: { last: "{{steps.rep.output.last.get.n}}", how: "{{steps.rep.outcome}}" },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.map((c) => [c.nodeId, c.input])).toEqual([
      ["rep:r1:get", { pass: 1, before: undefined }],
      ["rep:r2:get", { pass: 2, before: 1 }],
      ["after", { last: 2, how: "done" }],
    ]);
    expect(h.row("rep")).toMatchObject({
      nodeType: "repeat",
      status: "succeeded",
      output: { passes: 2, done: true },
      summary: "Check until ready: done after 2 rounds",
    });
    expect(runner.names()).toContain("rep:r1:until");
    expect(runner.names()).not.toContain("rep:r3:get");
  });

  it("stops the run at its limit by default", async () => {
    const h = new Harness();
    countingRead(h, 99);
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG }),
      proc([repeat({ maxTimes: 2 }), { id: "never", kind: "read", name: "N", tool: READ_TOOL.id }]),
      {},
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "Check until ready: stopped after 2 rounds",
      nodeId: "rep",
      errorKey: "repeat:limit",
    });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["rep:r1:get", "rep:r2:get"]);
    expect(h.row("rep")).toMatchObject({ status: "failed", output: { passes: 2, done: false } });
  });

  it("with onLimit proceed, goes on with outcome limit, which an if routes on", async () => {
    const h = new Harness();
    countingRead(h, 99);
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG }),
      proc([
        repeat({ maxTimes: 2, onLimit: "proceed" }),
        {
          id: "f",
          kind: "if",
          name: "Never ready?",
          paths: [
            {
              id: "limit",
              name: "Gave up",
              when: {
                match: "all",
                rules: [{ field: "{{steps.rep.outcome}}", op: "=", value: "limit" }],
              },
              steps: [{ id: "tell", kind: "read", name: "Tell", tool: READ_TOOL.id }],
            },
          ],
          otherwise: { id: "ok", steps: [] },
        },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("f")).toMatchObject({ output: { pathId: "limit" } });
    expect(h.row("rep")).toMatchObject({
      status: "succeeded",
      summary: "Check until ready: stopped after 2 rounds",
    });
  });

  it("waits between passes, never before the first", async () => {
    const h = new Harness();
    countingRead(h, 3);
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG }),
      proc([repeat({ between: "1 hour" })]),
      {},
    );
    expect(runner.calls.filter((c) => c.kind === "sleep").map((c) => c.name)).toEqual([
      "rep:r2:wait",
      "rep:r3:wait",
    ]);
  });

  it("makes each pass's write its own node, so its key and approval are per pass", async () => {
    const h = new Harness();
    countingRead(h, 2);
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG }),
      proc([
        repeat({}, [
          {
            id: "save",
            kind: "write",
            name: "Save",
            tool: WRITE_TOOL.id,
            input: { name: "{{loop.pass}}" },
          },
        ]),
      ]),
      {},
    );
    const writes = h.agentCalls.filter((c) => c.step.id === "save");
    expect(writes.map((c) => c.nodeId)).toEqual(["rep:r1:save", "rep:r2:save"]);
  });

  it("replays without running a pass again", async () => {
    const h = new Harness();
    countingRead(h, 2);
    const runner = new FakeStepRunner();
    const ctx = h.context({ catalog: CATALOG });
    const workflow = proc([repeat()]);
    await executeWorkflow(runner, ctx, workflow, {});
    runner.replay();
    const again = await executeWorkflow(runner, ctx, workflow, {});
    expect(again.status).toBe("succeeded");
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["rep:r1:get", "rep:r2:get"]);
  });
});
