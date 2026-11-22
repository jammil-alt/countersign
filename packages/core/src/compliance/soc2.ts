// SOC 2 readiness (docs/plan.md §1.218): each Trust Services Criterion in our scope (Security,
// Availability, Confidentiality) as in place, partial or missing, with its owner and its evidence.
// It is read from two places: the register (`CONTROLS`, which says what each control answers) and
// a few live checks that need the database (the quarterly access review's record, the yearly
// deletion drill) or the policies' state (adopted or still a draft).
//
// Loaded only by the readiness screen and its API route, never by the web app's first load.
//
// DECISION (§1.218): a criterion is in place when everything that answers it is; missing when
// nothing does, or nothing that does is even partly in place; partial otherwise. A criterion no
// control answers yet stays missing, so the list shows what is left to build, not only what is.
// DECISION (§1.218): the scope is the one `FRAMEWORK_SCOPE.soc2` names: Security (CC1–CC9),
// Availability (A1) and Confidentiality (C1). Processing Integrity (PI1), which one control maps
// to, is out of scope and left out here.

import { CONTROLS, type Control, type ControlStatus, type Evidence, POLICIES } from "./controls";

export const READINESS_STATUSES = ["in_place", "partial", "missing"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const READINESS_STATUS_NAMES: Record<ReadinessStatus, string> = {
  in_place: "In place",
  partial: "Partial",
  missing: "Missing",
};

export const SOC2_CATEGORIES = [
  "CC1",
  "CC2",
  "CC3",
  "CC4",
  "CC5",
  "CC6",
  "CC7",
  "CC8",
  "CC9",
  "A1",
  "C1",
] as const;
export type Soc2Category = (typeof SOC2_CATEGORIES)[number];

export const SOC2_CATEGORY_NAMES: Record<Soc2Category, string> = {
  CC1: "Control environment",
  CC2: "Communication and information",
  CC3: "Risk assessment",
  CC4: "Monitoring",
  CC5: "Control activities",
  CC6: "Logical and physical access",
  CC7: "System operations",
  CC8: "Change management",
  CC9: "Risk mitigation",
  A1: "Availability",
  C1: "Confidentiality",
};

/**
 * Who answers for each group of criteria. DECISION (§1.218): the information security policy
 * (§2) names one role, the security officer, who owns every group today; the map is here so a
 * group moves to another owner by pull request as the team grows.
 */
export const SOC2_OWNERS: Record<Soc2Category, string> = {
  CC1: "Security officer",
  CC2: "Security officer",
  CC3: "Security officer",
  CC4: "Security officer",
  CC5: "Security officer",
  CC6: "Security officer",
  CC7: "Security officer",
  CC8: "Security officer",
  CC9: "Security officer",
  A1: "Security officer",
  C1: "Security officer",
};

export type Soc2Criterion = {
  /** The criterion's reference, e.g. `CC6.2`. */
  id: string;
  category: Soc2Category;
  /** What it asks, in our own short words (the criteria's text is the AICPA's). */
  title: string;
  /** Where nothing answers it yet: what would. */
  hint?: string;
};

export const SOC2_CRITERIA: readonly Soc2Criterion[] = [
  { id: "CC1.1", category: "CC1", title: "Integrity and ethical values" },
  {
    id: "CC1.2",
    category: "CC1",
    title: "Oversight of internal control",
    hint: "A yearly written review of the controls by the owner, separate from running them.",
  },
  { id: "CC1.3", category: "CC1", title: "Structure, reporting lines and authority" },
  { id: "CC1.4", category: "CC1", title: "Competence: hiring, training, keeping people" },
  { id: "CC1.5", category: "CC1", title: "Accountability for controls" },
  {
    id: "CC2.1",
    category: "CC2",
    title: "Good information to run the controls",
    hint: "The register and this checklist, once the evidence pack (S-3) is kept with each review.",
  },
  { id: "CC2.2", category: "CC2", title: "Telling our people their responsibilities" },
  { id: "CC2.3", category: "CC2", title: "Telling clients and vendors what they need to know" },
  { id: "CC3.1", category: "CC3", title: "Objectives clear enough to find risks" },
  { id: "CC3.2", category: "CC3", title: "Risks found and analysed" },
  { id: "CC3.3", category: "CC3", title: "Fraud risk considered" },
  { id: "CC3.4", category: "CC3", title: "Significant changes assessed" },
  { id: "CC4.1", category: "CC4", title: "Controls evaluated, ongoing and separately" },
  {
    id: "CC4.2",
    category: "CC4",
    title: "Deficiencies reported and fixed",
    hint: "Findings from scans, drills and reviews tracked to their fix (the production scan's issue does this for scans).",
  },
  {
    id: "CC5.1",
    category: "CC5",
    title: "Control activities chosen against the risks",
    hint: "Follows from the risk analysis (GOV-3): each risk named with the controls that answer it.",
  },
  {
    id: "CC5.2",
    category: "CC5",
    title: "General controls over technology",
    hint: "Already largely the access, change and logging controls; map them here once the risk analysis is written.",
  },
  { id: "CC5.3", category: "CC5", title: "Policies and procedures in place" },
  { id: "CC6.1", category: "CC6", title: "Logical access security" },
  { id: "CC6.2", category: "CC6", title: "Granting access" },
  { id: "CC6.3", category: "CC6", title: "Changing and removing access" },
  {
    id: "CC6.4",
    category: "CC6",
    title: "Physical access",
    hint: "Ours is our vendors' data centres (Cloudflare, Neon): carved out to their own SOC 2 reports, checked in the yearly vendor review.",
  },
  { id: "CC6.5", category: "CC6", title: "Data protected when systems or clients are retired" },
  { id: "CC6.6", category: "CC6", title: "Protection from threats outside" },
  { id: "CC6.7", category: "CC6", title: "Data protected in transit" },
  { id: "CC6.8", category: "CC6", title: "Malicious software prevented or detected" },
  { id: "CC7.1", category: "CC7", title: "Vulnerabilities and configuration changes found" },
  { id: "CC7.2", category: "CC7", title: "Anomalies monitored" },
  { id: "CC7.3", category: "CC7", title: "Security events evaluated" },
  { id: "CC7.4", category: "CC7", title: "Incidents responded to" },
  { id: "CC7.5", category: "CC7", title: "Recovery from incidents" },
  { id: "CC8.1", category: "CC8", title: "Changes authorised, tested and approved" },
  {
    id: "CC9.1",
    category: "CC9",
    title: "Business disruption risk",
    hint: "A short continuity plan: what we do if a vendor or the owner is unavailable (with the risk analysis).",
  },
  { id: "CC9.2", category: "CC9", title: "Vendor and partner risk" },
  {
    id: "A1.1",
    category: "A1",
    title: "Capacity watched and planned",
    hint: "The provider dashboards' limits reviewed with the quarterly edge review, and written down.",
  },
  { id: "A1.2", category: "A1", title: "Backups and recovery infrastructure" },
  { id: "A1.3", category: "A1", title: "Recovery tested" },
  { id: "C1.1", category: "C1", title: "Confidential information identified and protected" },
  { id: "C1.2", category: "C1", title: "Confidential information disposed of" },
];

// ── The facts only the database knows ────────────────────────────────────────────────────────────

export type AccessReviewFact = {
  id: string;
  /** `2026-Q4` */
  period: string;
  createdAt: string;
  reviewerEmail: string;
  clients: number;
  people: number;
  removals: number;
};

export type DeletionDrillFact = {
  at: string;
  ok: boolean;
  /** Tables and rows the drill client had, all purged. */
  tables: number;
  rows: number;
  /** What failed, when it did. */
  failed: string | null;
};

export type Soc2Facts = {
  now: string;
  /** Newest first. */
  accessReviews: readonly AccessReviewFact[];
  deletionDrill: DeletionDrillFact | null;
};

/** The calendar quarter a time falls in, in UTC: `2026-Q4`. */
export function quarterOf(at: Date): string {
  return `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
}

/** The quarter before: `2026-Q1` → `2025-Q4`. */
export function previousQuarter(period: string): string {
  const [y, q] = period.split("-Q").map(Number) as [number, number];
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}

/** The last day of a quarter, `YYYY-MM-DD`. */
export function quarterEnd(period: string): string {
  const [y, q] = period.split("-Q").map(Number) as [number, number];
  return new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
}

const YEAR_MS = 365 * 86_400_000;

// ── Live checks ──────────────────────────────────────────────────────────────────────────────────

export type Soc2CheckResult = {
  id: string;
  title: string;
  status: ReadinessStatus;
  /** What the check found, in a sentence. */
  detail: string;
  evidence: readonly Evidence[];
};

type Soc2Check = {
  id: string;
  title: string;
  criteria: readonly string[];
  evaluate: (facts: Soc2Facts) => Omit<Soc2CheckResult, "id" | "title">;
};

const day = (iso: string) => iso.slice(0, 10);

function policyCheck(id: string, criteria: readonly string[]): Soc2Check {
  const policy = POLICIES.find((p) => p.id === id);
  if (!policy) throw new Error(`soc2: no policy ${id}`);
  return {
    id: `policy:${id}`,
    title: `${policy.title} policy`,
    criteria,
    evaluate: () => {
      const evidence: Evidence[] = policy.path ? [{ kind: "policy", ref: policy.path }] : [];
      if (policy.adopted) {
        return {
          status: "in_place",
          detail: `Version ${policy.version}, adopted ${policy.adopted}.`,
          evidence,
        };
      }
      if (policy.path) {
        return {
          status: "partial",
          detail: "Drafted; waiting for the owner to adopt it.",
          evidence,
        };
      }
      return { status: "missing", detail: "Not written yet.", evidence };
    },
  };
}

export const SOC2_CHECKS: readonly Soc2Check[] = [
  {
    id: "access-review",
    title: "Quarterly access review recorded",
    criteria: ["CC6.2", "CC6.3"],
    evaluate: (facts) => {
      const now = quarterOf(new Date(facts.now));
      const evidence: Evidence[] = [{ kind: "record", ref: "/ops/security/soc2#access-reviews" }];
      const current = facts.accessReviews.find((r) => r.period === now);
      if (current) {
        return {
          status: "in_place",
          detail: `${now} recorded on ${day(current.createdAt)} by ${current.reviewerEmail}: ${current.people} people, ${current.removals} to remove.`,
          evidence,
        };
      }
      const last = facts.accessReviews.find((r) => r.period === previousQuarter(now));
      if (last) {
        return {
          status: "partial",
          detail: `${last.period} recorded; ${now}'s is due by ${quarterEnd(now)}.`,
          evidence,
        };
      }
      return {
        status: "missing",
        detail: facts.accessReviews[0]
          ? `The last one is ${facts.accessReviews[0].period}; ${now}'s is due by ${quarterEnd(now)}.`
          : `None recorded yet; ${now}'s is due by ${quarterEnd(now)}.`,
        evidence,
      };
    },
  },
  {
    id: "deletion-drill",
    title: "Client deletion tested on a Sandbox client",
    criteria: ["CC6.5", "C1.2"],
    evaluate: (facts) => {
      const evidence: Evidence[] = [
        { kind: "code", ref: "packages/db/src/deletion-drill.ts" },
        { kind: "record", ref: "/ops/security/audit?action=client.deletion_drill" },
      ];
      const d = facts.deletionDrill;
      if (!d) return { status: "missing", detail: "Not run yet.", evidence };
      if (!d.ok) {
        return {
          status: "missing",
          detail: `The last drill, ${day(d.at)}, failed: ${d.failed ?? "see the audit log"}.`,
          evidence,
        };
      }
      const fresh = new Date(facts.now).getTime() - new Date(d.at).getTime() <= YEAR_MS;
      return {
        status: fresh ? "in_place" : "partial",
        detail: fresh
          ? `Passed ${day(d.at)}: ${d.rows} rows in ${d.tables} tables purged, nothing left.`
          : `Last passed ${day(d.at)}, over a year ago.`,
        evidence,
      };
    },
  },
  policyCheck("information-security", ["CC1.1", "CC2.2", "CC5.3"]),
  policyCheck("data-retention", ["C1.2"]),
  policyCheck("change-management", ["CC8.1"]),
  policyCheck("incident-response", ["CC7.3", "CC7.4", "CC7.5"]),
  policyCheck("vendor-management", ["CC9.2"]),
];

// ── The checklist ────────────────────────────────────────────────────────────────────────────────

const FROM_CONTROL: Record<ControlStatus, ReadinessStatus> = {
  in_place: "in_place",
  partial: "partial",
  planned: "missing",
};

export type Soc2Row = Soc2Criterion & {
  owner: string;
  status: ReadinessStatus;
  /** The controls that answer it, with their own status. */
  controls: readonly Pick<Control, "id" | "title" | "status" | "gap">[];
  checks: readonly Soc2CheckResult[];
  /** Where an auditor looks: every control's evidence and every check's, without repeats. */
  evidence: readonly Evidence[];
};

/** One status from the statuses of what answers a criterion (see the DECISION at the top). */
export function combineReadiness(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  if (statuses.length === 0) return "missing";
  if (statuses.every((s) => s === "in_place")) return "in_place";
  if (statuses.every((s) => s === "missing")) return "missing";
  return "partial";
}

/** The readiness checklist: every criterion in scope, in order. */
export function soc2Readiness(
  facts: Soc2Facts,
  controls: readonly Control[] = CONTROLS,
  checks: readonly Soc2Check[] = SOC2_CHECKS,
): Soc2Row[] {
  const results = checks.map((c) => ({
    criteria: c.criteria,
    result: { id: c.id, title: c.title, ...c.evaluate(facts) },
  }));
  return SOC2_CRITERIA.map((criterion) => {
    const answering = controls.filter((c) => c.maps.soc2?.includes(criterion.id));
    const own = results.filter((r) => r.criteria.includes(criterion.id)).map((r) => r.result);
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const e of [...answering.flatMap((c) => c.evidence), ...own.flatMap((r) => r.evidence)]) {
      const key = `${e.kind}:${e.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(e);
    }
    return {
      ...criterion,
      owner: SOC2_OWNERS[criterion.category],
      status: combineReadiness([
        ...answering.map((c) => FROM_CONTROL[c.status]),
        ...own.map((r) => r.status),
      ]),
      controls: answering.map(({ id, title, status, gap }) => ({
        id,
        title,
        status,
        ...(gap ? { gap } : {}),
      })),
      checks: own,
      evidence,
    };
  });
}

/** How many criteria are in each state. */
export function readinessCounts(rows: readonly Soc2Row[]): Record<ReadinessStatus, number> {
  const counts: Record<ReadinessStatus, number> = { in_place: 0, partial: 0, missing: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}
