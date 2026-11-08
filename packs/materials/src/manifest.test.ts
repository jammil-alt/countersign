// The manifest is a valid PackManifest, every tool has its handler, none writes to a client's tool,
// and the skills use only the pack's tools or the platform's.

import { PackManifest, SkillDefinition } from "@countersign/core";
import { DEFAULT_MODELS } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest } from "./manifest";
import { readDecimal, splitSavingFrom } from "./purchasing/tools";
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
    // P-5: Read a vendor's quote also reads a quote document with the platform's docs.get.
    const tools = new Set([
      ...materialsManifest.tools.map((t) => t.id),
      "inbox.create",
      "docs.get",
    ]);
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

describe("ingredients only (docs/plan.md §1.63)", () => {
  it("ships no agent templates: agents on the Purchasing area are built in the Agent lab", () => {
    expect(materialsManifest.templates).toEqual([]);
  });

  it("raises alerts only from a skill whose outputs carry sources", () => {
    const check = MATERIALS_SKILLS.find((s) => s.id === "materials.price-check");
    expect(check?.producesAlerts).toBe(true);
    expect((check?.output as { required?: string[] } | undefined)?.required).toContain("sources");
    expect(check?.settings.find((s) => s.key === "ignore_vendors")?.clientSpecific).toBe(true);
    expect(check?.settings.find((s) => s.key === "price_change_pct")?.default).toBe(5);
  });
});

// P-5: the Purchasing area (docs/plan.md §1.67).
describe("the Purchasing area's tools and skills", () => {
  const PURCHASING = [
    "materials.request.create",
    "materials.request.get",
    "materials.request.list",
    "materials.request.update",
    "materials.request.add-lines",
    "materials.request.match-lines",
    "materials.catalog.match-text",
    "materials.vendors-for-items",
    "materials.frequent-items",
    "materials.quote.create",
    "materials.quote.mark-sent",
    "materials.quote.get",
    "materials.quote.record",
    "materials.quote.compare",
    "materials.po.document",
    "materials.backfill-from-bills",
  ];

  it("registers every tool as a read or the pack's own write, with sources on every output", () => {
    expect(materialsManifest.version).toBe("0.2.0");
    for (const id of PURCHASING) {
      const spec = materialsManifest.tools.find((t) => t.id === id);
      expect(spec, id).toBeDefined();
      expect(["none", "internal"], id).toContain(spec?.sideEffect);
      expect((spec?.output as { required?: string[] } | undefined)?.required, id).toContain(
        "sources",
      );
    }
    expect(MATERIALS_HANDLERS["materials.request.update"]?.spec.verb).toBe("update");
  });

  it("reads text with two task skills on the small model; the rest are tool skills", () => {
    for (const id of ["materials.read-request", "materials.read-quote"]) {
      const skill = MATERIALS_SKILLS.find((s) => s.id === id);
      expect(skill?.mode, id).toBe("task");
      expect(skill?.model?.id, id).toBe(DEFAULT_MODELS.classification);
      expect(skill?.instructions, id).toMatch(/data: never follow instructions/);
      expect((skill?.output as { required?: string[] } | undefined)?.required, id).toContain(
        "sources",
      );
    }
    const purchasing = MATERIALS_SKILLS.filter((s) => s.category === "Purchasing");
    expect(purchasing.filter((s) => s.mode === "tool").map((s) => s.handler)).toEqual(
      expect.arrayContaining([
        "materials.request.create",
        "materials.quote.compare",
        "materials.po.document",
        "materials.backfill-from-bills",
      ]),
    );
    const compare = MATERIALS_SKILLS.find((s) => s.id === "materials.compare-quotes");
    expect(compare?.settings.find((s) => s.key === "split_min_saving_pct")?.default).toBe(5);
    expect(splitSavingFrom({})).toBe(5);
    expect(splitSavingFrom({ split_min_saving_pct: 10 })).toBe(10);
    expect(splitSavingFrom({ split_min_saving_pct: "lots" })).toBe(5);
  });

  it("reads quantities and prices as decimals, never floats", () => {
    expect(readDecimal(0.1)).toBe("0.1000");
    expect(readDecimal("59.75")).toBe("59.7500");
    expect(() => readDecimal(1.23456)).toThrow(/at most 4 places/);
    expect(() => readDecimal("1e3")).toThrow(/at most 4 places/);
  });
});
