// The skill model (owner, 2026-11-10; CLAUDE.md invariant 11): setup is the operator's only. The
// portal offers no agent or skill setup: no skills, builder, workflows, parameters or models.
// Clients keep signing in to their own tools, tightening permissions and approver rules, and
// their hours and people, which the portal's routes still offer.
import { describe, expect, it } from "vitest";
import routes from "./routes.tsx?raw";

const paths = [...routes.matchAll(/path="([^"]+)"/g)].map((m) => m[1] as string);

describe("the portal offers no setup", () => {
  it("has no route that builds or configures an agent or a skill", () => {
    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) {
      expect(p, p).not.toMatch(
        /skill|builder|workflow|process|parameter|model|template|definition/i,
      );
    }
    // What a client keeps: their tools, their approver rules, their hours and people.
    expect(paths).toEqual(
      expect.arrayContaining(["accounts", "settings/approvals", "settings/hours", "settings/team"]),
    );
  });
});
