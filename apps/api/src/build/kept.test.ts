import { uuidv7 } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { keptAnswer } from "./kept";

describe("keptAnswer (builder-plan.md B1)", () => {
  const start = new Date("2026-11-19T10:00:00.000Z");
  const before = uuidv7(start.getTime() - 86_400_000);
  const during = uuidv7(start.getTime() + 1500);

  it("leaves out the ids and times the try's own run made, and keeps the rest", () => {
    const output = {
      update: {
        wouldHaveDone: true,
        actionId: during,
        vendorId: before,
        at: "2026-11-19T10:00:02.000Z",
        invoiceDate: "2026-11-19",
        before: { amount: "20.00" },
      },
      notify: { sources: [before, during], lines: [{ sku: "OAK-2X4", qty: 3 }] },
      empty: { threadId: during },
    };
    expect(keptAnswer(output, start)).toEqual({
      update: {
        wouldHaveDone: true,
        vendorId: before,
        invoiceDate: "2026-11-19",
        before: { amount: "20.00" },
      },
      notify: { lines: [{ sku: "OAK-2X4", qty: 3 }] },
      empty: {},
    });
  });

  it("keeps a result with nothing the run made as it is", () => {
    expect(keptAnswer({ verdict: "same", score: 0.9 }, start)).toEqual({
      verdict: "same",
      score: 0.9,
    });
    expect(keptAnswer("same", start)).toBe("same");
  });

  it("is null when the whole result is the run's own", () => {
    expect(keptAnswer(during, start)).toBeNull();
  });
});
