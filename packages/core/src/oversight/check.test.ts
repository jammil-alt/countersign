import { describe, expect, it } from "vitest";
import { OWNER_REVIEW_CHOICES, ownerCheckWords, signalsOf, signalWords } from "./check";
import { OVERSIGHT_REVIEWS } from "./decision";

describe("the owner's check in words", () => {
  it("says a clean step was checked and nothing was off", () => {
    expect(ownerCheckWords({ result: "clean", attemptOutcome: "succeeded", signals: [] })).toBe(
      "Owner checked: nothing off",
    );
  });

  it("names the signal, the review and what the owner did", () => {
    expect(
      ownerCheckWords({
        result: "reviewed",
        attemptOutcome: "succeeded",
        signals: [
          {
            kind: "total_outlier",
            field: "total",
            amount: "4800.00",
            currency: "USD",
            median: "400.00",
            runs: 12,
          },
        ],
        cause: "checkpoint",
        verdict: "continue",
      }),
    ).toBe("Flagged: total 12× its usual → reviewed → carried on");
  });

  it("says why a flag or a failure went unreviewed", () => {
    expect(
      ownerCheckWords({
        result: "flagged",
        attemptOutcome: "failed",
        signals: [],
        reason: "limit",
      }),
    ).toBe("Failed → not reviewed: the review limit was reached");
    expect(
      ownerCheckWords({
        result: "reviewed",
        attemptOutcome: "failed",
        signals: [],
        cause: "failed",
        verdict: "retry",
      }),
    ).toBe("Failed → reviewed → tried again");
  });

  it("says when the owner isn't watching", () => {
    expect(
      ownerCheckWords({
        result: "not_watched",
        attemptOutcome: "succeeded",
        signals: [],
        reason: "owner_off",
      }),
    ).toBe("Not watched: the owner is off for this agent");
  });

  it("reads signals back, leaving out what isn't one", () => {
    expect(signalsOf([{ kind: "empty_output" }, { kind: "made_up" }, 3])).toEqual([
      { kind: "empty_output" },
    ]);
    expect(signalsOf(null)).toEqual([]);
    expect(signalWords({ kind: "confer_disagreed", count: 2 })).toBe("2 reviewers disagreed");
  });
});

describe("the review setting's choices", () => {
  it("covers every setting, and says what reviewing every step costs", () => {
    expect(OWNER_REVIEW_CHOICES.map((c) => c.value)).toEqual([...OVERSIGHT_REVIEWS]);
    const all = OWNER_REVIEW_CHOICES.find((c) => c.value === "all");
    expect(all?.label).toBe("Review every step");
    expect(all?.cost).toMatch(/model call on every step/);
  });
});
