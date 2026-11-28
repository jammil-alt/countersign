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

  it("ships no agent template until Spreadsheet to Zoho is built again in the step model", () => {
    expect(salesManifest.templates).toEqual([]);
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
