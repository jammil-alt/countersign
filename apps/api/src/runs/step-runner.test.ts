// Audit 4.4: a durable step's result over the limit fails its step with a clear error, before the
// engine's own 1 MiB limit, stored as a small marker so the step is neither retried nor run again
// on a replay.
import { describe, expect, it } from "vitest";
import { FakeWorkflowStep } from "../api.test-helper";
import {
  cloudflareStepRunner,
  resultBytes,
  STEP_RESULT_MAX_BYTES,
  StepResultTooLargeError,
} from "./step-runner";

const big = (bytes: number) => ({ text: "x".repeat(bytes) });

describe("the step runner's result limit", () => {
  it("hands on a result under the limit as it came", async () => {
    const runner = cloudflareStepRunner(new FakeWorkflowStep());
    const out = await runner.do("small", async () => big(100 * 1024));
    expect(resultBytes(out)).toBeLessThan(STEP_RESULT_MAX_BYTES);
    expect(out.text).toHaveLength(100 * 1024);
  });

  it("fails a step whose result is over the limit, with its size, once", async () => {
    const step = new FakeWorkflowStep();
    const runner = cloudflareStepRunner(step);
    let runs = 0;
    const work = async () => {
      runs += 1;
      return big(600 * 1024);
    };
    const failed = await runner.do("large", work).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepResultTooLargeError);
    expect(String((failed as Error).message)).toBe(
      "the result of step large is 601 KiB, over the 512 KiB a step may hand on",
    );
    // The engine kept only the marker, far under its own limit.
    expect(resultBytes(step.results.get("large"))).toBeLessThan(100);
    // A replay reads the marker and fails the same way, without running the step again.
    await expect(runner.do("large", work)).rejects.toBeInstanceOf(StepResultTooLargeError);
    expect(runs).toBe(1);
  });

  it("fails before the engine would, for a result past the engine's own limit", async () => {
    const runner = cloudflareStepRunner(new FakeWorkflowStep());
    await expect(runner.do("huge", async () => big(2 * 1024 * 1024))).rejects.toBeInstanceOf(
      StepResultTooLargeError,
    );
  });
});
