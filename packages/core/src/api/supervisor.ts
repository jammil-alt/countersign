import { z } from "zod";
import { isUuid } from "../ids";
import { FindingKind } from "../supervisor/health";
import { defineRoute } from "./contract";

// The supervisor's findings and health summary (docs/plan.md §1.28). The portal's overview shows
// the latest summary and the open findings that need the client (their plain steps only); the
// back office shows every finding of a client, the operator's with their details, and adds the
// supervisor to a client.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const Timestamp = z.string();

/** The daily check's counts, as the portal and the back office show them. */
export const HealthSummaryView = z.object({
  checkedAt: Timestamp,
  state: z.enum(["good", "attention"]),
  runs: z.object({ total: z.number().int(), failed: z.number().int() }),
  connections: z.object({ total: z.number().int(), needsAttention: z.number().int() }),
  waiting: z.object({ count: z.number().int(), oldestHours: z.number().int() }),
  agents: z.object({ active: z.number().int(), paused: z.number().int() }),
  openFindings: z.number().int(),
});
export type HealthSummaryView = z.infer<typeof HealthSummaryView>;

/** An open finding for the client admin: its title and plain steps, nothing else (invariant 11). */
export const PortalFinding = z.object({
  id: z.string(),
  kind: FindingKind,
  title: z.string(),
  steps: z.array(z.string()),
  createdAt: Timestamp,
  remindedAt: Timestamp.nullable(),
});
export type PortalFinding = z.infer<typeof PortalFinding>;

export const PortalHealth = z.object({
  summary: HealthSummaryView.nullable(),
  findings: z.array(PortalFinding),
});
export type PortalHealth = z.infer<typeof PortalHealth>;

/** A finding in the back office: either audience's item, the operator's with its details. */
export const OpsFinding = z.object({
  id: z.string(),
  audience: z.enum(["client_admin", "operator"]),
  kind: z.string(),
  title: z.string(),
  fingerprint: z.string(),
  status: z.enum(["open", "resolved", "expired"]),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  remindedAt: Timestamp.nullable(),
  reminders: z.number().int(),
  occurrences: z.number().int(),
  /** The operator's details (agent, version, step, error, connection); null on client items. */
  details: z.record(z.string(), z.unknown()).nullable(),
  /** The supervisor's note for the operator; null on client items. */
  note: z.string().nullable(),
  steps: z.array(z.string()),
  sources: z.array(z.string()),
});
export type OpsFinding = z.infer<typeof OpsFinding>;

const SupervisorRef = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  runStatus: z.string().nullable(),
  liveVersionId: z.string().nullable(),
});

export const supervisorRoutes = {
  opsClientHealth: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/health",
    auth: "session",
    roles: OPS,
    summary: "A client's health: the supervisor, its latest summary and its findings",
    params: z.object({ id: Id }),
    query: z.object({ status: z.enum(["open", "all"]).default("open") }),
    response: z.object({
      supervisor: SupervisorRef.nullable(),
      summary: HealthSummaryView.nullable(),
      findings: z.array(OpsFinding),
    }),
  }),
  opsAddSupervisor: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/supervisor",
    auth: "session",
    roles: OPS,
    summary:
      "Add Sloan, the account agent, to a client and turn it on: a fork of the template's live version, published and active",
    params: z.object({ id: Id }),
    body: z.strictObject({}).default({}),
    response: z.object({ supervisor: SupervisorRef, created: z.boolean() }),
  }),
} as const;
