// SOC 2 readiness (§1.218): every criterion in scope is listed once, with an owner; the register's
// SOC 2 references are all criteria in scope (or Processing Integrity, out of scope); and the
// status rule and live checks say what they should.
import { describe, expect, it } from "vitest";
import { CONTROLS, type Control, POLICIES } from "./controls";
import {
  combineReadiness,
  previousQuarter,
  quarterEnd,
  quarterOf,
  readinessCounts,
  SOC2_CATEGORIES,
  SOC2_CHECKS,
  SOC2_CRITERIA,
  SOC2_OWNERS,
  type Soc2Facts,
  soc2Readiness,
} from "./soc2";

const NOW = "2026-11-22T12:00:00.000Z";
const none: Soc2Facts = { now: NOW, accessReviews: [], deletionDrill: null };

const review = (period: string, createdAt: string) => ({
  id: `r-${period}`,
  period,
  createdAt,
  reviewerEmail: "officer@example.com",
  clients: 3,
  people: 9,
  removals: 1,
});

const row = (facts: Soc2Facts, id: string) => {
  const found = soc2Readiness(facts).find((r) => r.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the SOC 2 checklist", () => {
  it("lists each criterion once, in its category's order, with an owner", () => {
    const ids = SOC2_CRITERIA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SOC2_CRITERIA) {
      expect(c.id.startsWith(c.category), c.id).toBe(true);
      expect(SOC2_OWNERS[c.category].length, c.id).toBeGreaterThan(0);
    }
    const order = SOC2_CRITERIA.map((c) => SOC2_CATEGORIES.indexOf(c.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("covers every SOC 2 reference the register makes, except Processing Integrity", () => {
    const ids = new Set(SOC2_CRITERIA.map((c) => c.id));
    for (const c of CONTROLS) {
      for (const ref of c.maps.soc2 ?? []) {
        if (!ref.startsWith("PI")) expect(ids.has(ref), `${c.id} → ${ref}`).toBe(true);
      }
    }
  });

  it("checks only criteria in scope, and says what would answer one nothing answers yet", () => {
    const ids = new Set(SOC2_CRITERIA.map((c) => c.id));
    for (const check of SOC2_CHECKS) {
      for (const id of check.criteria) expect(ids.has(id), `${check.id} → ${id}`).toBe(true);
    }
    for (const r of soc2Readiness(none)) {
      if (r.controls.length === 0 && r.checks.length === 0) {
        expect(r.status, r.id).toBe("missing");
        expect(r.hint?.length, `${r.id} has a hint`).toBeGreaterThan(0);
      }
    }
  });

  it("is in place only when everything answering is, missing when nothing is even partly", () => {
    expect(combineReadiness([])).toBe("missing");
    expect(combineReadiness(["in_place", "in_place"])).toBe("in_place");
    expect(combineReadiness(["missing", "missing"])).toBe("missing");
    expect(combineReadiness(["in_place", "missing"])).toBe("partial");
    expect(combineReadiness(["partial"])).toBe("partial");
  });

  it("reads a control's status and keeps each piece of evidence once", () => {
    const fake: Control[] = [
      {
        id: "T-1",
        area: "access",
        title: "a",
        statement: "a",
        status: "in_place",
        tier: "all",
        evidence: [{ kind: "code", ref: "x" }],
        maps: { soc2: ["CC6.1"] },
      },
      {
        id: "T-2",
        area: "access",
        title: "b",
        statement: "b",
        status: "planned",
        gap: "not yet",
        tier: "all",
        evidence: [{ kind: "code", ref: "x" }],
        maps: { soc2: ["CC6.1", "CC6.6"] },
      },
    ];
    const rows = soc2Readiness(none, fake, []);
    const cc61 = rows.find((r) => r.id === "CC6.1");
    expect(cc61?.status).toBe("partial");
    expect(cc61?.evidence).toEqual([{ kind: "code", ref: "x" }]);
    expect(cc61?.controls.map((c) => c.id)).toEqual(["T-1", "T-2"]);
    expect(rows.find((r) => r.id === "CC6.6")?.status).toBe("missing");
    expect(readinessCounts(rows).in_place).toBe(0);
    expect(readinessCounts(rows).partial).toBe(1);
  });
});

describe("the quarter", () => {
  it("is the calendar quarter in UTC", () => {
    expect(quarterOf(new Date("2026-11-22T00:00:00Z"))).toBe("2026-Q4");
    expect(quarterOf(new Date("2027-01-01T00:00:00Z"))).toBe("2027-Q1");
    expect(previousQuarter("2027-Q1")).toBe("2026-Q4");
    expect(previousQuarter("2026-Q3")).toBe("2026-Q2");
    expect(quarterEnd("2026-Q4")).toBe("2026-12-31");
    expect(quarterEnd("2027-Q1")).toBe("2027-03-31");
  });
});

describe("the live checks", () => {
  const check = (facts: Soc2Facts, criterion: string, id: string) =>
    row(facts, criterion).checks.find((c) => c.id === id);

  it("wants this quarter's access review: last quarter's is partial, none or older is missing", () => {
    expect(check(none, "CC6.2", "access-review")?.status).toBe("missing");
    expect(check(none, "CC6.2", "access-review")?.detail).toMatch(/due by 2026-12-31/);
    const last = { ...none, accessReviews: [review("2026-Q3", "2026-09-30T10:00:00Z")] };
    expect(check(last, "CC6.3", "access-review")?.status).toBe("partial");
    const older = { ...none, accessReviews: [review("2026-Q1", "2026-03-30T10:00:00Z")] };
    expect(check(older, "CC6.3", "access-review")?.status).toBe("missing");
    const done = {
      ...none,
      accessReviews: [review("2026-Q4", "2026-11-20T10:00:00Z"), review("2026-Q3", "2026-09-30")],
    };
    const result = check(done, "CC6.2", "access-review");
    expect(result?.status).toBe("in_place");
    expect(result?.detail).toMatch(/^2026-Q4 recorded on 2026-11-20/);
  });

  it("wants a passing deletion drill within a year", () => {
    expect(check(none, "C1.2", "deletion-drill")?.status).toBe("missing");
    const drill = (at: string, ok: boolean) => ({
      ...none,
      deletionDrill: { at, ok, tables: 120, rows: 900, failed: ok ? null : "rows left in run" },
    });
    expect(check(drill("2026-11-01T00:00:00Z", true), "CC6.5", "deletion-drill")?.status).toBe(
      "in_place",
    );
    expect(check(drill("2025-06-01T00:00:00Z", true), "CC6.5", "deletion-drill")?.status).toBe(
      "partial",
    );
    const failed = check(drill("2026-11-01T00:00:00Z", false), "CC6.5", "deletion-drill");
    expect(failed?.status).toBe("missing");
    expect(failed?.detail).toMatch(/rows left in run/);
  });

  it("counts an adopted policy in place and a draft as partial", () => {
    const adopted = POLICIES.find((p) => p.adopted);
    const draft = POLICIES.find((p) => p.version && !p.adopted && p.path);
    expect(adopted && draft).toBeTruthy();
    expect(check(none, "CC8.1", "policy:change-management")?.status).toBe(
      POLICIES.find((p) => p.id === "change-management")?.adopted ? "in_place" : "partial",
    );
    expect(check(none, "CC5.3", "policy:information-security")?.status).toBe("in_place");
  });
});
