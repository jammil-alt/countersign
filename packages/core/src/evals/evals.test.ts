import { describe, expect, it } from "vitest";
import {
  EvalDataset,
  evalScorecard,
  expectedWritesOf,
  type RunWrite,
  resolveRefs,
  runWrites,
  scoreWrites,
  stepIdOf,
  WRITES_KEY,
} from "./evals";

const w = (step: string, input: unknown, output: unknown = null): RunWrite => ({
  step,
  nodeId: step,
  tool: "t",
  input,
  output,
});

describe("scoreWrites", () => {
  it("is exact when the same writes hold every named field", () => {
    const s = scoreWrites(
      [{ step: "send", expect: { input: { to: "ap@x.test" } } }],
      [w("send", { to: "ap@x.test", body: "anything" })],
    );
    expect(s).toEqual({ exact: true, missing: [], extra: [], fields: [] });
  });

  it("names a write that is missing, one more than expected, and a field that differs", () => {
    const s = scoreWrites(
      [
        { step: "save", expect: { output: { matched: 2 } } },
        { step: "send", expect: {} },
      ],
      [w("save", {}, { matched: 1 }), w("alerts", {})],
    );
    expect(s.exact).toBe(false);
    expect(s.missing).toEqual(["send"]);
    expect(s.extra).toEqual(["alerts"]);
    expect(s.fields).toEqual([
      { path: "save.0.output.matched", problem: "different", expected: 2, got: 1 },
    ]);
  });

  it("counts each write of a step in a loop, in order, and holds money within its tolerance", () => {
    const expected = [
      { step: "write", expect: { input: { total: "10.00" } } },
      { step: "write", expect: { input: { total: "20.00" } } },
    ];
    const got = [w("write", { total: "10.004" }), w("write", { total: "20" })];
    expect(scoreWrites(expected, got).exact).toBe(false);
    expect(
      scoreWrites(expected, got, { "write.*.input.total": { kind: "money", abs: "0.01" } }).exact,
    ).toBe(true);
    expect(scoreWrites(expected, [got[0] as RunWrite]).missing).toEqual(["write"]);
  });
});

describe("the rest", () => {
  it("resolves world ids and refuses an unknown name", () => {
    expect(resolveRefs({ a: "@doc", b: ["@doc", "x@doc"] }, { doc: "1" })).toEqual({
      a: "1",
      b: ["1", "x@doc"],
    });
    expect(() => resolveRefs("@nope", {})).toThrow(/no world id/);
  });

  it("reads writes from step rows: write and action steps that succeeded", () => {
    expect(stepIdOf("post:0:write-purchase")).toBe("write-purchase");
    const writes = runWrites(
      [
        { nodeId: "a", nodeType: "write", status: "succeeded", input: 1, output: 2 },
        { nodeId: "b", nodeType: "skill", status: "succeeded", input: 1, output: 2 },
        { nodeId: "p:0:c", nodeType: "action", status: "succeeded", input: 3, output: null },
        { nodeId: "d", nodeType: "write", status: "failed", input: 1, output: 2 },
      ],
      (s) => `tool-${s}`,
    );
    expect(writes.map((x) => [x.step, x.tool])).toEqual([
      ["a", "tool-a"],
      ["c", "tool-c"],
    ]);
  });

  it("finds a test case's expected writes under $writes", () => {
    expect(expectedWritesOf({ [WRITES_KEY]: [{ step: "s" }] })).toEqual([
      { step: "s", expect: {} },
    ]);
    expect(expectedWritesOf({ s: 1 })).toBeNull();
  });

  it("scores a dataset: exact rate, verifier agreement only where judged, cost, run time", () => {
    const card = evalScorecard([
      { status: "pass", exact: true, verifier: true, costUsd: "0.01", ms: 100 },
      { status: "fail", exact: false, verifier: false, costUsd: "0.03", ms: 300 },
      { status: "pass", exact: true, verifier: null, costUsd: "0", ms: 200 },
    ]);
    expect(card).toMatchObject({
      cases: 3,
      passed: 2,
      exactRate: 0.6667,
      verifierAgreement: 0.5,
      verifierChecked: 2,
      costUsd: "0.040000",
      msMedian: 200,
    });
    expect(evalScorecard([]).verifierAgreement).toBeNull();
  });

  it("refuses a dataset with two cases under one id", () => {
    const c = { id: "a", name: "A", world: {}, writes: [] };
    const r = EvalDataset.safeParse({
      schemaVersion: 1,
      template: "t",
      workflow: "w",
      cases: [c, c],
    });
    expect(r.success).toBe(false);
  });
});
