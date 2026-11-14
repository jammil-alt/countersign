// The security register (§1.100): ids are stable and unique, every reference resolves, every
// file it names as evidence exists, and the summaries count what they say.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROLS,
  type Control,
  controlsForTier,
  FRAMEWORKS,
  frameworkSummaries,
  POLICIES,
  PROCESSOR_RECEIVES,
  ROUTINES,
} from "./controls";
import { PROCESSORS } from "./processors";

const ROOT = resolve(__dirname, "../../../..");

describe("the security register", () => {
  it("has unique ids of the form AREA-n", () => {
    const ids = CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Z]{3}-\d+$/);
  });

  it("says what is open for every control not fully in place, and nothing for the rest", () => {
    for (const c of CONTROLS) {
      if (c.status === "in_place") expect(c.gap, c.id).toBeUndefined();
      else expect(c.gap?.length, c.id).toBeGreaterThan(0);
    }
  });

  it("maps every control to at least one framework and names evidence", () => {
    for (const c of CONTROLS) {
      expect(
        FRAMEWORKS.some((f) => (c.maps[f]?.length ?? 0) > 0),
        c.id,
      ).toBe(true);
      expect(c.evidence.length, c.id).toBeGreaterThan(0);
    }
  });

  it("names only routines that exist, and every routine keeps some control working", () => {
    const routines = new Set(ROUTINES.map((r) => r.id));
    const used = new Set<string>();
    for (const c of CONTROLS) {
      for (const r of c.routines ?? []) {
        expect(routines.has(r), `${c.id} → ${r}`).toBe(true);
        used.add(r);
      }
    }
    for (const r of routines) {
      if (r !== "client-exit") expect(used.has(r), r).toBe(true);
    }
  });

  it("names files that exist, so the evidence doesn't drift from the code", () => {
    const paths = [
      ...CONTROLS.flatMap((c) => c.evidence)
        .filter((e) => e.kind === "code" || e.kind === "policy")
        .map((e) => e.ref),
      ...POLICIES.flatMap((p) => (p.path ? [p.path] : [])),
    ];
    for (const p of new Set(paths)) expect(existsSync(resolve(ROOT, p)), p).toBe(true);
  });

  it("says what every vendor receives", () => {
    for (const p of PROCESSORS) expect(PROCESSOR_RECEIVES[p]?.length, p).toBeGreaterThan(0);
  });

  it("counts each framework's controls by status", () => {
    const fake: Control[] = [
      {
        id: "T-1",
        area: "access",
        title: "a",
        statement: "a",
        status: "in_place",
        tier: "all",
        evidence: [{ kind: "code", ref: "x" }],
        maps: { soc2: ["CC6.1", "CC6.2"], hipaa: ["164.312(b)"] },
      },
      {
        id: "T-2",
        area: "access",
        title: "b",
        statement: "b",
        status: "planned",
        gap: "b",
        tier: "regulated",
        evidence: [{ kind: "code", ref: "x" }],
        maps: { soc2: ["CC6.1"] },
      },
    ];
    expect(frameworkSummaries(fake)).toEqual([
      {
        framework: "soc2",
        references: 2,
        controls: 2,
        counts: { in_place: 1, partial: 0, planned: 1 },
      },
      {
        framework: "hipaa",
        references: 1,
        controls: 1,
        counts: { in_place: 1, partial: 0, planned: 0 },
      },
      {
        framework: "pci",
        references: 0,
        controls: 0,
        counts: { in_place: 0, partial: 0, planned: 0 },
      },
    ]);
    expect(controlsForTier(false, fake).map((c) => c.id)).toEqual(["T-1"]);
    expect(controlsForTier(true, fake).map((c) => c.id)).toEqual(["T-1", "T-2"]);
  });
});
