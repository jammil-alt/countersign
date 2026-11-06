import { z } from "zod";
import { isUuid } from "../ids";
import { ClientView, KpiFormat, KpiPeriod } from "../kpi/schema";
import { defineRoute } from "./contract";
import { AuditPeriod } from "./exports";

// KPIs and the client view, credits running out, and the client's audit export (ARCHITECTURE §9.9,
// §11.5, §11.7; docs/plan.md §1.50, W2-G). The portal gets each KPI's label and value, never its
// definition; the back office sees both. The client admin chooses what happens when credits run
// out and downloads the audit log; a run's audit trail is for anyone of the client who sees runs.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

/** At most this many record ids back a KPI (the value is exact; the ids are a sample). */
export const KPI_SOURCES_MAX = 100;

/** One KPI as the client reads it: its label and value in words, and what it counted. */
export const KpiValue = z.object({
  id: z.string(),
  label: z.string(),
  period: KpiPeriod,
  format: KpiFormat,
  /** A decimal string (a ratio as a fraction, 0.87); null when a ratio's denominator is 0. */
  value: z.string().nullable(),
  /** The value in the reader's language: "1,204", "$3,120.50", "87%". */
  display: z.string().nullable(),
  /** Money KPIs: the currency of the value. */
  currency: z.string().nullable(),
  /** The runs, changes or step records counted (invariant 10). */
  sources: z.array(z.string()).max(KPI_SOURCES_MAX),
  from: z.string(),
  to: z.string(),
});
export type KpiValue = z.infer<typeof KpiValue>;

export const ViewPanel = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("kpis"), kpis: z.array(z.string()) }),
  z.object({
    id: z.string(),
    kind: z.literal("pack_report"),
    pack: z.string(),
    report: z.string(),
  }),
]);

/** A service as the portal shows it beside its runs: KPI values and panels, no definition. */
export const ServiceView = z.object({
  service: z.object({ id: z.string(), name: z.string() }),
  kpis: z.array(KpiValue),
  panels: z.array(ViewPanel),
});
export type ServiceView = z.infer<typeof ServiceView>;

/** The back office's view of an agent's client view: the definition and, for a client agent, its values. */
export const OpsClientView = z.object({
  agent: z.object({
    id: z.string(),
    kind: z.enum(["template", "client"]),
    tenantId: z.string().nullable(),
  }),
  /** The version read: the live one. Null before anything is published. */
  versionId: z.string().nullable(),
  clientView: ClientView.nullable(),
  /** A client agent's values now (each KPI over its own period); null for a template. */
  values: z.array(KpiValue).nullable(),
});
export type OpsClientView = z.infer<typeof OpsClientView>;

// ── Credits ──────────────────────────────────────────────────────────────────────────────────────

/** What happens when a month's included credits are used (ARCHITECTURE §11.5). */
export const ON_CREDITS_OUT = ["continue", "pause"] as const;
export const OnCreditsOut = z.enum(ON_CREDITS_OUT);
export type OnCreditsOut = z.infer<typeof OnCreditsOut>;

export const CreditsOutBody = z.strictObject({ onCreditsOut: OnCreditsOut });

export const CreditsOutView = z.object({
  onCreditsOut: OnCreditsOut,
  /** `continue`: the client admin is told each time another block this size is used. */
  creditBlock: z.number().int(),
  /** Services paused because the month's credits ran out. */
  pausedForCredits: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type CreditsOutView = z.infer<typeof CreditsOutView>;

// ── The audit export and a run's audit trail ─────────────────────────────────────────────────────

/** A web ReadableStream, by its shape (core has no DOM or Workers types). */
export interface ByteStream {
  getReader(): unknown;
}

/** A file streamed as it is read (the audit export): not JSON. */
export const StreamFile = z.object({
  filename: z.string().min(1),
  contentType: z.literal("text/csv; charset=utf-8"),
  stream: z.custom<ByteStream>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { getReader?: unknown }).getReader === "function",
    "a stream",
  ),
});
export type StreamFile = z.infer<typeof StreamFile>;

export const RUN_AUDIT_KINDS = [
  "opened_run",
  "item_edit",
  "item_snooze",
  "item_undo",
  "signed",
  "declined",
  "answered",
] as const;

/** One line of a run's audit trail: who did what, when. Mezonas' people are "Mezonas" but the lead. */
export const RunAuditEntry = z.object({
  at: z.string(),
  who: z.string(),
  /** `client` for the client's own people, `mezonas` for us (the lead included). */
  side: z.enum(["client", "mezonas"]),
  kind: z.enum(RUN_AUDIT_KINDS),
  itemId: z.string().nullable(),
  /** Consecutive same lines (a page polled while open) count once, with how many. */
  times: z.number().int().min(1),
});
export type RunAuditEntry = z.infer<typeof RunAuditEntry>;

export const clientViewRoutes = {
  portalServiceView: defineRoute({
    method: "GET",
    path: "/api/services/:id/view",
    auth: "session",
    roles: CLIENT,
    summary: "A service's KPIs and panels: labels and values over its live runs",
    params: IdParams,
    response: ServiceView,
  }),
  opsAgentClientView: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/client-view",
    auth: "session",
    roles: OPS,
    summary: "An agent's client view: its KPIs and panels, and a client agent's values now",
    params: IdParams,
    response: OpsClientView,
  }),
  portalCreditsOut: defineRoute({
    method: "GET",
    path: "/api/billing/credits-out",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "What happens when this month's included credits are used",
    response: CreditsOutView,
  }),
  portalSetCreditsOut: defineRoute({
    method: "PUT",
    path: "/api/billing/credits-out",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Choose: keep working and add credits (continue), or pause the services until next month (pause)",
    body: CreditsOutBody,
    response: CreditsOutView,
  }),
  portalAuditExportCsv: defineRoute({
    method: "GET",
    path: "/api/audit/export.csv",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Your audit log for a period as CSV: your people by name, ours as Mezonas but your lead",
    query: AuditPeriod,
    response: StreamFile,
  }),
  portalRunAudit: defineRoute({
    method: "GET",
    path: "/api/runs/:id/audit",
    auth: "session",
    roles: CLIENT,
    summary: "A run's audit trail: who opened it or its items and who signed, in order",
    params: IdParams,
    response: z.object({ entries: z.array(RunAuditEntry) }),
  }),
} as const;
