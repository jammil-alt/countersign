// The time picker's values (docs/plan.md §1.177): what it shows for a stored time, and what it
// stores for what was picked.
import { describe, expect, it } from "vitest";
import {
  durationOfParts,
  durationWords,
  partsOf,
  presetOf,
  reminderPlan,
  remindersOf,
  reminderWords,
} from "./duration-parts";

const none = { week: 0, day: 0, hour: 0, minute: 0 };

describe("a wait as it is picked", () => {
  it("knows the common times, however they are spaced", () => {
    expect(presetOf("30 minutes")).toBe("30 minutes");
    expect(presetOf("1 hours")).toBe("1 hour");
    expect(presetOf("7  days")).toBe("7 days");
    expect(presetOf("3 days")).toBeNull();
    expect(presetOf("soon")).toBeNull();
  });

  it("spreads a time over its units on the clock, and keeps its unit in business hours", () => {
    expect(partsOf("90 minutes", true)).toEqual({ ...none, hour: 1, minute: 30 });
    expect(partsOf("36 hours", true)).toEqual({ ...none, day: 1, hour: 12 });
    expect(partsOf("3 weeks", true)).toEqual({ ...none, week: 3 });
    // A business day is the next open day, not 24 working hours: 2 days stays 2 days.
    expect(partsOf("48 hours", false)).toEqual({ ...none, hour: 48 });
    expect(partsOf("30 seconds", true)).toBeNull();
    expect(partsOf("soon", true)).toBeNull();
  });

  it("stores one unit as it is, and several in the smallest", () => {
    expect(durationOfParts({ ...none, day: 3 })).toBe("3 days");
    expect(durationOfParts({ ...none, week: 1 })).toBe("1 week");
    expect(durationOfParts({ ...none, day: 1, hour: 12 })).toBe("36 hours");
    expect(durationOfParts({ week: 1, day: 2, hour: 3, minute: 4 })).toBe("13144 minutes");
    expect(durationOfParts(none)).toBeNull();
    expect(durationWords("13144 minutes")).toBe("1 week 2 days 3 hours 4 minutes");
  });
});

describe("reminders as they are picked", () => {
  it("writes so many times, so far apart, as times after the asking", () => {
    expect(remindersOf({ kind: "every", times: 5, every: "30 minutes" })).toEqual([
      "30 minutes",
      "60 minutes",
      "90 minutes",
      "120 minutes",
      "150 minutes",
    ]);
    expect(remindersOf({ kind: "every", times: 1, every: "30 minutes" })).toEqual(["30 minutes"]);
    // Five is the most a wait may have.
    expect(remindersOf({ kind: "every", times: 9, every: "1 day" })).toHaveLength(5);
    expect(remindersOf({ kind: "none" })).toEqual([]);
  });

  it("reads them back, and leaves uneven times as written", () => {
    expect(reminderPlan(["30 minutes", "60 minutes", "90 minutes"])).toEqual({
      kind: "every",
      times: 3,
      every: "30 minutes",
    });
    expect(reminderPlan(["1 day"])).toEqual({ kind: "every", times: 1, every: "1 day" });
    expect(reminderPlan(["1 hour", "4 hours"])).toEqual({ kind: "set", at: ["1 hour", "4 hours"] });
    expect(reminderPlan([])).toEqual({ kind: "none" });
    expect(reminderPlan(undefined)).toEqual({ kind: "none" });
  });

  it("says them in a line", () => {
    expect(reminderWords({ kind: "every", times: 1, every: "30 minutes" })).toBe(
      "Reminds them once, 30 minutes after asking.",
    );
    expect(reminderWords({ kind: "every", times: 5, every: "30 minutes" })).toBe(
      "Reminds them 5 times, every 30 minutes: the last 2 hours 30 minutes after asking.",
    );
  });
});
