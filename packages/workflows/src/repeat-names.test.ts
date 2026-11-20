// PLATFORM_QA CONS-2: the validator and the executor read one process two ways. A repeat's own
// durable names (`${name}:r${pass}:until`, `:wait`) sit beside its steps' (`${name}:r${pass}:<id>`),
// and the validator accepts `until` and `wait` as step ids.
import { processes } from "@countersign/core";
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

/** A repeat that reads until the read says `ready`, its one inner step named `innerId`. */
function repeat(innerId: string, between?: string) {
  return {
    id: "rep",
    kind: "repeat",
    name: "Check until ready",
    steps: [{ id: innerId, kind: "read", name: "Check", tool: READ_TOOL.id, input: {} }],
    until: {
      rules: {
        match: "all",
        rules: [{ field: `{{steps.${innerId}.output.ready}}`, op: "=", value: true }],
      },
    },
    maxTimes: 3,
    ...(between ? { between } : {}),
  };
}

describe("a repeat's durable names", () => {
  it("(PLATFORM_QA CONS-2) a repeat whose inner step is named `until` stops when its rule holds", async () => {
    const steps = [repeat("until")];
    // The validator accepts the id.
    const v = processes.validateProcess(proc(steps), { tools: CATALOG.tools });
    expect(v.errors).toEqual([]);

    const h = new Harness();
    let n = 0;
    h.handlers.until = () => {
      n += 1;
      return { kind: "done", output: { n, ready: true } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context({ catalog: CATALOG }), proc(steps), {});
    // Ready on the first pass: one pass, done.
    expect({ status: result.status, passes: n }).toEqual({ status: "succeeded", passes: 1 });
    expect(runner.names()).toContain("rep:r1:~until");
  });

  it("(PLATFORM_QA CONS-2) a repeat whose inner step is named `wait` runs each pass's step", async () => {
    const steps = [repeat("wait", "1 hour")];
    const h = new Harness();
    let n = 0;
    h.handlers.wait = () => {
      n += 1;
      return { kind: "done", output: { n, ready: n === 2 } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context({ catalog: CATALOG }), proc(steps), {});
    expect({ status: result.status, passes: n }).toEqual({ status: "succeeded", passes: 2 });
    expect(runner.names()).toEqual(expect.arrayContaining(["rep:r2:wait", "rep:r2:~wait"]));
  });

  it("(PLATFORM_QA CONS-2) a repeat with other step ids keeps the names it always had", async () => {
    const h = new Harness();
    h.handlers.check = () => ({ kind: "done", output: { ready: true } });
    const runner = new FakeStepRunner();
    await executeWorkflow(runner, h.context({ catalog: CATALOG }), proc([repeat("check")]), {});
    expect(runner.names()).toContain("rep:r1:until");
  });
});
