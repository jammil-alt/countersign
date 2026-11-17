// Back office: a client's recent events of one type, offered as a test run's trigger payload
// (docs/plan.md §1.16 "Test-run payloads"): the payload as it was emitted, so a test run of an
// event-triggered workflow reads real records, with a plain label for the picker; and (audit 4.6)
// the client's events set aside after failing to dispatch, given back to the dispatcher by hand. Operator-only;
// the query runs with withTenant's scope (narrowToTenant) and names the client too (invariant 1).

import { type ExtractedHeader, isUuid, type RecentEvent, routes } from "@countersign/core";
import {
  docExtraction,
  document,
  event,
  narrowToTenant,
  run,
  type Tx,
  vendor,
} from "@countersign/db";
import { RETRY_SET_ASIDE_MAX, retrySetAside } from "@countersign/senses";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount } from "../http";
import { dispatchByIds } from "../runs/dispatch";

/** How many events the picker lists unless asked for more. */
export const RECENT_EVENTS = 10;

const ids = (values: unknown[]): string[] => [
  ...new Set(values.filter((v): v is string => typeof v === "string" && isUuid(v))),
];

/** The payload's plain fields (not ids, not objects), for an event with no record to name. */
function plainFields(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(
      ([, v]) =>
        (typeof v === "string" && v !== "" && !isUuid(v)) ||
        typeof v === "number" ||
        typeof v === "boolean",
    )
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

/**
 * The client's latest events of `type`, newest first, never a test run's. `tx` must be scoped to
 * this one client.
 */
// DECISION: a test run emits nothing (packages/senses `emit` with `testRun`), so the outbox holds
// no test run's events; an event whose payload names a test run (`runId`) is left out all the
// same, so a test run's approval resolved by hand can never become another test's input.
export async function recentEvents(
  tx: Tx,
  tenantId: string,
  type: string,
  limit = RECENT_EVENTS,
): Promise<RecentEvent[]> {
  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.tenantId, tenantId),
        eq(event.type, type),
        sql`not exists (select 1 from ${run} where ${run.tenantId} = ${event.tenantId}
          and ${run.mode} = 'test' and ${run.id}::text = ${event.payload}->>'runId')`,
      ),
    )
    .orderBy(desc(event.createdAt), desc(event.id))
    .limit(limit);
  const payloads = rows.map((r) => r.payload as Record<string, unknown>);

  // Labels: the documents, extractions and vendors the events name, one query each.
  const documentIds = ids(payloads.map((p) => p.documentId));
  const extractionIds = ids(payloads.map((p) => p.extractionId));
  const vendorIds = ids(payloads.map((p) => p.vendorId));
  const docs = new Map(
    (documentIds.length
      ? await tx
          .select({ id: document.id, filename: document.filename })
          .from(document)
          .where(and(eq(document.tenantId, tenantId), inArray(document.id, documentIds)))
      : []
    ).map((d) => [d.id, d.filename]),
  );
  const extractions = new Map(
    (extractionIds.length
      ? await tx
          .select({
            id: docExtraction.id,
            header: docExtraction.header,
            total: docExtraction.total,
            currency: docExtraction.currency,
          })
          .from(docExtraction)
          .where(
            and(eq(docExtraction.tenantId, tenantId), inArray(docExtraction.id, extractionIds)),
          )
      : []
    ).map((x) => [x.id, x]),
  );
  const vendors = new Map(
    (vendorIds.length
      ? await tx
          .select({ id: vendor.id, name: vendor.name })
          .from(vendor)
          .where(and(eq(vendor.tenantId, tenantId), inArray(vendor.id, vendorIds)))
      : []
    ).map((v) => [v.id, v.name]),
  );

  return rows.map((row, i) => {
    const payload = payloads[i] as Record<string, unknown>;
    let label: string | null = null;
    let vendorName: string | null = null;
    let total: RecentEvent["total"] = null;
    if (typeof payload.documentId === "string") {
      label = docs.get(payload.documentId) ?? null;
    }
    if (typeof payload.extractionId === "string") {
      const x = extractions.get(payload.extractionId);
      if (x) {
        vendorName = (x.header as Partial<ExtractedHeader>).vendorName || null;
        total = { amount: x.total, currency: x.currency };
      }
    }
    if (typeof payload.transactionId === "string") {
      const date = typeof payload.txnDate === "string" ? payload.txnDate : null;
      label = date ? `Purchase dated ${date}` : "Purchase";
      if (typeof payload.vendorId === "string") vendorName = vendors.get(payload.vendorId) ?? null;
      const t = payload.total as { amount?: unknown; currency?: unknown } | null | undefined;
      if (t && typeof t.amount === "string" && typeof t.currency === "string") {
        total = { amount: t.amount, currency: t.currency };
      }
    }
    return {
      id: row.id,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      payload,
      label: label || plainFields(payload) || row.type,
      vendorName,
      total,
    };
  });
}

/** How many set-aside events the list names (the count covers them all). */
const SET_ASIDE_LISTED = 50;

export function opsEventRoutes(app: Hono<AppEnv>): void {
  // Audit 4.6: events set aside after failing to dispatch (docs/operations.md §5).
  mount(app, routes.opsSetAsideEvents, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const tenantId = ctx.params.id;
    return narrowToTenant(ctx.tx, tenantId, async (tx) => {
      const where = and(
        eq(event.tenantId, tenantId),
        isNotNull(event.setAsideAt),
        isNull(event.dispatchedAt),
      );
      const [totals] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<string | null>`min(${event.createdAt})`,
        })
        .from(event)
        .where(where);
      const rows = await tx
        .select()
        .from(event)
        .where(where)
        .orderBy(desc(event.setAsideAt), desc(event.id))
        .limit(SET_ASIDE_LISTED);
      return {
        count: totals?.count ?? 0,
        oldest: totals?.oldest ? new Date(totals.oldest).toISOString() : null,
        events: rows.map((e) => ({
          id: e.id,
          type: e.type,
          createdAt: e.createdAt.toISOString(),
          setAsideAt: (e.setAsideAt as Date).toISOString(),
          attempts: e.dispatchAttempts,
          error: e.dispatchError,
        })),
      };
    });
  });

  // DECISION (audit 4.6): the operator gives events back by hand once the cause is fixed, at most
  // RETRY_SET_ASIDE_MAX a call, and they are dispatched right after the commit (the sweep would
  // take them within a minute anyway). An event that should never run is simply left set aside.
  mount(app, routes.opsRetrySetAsideEvents, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const tenantId = ctx.params.id;
    const ids = await narrowToTenant(ctx.tx, tenantId, (tx) =>
      retrySetAside(tx, {
        ...(ctx.body.eventIds ? { ids: ctx.body.eventIds } : {}),
        limit: RETRY_SET_ASIDE_MAX,
      }),
    );
    if (ids.length > 0) {
      ctx.afterCommit(async () => {
        await dispatchByIds(
          { db: ctx.services.db, instances: ctx.services.instances },
          tenantId,
          ids,
        );
      });
    }
    return { retried: ids.length };
  });

  mount(app, routes.opsClientEvents, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const tenantId = ctx.params.id;
    return {
      events: await narrowToTenant(ctx.tx, tenantId, (tx) =>
        recentEvents(tx, tenantId, ctx.query.type, ctx.query.limit ?? RECENT_EVENTS),
      ),
    };
  });
}
