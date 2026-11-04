// The manifest is a valid PackManifest, every tool has its handler, none writes to a client's tool,
// and the skills use only the pack's tools or the platform's.

import { PackManifest, SkillDefinition, type Step, validateBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest } from "./manifest";
import { thresholdFrom } from "./tools";

function* walkSteps(steps: readonly Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    if (s.kind === "fork") {
      for (const p of s.paths) yield* walkSteps(p.steps);
      yield* walkSteps(s.otherwise.steps);
    }
    if (s.kind === "for_each") yield* walkSteps(s.steps);
  }
}

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

describe("the Pia template", () => {
  const pia = materialsManifest.templates.find((t) => t.slug === "pia");
  const steps = (pia?.bundle.workflows ?? []).flatMap((w) => [...walkSteps(w.workflow.steps)]);

  it("is in the manifest with both workflows, and parses as a bundle", () => {
    expect(pia).toBeDefined();
    expect(validateBundle(pia?.bundle).errors).toEqual([]);
    expect(pia?.bundle.workflows.map((w) => w.slug)).toEqual([
      "purchase-intake",
      "weekly-price-review",
    ]);
    expect(pia?.bundle.workflows[0]?.workflow.trigger.on).toEqual({
      type: "event",
      event: "transaction.created",
    });
    expect(pia?.bundle.workflows[1]?.workflow.trigger.on).toMatchObject({
      type: "schedule",
      cron: "0 7 * * 1",
    });
  });

  it("uses only the pack's skills and the platform's docs skills", () => {
    const own = new Set(MATERIALS_SKILLS.map((s) => s.id));
    for (const s of pia?.bundle.definition.skills ?? []) {
      expect(own.has(s.skill) || s.skill.startsWith("docs."), s.skill).toBe(true);
    }
    expect(pia?.bundle.definition.extraTools).toEqual([]);
  });

  it("never writes without approval (invariant 8) and asks people where the architecture does", () => {
    for (const s of steps) {
      if (s.kind === "skill" && s.approval) expect(s.approval.required).toBe("required");
      expect(s.kind).not.toBe("action");
    }
    const people = steps.filter((s) => s.kind === "person").map((s) => s.id);
    expect(people).toEqual(["ask-for-invoice", "check-totals", "review-matches", "review-digest"]);
  });

  it("raises alerts only from a skill whose outputs carry sources", () => {
    const check = MATERIALS_SKILLS.find((s) => s.id === "materials.price-check");
    expect(check?.producesAlerts).toBe(true);
    expect((check?.output as { required?: string[] } | undefined)?.required).toContain("sources");
    expect(check?.settings.find((s) => s.key === "ignore_vendors")?.clientSpecific).toBe(true);
    expect(check?.settings.find((s) => s.key === "price_change_pct")?.default).toBe(5);
  });
});
