import { z } from "zod";
import { PROCESSORS } from "../compliance/processors";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Compliance routes (docs/plan.md §1.35): the audit log, the access review, a client's HIPAA mode
// and retiring a client. Operator only.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

export const AUDIT_PAGE_MAX = 500;
export const COMPLIANCE_REASON_MAX = 500;
/** Days between retiring a client and purging its data (files by the cron, rows by the owner). */
export const RETIREMENT_PURGE_DAYS = 30;
/** How long audit rows are kept (HIPAA §164.316(b)(2)). */
export const AUDIT_RETENTION_YEARS = 6;

export const AuditEventRow = z.object({
  id: z.string(),
  client: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  actor: z.object({
    kind: z.enum(["user", "system", "anonymous"]),
    id: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string().nullable(),
  }),
  action: z.string(),
  outcome: z.enum(["ok", "refused", "error"]),
  httpStatus: z.number().int().nullable(),
  target: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEventRow = z.infer<typeof AuditEventRow>;

export const AuditQuery = z.object({
  /** The back office's client filter is the usual `?client=` (it also narrows the scope). */
  client: Id.optional(),
  user: Id.optional(),
  /** Matches the start of the action, e.g. `session.` or `GET /api/documents`. */
  action: z.string().trim().min(1).max(200).optional(),
  outcome: z.enum(["ok", "refused", "error"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Paging: rows older than this row id. */
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(100),
});

export const AccessReviewUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  memberships: z.array(
    z.object({
      client: z.object({ id: z.string(), name: z.string(), retired: z.boolean() }),
      role: z.string(),
    }),
  ),
  lastSignInAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});
export type AccessReviewUser = z.infer<typeof AccessReviewUser>;

export const ClientCompliance = z.object({
  clientId: z.string(),
  hipaa: z.boolean(),
  /** Whether HIPAA mode could be turned on now, and if not, why. */
  readiness: z.object({ ready: z.boolean(), problems: z.array(z.string()) }),
  processors: z.array(z.object({ id: z.enum(PROCESSORS), name: z.string(), covered: z.boolean() })),
  retiredAt: z.string().nullable(),
  /** When the client's data may be purged; null unless retired. */
  purgeAfter: z.string().nullable(),
  changes: z.array(
    z.object({
      id: z.string(),
      setting: z.string(),
      to: z.unknown(),
      reason: z.string(),
      by: z.object({ id: z.string(), email: z.string() }).nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type ClientCompliance = z.infer<typeof ClientCompliance>;

export const SetHipaaMode = z.strictObject({
  hipaa: z.boolean(),
  /** Optional: the change log says "HIPAA mode switched on (or off)" without one. */
  reason: z.string().trim().max(COMPLIANCE_REASON_MAX).optional(),
});

export const RetireClient = z.strictObject({
  /** Optional: the change log says "Retired" without one. */
  reason: z.string().trim().max(COMPLIANCE_REASON_MAX).optional(),
  /** The client's name, typed again: retiring can't be undone. */
  confirmName: z.string().trim().min(1).max(200),
});

export const complianceRoutes = {
  opsAudit: defineRoute({
    method: "GET",
    path: "/api/ops/audit",
    auth: "session",
    roles: OPS,
    summary: "The audit log: who read or changed what, newest first, filtered and paged",
    query: AuditQuery,
    response: z.object({ events: z.array(AuditEventRow), nextBefore: z.string().nullable() }),
  }),
  opsAccessReview: defineRoute({
    method: "GET",
    path: "/api/ops/access-review",
    auth: "session",
    roles: OPS,
    summary: "Every user of the operator's clients, their roles, last sign-in and last request",
    response: z.object({ users: z.array(AccessReviewUser), generatedAt: z.string() }),
  }),
  opsClientCompliance: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/compliance",
    auth: "session",
    roles: OPS,
    summary: "A client's HIPAA mode, which vendors have a signed BAA, and its retirement",
    params: IdParams,
    response: ClientCompliance,
  }),
  opsClientComplianceSet: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/compliance",
    auth: "session",
    roles: OPS,
    summary: "Turn a client's HIPAA mode on or off (a reason is optional)",
    params: IdParams,
    body: SetHipaaMode,
    response: ClientCompliance,
  }),
  opsClientRetire: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/retire",
    auth: "session",
    roles: OPS,
    summary:
      "Retire a client: no sign-ins, no runs, connections removed; its data is purged 30 days later",
    params: IdParams,
    body: RetireClient,
    response: ClientCompliance,
  }),
} as const;
