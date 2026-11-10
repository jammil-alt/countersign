// R2 (docs/plan.md §1.86, §9): the skill schema gained `method`, `reads`, `browse` and `rules`.
// A built-in skill pinned by a stored version, or a `skill_version` row, is read again under the
// new schema, so re-parsing a registered built-in must neither fail nor add a field (a default)
// that would move its hash (invariant 3). No database: the catalog is code.

import { hashJson, isToolWrapper, SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

// The catalog a deployment builds (every connector registered, outside production), as
// platformFor does.
const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const builtins = platform.catalog.list();

// DECISION: both counts are pinned (the owner's inventory: 100 skills, 85 of them only a tool by
// another name), so retiring wrappers in R2, or a new connector read, changes them on purpose.
const BUILTINS = 100;
const WRAPPERS = 85;

describe("built-in skills under the R2 skill schema", () => {
  it("registers the platform's, the packs' and each connector's read skills, once each", () => {
    expect(builtins.length).toBe(BUILTINS);
    expect(new Set(builtins.map((s) => s.id)).size).toBe(builtins.length);
  });

  it("parses every one unchanged: same fields, same hash", async () => {
    for (const def of builtins) {
      const stored = JSON.parse(JSON.stringify(def)) as unknown;
      const parsed = SkillDefinition.safeParse(stored);
      expect(parsed.success, def.id).toBe(true);
      if (!parsed.success) continue;
      expect(Object.keys(parsed.data).sort(), def.id).toEqual(Object.keys(def).sort());
      expect(await hashJson(parsed.data), def.id).toBe(await hashJson(stored));
      // No built-in names a method yet: it is derived from `mode` (skillMethod).
      expect(parsed.data.method, def.id).toBeUndefined();
    }
  });

  it("counts the tool wrappers that retire (a process reads or writes the tool directly)", () => {
    // Every connector read skill (connectorReadSkills) is one, plus the platform's tool-mode
    // built-ins that call only their handler.
    const wrappers = builtins.filter(isToolWrapper);
    expect(wrappers.length).toBe(WRAPPERS);
    expect(wrappers.every((s) => s.mode === "tool" && s.tools.length === 0)).toBe(true);
  });
});
