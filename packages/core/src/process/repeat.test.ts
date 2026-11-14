// v0.17 (ARCHITECTURE §10.14 "Automations, repeat and the agent's choice"; docs/plan.md §1.99,
// M59): the repeat step in the schema, the validator and the walkers.
import { describe, expect, it } from "vitest";
import { flattenBundle, unflattenBundle } from "../bundle/flatten";
import { bundleInput } from "../testing/fixtures";
import { stepOutcomes } from "./outcomes";
import { type Process, Step } from "./schema";
import { durableEstimate, validateProcess } from "./validate";
import { allSteps, logicDepth, nodeIds } from "./walk";

const ask = (id: string) => ({
  id,
  name: "Ask",
  kind: "person",
  mode: "ask",
  assignee: "client_admin",
  title: "Ready?",
  payload: {},
  deadline: { after: "1 day" },
});
const note = (id: string, message = id) => ({
  id,
  name: id,
  kind: "notify",
  notify: { to: ["lead"], message },
});
const until = (field: string, value: unknown, op = "=") => ({
  rules: { match: "all", rules: [{ field, op, value }] },
});

function repeat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rep",
    name: "Ask until ready",
    kind: "repeat",
    steps: [ask("a"), note("n", "Pass {{loop.pass}}: {{loop.previous.a.output.answer}}")],
    until: until("{{steps.a.output.approved}}", true),
    ...over,
  };
}

const base = (steps: Record<string, unknown>[]) => ({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps,
});

const codes = (r: ReturnType<typeof validateProcess>) => r.errors.map((e) => [e.code, e.stepId]);

describe("the repeat step", () => {
  it("parses with its defaults: at most 3 passes, stop at the limit", () => {
    const parsed = Step.parse(repeat());
    expect(parsed).toMatchObject({ kind: "repeat", maxTimes: 3, onLimit: "stop" });
    expect(() => Step.parse(repeat({ maxTimes: 11 }))).toThrow();
    expect(() => Step.parse(repeat({ maxTimes: 0 }))).toThrow();
  });

  it("validates loop.pass, the pass before, and an until over its own steps", () => {
    const r = validateProcess(
      base([
        repeat(),
        note("after", "{{steps.rep.output.passes}} {{steps.rep.output.last.a.answer}}"),
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("keeps the steps inside it out of sight after it, and loop out of sight outside it", () => {
    const r = validateProcess(
      base([repeat(), note("after", "{{steps.a.output.approved}} {{loop.pass}}")]),
    );
    expect(codes(r)).toEqual([
      ["template_scope", "after"],
      ["template_scope", "after"],
    ]);
  });

  it("refuses an until over a step that isn't at its top, and a pass-before of an unknown step", () => {
    const r = validateProcess(
      base([
        repeat({
          until: until("{{steps.nope.output.x}}", 1),
          steps: [ask("a"), note("n", "{{loop.previous.zz.output.answer}}")],
        }),
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.stepId).sort()).toEqual(["n", "rep"]);
  });

  it("refuses an empty repeat, one inside another, a bad wait and onError on it", () => {
    expect(codes(validateProcess(base([repeat({ steps: [] })])))).toEqual([
      ["repeat_empty", "rep"],
    ]);
    const nested = repeat({
      steps: [
        ask("a"),
        {
          ...repeat(),
          id: "inner",
          steps: [ask("b")],
          until: until("{{steps.b.output.approved}}", true),
        },
      ],
    });
    expect(codes(validateProcess(base([nested])))).toContainEqual(["repeat_nested", "inner"]);
    expect(codes(validateProcess(base([repeat({ between: "8 days" })])))).toEqual([
      ["repeat_between", "rep"],
    ]);
    expect(codes(validateProcess(base([repeat({ between: "1 hour" })])))).toEqual([]);
    expect(codes(validateProcess(base([repeat({ onError: "continue" })])))).toEqual([
      ["on_error_not_here", "rep"],
    ]);
  });

  it("refuses a workflow that could pass Cloudflare's step limit, counting each repeat at its most", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => note(`x${i}`));
    const ok = repeat({ maxTimes: 10, steps: [ask("a"), ...many(80)] });
    expect(durableEstimate([Step.parse(ok)])).toBe(1 + 10 * (81 + 2));
    expect(codes(validateProcess(base([ok])))).toEqual([]);
    const big = repeat({ maxTimes: 10, steps: [ask("a"), ...many(90)] });
    expect(codes(validateProcess(base([big])))).toEqual([["repeat_too_big", null]]);
  });

  it("advises on a write or a for each inside it", () => {
    const r = validateProcess(
      base([
        repeat({
          steps: [
            ask("a"),
            {
              id: "each",
              name: "Each",
              kind: "for_each",
              over: "{{trigger.lines}}",
              steps: [note("x")],
            },
            { id: "w", name: "Save", kind: "write", tool: "qbo.bill.update", input: {} },
          ],
        }),
      ]),
    );
    expect(r.warnings.map((w) => [w.code, w.stepId])).toEqual(
      expect.arrayContaining([
        ["repeat_for_each", "each"],
        ["repeat_write", "w"],
      ]),
    );
  });

  it("ends done, or at its limit only when it goes on past it", () => {
    expect(stepOutcomes(Step.parse(repeat()))).toEqual(["done"]);
    expect(stepOutcomes(Step.parse(repeat({ onLimit: "proceed" })))).toEqual(["done", "limit"]);
  });

  it("is walked like a for each: its steps, its ids, its depth", () => {
    const p = validateProcess(base([repeat()])).value as Process;
    expect(allSteps(p).map((l) => [l.step.id, l.depth, l.repeats.map((r) => r.id)])).toEqual([
      ["rep", 0, []],
      ["a", 1, ["rep"]],
      ["n", 1, ["rep"]],
    ]);
    expect(nodeIds(p)).toEqual(["t", "rep", "a", "n"]);
    expect(logicDepth(p)).toBe(1);
  });

  it("flattens for a merge and back with its steps in place", () => {
    const p = validateProcess(base([repeat()])).value as Process;
    const fixture = bundleInput() as unknown as { workflows: { workflow: unknown }[] };
    const bundle = {
      ...fixture,
      workflows: [{ ...fixture.workflows[0], workflow: p }],
    } as never;
    const back = unflattenBundle(flattenBundle(bundle)) as unknown as {
      workflows: { workflow: Process }[];
    };
    expect(back.workflows[0]?.workflow.steps).toEqual(p.steps);
  });
});
