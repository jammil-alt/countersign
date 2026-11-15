import { describe, expect, it } from "vitest";
import { thinkingOf } from "./thinking";

describe("thinkingOf", () => {
  it("reads a step's kind first", () => {
    expect(thinkingOf({ kind: "confer" })).toBe("rechecking");
    expect(thinkingOf({ kind: "read" })).toBe("tracing");
    expect(thinkingOf({ kind: "write" })).toBe("tracing");
    expect(thinkingOf({ kind: "conversation" })).toBe("drafting");
    expect(thinkingOf({ kind: "notify" })).toBe("drafting");
    expect(thinkingOf({ kind: "handoff" })).toBe("weighing");
    expect(thinkingOf({})).toBe("weighing");
  });

  it("reads a skill step by the words of its skill id", () => {
    const of = (skill: string) => thinkingOf({ kind: "skill", skill });
    expect(of("docs.bill.check")).toBe("rechecking");
    expect(of("materials.matches.check")).toBe("rechecking");
    expect(of("account.draft_change")).toBe("drafting");
    expect(of("materials.prices.digest")).toBe("drafting");
    expect(of("test.summarize@3")).toBe("drafting");
    expect(of("materials.match_lines")).toBe("tracing");
    expect(of("bookkeeping.reconcile")).toBe("tracing");
    expect(of("docs.extract")).toBe("tracing");
    expect(of("knowledge.search")).toBe("tracing");
    expect(of("custom:draft-reminders")).toBe("drafting");
    expect(of("bookkeeping.categorize")).toBe("weighing");
    expect(of("materials.quote.compare")).toBe("weighing");
  });

  it("does not read a skill's namespace as its work", () => {
    // "docs" is where the skill lives, not that it writes a document.
    expect(thinkingOf({ kind: "skill", skill: "docs.plan_bill" })).toBe("weighing");
    // "ready" is not "read".
    expect(thinkingOf({ kind: "skill", skill: "bookkeeping.ready" })).toBe("weighing");
  });
});
