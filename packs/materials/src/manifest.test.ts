// The manifest is a valid PackManifest, every tool has its handler, none writes to a client's tool,
// and the skills use only the pack's tools or the platform's.

import { PackManifest, SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest } from "./manifest";
import { thresholdFrom } from "./tools";

describe("the Materials manifest", () => {
  it("parses, and names its events and tools after the pack", () => {
    expect(PackManifest.safeParse(materialsManifest).success).toBe(true);
    for (const e of materialsManifest.events) expect(e.type.startsWith("materials.")).toBe(true);
    for (const t of materialsManifest.tools) expect(t.id.startsWith("materials.")).toBe(true);
  });

  it("has a handler for every tool and no external tool", () => {
    for (const spec of materialsManifest.tools) {
      expect(MATERIALS_HANDLERS[spec.id]?.spec).toEqual(spec);
      expect(spec.sideEffect).not.toBe("external");
    }
  });

  it("gives every skill tools that exist, and requires the pack", () => {
    const tools = new Set([...materialsManifest.tools.map((t) => t.id), "inbox.create"]);
    for (const skill of MATERIALS_SKILLS) {
      expect(SkillDefinition.safeParse(skill).success, skill.id).toBe(true);
      for (const t of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
        expect(tools.has(t), `${skill.id} → ${t}`).toBe(true);
      }
      expect(skill.requiresPacks).toEqual(["materials"]);
    }
  });

  it("defaults match_confidence_auto to 0.90 and ignores nonsense settings", () => {
    const skill = MATERIALS_SKILLS.find((s) => s.id === "materials.match-lines");
    expect(skill?.settings.find((s) => s.key === "match_confidence_auto")?.default).toBe(0.9);
    expect(thresholdFrom({})).toBe(0.9);
    expect(thresholdFrom({ match_confidence_auto: 0.95 })).toBe(0.95);
    expect(thresholdFrom({ match_confidence_auto: "lots" })).toBe(0.9);
    expect(thresholdFrom({ match_confidence_auto: 3 })).toBe(0.9);
  });
});
