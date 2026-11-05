// The audit log (docs/plan.md §1.35; HIPAA §164.312(b), SOC 2 CC7.2, PCI DSS 10): one
// `audit_event` row per request to a session route (reads included), per sign-in and sign-out,
// and per refused or failed request. Rows hold ids, never bodies or record content.

import { isUuid } from "@countersign/core";
import { auditEvent, type Db, type Tx, withTenant } from "@countersign/db";
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
      await withTenant(db, entry.tenantId, (tx) => tx.insert(auditEvent).values(values));
    } else {
      await db.insert(auditEvent).values({ ...values, tenantId: null });
    }
  } catch (error) {
    console.error("audit row not written", error);
    captureException(error, { tags: { kind: "audit" } });
  }
}
