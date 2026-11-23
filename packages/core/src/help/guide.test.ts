// The portal's guide (v0.19 O6): Sloan answers "how do I…" from these entries (`account.help`).
import { describe, expect, it } from "vitest";
import { guideFor, PORTAL_GUIDE } from "./guide";

describe("the portal's guide", () => {
  it("has one entry per id, each with steps and a portal path", () => {
    const ids = PORTAL_GUIDE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of PORTAL_GUIDE) {
      expect(e.path.startsWith("/"), e.id).toBe(true);
      expect(e.steps.length, e.id).toBeGreaterThan(0);
    }
  });

  // S2.5 (overnight fixes): Sloan couldn't tell a client how to add a Knowledge note.
  it.each([
    "How do I add a note to Knowledge?",
    "Can you remember that we close early on Fridays?",
    "Where do I add an FAQ?",
    "how do i add a policy",
  ])("finds how to add a Knowledge entry for %j", (question) => {
    const [first] = guideFor({ question });
    expect(first).toMatchObject({ id: "knowledge", path: "/settings/charter" });
    expect(first?.steps.join(" ")).toContain("Charter and policies");
  });

  it("finds it from the screen the person is on", () => {
    expect(guideFor({ path: "/settings/charter" })[0]?.id).toBe("knowledge");
  });
});
