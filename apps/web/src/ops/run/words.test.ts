import { describe, expect, it } from "vitest";
import {
  age,
  checkFailureWords,
  errorGroupLabel,
  foldSameFailures,
  hoursWords,
  runErrorLine,
  sameFailureWords,
} from "./words";

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

describe("a failed check in words", () => {
  it("turns Zod's report into one plain sentence", () => {
    expect(checkFailureWords("✖ Invalid UUID\n  → at trigger.documentId")).toBe(
      "The input wasn't valid: an id isn't in the right form (documentId)",
    );
    expect(
      checkFailureWords(
        "✖ Invalid input: expected string, received undefined\n  → at vendor.name\n✖ Invalid UUID",
      ),
    ).toBe("The input wasn't valid: a value is missing (name), and 1 more");
    expect(
      checkFailureWords(
        '[{"code":"invalid_type","message":"Invalid input: expected number, received string","path":["amount"]}]',
      ),
    ).toBe("The input wasn't valid: a value isn't a number (amount)");
    expect(checkFailureWords("QuickBooks said 401")).toBeNull();
  });

  it("shows on the runs list's row with the step, and leaves other reasons as they are", () => {
    expect(runErrorLine({ reason: "✖ Invalid UUID\n  → at id" }, "Read the bill")).toBe(
      "The input wasn't valid: an id isn't in the right form (id) · at Read the bill",
    );
    expect(runErrorLine({ reason: "HTTP 401" })).toBe("HTTP 401");
    expect(runErrorLine({ reason: "timeout" })).toBe("Timed out waiting");
  });
});

describe("folding failures alike", () => {
  const base = { tenantId: "t", agentId: "a", mode: "test", errorStep: null };
  const failed = (id: string, reason = "✖ Invalid UUID") => ({
    ...base,
    id,
    status: "failed",
    error: { reason },
  });

  it("folds three or more alike into one row where the first was", () => {
    const runs = [
      { ...base, id: "ok", status: "succeeded", error: null },
      ...Array.from({ length: 32 }, (_, i) => failed(`f${i}`)),
      failed("other", "HTTP 401"),
    ];
    const items = foldSameFailures(runs);
    expect(items.map((i) => i.kind)).toEqual(["run", "same", "run"]);
    const same = items[1];
    expect(same?.kind === "same" && same.runs.length).toBe(32);
    expect(sameFailureWords(same?.kind === "same" ? same.runs : [])).toBe(
      "32 failed test runs, same error",
    );
  });

  it("leaves two alike, other agents and live runs apart", () => {
    const two = foldSameFailures([failed("a1"), failed("a2")]);
    expect(two.every((i) => i.kind === "run")).toBe(true);
    const mixed = foldSameFailures([
      failed("x1"),
      failed("x2"),
      { ...failed("x3"), agentId: "b" },
      { ...failed("x4"), mode: "live" },
    ]);
    expect(mixed.every((i) => i.kind === "run")).toBe(true);
    expect(sameFailureWords([{ mode: "live" }, { mode: "test" }])).toBe(
      "2 failed runs, same error",
    );
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
