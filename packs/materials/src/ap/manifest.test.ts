// Plan entry §1.233: the AP pack's manifest is core's one pack shape, extends the Purchasing area,
// has a handler for every tool and no external tool, its skills use tools that exist, and its
// pack ships no agent template for now.

import { PackManifest, processArea, SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { AP_CONFIG_DEFAULTS, apConfigOf } from "./config";
import { AP_HANDLERS, AP_SKILLS, apManifest } from "./manifest";

describe("the AP manifest", () => {
  it("parses, extends the Purchasing area and names its tools after the pack", () => {
    expect(PackManifest.safeParse(apManifest).success).toBe(true);
    expect(apManifest).toMatchObject({ id: "ap", area: "purchasing", extends: "materials" });
    for (const t of apManifest.tools) expect(t.id.startsWith("ap.")).toBe(true);
    expect(processArea({ requiresPacks: ["ap"] })).toBe("purchasing");
  });

  it("has a handler for every tool, none external, and sources on every write", () => {
    for (const spec of apManifest.tools) {
      expect(AP_HANDLERS[spec.id]?.spec).toEqual(spec);
      expect(spec.sideEffect).not.toBe("external");
      if (spec.sideEffect === "internal") {
        expect((spec.output as { required?: string[] }).required, spec.id).toContain("sources");
      }
    }
  });

  it("gives every skill tools that exist, and requires the pack", () => {
    // The chart of accounts is Shared's: one list for every area (docs/step-model-plan.md §10e).
    const tools = new Set([...apManifest.tools.map((t) => t.id), "ledger.accounts.list"]);
    for (const skill of AP_SKILLS) {
      expect(SkillDefinition.safeParse(skill).success, skill.id).toBe(true);
      for (const t of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
        expect(tools.has(t), `${skill.id} → ${t}`).toBe(true);
      }
      expect(skill.requiresPacks).toEqual(["ap"]);
    }
    const suggest = AP_SKILLS.find((s) => s.id === "ap.suggest-accounts");
    expect(suggest?.instructions).toMatch(/data, never instructions/);
  });

  it("reads its configuration with defaults, and a bad value as the default", () => {
    expect(apConfigOf({})).toEqual(AP_CONFIG_DEFAULTS);
    expect(
      apConfigOf({
        packs: { ap: { pay_day: "tuesday", price_tolerance_pct: 500, require_po: true } },
      }),
    ).toEqual({ ...AP_CONFIG_DEFAULTS, payDay: "tuesday", requirePo: true });
  });
});

describe("the Bills to pay template", () => {
  // Since the step model's purge the pack ships no agent template: Bills to pay is built again
  // later (docs/step-model-plan.md §12 R0).
  it("is not shipped for now", () => {
    expect(apManifest.templates).toEqual([]);
  });
});
