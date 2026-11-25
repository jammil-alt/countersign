// The audit log (docs/plan.md §1.35; HIPAA §164.312(b), SOC 2 CC7.2, PCI DSS 10): one
// `audit_event` row per request to a session route (reads included), per sign-in and sign-out,
// and per refused or failed request. Rows hold ids, never bodies or record content.

import { AUDIT_REFRESH_HEADER, AUDIT_REFRESH_KEY, isUuid } from "@countersign/core";
import { auditEvent, type Db, type Tx, withTenants } from "@countersign/db";
import { captureException } from "@sentry/cloudflare";
import type { Context } from "hono";

export interface AuditEntry {
  tenantId: string | null;
  actorKind: "user" | "system" | "anonymous";
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  /** `GET /api/runs/:id` for a route; `session.sign_in` etc. otherwise. */
  action: string;
  outcome: "ok" | "refused" | "error";
  httpStatus?: number | null;
  /** Ids only: route params, the requested client. */
  target?: Record<string, string>;
}

const MAX_TARGET_VALUE = 200;
const MAX_USER_AGENT = 256;

/** Where the request came from: Cloudflare's client IP and the user agent, cut short. */
export function requestOrigin(c: Context): { ip: string | null; userAgent: string | null } {
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const ua = c.req.header("user-agent") ?? null;
  return { ip, userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null };
}

/** A route's params (and `?client=`) as the audit target: strings only, cut short. */
export function auditTarget(c: Context, requestedClient: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  let params: Record<string, unknown> = {};
  try {
    params = c.req.param() as Record<string, unknown>;
  } catch {
    // No route matched (the 404 handler): no params.
  }
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") out[k] = v.slice(0, MAX_TARGET_VALUE);
  }
  if (requestedClient) out.client = requestedClient.slice(0, MAX_TARGET_VALUE);
  // §1.243: the security officer's investigation of locked clients, so its reads stand out.
  if (c.req.method === "GET" && c.req.query("investigate") === "1") out.investigate = "1";
  // DECISION (S6.9): a read the app sent to refresh what is on screen (a page's 2-second poll)
  // keeps its row, tagged, so the log counts the person opening a page once per visit, not 182
  // times. Only reads are tagged: a write is never a refresh. The tag is the app's word for it;
  // nothing is hidden by it, and the CSV export carries every row with its tag.
  if (c.req.method === "GET" && c.req.header(AUDIT_REFRESH_HEADER) === "1") {
    out[AUDIT_REFRESH_KEY] = "1";
  }
  return out;
}

/** The route as written in the app (`/api/runs/:id`), never the path with its ids. */
export function auditAction(c: Context): string {
  return `${c.req.method} ${c.req.routePath || c.req.path}`;
}

function row(entry: AuditEntry, c: Context | null) {
  const origin = c ? requestOrigin(c) : { ip: null, userAgent: null };
  return {
    tenantId: entry.tenantId,
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    actorRole: entry.actorRole ?? null,
    action: entry.action.slice(0, 300),
    outcome: entry.outcome,
    httpStatus: entry.httpStatus ?? null,
    target: entry.target ?? {},
    ip: origin.ip,
    userAgent: origin.userAgent,
  };
}

/**
 * In the request's own transaction: the row commits with whatever the request wrote, and a
 * failure to write it fails the request (the log is not optional).
 */
export async function auditInTx(tx: Tx, c: Context | null, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEvent).values(row(entry, c));
}

/**
 * Outside any request transaction (refusals, failures, sign-ins): its own short transaction,
 * scoped to the row's client. Never throws: a request that already failed is not failed again
 * by its audit row, but the miss is reported.
 */
export async function auditAlone(db: Db, c: Context | null, entry: AuditEntry): Promise<void> {
  try {
    const values = row(entry, c);
    if (entry.tenantId && isUuid(entry.tenantId)) {
      // withTenants, not withTenant: a locked client's request is audited too (§1.243). Its scope
      // leaves the client out but names it (`app.locked_tenant_ids`), which audit_write accepts.
      await withTenants(db, [entry.tenantId], (tx) => tx.insert(auditEvent).values(values));
    } else {
      await db.insert(auditEvent).values({ ...values, tenantId: null });
    }
  } catch (error) {
    console.error("audit row not written", error);
    captureException(error, { tags: { kind: "audit" } });
  }
}
