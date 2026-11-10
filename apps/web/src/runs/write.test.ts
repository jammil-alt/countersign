import { describe, expect, it } from "vitest";
import { CATALOGS, createTranslator } from "../i18n/catalog";
import { writeLine } from "./write";

describe("a write on the client's timeline", () => {
  it("reads in each language, saved or changed in their tool", () => {
    for (const locale of Object.keys(CATALOGS) as (keyof typeof CATALOGS)[]) {
      const t = createTranslator(locale);
      const changed = writeLine(t, { kind: "change_in", connector: "QuickBooks" }, "succeeded");
      expect(changed, locale).toContain("QuickBooks");
      expect(writeLine(t, { kind: "save_to_records", connector: null }, "succeeded")).not.toBe(
        writeLine(t, { kind: "save_to_records", connector: null }, "waiting"),
      );
      expect(
        writeLine(t, { kind: "change_in", connector: null }, "succeeded").length,
      ).toBeGreaterThan(0);
    }
    const en = createTranslator("en");
    expect(writeLine(en, { kind: "change_in", connector: "QuickBooks" }, "succeeded")).toBe(
      "Changed in QuickBooks",
    );
    expect(writeLine(en, { kind: "save_to_records", connector: null }, "succeeded")).toBe(
      "Saved to your records",
    );
  });
});
