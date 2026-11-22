// A test of some of a process's top-level steps (docs/plan.md §1.185): the ones before the first
// picked step are not run (what was given for one stands as its output), the run goes through the
// picked steps, and it ends after the last, succeeded.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow, type RunRange } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness } from "./fakes.test-helper";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const skill = (id: string, input: Record<string, unknown> = {}) => ({
  id,
  kind: "skill",
  name: id.toUpperCase(),
  skill: "web.browse",
  input: { site: id, ...input },
});
const STEPS = [
  skill("a"),
  skill("b", { from: "{{steps.a.output.value}}" }),
  skill("c", { from: "{{steps.b.output.value}}" }),
  skill("d"),
];
const proc = () =>
  ({ schemaVersion: 4, triggers: [MANUAL], steps: STEPS }) as unknown as processes.Process;

async function run(range: RunRange | undefined) {
  const h = new Harness();
  for (const id of ["a", "b", "c", "d"]) {
    h.handlers[id] = (req) => ({
      kind: "done",
      output: { value: `${id}:${JSON.stringify(req.input)}` },
    });
  }
  const result = await executeWorkflow(
    new FakeStepRunner(),
    h.context(range ? { range } : {}),
    proc(),
    {},
  );
  const ran = h.agentCalls.map((c) => c.step.id);
  return { h, result, ran };
}

describe("a test of some of the steps", () => {
  it("runs every step when no range is given", async () => {
    const { result, ran } = await run(undefined);
    expect(result).toEqual({ status: "succeeded" });
    expect(ran).toEqual(["a", "b", "c", "d"]);
  });

  it("stops after the last picked step, succeeded", async () => {
    const { h, result, ran } = await run({ to: "b" });
    expect(result).toMatchObject({ status: "succeeded", reason: "range", nodeId: "b" });
    expect(ran).toEqual(["a", "b"]);
    expect(h.row("c")).toBeUndefined();
  });

  it("starts at the first picked step, reading what was given for the one before", async () => {
    const { h, result, ran } = await run({
      from: "b",
      to: "c",
      given: { a: { value: "typed by the tester" } },
    });
    expect(result).toMatchObject({ status: "succeeded", nodeId: "c" });
    // a is not run: its row holds what was given, and says so.
    expect(ran).toEqual(["b", "c"]);
    expect(h.row("a")).toMatchObject({ status: "succeeded" });
    expect(h.row("a")?.updates.at(-1)).toMatchObject({
      output: { value: "typed by the tester" },
      summary: "given for this test, not run",
    });
    // b read it, and c read what b made in this run.
    const b = h.agentCalls.find((c) => c.step.id === "b");
    expect(b?.input).toMatchObject({ from: "typed by the tester" });
    const c = h.agentCalls.find((c2) => c2.step.id === "c");
    expect(String((c?.input as { from: string }).from)).toContain("b:");
  });

  it("runs one step alone", async () => {
    const { ran, result } = await run({ from: "d", to: "d" });
    expect(ran).toEqual(["d"]);
    expect(result).toMatchObject({ status: "succeeded", nodeId: "d" });
  });

  it("doesn't run a step before the first that was given nothing", async () => {
    const { ran, h } = await run({ from: "b", to: "b" });
    // a has no row at all. A reference to it reads as nothing, as any missing value does, which
    // is why apps/api refuses a range whose steps read a step that was given nothing.
    expect(h.row("a")).toBeUndefined();
    expect(ran).toEqual(["b"]);
    const b = h.agentCalls.find((c) => c.step.id === "b");
    expect((b?.input as { from?: unknown }).from ?? "").toBe("");
  });
});
