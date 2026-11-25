// Audit 4.4: a durable step's result over the limit (960 KiB) fails its step with a clear error,
// before the engine's own 1 MiB limit, stored as a small marker so the step is neither retried nor run again
// on a replay.
import { ClientLockedError } from "@countersign/db";
import { describe, expect, it } from "vitest";
import { FakeWorkflowStep } from "../api.test-helper";
import {
  cloudflareStepRunner,
  resultBytes,
  STEP_RESULT_MAX_BYTES,
  StepResultTooLargeError,
  stepUnlessLocked,
} from "./step-runner";

const big = (bytes: number) => ({ text: "x".repeat(bytes) });

describe("the step runner's result limit", () => {
  it("hands on a result under the limit as it came, up to what works today", async () => {
    const runner = cloudflareStepRunner(new FakeWorkflowStep());
    const out = await runner.do("small", async () => big(900 * 1024));
    expect(resultBytes(out)).toBeLessThan(STEP_RESULT_MAX_BYTES);
    expect(out.text).toHaveLength(900 * 1024);
  });

  it("fails a step whose result is over the limit, with its size, once", async () => {
    const step = new FakeWorkflowStep();
    const runner = cloudflareStepRunner(step);
    let runs = 0;
    const work = async () => {
      runs += 1;
      return big(1000 * 1024);
    };
    const failed = await runner.do("large", work).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(StepResultTooLargeError);
    expect(String((failed as Error).message)).toBe(
      "the result of step large is 1001 KiB, over the 960 KiB a step may hand on",
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

// Lockdown (docs/plan.md §1.243): a step refused because its client is locked ends the instance at
// once, never retried and the same on a replay; every other error is the step's own.
describe("a step whose client is locked", () => {
  const locked = () => Object.assign(new Error("client_locked"), { cause: { code: "MZLCK" } });

  it("stores a marker instead of failing the step, and throws ClientLockedError", async () => {
    const step = new FakeWorkflowStep();
    const runner = cloudflareStepRunner(step);
    let runs = 0;
    const work = async () => {
      runs += 1;
      throw locked();
    };
    await expect(runner.do("load", work)).rejects.toBeInstanceOf(ClientLockedError);
    expect(step.results.get("load")).toEqual({ __clientLocked: true });
    await expect(runner.do("load", work)).rejects.toBeInstanceOf(ClientLockedError);
    expect(runs).toBe(1);
  });

  it("leaves any other error to the engine, so it is retried as configured", async () => {
    const step = new FakeWorkflowStep();
    await expect(
      stepUnlessLocked(
        (body) => step.do("other", body),
        async () => {
          throw new Error("network");
        },
      ),
    ).rejects.toThrow("network");
    expect(step.results.has("other")).toBe(false);
  });

  it("hands on a result as it came", async () => {
    const step = new FakeWorkflowStep();
    expect(
      await stepUnlessLocked(
        (body) => step.do("ok", body),
        async () => ({ n: 1 }),
      ),
    ).toEqual({
      n: 1,
    });
  });
});
