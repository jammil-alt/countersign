import { describe, expect, it } from "vitest";
import { age, errorGroupLabel, hoursWords } from "./words";

describe("hoursWords and age", () => {
  it("says long waits in days, never hundreds of hours (QA, 2026-11-22)", () => {
    expect(hoursWords(0.5)).toBe("under an hour");
    expect(hoursWords(14)).toBe("14 h");
    expect(hoursWords(47.9)).toBe("47 h");
    expect(hoursWords(239)).toBe("9 days");
    expect(hoursWords(240)).toBe("10 days");
    const now = new Date("2026-11-22T12:00:00.000Z");
    expect(age(new Date(now.getTime() - 239 * 3_600_000).toISOString(), now)).toBe("9 days");
  });
});

describe("errorGroupLabel", () => {
  it("reads a failed-runs group's key in words, never its id", () => {
    expect(errorGroupLabel("testkit.record.update:unauthorized")).toBe(
      "Testkit · Update a record · unauthorized",
    );
    expect(errorGroupLabel("person:timeout")).toBe("A person step · timeout");
    expect(errorGroupLabel("run:no_workflow")).toBe("Before any step · no workflow");
    expect(errorGroupLabel("unknown")).toBe("No reason given");
  });
});
