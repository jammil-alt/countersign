import { describe, expect, it } from "vitest";
import {
  AUDIT_BUCKETS,
  auditBucket,
  chooseForAudit,
  DEFAULT_AUDIT_RULE,
  effectiveAuditRule,
  runAuditSettingsOf,
} from "./sampling";

const ids = Array.from(
  { length: 4000 },
  (_, i) =>
    `0193a5f2-7c1e-7${(i % 4096).toString(16).padStart(3, "0")}-8a1b-${i.toString(16).padStart(12, "0")}`,
);

describe("auditBucket", () => {
  it("is the same for an id every time, whatever its case", () => {
    const id = "0193A5F2-7C1E-7000-8A1B-00000000002A";
    expect(auditBucket(id)).toBe(auditBucket(id.toLowerCase()));
    expect(auditBucket(id)).toBe(auditBucket(id));
  });

  it("spreads ids over every hundredth of a percent", () => {
    const buckets = ids.map(auditBucket);
    expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...buckets)).toBeLessThan(AUDIT_BUCKETS);
    const under5 = buckets.filter((b) => b < 500).length / buckets.length;
    expect(under5).toBeGreaterThan(0.03);
    expect(under5).toBeLessThan(0.07);
  });
});

describe("chooseForAudit", () => {
  it("queues every run that wrote, and says so", () => {
    for (const runId of ids.slice(0, 50)) {
      const c = chooseForAudit({ runId, wrote: true, rule: DEFAULT_AUDIT_RULE, source: "default" });
      expect(c).toMatchObject({ queued: true, reason: "wrote" });
      expect(c.applied).toMatchObject({ writes: true, percent: 5, source: "default" });
    }
  });

  it("samples the rest by bucket, and the same run the same way each time", () => {
    for (const runId of ids.slice(0, 200)) {
      const c = chooseForAudit({ runId, wrote: false, rule: DEFAULT_AUDIT_RULE, source: "client" });
      expect(c.queued).toBe(auditBucket(runId) < 500);
      expect(c.reason).toBe(c.queued ? "sampled" : null);
      expect(
        chooseForAudit({ runId, wrote: false, rule: DEFAULT_AUDIT_RULE, source: "client" }),
      ).toEqual(c);
    }
  });

  it("queues nothing with writes off and 0%, everything at 100%", () => {
    const off = { writes: false, percent: 0 };
    expect(
      ids.some(
        (runId) => chooseForAudit({ runId, wrote: true, rule: off, source: "agent" }).queued,
      ),
    ).toBe(false);
    const all = { writes: false, percent: 100 };
    expect(
      ids.every(
        (runId) => chooseForAudit({ runId, wrote: false, rule: all, source: "agent" }).queued,
      ),
    ).toBe(true);
  });
});

describe("the rule an agent is judged by", () => {
  it("is its override, else the client's, else the default", () => {
    const settings = runAuditSettingsOf({
      runAudit: {
        rule: { writes: true, percent: 10 },
        agents: { a1: { writes: false, percent: 1 } },
      },
    });
    expect(effectiveAuditRule(settings, "a1")).toEqual({
      rule: { writes: false, percent: 1 },
      source: "agent",
    });
    expect(effectiveAuditRule(settings, "a2")).toEqual({
      rule: { writes: true, percent: 10 },
      source: "client",
    });
    expect(effectiveAuditRule({}, "a2")).toEqual({ rule: DEFAULT_AUDIT_RULE, source: "default" });
  });

  it("reads settings that don't parse as none", () => {
    expect(runAuditSettingsOf({ runAudit: { rule: { writes: "yes" } } })).toEqual({});
    expect(runAuditSettingsOf(null)).toEqual({});
    expect(
      effectiveAuditRule(runAuditSettingsOf({ runAudit: { agents: {} } }), "__proto__").source,
    ).toBe("default");
  });
});
