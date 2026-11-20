// Text Postgres can store, and cutting it on whole characters (BUILDER_QA INPUT-1, INPUT-3).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clampFitGap, clampText } from "./build/build";
import { sliceWhole, storable, storableJson, storableText } from "./text";

const wellFormed = (s: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("storable text", () => {
  it("refuses a NUL and half of a character, and takes the rest", () => {
    expect(storableText("Invoice review 𠮷野家 ✓")).toBe(true);
    expect(storableText("Invoice\u0000 review")).toBe(false);
    expect(storableText("Flag late invoices \ud83d")).toBe(false);
    expect(storableText("\ude00 at the start")).toBe(false);
  });

  it("checks every string and key of a JSON value", () => {
    expect(storableJson({ a: ["ok", { b: "fine" }], n: 1 })).toBe(true);
    expect(storableJson({ a: ["ok", { b: "Oak\u0000" }] })).toBe(false);
    expect(storableJson({ "k\ud83d": "v" })).toBe(false);
  });

  it("is a schema rule that names the field", () => {
    const schema = z.object({ title: storable(z.string().trim().min(1)) });
    const out = schema.safeParse({ title: "Invoice\u0000 review" });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(["title"]);
  });
});

describe("cutting text on whole characters", () => {
  it("drops a character rather than cut it in two", () => {
    expect(sliceWhole("ab😀cd", 3)).toBe("ab");
    expect(sliceWhole("ab😀cd", 4)).toBe("ab😀");
    expect(sliceWhole("abc", 10)).toBe("abc");
  });

  // BUILDER_QA INPUT-3.
  it("clampText never leaves half a surrogate pair", () => {
    // 498 code units, then 𠮷 (two code units): the cut at 499 falls between its halves.
    const text = `${"照".repeat(498)}𠮷${"合".repeat(20)}`;
    const out = clampText(text, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(wellFormed(out), JSON.stringify(out.slice(-3))).toBe(true);
    const gap = clampFitGap({
      rows: [{ id: "r", need: "n", verdict: "native", how: text, dropped: false, later: false }],
      needsTrue: [],
      setup: [],
    });
    expect(wellFormed(gap.rows[0]?.how ?? "")).toBe(true);
  });
});
