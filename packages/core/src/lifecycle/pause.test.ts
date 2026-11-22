import { describe, expect, it } from "vitest";
import {
  mayResume,
  PauseBody,
  pauseEnded,
  pauseReasonWords,
  pauseUntilProblem,
  readPause,
} from "./pause";

describe("pauseReasonWords", () => {
  it("drops a reason that only echoes the action or says who paused", () => {
    expect(pauseReasonWords("Pause")).toBeNull();
    expect(pauseReasonWords(" paused. ")).toBeNull();
    expect(pauseReasonWords("")).toBeNull();
    expect(pauseReasonWords(null)).toBeNull();
    expect(pauseReasonWords("paused by the operator")).toBeNull();
  });

  it("keeps a real reason, and words a credits-out pause", () => {
    expect(pauseReasonWords("Month-end close")).toBe("Month-end close");
    expect(pauseReasonWords("Pause until the new price list")).toBe(
      "Pause until the new price list",
    );
    expect(pauseReasonWords("credits_out")).toBe("the month's credits ran out");
  });

  it("strips trailing stops and spaces in linear time, whatever the client wrote", () => {
    expect(pauseReasonWords("Pause!!")).toBeNull();
    expect(pauseReasonWords("Pause . !")).toBeNull();
    const long = `x${" ".repeat(50_000)}y`;
    const started = Date.now();
    expect(pauseReasonWords(long)).toBe(long);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

const now = new Date("2026-11-06T12:00:00Z");
const at = now.toISOString();

describe("pausing", () => {
  it("needs a reason of 1–500 characters", () => {
    expect(PauseBody.safeParse({ reason: "" }).success).toBe(false);
    expect(PauseBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(PauseBody.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(PauseBody.safeParse({ reason: "Month-end close" }).success).toBe(true);
    expect(
      PauseBody.safeParse({ reason: "r", until: "2026-11-07T12:00:00Z", extra: 1 }).success,
    ).toBe(false);
  });

  it("takes an end in the future, at most 90 days away", () => {
    expect(pauseUntilProblem(undefined, now)).toBeNull();
    expect(pauseUntilProblem("2026-11-06T11:00:00Z", now)).toMatch(/future/);
    expect(pauseUntilProblem("2026-11-07T12:00:00Z", now)).toBeNull();
    expect(pauseUntilProblem("2027-03-01T12:00:00Z", now)).toMatch(/90 days/);
  });

  it("lets the client resume only the client side's pause; the operator any", () => {
    const client = readPause({ side: "client", by: "u", reason: "r", at });
    const operator = readPause({ side: "operator", by: "o", reason: "r", at });
    expect(mayResume(client, "client")).toBe(true);
    expect(mayResume(operator, "client")).toBe(false);
    expect(
      mayResume(readPause({ side: "system", by: null, reason: "credits_out", at }), "client"),
    ).toBe(false);
    expect(mayResume(null, "client")).toBe(false);
    expect(mayResume(operator, "operator")).toBe(true);
    expect(mayResume(null, "operator")).toBe(true);
  });

  it("ends when `until` has passed", () => {
    const p = readPause({
      side: "client",
      by: "u",
      reason: "r",
      at,
      until: "2026-11-06T12:00:00Z",
    });
    expect(pauseEnded(p, new Date("2026-11-06T11:59:00Z"))).toBe(false);
    expect(pauseEnded(p, now)).toBe(true);
    expect(pauseEnded(readPause({ side: "client", by: "u", reason: "r", at }), now)).toBe(false);
    expect(readPause({ nope: 1 })).toBeNull();
  });
});
