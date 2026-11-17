import { describe, expect, it } from "vitest";
import { callKindOf, laterUntil, todoTag } from "./call";

describe("Your call", () => {
  it("puts each to-do under its kind chip", () => {
    expect(callKindOf("issue")).toBe("issues");
    expect(callKindOf("client_ask")).toBe("issues");
    expect(callKindOf("build")).toBe("builds");
    expect(callKindOf("deal")).toBe("sales");
    expect(callKindOf("enhancement")).toBe("enh");
    expect(callKindOf("question")).toBe("other");
    expect(callKindOf(null)).toBe("other");
    expect(callKindOf(null, "build_item")).toBe("builds");
  });

  it("tags a card as the prototype does", () => {
    expect(todoTag("issue", { urgency: "critical" })).toBe("Issue · critical");
    expect(todoTag("deal", { dealKind: "expansion" })).toBe("Expansion");
    expect(todoTag("deal", { dealKind: "new" })).toBe("New account");
    expect(todoTag("enhancement", { asks: 4 })).toBe("Enhancement · 4 clients");
    expect(todoTag("enhancement", { asks: 1 })).toBe("Enhancement · 1 client");
    expect(todoTag(null)).toBe("To-do");
  });

  it("brings a snoozed to-do back at 9:00 on the next weekday", () => {
    // Tuesday afternoon: Wednesday 9:00.
    expect(laterUntil(new Date("2026-11-17T15:00:00Z")).toISOString()).toBe(
      "2026-11-18T09:00:00.000Z",
    );
    // Friday: Monday. Saturday early: Monday.
    expect(laterUntil(new Date("2026-11-20T08:00:00Z")).toISOString()).toBe(
      "2026-11-23T09:00:00.000Z",
    );
    expect(laterUntil(new Date("2026-11-21T01:00:00Z")).toISOString()).toBe(
      "2026-11-23T09:00:00.000Z",
    );
  });
});
