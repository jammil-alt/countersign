// v0.16 (docs/plan.md §1.86): a browsing skill's sites are checked when it is saved: each must be
// in the operator's catalogue and not blocked tier. Pure checks first, then against a real
// database as cs_worker (the catalogue is readable in operator sessions only).

import { cloneJson } from "@countersign/core";
import { browserSite } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import { AgentsError } from "../errors";
import { createHarness, type Harness, LOOKUP_SKILL } from "../log/harness.test-helper";
import { browseProblems, createSkill, createSkillVersion, rollbackSkill } from "./skills";

const def = (sites: string[], instructions = "Find the order's delivery date on the portal.") => ({
  ...cloneJson(LOOKUP_SKILL),
  // Skill model (2026-11-10): new versions are AI skills on their own model, never agent mode.
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  id: "custom:order-status",
  name: "Order status",
  instructions,
  tools: [],
  requiresConnectors: [],
  browse: { sites, pages: ["/orders/*"] },
});

describe("browseProblems", () => {
  const tiers = new Map([
    ["acme-supply", "low"],
    ["first-bank", "blocked"],
  ] as const);

  it("names a site missing from the catalogue and a blocked one", () => {
    expect(browseProblems(def(["acme-supply"]), tiers)).toEqual([]);
    expect(browseProblems(def(["acme-supply", "nowhere", "first-bank"]), tiers)).toEqual([
      "no browser site nowhere in the catalogue",
      "browser site first-bank is blocked tier: agents never sign in to it",
    ]);
    // A skill that doesn't browse has nothing to check.
    expect(browseProblems({}, new Map())).toEqual([]);
  });
});

const harness = await createHarness();
afterAll(() => harness?.close());

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentsError) return `${e.code}: ${e.message}`;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!harness)("saving a browsing skill", () => {
  const h = harness as Harness;

  it("refuses a missing or blocked site on create, on a new version and on a rollback", async () => {
    await h.t.db.insert(browserSite).values([
      { slug: "acme-supply", name: "Acme Supply", tier: "low" },
      { slug: "first-bank", name: "First Bank", tier: "high" },
    ]);
    const created = await h.ops((tx) =>
      createSkill(tx, { tenantId: null, definition: def(["acme-supply"]), tools: h.tools }),
    );
    expect(created.version.definition.browse?.sites).toEqual(["acme-supply"]);
    // A high-tier site is in the catalogue: saving is fine (a person signs in there).
    const high = await h.ops((tx) =>
      createSkillVersion(tx, { skillId: created.skill.id, definition: def(["first-bank"]) }),
    );

    expect(
      await refusal(
        h.ops((tx) =>
          createSkill(tx, {
            tenantId: null,
            definition: { ...def(["nowhere"]), id: "custom:other" },
            tools: h.tools,
          }),
        ),
      ),
    ).toBe("invalid_definition: no browser site nowhere in the catalogue");

    await h.t.db.update(browserSite).set({ tier: "blocked" });
    expect(
      await refusal(
        h.ops((tx) =>
          createSkillVersion(tx, {
            skillId: created.skill.id,
            definition: def(["acme-supply"], "Look again."),
          }),
        ),
      ),
    ).toMatch(/^invalid_definition: browser site acme-supply is blocked tier/);
    expect(
      await refusal(
        h.ops((tx) => rollbackSkill(tx, { skillId: created.skill.id, toVersionId: high.id })),
      ),
    ).toMatch(/first-bank is blocked tier/);
  });

  it("outside an operator session every site reads as missing, so the skill is refused", async () => {
    expect(
      await refusal(
        h.client(h.A, (tx) =>
          createSkill(tx, {
            tenantId: h.A.tenantId,
            definition: { ...def(["acme-supply"]), id: "custom:client-own" },
            tools: h.tools,
          }),
        ),
      ),
    ).toBe("invalid_definition: no browser site acme-supply in the catalogue");
  });
});
