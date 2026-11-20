// The Sales pack's manifest (docs/plan.md §1.164): it parses, its tools are the pack's and the Sales
// area's, only the two that embed or ask a model say so, and it names the connection it needs.

import { PackManifest } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { SALES_HANDLERS, SALES_SKILLS, salesManifest } from "./manifest";

describe("the Sales pack's manifest", () => {
  it("parses, with its tools, skills and the Zoho CRM connection", () => {
    const m = PackManifest.parse(salesManifest);
    expect(m.id).toBe("sales");
    expect(m.name).toBe("Sales");
    expect(m.tools.map((t) => t.id).sort()).toEqual([
      "sales.keys.refresh",
      "sales.match_records",
      "sales.matches.confirmed",
      "sales.records.lookup",
    ]);
    expect(m.connections).toEqual([expect.objectContaining({ connectors: ["zoho_crm"] })]);
    expect(Object.keys(SALES_HANDLERS).sort()).toEqual(m.tools.map((t) => t.id).sort());
  });

  it("puts every tool in the Sales area, and says which call a model", () => {
    for (const t of salesManifest.tools) {
      expect(t.source).toBe("sales");
      expect(t.area).toBe("sales");
    }
    const usesModel = salesManifest.tools.filter((t) => t.usesModel).map((t) => t.id);
    expect(usesModel.sort()).toEqual(["sales.keys.refresh", "sales.match_records"]);
    for (const id of ["sales.records.lookup", "sales.matches.confirmed"]) {
      const read = salesManifest.tools.find((t) => t.id === id);
      expect(read, id).toMatchObject({ sideEffect: "none", verb: "read" });
    }
  });

  it("ships Spreadsheet to Zoho: Sales' area, approval on, the update grouped per run", () => {
    const [template] = salesManifest.templates;
    expect(template?.slug).toBe("spreadsheet-to-zoho");
    expect(template?.bundle.definition).toMatchObject({
      area: "sales",
      permissions: { mode: "suggest_only" },
    });
    const v2 = template?.versions?.at(-1) as unknown as {
      definition: { area: string; skills: { skill: string; parameters?: unknown }[] };
      workflows: { workflow: { triggers: unknown[]; steps: Record<string, unknown>[] } }[];
    };
    expect(v2.definition.area).toBe("sales");
    const process = v2.workflows[0]?.workflow;
    // The step ids are fixed: merges line up by them.
    expect(process?.steps.map((s) => s.id)).toEqual([
      "read",
      "shape",
      "match",
      "needs-person",
      "confirmed",
      "update",
    ]);
    const text = JSON.stringify(process);
    expect(text).toContain('"review":"sales.match"');
    const update = process?.steps.find((s) => s.id === "update") as {
      kind: string;
      concurrency: number;
      steps: { tool: string; checks: { approval: { required: string } } }[];
    };
    expect(update.kind).toBe("for_each");
    expect(update.concurrency).toBe(50);
    expect(update.steps[0]).toMatchObject({
      tool: "zoho_crm.record.update",
      checks: { approval: { required: "required" } },
    });
    // The template's columns are everyone's; none is one client's.
    const read = v2.definition.skills.find((s) => s.skill === "data.read-table");
    expect(JSON.stringify(read?.parameters)).not.toContain("clientSpecific");
  });

  it("asks the Sales area's own intake questions", () => {
    expect(salesManifest.intakeSection).toMatchObject({ kind: "area", area: "sales" });
  });

  it("gives the match its threshold and fields as the step's settings", () => {
    const match = SALES_SKILLS.find((s) => s.id === "sales.match-records");
    expect(match?.settings.map((s) => [s.key, s.default])).toEqual([
      ["match_threshold", 0.9],
      ["match_on", ""],
    ]);
    for (const s of SALES_SKILLS) expect(s.requiresPacks).toEqual(["sales"]);
  });
});
