// A run's Model calls tab said "This run made no model calls" of a run whose step 6 spent 22.4k
// tokens ($0.11): the step's usage (step_run) was there, its model_call rows were not. The route
// now reports each step's usage beyond its recorded calls, so the gap is never shown as nothing.
import { describe, expect, it } from "vitest";
import { unrecordedUsage } from "./routes/run-controls";

const step = (id: string, tokensIn: number, tokensOut: number, costUsd: string) => ({
  id,
  nodeId: `node-${id}`,
  tokensIn,
  tokensOut,
  costUsd,
});

describe("unrecordedUsage", () => {
  it("names a step that spent tokens with no recorded calls", () => {
    expect(unrecordedUsage([step("s6", 21_000, 1_400, "0.110000")], [])).toEqual([
      { stepRunId: "s6", nodeId: "node-s6", tokensIn: 21_000, tokensOut: 1_400, costUsd: "0.1100" },
    ]);
  });

  it("leaves out steps whose calls account for their usage, and those that spent nothing", () => {
    const calls = [
      { stepRunId: "s1", tokensIn: 100, tokensOut: 20, costUsd: "0.0008" },
      { stepRunId: "s1", tokensIn: 100, tokensOut: 20, costUsd: "0.0008" },
    ];
    expect(
      unrecordedUsage([step("s1", 200, 40, "0.001600"), step("s2", 0, 0, "0.000000")], calls),
    ).toEqual([]);
  });

  it("reports only what is missing when some calls were recorded", () => {
    const calls = [{ stepRunId: "s1", tokensIn: 100, tokensOut: 20, costUsd: "0.0008" }];
    expect(unrecordedUsage([step("s1", 300, 60, "0.002400")], calls)).toEqual([
      { stepRunId: "s1", nodeId: "node-s1", tokensIn: 200, tokensOut: 40, costUsd: "0.0016" },
    ]);
  });
});
