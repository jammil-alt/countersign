import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Exports (docs/plan.md §1.36): a client's data export (operator, a ZIP built in the background),
// the accountant export (changes made to the client's tools in a period, with their runs and
// documents) and the client's own audit log as CSV. The terms promise an export on request within
// 30 days after the service ends (apps/site terms §12).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

export const EXPORT_STATUSES = ["running", "ready", "failed"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const EXPORT_REASON_MAX = 500;
/** The longest period one accountant or audit export covers. */
export const EXPORT_PERIOD_MAX_DAYS = 366;

/** One client data export, as the back office lists it. */
export const ClientExport = z.object({
  id: z.string(),
  status: z.enum(EXPORT_STATUSES),
  requestedAt: z.string(),
  requestedBy: z.object({ id: z.string(), email: z.string().nullable() }).nullable(),
  reason: z.string(),
  finishedAt: z.string().nullable(),
  /** Files in the ZIP (tables, documents and the README), once ready. */
  files: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** Why it failed, in words. */
  error: z.string().nullable(),
  /** A link that works for a few minutes, for a ready export. */
  download: z.object({ url: z.string(), filename: z.string(), expiresAt: z.string() }).nullable(),
});
export type ClientExport = z.infer<typeof ClientExport>;

export const ClientExports = z.object({
  exports: z.array(ClientExport),
  /** When the client was retired; null while it is a client. */
  retiredAt: z.string().nullable(),
  /** The last moment an export can be started for a retired client; null while it is a client. */
  exportableUntil: z.string().nullable(),
});
export type ClientExports = z.infer<typeof ClientExports>;

export const StartClientExport = z.strictObject({
  /** Why, for the client's change log (e.g. "Asked for by the client on leaving"). */
  reason: z.string().trim().min(1).max(EXPORT_REASON_MAX).optional(),
});

const PlainDate = z.iso.date();

/** Whether a period is the right way round and no longer than the most an export covers. */
function periodProblem(p: { from: string; to: string }): string | null {
  if (p.from > p.to) return "`from` must be on or before `to`";
  if (periodDays(p.from, p.to) > EXPORT_PERIOD_MAX_DAYS) {
    return `a period is at most ${EXPORT_PERIOD_MAX_DAYS} days`;
  }
  return null;
}

function checkPeriod(p: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const problem = periodProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["to"] });
}

/** A period of whole days in the client's timezone, both ends included. */
export const AuditPeriod = z.object({ from: PlainDate, to: PlainDate }).superRefine(checkPeriod);
export type AuditPeriod = z.infer<typeof AuditPeriod>;

/**
 * The accountant export's period, and its format: a ZIP with the documents (default), or the
 * changes alone as one CSV.
 */
export const ExportPeriod = z
  .object({ from: PlainDate, to: PlainDate, format: z.enum(["zip", "csv"]).default("zip") })
  .superRefine(checkPeriod);
export type ExportPeriod = z.infer<typeof ExportPeriod>;

/** Days from `from` to `to`, both included. */
export function periodDays(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/**
 * A file download: the API answers with the bytes themselves (`Content-Disposition: attachment`),
 * not JSON. The schema checks what the handler hands back before it is sent.
 */
export const ExportFile = z.object({
  filename: z.string().min(1),
  contentType: z.enum(["text/csv; charset=utf-8", "application/zip"]),
  bytes: z.instanceof(Uint8Array),
});
export type ExportFile = z.infer<typeof ExportFile>;

export const exportRoutes = {
  opsClientExports: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/exports",
    auth: "session",
    roles: OPS,
    summary: "A client's data exports, with a short-lived link to each ready one",
    params: IdParams,
    response: ClientExports,
  }),
  opsClientExportStart: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/exports",
    auth: "session",
    roles: OPS,
    summary:
      "Start a client data export: every record table as CSV and the original documents, in one ZIP",
    params: IdParams,
    body: StartClientExport,
    response: ClientExport,
  }),
  opsClientAccountantExport: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/exports/accountant",
    auth: "session",
    roles: OPS,
    summary: "A client's accountant export for a period (the changes made to its tools)",
    params: IdParams,
    query: ExportPeriod,
    response: ExportFile,
  }),
  portalAccountantExport: defineRoute({
    method: "GET",
    path: "/api/exports/accountant",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "The accountant export for a period: each change made to your tools, who signed it, its run and documents",
    query: ExportPeriod,
    response: ExportFile,
  }),
  // v0.12 W2-G: the client's audit log moved to `GET /api/audit/export.csv` (api/client-view.ts),
  // streamed and with people named as ARCHITECTURE §11.7 says.
} as const;
