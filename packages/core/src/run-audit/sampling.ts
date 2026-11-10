// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): which finished runs go to a person's audit.
// A client's rule (with an agent's override) says: every run that wrote to the client's tools,
// plus a share of the rest. The share is picked by a hash of the run id, so the same run is always
// picked or not, whenever and however often the choice is made (a replayed finish step agrees).
// The rule lives in the client's settings (`tenant.settings.runAudit`); no column, no table.
//
// Pure.

import { z } from "zod";
import { isPlainObject } from "../json";

/** A sampling rule: every run that wrote to the client's tools, and this percent of the rest. */
export const AuditRule = z
  .strictObject({
    /** Queue every run that made a change in the client's tools (an external action done). */
    writes: z.boolean(),
    /** Of the other runs, this percent (0 to 100, to two decimals). */
    percent: z.number().min(0).max(100),
  })
  .meta({ id: "AuditRule" });
export type AuditRule = z.infer<typeof AuditRule>;

/** What a client starts with. */
// DECISION (wave 6): on by default: every run that wrote to a client's tool plus 5% of the rest.
// A write is what an auditor most wants to see; 5% of the rest keeps the reads honest without a
// queue nobody can keep up with.
export const DEFAULT_AUDIT_RULE: AuditRule = { writes: true, percent: 5 };

/** `tenant.settings.runAudit`: the client's rule and each agent's override, by agent id. */
export const RunAuditSettings = z.object({
  rule: AuditRule.optional(),
  agents: z.record(z.string(), AuditRule).optional(),
});
export type RunAuditSettings = z.infer<typeof RunAuditSettings>;

/** The settings stored under a client's `runAudit`; anything that doesn't parse reads as none. */
export function runAuditSettingsOf(tenantSettings: unknown): RunAuditSettings {
  if (!isPlainObject(tenantSettings)) return {};
  const parsed = RunAuditSettings.safeParse(tenantSettings.runAudit);
  return parsed.success ? parsed.data : {};
}

/** Where the rule a run was judged by came from. */
export const AUDIT_RULE_SOURCES = ["default", "client", "agent"] as const;
export type AuditRuleSource = (typeof AUDIT_RULE_SOURCES)[number];

/** The rule for one agent: its override, else the client's, else the default. */
export function effectiveAuditRule(
  settings: RunAuditSettings,
  agentId: string,
): { rule: AuditRule; source: AuditRuleSource } {
  const own =
    settings.agents && Object.hasOwn(settings.agents, agentId)
      ? settings.agents[agentId]
      : undefined;
  if (own) return { rule: own, source: "agent" };
  if (settings.rule) return { rule: settings.rule, source: "client" };
  return { rule: DEFAULT_AUDIT_RULE, source: "default" };
}

/** Buckets a run id falls in: 0 to 9,999, one per hundredth of a percent. */
export const AUDIT_BUCKETS = 10_000;

/**
 * The run's bucket: FNV-1a (32-bit) over its id, lowercased, modulo 10,000. Stable for an id, the
 * same in a Worker and in Node, and spread evenly enough over uuids.
 */
export function auditBucket(runId: string): number {
  let h = 0x811c9dc5;
  for (const ch of runId.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AUDIT_BUCKETS;
}

/** The rule as a run was judged by, kept on its queue row (`run_audit.rule`). */
export const AppliedAuditRule = AuditRule.extend({
  source: z.enum(AUDIT_RULE_SOURCES),
  /** The run's bucket (`auditBucket`); sampled when below `percent × 100`. */
  bucket: z
    .number()
    .int()
    .min(0)
    .max(AUDIT_BUCKETS - 1),
});
export type AppliedAuditRule = z.infer<typeof AppliedAuditRule>;

/** Whether a finished run is queued for audit, and why. */
export interface AuditChoice {
  queued: boolean;
  reason: "wrote" | "sampled" | null;
  applied: AppliedAuditRule;
}

/** Applies a rule to a finished run: a write first, else its bucket against the percent. */
export function chooseForAudit(input: {
  runId: string;
  wrote: boolean;
  rule: AuditRule;
  source: AuditRuleSource;
}): AuditChoice {
  const bucket = auditBucket(input.runId);
  const applied: AppliedAuditRule = { ...input.rule, source: input.source, bucket };
  if (input.rule.writes && input.wrote) return { queued: true, reason: "wrote", applied };
  // Hundredths of a percent: 5% is buckets 0 to 499.
  const cut = Math.round(input.rule.percent * 100);
  if (bucket < cut) return { queued: true, reason: "sampled", applied };
  return { queued: false, reason: null, applied };
}
