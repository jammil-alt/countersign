// The setup nudge (docs/plan.md §1.206, SU6): from the lead, in each language, listing what's left.
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import { renderSetupNudgeEmail } from "./setup-nudge";

const base = {
  client: "Hartley Millwork",
  to: { name: "Dana Ruiz", email: "dana@hartley.example.com" },
  lead: { name: "Ana Navarro", photoUrl: null },
  link: "https://app.mezonas.com/start",
  origin: "https://app.mezonas.com",
};

describe("the setup nudge", () => {
  it("lists what's left with one button, from the lead", () => {
    const out = renderSetupNudgeEmail({
      ...base,
      locale: "en",
      items: ["Connect Gmail", "Sign the scope"],
    });
    expect(out.subject).toBe("A few things left to set up Hartley Millwork");
    expect(out.text).toContain("Hi Dana,");
    expect(out.text).toContain("2 things are waiting on you before Hartley Millwork's trial");
    expect(out.text).toContain("· Connect Gmail");
    expect(out.text).toContain("Sent by Ana Navarro at Mezonas.");
    expect(out.html).toContain("https://app.mezonas.com/start");
  });

  it("names at most ten lines and says how many more", () => {
    const items = Array.from({ length: 12 }, (_, i) => `Thing ${i + 1}`);
    const out = renderSetupNudgeEmail({ ...base, locale: "en", items });
    expect(out.text).toContain("· Thing 10");
    expect(out.text).not.toContain("· Thing 11");
    expect(out.text).toContain("And 2 more on Getting started.");
  });

  it("is written in every language", () => {
    for (const locale of LOCALES) {
      const out = renderSetupNudgeEmail({ ...base, locale, items: ["Sign the scope"] });
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.text).toContain("Hartley Millwork");
    }
  });
});
