// The security and compliance register (docs/plan.md §1.100): every control Mezonas runs, what it
// commits to, where an auditor or a client's IT team sees the evidence, whether it is in place,
// and which framework requirements it answers. The back office's Security section reads it; so
// will the evidence pack and the questionnaire answers (S-3, S-5).
//
// It is code, reviewed like code: a control changes by pull request, and its status changes when
// the work lands. What the code enforces is described in `docs/security.md`; what we commit to is
// in `docs/policies/`; what is still open is in `docs/hipaa-plan.md`.
//
// DECISION (§1.100): framework references are our own mapping, at the level an auditor starts from
// (SOC 2 Trust Services Criteria 2017, rev. 2022; the HIPAA Security Rule, 45 CFR 164 Subpart C;
// PCI DSS v4.0.1 SAQ A, by requirement). The auditor confirms them; the screen says so.
//
// DECISION (§1.100): two tiers. Every client gets the Standard controls. A Regulated client is one
// in HIPAA mode (§1.35): it adds the controls marked `regulated` (BAAs, its own audit log). No new
// column: the tier is read from the client's compliance settings.

import { PROCESSORS, type Processor } from "./processors";

export const FRAMEWORKS = ["soc2", "hipaa", "pci"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const FRAMEWORK_NAMES: Record<Framework, string> = {
  soc2: "SOC 2",
  hipaa: "HIPAA",
  pci: "PCI DSS",
};

/** What each framework asks of us, in a line, for the overview. */
export const FRAMEWORK_SCOPE: Record<Framework, string> = {
  soc2: "Security, Availability and Confidentiality criteria. Type I, then a Type II period.",
  hipaa: "Security Rule safeguards, as a business associate of clients in HIPAA mode.",
  pci: "SAQ A: card payments are taken only on Stripe's hosted pages.",
};

export const CONTROL_STATUSES = ["in_place", "partial", "planned"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export const CONTROL_STATUS_NAMES: Record<ControlStatus, string> = {
  in_place: "In place",
  partial: "Partly in place",
  planned: "Planned",
};

export const CONTROL_AREAS = [
  "governance",
  "access",
  "isolation",
  "data",
  "agents",
  "logging",
  "change",
  "incidents",
  "continuity",
  "vendors",
  "lifecycle",
] as const;
export type ControlArea = (typeof CONTROL_AREAS)[number];

export const CONTROL_AREA_NAMES: Record<ControlArea, string> = {
  governance: "Governance and people",
  access: "Sign-in and access",
  isolation: "Client isolation",
  data: "Protecting data",
  agents: "Agents and writes",
  logging: "Logging and monitoring",
  change: "Changes and vulnerabilities",
  incidents: "Incidents",
  continuity: "Backups and continuity",
  vendors: "Vendors",
  lifecycle: "Retention and leaving",
};

/** Where the evidence for a control is: code, a setting outside it, a policy, a record or a screen. */
export const EVIDENCE_KINDS = ["code", "setting", "policy", "record", "screen"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_KIND_NAMES: Record<EvidenceKind, string> = {
  code: "Code",
  setting: "Setting",
  policy: "Policy",
  record: "Record",
  screen: "Screen",
};

export type Evidence = {
  kind: EvidenceKind;
  /** A repository path, a setting's place, or a back-office address (starting with `/ops`). */
  ref: string;
  /** What the auditor finds there, when the reference alone doesn't say. */
  note?: string;
};

export type ControlTier = "all" | "regulated";

export type Control = {
  /** Stable, never reused: `AREA-n`. Questionnaire answers and evidence point at it. */
  id: string;
  area: ControlArea;
  title: string;
  /** What we do, in a sentence or two, in the words a client's IT team reads. */
  statement: string;
  status: ControlStatus;
  /** What is still open, when not fully in place. */
  gap?: string;
  /** `regulated`: only for clients in HIPAA mode. */
  tier: ControlTier;
  evidence: readonly Evidence[];
  /** Framework references; an empty or missing list means the framework doesn't ask for it. */
  maps: Partial<Record<Framework, readonly string[]>>;
  /** The routines that keep it working (ROUTINES ids). */
  routines?: readonly string[];
};

const ISP = "docs/policies/information-security.md";
const DRP = "docs/policies/data-retention.md";

export const CONTROLS: readonly Control[] = [
  // ── Governance and people ──────────────────────────────────────────────────────────────────────
  {
    id: "GOV-1",
    area: "governance",
    title: "A named security officer",
    statement:
      "One person owns security: the policies, exceptions, incident response and the reviews.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§2 Roles" }],
    maps: { soc2: ["CC1.3"], hipaa: ["164.308(a)(2)"], pci: ["12.10.1"] },
  },
  {
    id: "GOV-2",
    area: "governance",
    title: "Written policies, reviewed every year",
    statement:
      "Information security and data retention policies, adopted and versioned, reviewed yearly and after any incident or major change.",
    status: "partial",
    gap: "Acceptable use is not yet written as its own policy.",
    tier: "all",
    evidence: [
      { kind: "policy", ref: ISP },
      { kind: "policy", ref: DRP },
    ],
    maps: {
      soc2: ["CC1.1", "CC2.2", "CC5.3"],
      hipaa: ["164.316(a)", "164.316(b)(2)(iii)"],
      pci: ["12.1"],
    },
    routines: ["policy-review"],
  },
  {
    id: "GOV-3",
    area: "governance",
    title: "A yearly risk analysis",
    statement:
      "We write down what could go wrong, how likely it is and what we do about it, every year and after big changes.",
    status: "planned",
    gap: "The first risk analysis is not written yet.",
    tier: "all",
    evidence: [{ kind: "record", ref: "Risk analysis (yearly)" }],
    maps: {
      soc2: ["CC3.1", "CC3.2", "CC3.3", "CC3.4"],
      hipaa: ["164.308(a)(1)(ii)(A)", "164.308(a)(1)(ii)(B)"],
      pci: ["12.3.1"],
    },
    routines: ["risk-analysis"],
  },
  {
    id: "GOV-4",
    area: "governance",
    title: "Security training at joining and every year",
    statement:
      "Everyone with access reads the policies when they join and every year, and confirms it in writing.",
    status: "partial",
    gap: "The policy requires it; confirmations are not recorded yet.",
    tier: "all",
    evidence: [
      { kind: "policy", ref: ISP, note: "§11" },
      { kind: "record", ref: "Training confirmations" },
    ],
    maps: { soc2: ["CC1.4", "CC2.2"], hipaa: ["164.308(a)(5)(i)"], pci: ["12.6"] },
    routines: ["training"],
  },
  {
    id: "GOV-5",
    area: "governance",
    title: "Sanctions and exceptions",
    statement:
      "Exceptions need the security officer's written approval with a reason and an end date. Breaking the policy can end access or the engagement.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§11" }],
    maps: { soc2: ["CC1.5"], hipaa: ["164.308(a)(1)(ii)(C)"] },
  },
  {
    id: "GOV-6",
    area: "governance",
    title: "Devices used for Mezonas",
    statement:
      "Full-disk encryption, a screen lock of 5 minutes or less, current updates and no shared users. No client data on personal devices or accounts.",
    status: "partial",
    gap: "The policy requires it; devices are not yet checked and recorded.",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§4" }],
    maps: { soc2: ["CC6.8"], hipaa: ["164.310(b)", "164.310(c)", "164.310(d)(1)"] },
  },

  // ── Sign-in and access ─────────────────────────────────────────────────────────────────────────
  {
    id: "ACC-1",
    area: "access",
    title: "Named accounts, invited and verified",
    statement:
      "Every person has their own account. Only invited, verified email addresses can sign in. No shared logins.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/auth" },
      { kind: "setting", ref: "WorkOS AuthKit", note: "docs/security.md §10" },
    ],
    maps: {
      soc2: ["CC6.1", "CC6.2"],
      hipaa: ["164.312(a)(2)(i)", "164.312(d)"],
      pci: ["8.2.1", "8.2.2"],
    },
  },
  {
    id: "ACC-2",
    area: "access",
    title: "A second factor for every sign-in",
    statement:
      "Multi-factor authentication is required for everyone, staff and clients. Staff use passkeys or hardware keys on the systems that hold client data.",
    status: "partial",
    gap: "Staff passkeys on provider consoles are policy, not yet checked and recorded.",
    tier: "all",
    evidence: [
      { kind: "setting", ref: "WorkOS: MFA required", note: "docs/security.md §10" },
      { kind: "policy", ref: ISP, note: "§3" },
    ],
    maps: { soc2: ["CC6.1"], hipaa: ["164.312(d)"], pci: ["8.3.1", "8.4.1"] },
  },
  {
    id: "ACC-3",
    area: "access",
    title: "Sessions end on their own",
    statement:
      "After 30 minutes without the person's own activity, and 12 hours after sign-in. Background polling never keeps a session alive.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/core/src/security/session-limits.ts" },
      { kind: "code", ref: "apps/web/src/session/activity.ts" },
      { kind: "setting", ref: "WorkOS: session lifetime", note: "docs/security.md §10" },
    ],
    maps: { soc2: ["CC6.1"], hipaa: ["164.312(a)(2)(iii)"], pci: ["8.2.8"] },
  },
  {
    id: "ACC-4",
    area: "access",
    title: "Least privilege by role",
    statement:
      "Three roles: Mezonas, client admin and client user. Mezonas staff reach only the clients they serve; the portal never returns agent definitions, prompts or costs.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/auth" },
      { kind: "code", ref: "apps/api/src/http.ts", note: "mount(): roles per route" },
    ],
    maps: {
      soc2: ["CC6.1", "CC6.3"],
      hipaa: ["164.308(a)(4)(ii)(B)", "164.312(a)(1)"],
      pci: ["7.2.1"],
    },
  },
  {
    id: "ACC-5",
    area: "access",
    title: "Quarterly access review",
    statement:
      "Every quarter we review every account and its roles, remove what isn't needed, and keep the dated list.",
    status: "partial",
    gap: "The review is built (/ops/security/audit, Access review); its quarterly record is kept outside the product.",
    tier: "all",
    evidence: [
      { kind: "screen", ref: "/ops/security/audit?view=access" },
      { kind: "policy", ref: ISP, note: "§3" },
    ],
    maps: { soc2: ["CC6.2", "CC6.3"], hipaa: ["164.308(a)(3)(ii)(B)", "164.308(a)(4)(ii)(C)"] },
    routines: ["access-review"],
  },
  {
    id: "ACC-6",
    area: "access",
    title: "Access removed within a business day",
    statement:
      "When someone leaves or changes role, their access is removed within one business day; a removed person's open session keeps it for at most 5 minutes.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "policy", ref: ISP, note: "§3" },
      { kind: "screen", ref: "/ops/security/audit", note: "membership changes" },
    ],
    maps: { soc2: ["CC6.2"], hipaa: ["164.308(a)(3)(ii)(C)"], pci: ["8.2.5"] },
  },

  // ── Client isolation ───────────────────────────────────────────────────────────────────────────
  {
    id: "ISO-1",
    area: "isolation",
    title: "Each client's data is walled off in the database",
    statement:
      "Every client table carries the client's id under forced row-level security. The application's database role cannot bypass it, and every query also filters by client.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/db/src/rls.test.ts" },
      { kind: "code", ref: "packages/db", note: "withTenant()" },
    ],
    maps: { soc2: ["CC6.1", "C1.1"], hipaa: ["164.312(a)(1)"] },
  },
  {
    id: "ISO-2",
    area: "isolation",
    title: "What agents learn stays with the client",
    statement:
      "Memory, aliases and catalogs belong to one client. Copying an agent to another client never carries its data, records or connections.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: "packages/agents", note: "fork and promote tests" }],
    maps: { soc2: ["C1.1"], hipaa: ["164.312(a)(1)"] },
  },
  {
    id: "ISO-3",
    area: "isolation",
    title: "No client data in CI",
    statement:
      "Tests run against a throwaway database; CI never connects to our production or staging databases.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: ".github/workflows/checks.yml" }],
    maps: { soc2: ["CC6.1", "C1.1"], pci: ["6.5.5"] },
  },

  // ── Protecting data ────────────────────────────────────────────────────────────────────────────
  {
    id: "DAT-1",
    area: "data",
    title: "Encrypted in transit",
    statement:
      "HTTPS only, TLS 1.2 or higher, HSTS for two years. The database is reached over TLS.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "setting", ref: "Cloudflare: Always Use HTTPS, minimum TLS 1.2" },
      { kind: "code", ref: "apps/api/src/security-headers.ts" },
    ],
    maps: { soc2: ["CC6.7"], hipaa: ["164.312(e)(1)", "164.312(e)(2)(ii)"], pci: ["4.2.1"] },
  },
  {
    id: "DAT-2",
    area: "data",
    title: "Encrypted at rest",
    statement: "The database (Neon) and files (Cloudflare R2) are encrypted with AES-256.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "record", ref: "Neon and Cloudflare security reports" }],
    maps: { soc2: ["CC6.1"], hipaa: ["164.312(a)(2)(iv)"] },
  },
  {
    id: "DAT-3",
    area: "data",
    title: "Clients' secrets under the client's own key",
    statement:
      "Tokens, API keys and website logins are encrypted with each client's own key, write-only, never shown to anyone (us included), never logged and never given to a model.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: "packages/connectors", note: "the vault" }],
    maps: { soc2: ["CC6.1", "C1.1"], hipaa: ["164.312(a)(2)(iv)"] },
  },
  {
    id: "DAT-4",
    area: "data",
    title: "Second factors and website logins kept apart",
    statement:
      "Second-factor codes live only in a separate service with its own key. Website logins are typed by a separate browser service that holds no secrets.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "apps/mfa" },
      { kind: "code", ref: "apps/browser" },
    ],
    maps: { soc2: ["CC6.1"], hipaa: ["164.312(a)(1)"] },
  },
  {
    id: "DAT-5",
    area: "data",
    title: "Card numbers are never stored",
    statement:
      "We take no card payments ourselves: Stripe's hosted invoices do. A card number that arrives anyway is stored only as its last four digits.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/core/src/compliance/card-numbers.ts" },
      { kind: "setting", ref: "Stripe hosted invoices" },
    ],
    maps: { soc2: ["C1.1"], pci: ["3.2.1", "12.8.1"] },
  },
  {
    id: "DAT-6",
    area: "data",
    title: "We read only what a feature needs",
    statement:
      "Email sync keeps only matching messages, headers and attachments; bodies are fetched on demand. Gmail is send only. Error reports carry no client content.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/connectors/src/gmail" },
      { kind: "code", ref: "apps/api/src/observability/sentry.ts" },
    ],
    maps: { soc2: ["C1.1"], hipaa: ["164.502(b)"] },
  },

  // ── Agents and writes ──────────────────────────────────────────────────────────────────────────
  {
    id: "AGT-1",
    area: "agents",
    title: "Approval before an agent changes a client's tools",
    statement:
      "Every step that can write needs a person's approval by default. Each write runs once, records the record's state before, and who approved it. Delete is off.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/agents", note: "permission gate, external actions" },
      { kind: "screen", ref: "/ops/runs" },
    ],
    maps: { soc2: ["CC8.1", "PI1.3"], hipaa: ["164.312(c)(1)"] },
  },
  {
    id: "AGT-2",
    area: "agents",
    title: "Untrusted text stays data",
    statement:
      "Document, email and web page text reaches a model only as data, never as instructions. Agents cannot change their own permissions, plan or approvals.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: "packages/agents", note: "runtime" }],
    maps: { soc2: ["CC6.8", "CC7.1"], hipaa: ["164.308(a)(5)(ii)(B)"] },
  },
  {
    id: "AGT-3",
    area: "agents",
    title: "Agents' history can't be rewritten",
    statement:
      "Agent versions, extractions and raw records are never changed or deleted; every decision records the agent version that made it.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: "packages/db", note: "immutable tables" }],
    maps: { soc2: ["CC8.1"], hipaa: ["164.312(c)(1)"] },
  },
  {
    id: "AGT-4",
    area: "agents",
    title: "No model trains on client data",
    statement:
      "Model providers are used through their APIs, whose terms exclude training on our data. Data is sent only for the task.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/core/src/compliance/processors.ts" },
      { kind: "policy", ref: DRP, note: "§3" },
    ],
    maps: { soc2: ["C1.1", "CC9.2"] },
  },

  // ── Logging and monitoring ─────────────────────────────────────────────────────────────────────
  {
    id: "LOG-1",
    area: "logging",
    title: "Who read or changed what, kept 6 years",
    statement:
      "Every request, sign-in and refused sign-in is logged with the person, role, client, action, outcome and origin. The log can't be changed, by anyone, and is kept 6 years.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "screen", ref: "/ops/security/audit" },
      { kind: "code", ref: "apps/api/src/audit.ts" },
      { kind: "code", ref: "packages/db/migrations/0017_audit_log.sql" },
    ],
    maps: {
      soc2: ["CC7.2", "CC7.3"],
      hipaa: ["164.312(b)", "164.308(a)(1)(ii)(D)", "164.316(b)(2)(i)"],
      pci: ["10.2.1"],
    },
    routines: ["audit-retention"],
  },
  {
    id: "LOG-2",
    area: "logging",
    title: "Errors alert us",
    statement:
      "Errors alert the security officer through Sentry. Error reports are scrubbed of client content, emails, IPs, keys and card numbers.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: "apps/api/src/observability/sentry.ts" }],
    maps: { soc2: ["CC7.2"], hipaa: ["164.308(a)(6)(ii)"] },
  },
  {
    id: "LOG-3",
    area: "logging",
    title: "Clients see their own audit log",
    statement:
      "A regulated client's admin can see who read or changed their data, and download it.",
    status: "planned",
    gap: "Not built (docs/hipaa-plan.md T3).",
    tier: "regulated",
    evidence: [{ kind: "screen", ref: "Portal: Security (planned)" }],
    maps: { soc2: ["CC2.3"], hipaa: ["164.308(a)(1)(ii)(D)"] },
  },

  // ── Changes and vulnerabilities ────────────────────────────────────────────────────────────────
  {
    id: "CHG-1",
    area: "change",
    title: "Every change is reviewed and tested",
    statement:
      "Every change is a pull request to a protected main branch with passing checks (lint, layering, typecheck, tests, CodeQL). Migrations, CI and sign-in changes each get their own.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "setting", ref: 'GitHub ruleset "Protect main"' },
      { kind: "code", ref: ".github/workflows/ci.yml" },
    ],
    maps: { soc2: ["CC8.1"], hipaa: ["164.308(a)(8)"], pci: ["6.5.1"] },
  },
  {
    id: "CHG-2",
    area: "change",
    title: "Staging before production",
    statement:
      "Every change runs on staging first. Production deploys only from a tagged release, and migrations meet real rows on staging first.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "code", ref: ".github/workflows/deploy.yml" }],
    maps: { soc2: ["CC8.1"], pci: ["6.5.3"] },
  },
  {
    id: "CHG-3",
    area: "change",
    title: "Scanning for vulnerabilities and secrets",
    statement:
      "CodeQL scans every change and the code weekly; Dependabot alerts and updates dependencies; secret scanning blocks pushes with keys.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: ".github/workflows/codeql.yml" },
      { kind: "setting", ref: "GitHub: Dependabot, secret scanning, push protection" },
    ],
    maps: { soc2: ["CC7.1"], hipaa: ["164.308(a)(1)(ii)(B)"], pci: ["6.3.1", "6.3.3"] },
    routines: ["dependency-updates"],
  },
  {
    id: "CHG-4",
    area: "change",
    title: "Patches on a deadline",
    statement: "Critical fixes within 7 days, high within 30, the rest at the monthly update.",
    status: "in_place",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§6" }],
    maps: { soc2: ["CC7.1"], hipaa: ["164.308(a)(1)(ii)(B)"], pci: ["6.3.3"] },
    routines: ["dependency-updates"],
  },
  {
    id: "CHG-5",
    area: "change",
    title: "Hardened application edge",
    statement:
      "Strict content security policy, no framing, no caching of answers, rate limits on the API, and signature checks on every webhook.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "apps/web/public/_headers" },
      { kind: "setting", ref: "Cloudflare: API rate limit" },
    ],
    maps: { soc2: ["CC6.6"], hipaa: ["164.312(e)(1)"], pci: ["6.4.1"] },
  },
  {
    id: "CHG-6",
    area: "change",
    title: "A yearly penetration test",
    statement: "An outside firm tests the product once a year.",
    status: "planned",
    gap: "No test yet (docs/hipaa-plan.md T10).",
    tier: "all",
    evidence: [{ kind: "record", ref: "Penetration test report" }],
    maps: { soc2: ["CC4.1", "CC7.1"], hipaa: ["164.308(a)(8)"], pci: ["11.4.1"] },
    routines: ["pen-test"],
  },
  {
    id: "CHG-7",
    area: "change",
    title: "Production scanned from outside every week",
    statement:
      "An automated scanner visits the live product as an outsider would, every week and after each release, and reports weak headers, cookies, error pages and anything public that shouldn't be. It never signs in, so it never reaches client data.",
    status: "partial",
    gap: "Built; it starts once production has its first release.",
    tier: "all",
    evidence: [
      { kind: "code", ref: ".github/workflows/zap-scan.yml", note: "OWASP ZAP baseline" },
      { kind: "record", ref: 'GitHub issue "Production scan: findings" and each run\'s report' },
    ],
    maps: { soc2: ["CC4.1", "CC7.1"], hipaa: ["164.308(a)(8)", "164.308(a)(1)(ii)(B)"] },
    routines: ["production-scan"],
  },
  {
    id: "CHG-8",
    area: "change",
    title: "Our network edge checked for weak settings",
    statement:
      "Cloudflare reviews our DNS, TLS and edge settings for exposures and weak configuration; we review its findings every quarter.",
    status: "planned",
    gap: "Cloudflare Security Insights is not switched on yet.",
    tier: "all",
    evidence: [
      { kind: "setting", ref: "Cloudflare: Security Center, Security Insights" },
      { kind: "record", ref: "Quarterly review of its findings" },
    ],
    maps: { soc2: ["CC6.6", "CC7.1"], hipaa: ["164.308(a)(1)(ii)(B)"] },
    routines: ["edge-review"],
  },

  // ── Incidents ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "INC-1",
    area: "incidents",
    title: "Incident response, clients told within 72 hours",
    statement:
      "Report, contain, investigate, notify, learn. Affected clients are told within 72 hours of confirming their data was exposed.",
    status: "partial",
    gap: "The plan is written; it has not been rehearsed.",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§9" }],
    maps: {
      soc2: ["CC7.3", "CC7.4", "CC7.5"],
      hipaa: ["164.308(a)(6)(ii)", "164.410"],
      pci: ["12.10.1"],
    },
    routines: ["incident-drill"],
  },

  // ── Backups and continuity ─────────────────────────────────────────────────────────────────────
  {
    id: "BCK-1",
    area: "continuity",
    title: "Point-in-time backups",
    statement:
      "The database keeps 7 days of point-in-time history. Original documents are written once and never changed.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "setting", ref: "Neon: history window 7 days", note: "docs/security.md §10" },
    ],
    maps: { soc2: ["A1.2"], hipaa: ["164.308(a)(7)(ii)(A)"] },
  },
  {
    id: "BCK-2",
    area: "continuity",
    title: "A restore tested every quarter",
    statement: "Every quarter we restore from the database's history and record the result.",
    status: "partial",
    gap: "The routine is in docs/operations.md §4; its record is kept outside the product.",
    tier: "all",
    evidence: [{ kind: "record", ref: "docs/operations.md §4" }],
    maps: { soc2: ["A1.3"], hipaa: ["164.308(a)(7)(ii)(B)", "164.308(a)(7)(ii)(D)"] },
    routines: ["restore-test"],
  },

  // ── Vendors ────────────────────────────────────────────────────────────────────────────────────
  {
    id: "VEN-1",
    area: "vendors",
    title: "Every vendor that receives client data is listed",
    statement:
      "The list is in the code and on mezonas.com/subprocessors. A feature that sends client data to a new vendor must name it, or it can't ship.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "code", ref: "packages/core/src/compliance/processors.ts" },
      { kind: "screen", ref: "/ops/security/vendors" },
    ],
    maps: { soc2: ["CC9.2", "CC2.3"], hipaa: ["164.308(b)(1)"], pci: ["12.8.1"] },
  },
  {
    id: "VEN-2",
    area: "vendors",
    title: "Vendors reviewed before use and every year",
    statement:
      "Before adding a vendor we check its security report, its training terms and its data terms; we re-check each one yearly. Clients are told before a new one receives their data.",
    status: "partial",
    gap: "Reviews are not yet recorded.",
    tier: "all",
    evidence: [{ kind: "policy", ref: ISP, note: "§8" }],
    maps: { soc2: ["CC9.2"], pci: ["12.8.2", "12.8.4"] },
    routines: ["vendor-review"],
  },
  {
    id: "VEN-3",
    area: "vendors",
    title: "Business associate agreements with vendors",
    statement:
      "A regulated client's data goes only to vendors with a signed BAA. The product refuses the rest: models, tools and connectors alike.",
    status: "planned",
    gap: "No vendor BAAs are signed yet, so no client can be in HIPAA mode.",
    tier: "regulated",
    evidence: [
      { kind: "code", ref: "apps/api/src/compliance/policy.ts" },
      { kind: "setting", ref: "BAA_PROCESSORS (apps/api/wrangler.jsonc)" },
    ],
    maps: { hipaa: ["164.308(b)(1)", "164.314(a)"] },
  },
  {
    id: "VEN-4",
    area: "vendors",
    title: "A BAA with each regulated client",
    statement: "We sign the client's BAA, or offer ours, before switching it to HIPAA mode.",
    status: "planned",
    gap: "The BAA template needs counsel's review.",
    tier: "regulated",
    evidence: [{ kind: "record", ref: "Signed BAAs" }],
    maps: { hipaa: ["164.308(b)(1)", "164.504(e)"] },
  },

  // ── Retention and leaving ──────────────────────────────────────────────────────────────────────
  {
    id: "LIF-1",
    area: "lifecycle",
    title: "Data kept only as long as needed",
    statement:
      "Each kind of data has a retention period. Files are deleted automatically 30 days after a client leaves; backups expire 7 days later.",
    status: "in_place",
    tier: "all",
    evidence: [
      { kind: "policy", ref: DRP },
      { kind: "code", ref: "apps/api/src/compliance/retention.ts" },
    ],
    maps: { soc2: ["C1.1", "C1.2"], hipaa: ["164.310(d)(2)(i)"], pci: ["3.2.1"] },
  },
  {
    id: "LIF-2",
    area: "lifecycle",
    title: "Leaving cleanly",
    statement:
      "Retiring a client stops its sign-ins and agents and revokes its connections at once; its data is purged after 30 days.",
    status: "partial",
    gap: "Data at messaging vendors is closed by hand from a checklist (docs/hipaa-plan.md T5).",
    tier: "all",
    evidence: [
      { kind: "code", ref: "apps/api/src/routes/compliance.ts", note: "retire" },
      { kind: "record", ref: "docs/operations.md §1.2" },
    ],
    maps: { soc2: ["C1.2", "CC6.5"], hipaa: ["164.310(d)(2)(i)", "164.504(e)(2)(ii)(J)"] },
    routines: ["client-exit"],
  },
];

// ── Routines ─────────────────────────────────────────────────────────────────────────────────────

export const ROUTINE_CADENCES = ["weekly", "monthly", "quarterly", "yearly", "on_event"] as const;
export type RoutineCadence = (typeof ROUTINE_CADENCES)[number];

export const ROUTINE_CADENCE_NAMES: Record<RoutineCadence, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Every quarter",
  yearly: "Every year",
  on_event: "When it happens",
};

export type Routine = {
  id: string;
  title: string;
  cadence: RoutineCadence;
  /** What doing it means, and what to keep. */
  how: string;
  /** Where it is done. */
  where: string;
};

/** The recurring work that is SOC 2 Type II's evidence: done on time, and recorded. */
export const ROUTINES: readonly Routine[] = [
  {
    id: "access-review",
    title: "Access review",
    cadence: "quarterly",
    how: "Review every account and role in the app and on each provider console; remove what isn't needed; keep the dated list.",
    where: "/ops/security/audit?view=access",
  },
  {
    id: "restore-test",
    title: "Restore test",
    cadence: "quarterly",
    how: "Restore the production database from its history into a branch; check it; note the result.",
    where: "docs/operations.md §4",
  },
  {
    id: "dependency-updates",
    title: "Dependency updates",
    cadence: "monthly",
    how: "Merge Dependabot's grouped updates once green; security updates within their deadline.",
    where: "GitHub",
  },
  {
    id: "risk-analysis",
    title: "Risk analysis",
    cadence: "yearly",
    how: "Write down the risks, their likelihood and what we do about them.",
    where: "docs/policies",
  },
  {
    id: "policy-review",
    title: "Policy review",
    cadence: "yearly",
    how: "Review each policy; record the new version and who approved it.",
    where: "docs/policies",
  },
  {
    id: "training",
    title: "Security training",
    cadence: "yearly",
    how: "Everyone with access reads the policies and confirms it in writing.",
    where: "docs/policies",
  },
  {
    id: "vendor-review",
    title: "Vendor review",
    cadence: "yearly",
    how: "For each vendor: its current security report, training terms and BAA status.",
    where: "/ops/security/vendors",
  },
  {
    id: "production-scan",
    title: "Production scan",
    cadence: "weekly",
    how: "Read the week's scan issue; fix findings on the policy's deadlines, or record why one is accepted.",
    where: "GitHub: Actions, Production scan",
  },
  {
    id: "edge-review",
    title: "Edge settings review",
    cadence: "quarterly",
    how: "Read Cloudflare's Security Insights; fix or accept each finding, and note the date.",
    where: "Cloudflare: Security Center",
  },
  {
    id: "pen-test",
    title: "Penetration test",
    cadence: "yearly",
    how: "An outside firm tests the product; fix findings by severity.",
    where: "Outside firm",
  },
  {
    id: "incident-drill",
    title: "Incident drill",
    cadence: "yearly",
    how: "Walk through a likely incident against the policy; write down what to change.",
    where: "docs/policies/information-security.md §9",
  },
  {
    id: "audit-retention",
    title: "Audit log retention",
    cadence: "yearly",
    how: "Remove audit rows older than 6 years (none before 2032).",
    where: "Database",
  },
  {
    id: "client-exit",
    title: "Client exit",
    cadence: "on_event",
    how: "Retire the client, close its data at other vendors from the checklist, then purge after 30 days.",
    where: "docs/operations.md §1.2",
  },
];

// ── Policies ─────────────────────────────────────────────────────────────────────────────────────

export type Policy = {
  id: string;
  title: string;
  /** Repository path; null while it is still to be written. */
  path: string | null;
  version: string | null;
  adopted: string | null;
  nextReview: string | null;
};

export const POLICIES: readonly Policy[] = [
  {
    id: "information-security",
    title: "Information security",
    path: ISP,
    version: "1.0",
    adopted: "2026-11-09",
    nextReview: "2027-11-09",
  },
  {
    id: "data-retention",
    title: "Data retention and deletion",
    path: DRP,
    version: "1.0",
    adopted: "2026-11-09",
    nextReview: "2027-11-09",
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    path: null,
    version: null,
    adopted: null,
    nextReview: null,
  },
  {
    id: "baa-template",
    title: "Business associate agreement (template)",
    path: null,
    version: null,
    adopted: null,
    nextReview: null,
  },
];

// ── Vendors ──────────────────────────────────────────────────────────────────────────────────────

/** What each of our vendors receives (docs/security.md §11). */
export const PROCESSOR_RECEIVES: Record<Processor, string> = {
  cloudflare: "All traffic; the app, files, email routing and the browser service",
  neon: "The database",
  workos: "Users' names, emails and sign-ins",
  anthropic: "What agents read and write, and documents to extract",
  openai: "The same, for agents set to OpenAI models",
  xai: "The same, for agents set to xAI models",
  google: "The same, for agents set to Gemini models",
  twilio: "Texts and calls of clients that use them",
  meta_whatsapp: "WhatsApp messages",
  elevenlabs: "Live calls and their transcripts",
  resend: "Emails sent from our sending service",
  plaid: "Bank and card feeds",
  anthropic_web: "Search terms and addresses an agent looks up",
  hackernews: "Search terms an agent looks up",
  billcom: "Bills and payables, for clients that connect BILL",
};

/** Vendors we use that are kept out of scope for client data, and how. */
export const OUT_OF_SCOPE_VENDORS: readonly { name: string; why: string }[] = [
  { name: "Stripe", why: "Billing only: client company and amounts, no client records or cards." },
  { name: "Sentry", why: "Error reports, scrubbed of client content before they leave." },
  { name: "GitHub", why: "Code only. CI never gets client data." },
];

// ── Summaries ────────────────────────────────────────────────────────────────────────────────────

export type FrameworkSummary = {
  framework: Framework;
  /** Distinct references the controls answer. */
  references: number;
  controls: number;
  counts: Record<ControlStatus, number>;
};

/** How far each framework is, by the controls that map to it. */
export function frameworkSummaries(controls: readonly Control[] = CONTROLS): FrameworkSummary[] {
  return FRAMEWORKS.map((framework) => {
    const mapped = controls.filter((c) => (c.maps[framework]?.length ?? 0) > 0);
    const counts: Record<ControlStatus, number> = { in_place: 0, partial: 0, planned: 0 };
    for (const c of mapped) counts[c.status]++;
    const refs = new Set(mapped.flatMap((c) => c.maps[framework] ?? []));
    return { framework, references: refs.size, controls: mapped.length, counts };
  });
}

/** The controls a client gets: Standard for everyone, plus Regulated ones in HIPAA mode. */
export function controlsForTier(
  regulated: boolean,
  controls: readonly Control[] = CONTROLS,
): Control[] {
  return controls.filter((c) => c.tier === "all" || regulated);
}

/** Every vendor id, so the Vendors tab lists them in the register's order. */
export const VENDOR_ORDER: readonly Processor[] = PROCESSORS;
