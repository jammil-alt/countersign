// CONS lens (consistency): the validator and the executor read one process two ways.
import { processes } from "@countersign/core";
import { executeWorkflow } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { Harness, WRITE_TOOL } from "../../../../packages/workflows/src/fakes.test-helper";
import { FakeWorkflowStep } from "../api.test-helper";
import { cloudflareStepRunner } from "../runs/step-runner";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };
const CATALOG = { tools: { [WRITE_TOOL.id]: WRITE_TOOL, [READ_TOOL.id]: READ_TOOL } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

/** A repeat that reads until the read says `ready`, its one inner step named `innerId`. */
function repeat(innerId: string) {
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
  };
}

describe("CONS: validator vs executor on durable names", () => {
  it("CONS-2: a repeat whose inner step is named `until` stops when its rule holds", async () => {
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
    // The real Cloudflare adapter over the engine's replay contract (a name returns its stored result).
    const result = await executeWorkflow(
      cloudflareStepRunner(new FakeWorkflowStep()),
      h.context({ catalog: CATALOG }),
      proc(steps),
      {},
    );
    // Ready on the first pass: one pass, done.
    expect({ status: result.status, passes: n }).toEqual({ status: "succeeded", passes: 1 });
  });

  it("CONS-2 (control): the same repeat with its inner step named `check` stops after one pass", async () => {
    const h = new Harness();
    let n = 0;
    h.handlers.check = () => {
      n += 1;
      return { kind: "done", output: { n, ready: true } };
    };
    const result = await executeWorkflow(
      cloudflareStepRunner(new FakeWorkflowStep()),
      h.context({ catalog: CATALOG }),
      proc([repeat("check")]),
      {},
    );
    expect({ status: result.status, passes: n }).toEqual({ status: "succeeded", passes: 1 });
  });
});
