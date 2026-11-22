// The evidence export and the rollup (docs/agent-assurance-plan.md §5, A4; §1.231.3): the stored
// check results (`control_check`) over a chosen period, per agent and client, for an auditor, as
// CSV and a printable page; and, per register control, how many agents' checks were verified over
// the period, on /ops/security. Back office only (§5): the portal has neither. Evidence is counts
// and record ids, never contents (invariant 13); nothing here is a bundle, a prompt or a cost.

import { z } from "zod";
import { CONTROLS, type Control } from "../compliance/controls";
import { CHECK_RESULTS, type CheckResultValue, checkSpec } from "./checks";
import { checkedControls, controlRefs } from "./coverage";

/** The longest period one export covers. */
export const EVIDENCE_PERIOD_MAX_DAYS = 366;
/** The period when none is given: the last 30 days. */
export const EVIDENCE_PERIOD_DEFAULT_DAYS = 30;
/** The most rows one export carries; `truncated` says when there were more. */
// DECISION (§1.231.3): 5,000 rows (about a year of nightly checks for one agent's 19 checks is
// ~7,000; a narrower period or one agent covers more). The page and the CSV say when it was cut.
export const EVIDENCE_ROWS_MAX = 5000;

export const RESULT_WORDS: Record<CheckResultValue, string> = {
  verified: "Verified",
  in_review: "In review",
  not_applicable: "Not applicable",
};

export const EvidenceRow = z.object({
  id: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  agent: z.object({ id: z.string(), name: z.string() }),
  version: z.number().int().nullable(),
  checkId: z.string(),
  /** "K3", or "" for a check no longer in the list. */
  number: z.string(),
  name: z.string(),
  kind: z.string(),
  controls: z.array(z.string()),
  /** The SOC 2 criteria its controls answer (never "meets"). */
  soc2: z.array(z.string()),
  result: z.enum(CHECK_RESULTS),
  found: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  checkedAt: z.string(),
  trigger: z.string(),
  issueId: z.string().nullable(),
});
export type EvidenceRow = z.infer<typeof EvidenceRow>;

export const AssuranceEvidence = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  rows: z.array(EvidenceRow),
  truncated: z.boolean(),
  generatedAt: z.string(),
});
export type AssuranceEvidence = z.infer<typeof AssuranceEvidence>;

export const AssuranceRollupRow = z.object({
  id: z.string(),
  title: z.string(),
  soc2: z.array(z.string()),
  /** Agents with a result for a check proving this control in the period. */
  agents: z.number().int(),
  /** Of those, every result verified or not applicable, with at least one verified. */
  verified: z.number().int(),
  /** Of those, at least one result in review. */
  inReview: z.number().int(),
  /** Of those, every result not applicable. */
  notApplicable: z.number().int(),
  results: z.number().int(),
});
export type AssuranceRollupRow = z.infer<typeof AssuranceRollupRow>;

export const AssuranceRollup = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  clients: z.number().int(),
  agents: z.number().int(),
  controls: z.array(AssuranceRollupRow),
  generatedAt: z.string(),
});
export type AssuranceRollup = z.infer<typeof AssuranceRollup>;

/** A row as stored, with its client's and agent's names. */
export type StoredCheckRow = {
  id: string;
  tenantId: string;
  clientName: string;
  agentId: string;
  agentName: string;
  version: number | null;
  checkId: string;
  kind: string;
  controls: readonly string[];
  result: CheckResultValue;
  found: string;
  evidence: unknown;
  periodStart: Date | null;
  periodEnd: Date | null;
  checkedAt: Date;
  trigger: string;
  issueId: string | null;
};

/** The export's row for a stored result: the check's name and number, and its SOC 2 criteria. */
export function evidenceRow(r: StoredCheckRow): EvidenceRow {
  const spec = checkSpec(r.checkId);
  return {
    id: r.id,
    client: { id: r.tenantId, name: r.clientName },
    agent: { id: r.agentId, name: r.agentName },
    version: r.version,
    checkId: r.checkId,
    number: spec?.number ?? "",
    name: spec?.name ?? r.checkId,
    kind: r.kind,
    controls: [...r.controls],
    // DECISION (§1.231.3): SOC 2 only. HIPAA sections show only to a client in HIPAA mode (§6);
    // an auditor's export across clients doesn't carry them.
    soc2: controlRefs(r.controls, false).soc2,
    result: r.result,
    found: r.found,
    evidence:
      r.evidence && typeof r.evidence === "object" ? (r.evidence as Record<string, unknown>) : {},
    periodStart: r.periodStart?.toISOString() ?? null,
    periodEnd: r.periodEnd?.toISOString() ?? null,
    checkedAt: r.checkedAt.toISOString(),
    trigger: r.trigger,
    issueId: r.issueId,
  };
}

export const EVIDENCE_CSV_COLUMNS = [
  "checked at",
  "client",
  "agent",
  "version",
  "check",
  "name",
  "kind",
  "controls",
  "SOC 2 criteria answered",
  "result",
  "found",
  "evidence (counts and record ids)",
  "period start",
  "period end",
  "trigger",
  "issue",
] as const;

/** One CSV line's values, in `EVIDENCE_CSV_COLUMNS` order. */
export function evidenceCsvValues(r: EvidenceRow): (string | number | null | readonly string[])[] {
  return [
    r.checkedAt,
    r.client.name,
    r.agent.name,
    r.version === null ? "" : `v${r.version}`,
    r.number || r.checkId,
    r.name,
    r.kind,
    r.controls,
    r.soc2,
    RESULT_WORDS[r.result],
    r.found,
    JSON.stringify(r.evidence),
    r.periodStart,
    r.periodEnd,
    r.trigger,
    r.issueId,
  ];
}

/**
 * Per register control a check proves: over the period, how many agents' checks were verified,
 * in review at some point, or not applicable throughout.
 */
export function assuranceRollup(
  rows: readonly Pick<StoredCheckRow, "agentId" | "controls" | "result">[],
  controls: readonly Control[] = CONTROLS,
): AssuranceRollupRow[] {
  const checked = new Set(checkedControls());
  return controls
    .filter((c) => checked.has(c.id))
    .map((c) => {
      const mine = rows.filter((r) => r.controls.includes(c.id));
      const byAgent = new Map<string, CheckResultValue[]>();
      for (const r of mine) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r.result]);
      let verified = 0;
      let inReview = 0;
      let notApplicable = 0;
      for (const results of byAgent.values()) {
        if (results.includes("in_review")) inReview += 1;
        else if (results.includes("verified")) verified += 1;
        else notApplicable += 1;
      }
      return {
        id: c.id,
        title: c.title,
        soc2: [...(c.maps.soc2 ?? [])],
        agents: byAgent.size,
        verified,
        inReview,
        notApplicable,
        results: mine.length,
      };
    });
}

const DAY_MS = 86_400_000;

/**
 * The period an export covers: `from` (a date, from its start) to `to` (a date, to its end), UTC;
 * the last 30 days by default. Null when it runs backwards or is longer than the most allowed.
 */
export function evidencePeriod(
  q: { from?: string | undefined; to?: string | undefined },
  now: Date,
): { start: Date; end: Date } | null {
  const end = q.to
    ? new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + DAY_MS)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
  const start = q.from
    ? new Date(`${q.from}T00:00:00.000Z`)
    : new Date(end.getTime() - EVIDENCE_PERIOD_DEFAULT_DAYS * DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (start >= end) return null;
  if (end.getTime() - start.getTime() > EVIDENCE_PERIOD_MAX_DAYS * DAY_MS) return null;
  return { start, end };
}
