import { describe, expect, it } from "vitest";
import {
  assuranceRollup,
  EVIDENCE_CSV_COLUMNS,
  evidenceCsvValues,
  evidencePeriod,
  evidenceRow,
  type StoredCheckRow,
} from "./evidence";

// §1.231.3 (A4): the evidence export's rows and period, and the rollup per register control.

const row = (over: Partial<StoredCheckRow> = {}): StoredCheckRow => ({
  id: "r1",
  tenantId: "t1",
  clientName: "Harbor Millwork",
  agentId: "a1",
  agentName: "Bills in",
  version: 7,
  checkId: "delete_off",
  kind: "setup",
  controls: ["AGT-1"],
  result: "verified",
  found: "Off on QuickBooks Online",
  evidence: { connections: ["c1"], open: [] },
  periodStart: null,
  periodEnd: null,
  checkedAt: new Date("2026-11-21T08:23:00.000Z"),
  trigger: "nightly",
  issueId: null,
  ...over,
});

describe("the evidence export", () => {
  it("names each result's check, its SOC 2 criteria and its evidence ids", () => {
    const r = evidenceRow(row());
    expect(r).toMatchObject({ number: "K3", name: "Delete is off", version: 7 });
    expect(r.soc2).toEqual(["CC8.1", "PI1.3"]);
    const csv = evidenceCsvValues(r);
    expect(csv).toHaveLength(EVIDENCE_CSV_COLUMNS.length);
    expect(csv[9]).toBe("Verified");
    expect(csv[11]).toBe('{"connections":["c1"],"open":[]}');
  });

  it("covers the last 30 days by default, whole UTC days, at most a year, never backwards", () => {
    const now = new Date("2026-11-22T15:00:00.000Z");
    const p = evidencePeriod({}, now);
    expect(p?.end.toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(p?.start.toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(evidencePeriod({ from: "2026-11-01", to: "2026-11-01" }, now)?.end.toISOString()).toBe(
      "2026-11-02T00:00:00.000Z",
    );
    expect(evidencePeriod({ from: "2026-11-20", to: "2026-11-01" }, now)).toBeNull();
    expect(evidencePeriod({ from: "2024-01-01", to: "2026-11-01" }, now)).toBeNull();
  });
});

describe("the rollup", () => {
  it("counts agents per control: verified, in review at any point, or not applicable", () => {
    const out = assuranceRollup([
      row({ agentId: "a1", controls: ["AGT-1"], result: "verified" }),
      row({ agentId: "a1", controls: ["AGT-1"], result: "in_review" }),
      row({ agentId: "a2", controls: ["AGT-1"], result: "verified" }),
      row({ agentId: "a3", controls: ["AGT-1"], result: "not_applicable" }),
      row({ agentId: "a2", controls: ["ACC-2"], result: "verified" }),
    ]);
    expect(out.find((c) => c.id === "AGT-1")).toMatchObject({
      agents: 3,
      verified: 1,
      inReview: 1,
      notApplicable: 1,
      results: 4,
    });
    expect(out.find((c) => c.id === "ACC-2")).toMatchObject({ agents: 1, verified: 1 });
    // Only controls an agent check proves; the platform's own are on the register's pages.
    expect(out.find((c) => c.id === "GOV-1")).toBeUndefined();
    expect(out.find((c) => c.id === "ISO-1")).toMatchObject({ agents: 0 });
  });
});
