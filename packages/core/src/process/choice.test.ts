// M61 (ARCHITECTURE v0.17 §10.14; docs/plan.md §1.99): an `if` the agent decides and a repeat the
// agent judges, in the schema and the validator; and the answer's checks.
import { describe, expect, it } from "vitest";
import { pickedPath } from "./choice";
import { processPathsAt } from "./paths";
import { validateProcess } from "./validate";

const note = (id: string, message = id) => ({
  id,
  name: id,
  kind: "notify",
  notify: { to: ["lead"], message },
});
const base = (steps: Record<string, unknown>[]) => ({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps,
});
const codes = (r: ReturnType<typeof validateProcess>) => r.errors.map((e) => [e.code, e.stepId]);

function agentIf(over: Record<string, unknown> = {}, paths?: Record<string, unknown>[]) {
  return {
    id: "how",
    name: "How to buy",
    kind: "if",
    decide: "agent",
    paths: paths ?? [
      {
        id: "reorder",
        name: "Reorder",
        describe: "the item is on the usual vendor's list",
        when: { match: "all", rules: [] },
        steps: [note("r")],
      },
      {
        id: "quote",
        name: "Get two quotes",
        describe: "the item is new",
        when: { match: "all", rules: [] },
        steps: [note("q")],
      },
    ],
    otherwise: { id: "else", steps: [] },
    ...over,
  };
}

describe("an if the agent decides", () => {
  it("is valid with a description per path and no rules", () => {
    expect(codes(validateProcess(base([agentIf()])))).toEqual([]);
  });

  it("needs each path to say when to take it, in fixed words", () => {
    const r = validateProcess(
      base([
        agentIf({}, [
          { id: "a", name: "A", when: { match: "all", rules: [] }, steps: [] },
          {
            id: "b",
            name: "B",
            describe: "when {{trigger.note}}",
            when: { match: "all", rules: [] },
            steps: [],
          },
        ]),
      ]),
    );
    expect(codes(r)).toEqual([
      ["choice_describe_missing", "a"],
      ["input_not_fixed", "b"],
    ]);
  });

  it("types what it reads, and asks a person to pick from six paths at most", () => {
    const r = validateProcess(base([agentIf({ show: { x: "{{steps.nope.output.y}}" } })]));
    expect(codes(r)).toEqual([["template_scope", "how"]]);
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      describe: "sometimes",
      when: { match: "all", rules: [] },
      steps: [],
    }));
    expect(codes(validateProcess(base([agentIf({ ifUnsure: "ask" }, seven)])))).toEqual([
      ["choice_too_many", "how"],
    ]);
    expect(codes(validateProcess(base([agentIf({}, seven)])))).toEqual([]);
  });

  it("still needs rules on every path when the rules decide", () => {
    const r = validateProcess(base([agentIf({ decide: "rules" })]));
    expect(r.errors.map((e) => e.stepId).sort()).toEqual(["quote", "reorder"]);
  });
});

describe("a repeat the agent judges", () => {
  const judged = (over: Record<string, unknown> = {}) => ({
    id: "rep",
    name: "Draft the RFQ",
    kind: "repeat",
    steps: [note("draft", "Pass {{loop.pass}}: fix {{loop.feedback}}")],
    until: { agent: { goal: "The RFQ names every line, a quantity and a date." } },
    ...over,
  });

  it("is valid, and offers {{loop.feedback}} inside it", () => {
    const p = base([judged()]);
    expect(codes(validateProcess(p))).toEqual([]);
    const paths = processPathsAt(validateProcess(p).value as never, "draft").map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["loop.pass", "loop.feedback"]));
  });

  it("keeps its goal fixed, and has no feedback when rules decide", () => {
    expect(
      codes(validateProcess(base([judged({ until: { agent: { goal: "{{trigger.goal}}" } } })]))),
    ).toEqual([["input_not_fixed", "rep"]]);
    const ruled = judged({
      until: { rules: { match: "all", rules: [{ field: "{{loop.pass}}", op: ">=", value: 2 }] } },
    });
    expect(codes(validateProcess(base([ruled])))).toEqual([["template_path", "draft"]]);
  });
});

describe("the agent's answer", () => {
  it("picks only a path it was offered, with a reason", () => {
    expect(pickedPath({ path: "quote", reason: "New item." }, ["reorder", "quote"])).toEqual({
      path: "quote",
      reason: "New item.",
      sources: [],
    });
    expect(pickedPath({ path: "owner", reason: "x" }, ["reorder", "quote"])).toBeNull();
    expect(pickedPath({ path: "unsure", reason: "x" }, ["reorder", "quote"])).toBeNull();
    expect(pickedPath({ path: "quote" }, ["quote"])).toBeNull();
  });
});
