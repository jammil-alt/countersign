// The security register (docs/plan.md §1.102) names files as evidence: each must exist, so the
// register can't drift from the code. Here rather than in packages/core, which has no Node.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONTROLS, POLICIES, SOC2_CHECKS, soc2Readiness } from "@countersign/core";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

describe("the security register's evidence", () => {
  it("names files that exist, so the evidence doesn't drift from the code", () => {
    const paths = [
      ...CONTROLS.flatMap((c) => c.evidence)
        .filter((e) => e.kind === "code" || e.kind === "policy")
        .map((e) => e.ref),
      ...POLICIES.flatMap((p) => (p.path ? [p.path] : [])),
      // §1.218: the SOC 2 readiness checks' own evidence.
      ...soc2Readiness({ now: new Date().toISOString(), accessReviews: [], deletionDrill: null })
        .flatMap((r) => r.evidence)
        .filter((e) => e.kind === "code" || e.kind === "policy")
        .map((e) => e.ref),
    ];
    expect(SOC2_CHECKS.length).toBeGreaterThan(0);
    for (const p of new Set(paths)) expect(existsSync(resolve(ROOT, p)), p).toBe(true);
  });
});
