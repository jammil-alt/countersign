// Plan entry §1.233: the AP pack's manifest is core's one pack shape, extends the Purchasing area,
// has a handler for every tool and no external tool, its skills use tools that exist, and its
// template is suggest-only in the Purchasing area with writes verified, writes nothing to a
// client's tool, and pays nothing.

import { PackManifest, processArea, processes, SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { MATERIALS_SKILLS } from "../manifest";
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
  const [t] = apManifest.templates;
  const latest = t?.versions?.at(-1);

  it("is suggest only, in the Purchasing area, with every write verified", () => {
    expect(apManifest.templates.map((x) => x.slug)).toEqual(["bills-to-pay"]);
    expect(latest?.definition).toMatchObject({
      area: "purchasing",
      permissions: { mode: "suggest_only" },
      oversight: { verify: "writes" },
    });
  });

  it("writes only records of ours: nothing to a client's tool, and no payment", () => {
    const writes: string[] = [];
    const skills = new Set([...AP_SKILLS, ...MATERIALS_SKILLS].map((s) => s.id));
    for (const w of latest?.workflows ?? []) {
      if (w.workflow.schemaVersion !== 4) continue;
      for (const { step } of processes.allSteps(w.workflow)) {
        if (step.kind === "write") writes.push(step.action ?? step.tool ?? "");
        if (step.kind === "skill") expect(skills.has(step.skill), step.skill).toBe(true);
      }
    }
    // Our records only: the reading, the purchase, the matches and prices, the bill, the list.
    expect([...new Set(writes)].sort()).toEqual([
      "ap.bill.prepare",
      "ap.pay_list.build",
      "docs.read",
      "docs.record_purchase",
      "materials.matches.record",
      "materials.prices.check",
      "materials.prices.record",
    ]);
    expect(JSON.stringify(latest)).not.toMatch(/"action":/);
  });

  it("keeps Vendor contracts' invoice step ids, so the two read alike", () => {
    const bills = latest?.workflows.find((w) => w.slug === "bill-in")?.workflow;
    if (bills?.schemaVersion !== 4) throw new Error("no process");
    const ids = processes.allSteps(bills).map((l) => l.step.id);
    for (const id of [
      "invoice",
      "purchase",
      "no-purchase",
      "lookup",
      "compare",
      "prepare",
      "suggest",
    ]) {
      expect(ids, id).toContain(id);
    }
    const weekly = latest?.workflows.find((w) => w.slug === "pay-list")?.workflow;
    if (weekly?.schemaVersion !== 4) throw new Error("no weekly process");
    const person = processes.allSteps(weekly).find((l) => l.step.id === "approve")?.step;
    expect(person).toMatchObject({ kind: "person", assignee: "client_admin" });
  });
});
