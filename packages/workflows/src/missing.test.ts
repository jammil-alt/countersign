// v0.18 (docs/plan.md §1.103): a missing step never runs. Validation keeps it from being published;
// if a version held one anyway, the run fails before any step, so nothing runs part-way.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FakeStepRunner } from "./fake-runner";
import { executeProcess, Harness, WRITE_TOOL } from "./fakes.test-helper";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };
const CATALOG = { tools: { [WRITE_TOOL.id]: WRITE_TOOL, [READ_TOOL.id]: READ_TOOL } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const missing = {
  id: "m1",
  kind: "missing",
  name: "Read card charges",
  need: "There is no card feed connector.",
};

describe("a missing step", () => {
  it("fails the run before any step runs, wherever it is", async () => {
    const h = new Harness();
    h.handlers.get = () => ({ kind: "done", output: {} });
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG }),
      proc([
        { id: "get", kind: "read", name: "Read first", tool: READ_TOOL.id },
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.items}}",
          steps: [missing],
        },
      ]),
      { items: [1] },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: 'the step "Read card charges" is missing and can\'t run',
      nodeId: "m1",
    });
    expect(result.status === "failed" && result.errorKey?.startsWith("missing:")).toBe(true);
    expect(h.agentCalls).toEqual([]);
  });
});
