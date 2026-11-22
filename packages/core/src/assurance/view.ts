// An agent's architecture and security, as the SOP's section 14 shows it to the client and the
// back office's Security tab to us (docs/agent-assurance-plan.md §3–§5). Made by code
// (`assuranceView`) from the SOP, the setup and the stored check results; nothing here is a
// bundle, an instruction, a prompt or a cost (invariant 11).

import { z } from "zod";
import { COVERAGE_STATES } from "./coverage";

export const ARCH_ZONES = ["business", "mezonas", "ai", "outside"] as const;

export const ArchBox = z.object({
  key: z.string(),
  zone: z.enum(ARCH_ZONES),
  title: z.string(),
  lines: z.array(z.string()),
  /** People: drawn in copper. */
  person: z.boolean(),
});
export type ArchBox = z.infer<typeof ArchBox>;

export const ArchFlow = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  /** The SOP's controls (C1) and the register's (DAT-3) on this flow. */
  refs: z.array(z.string()),
  /** To an AI provider: drawn dashed. */
  ai: z.boolean(),
});
export type ArchFlow = z.infer<typeof ArchFlow>;

export const Architecture = z.object({
  zones: z.array(z.object({ key: z.enum(ARCH_ZONES), title: z.string() })),
  boxes: z.array(ArchBox),
  flows: z.array(ArchFlow),
});
export type Architecture = z.infer<typeof Architecture>;

/** "not_checked": no stored result yet (a new agent, or an attack check before A3). */
export const VIEW_RESULTS = ["verified", "in_review", "not_checked", "not_applicable"] as const;
export type ViewResult = (typeof VIEW_RESULTS)[number];

export const AssuranceCheckRow = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  kind: z.enum(["setup", "runs", "attack"]),
  controls: z.array(z.string()),
  soc2: z.array(z.string()),
  /** Only for a client in HIPAA mode. */
  hipaa: z.array(z.string()),
  result: z.enum(VIEW_RESULTS),
  /** What it found; empty in the client's view while in review. */
  found: z.string(),
  /** In review since. */
  since: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** The back office only: counts and record ids, and the issue it opened. */
  evidence: z.record(z.string(), z.unknown()).optional(),
  issueId: z.string().nullable().optional(),
});
export type AssuranceCheckRow = z.infer<typeof AssuranceCheckRow>;

export const AssuranceCoverageRow = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(COVERAGE_STATES),
  status: z.enum(["in_place", "partial", "planned"]),
  why: z.string().nullable(),
  soc2: z.array(z.string()),
  hipaa: z.array(z.string()),
});

export const AssuranceDataRow = z.object({
  data: z.string(),
  fields: z.string().nullable(),
  from: z.string(),
  keptWhere: z.string(),
  keptFor: z.string(),
  whoSees: z.string(),
  /** Not yet in the retention policy, or another gap to show plainly. */
  gap: z.boolean(),
});

export const AssuranceAiRow = z.object({
  use: z.string(),
  provider: z.string(),
  model: z.string(),
  sent: z.string(),
  protection: z.string(),
  providerKeeps: z.string(),
});

export const AssuranceAccessRow = z.object({
  tool: z.string(),
  detail: z.string().nullable(),
  signsIn: z.string(),
  credential: z.string(),
  agentMay: z.string(),
  whoChanges: z.string(),
  person: z.boolean(),
});

export const AssuranceView = z.object({
  agent: z.object({ id: z.string(), name: z.string() }),
  client: z.string(),
  asOf: z.string(),
  period: z.object({ start: z.string(), end: z.string() }),
  hipaa: z.boolean(),
  version: z.number().int(),
  architecture: Architecture,
  counts: z.object({
    checks: z.number().int(),
    verified: z.number().int(),
    inReview: z.number().int(),
    notChecked: z.number().int(),
    notApplicable: z.number().int(),
  }),
  lastChecked: z.string().nullable(),
  checks: z.array(AssuranceCheckRow),
  coverage: z.array(AssuranceCoverageRow),
  data: z.array(AssuranceDataRow),
  ai: z.array(AssuranceAiRow),
  access: z.array(AssuranceAccessRow),
});
export type AssuranceView = z.infer<typeof AssuranceView>;
