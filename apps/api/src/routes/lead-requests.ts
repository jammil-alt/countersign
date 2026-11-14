// The lead's requests on a client admin's Desk (docs/plan.md §1.101): a question or an ask from
// the client's Mezonas lead, made in the back office or by Reggie, answered on the Desk like any
// request, and read back here.

import {
  LEAD_REQUEST_SUBJECT,
  type LeadRequest,
  type LeadRequestCreateInput,
  routes,
} from "@countersign/core";
import { appUser, inboxItem, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, iso, mount } from "../http";

type ItemRow = typeof inboxItem.$inferSelect;

function read(row: ItemRow, names: Map<string, string | null>): LeadRequest {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const lead = (p.leadRequest ?? {}) as { askedBy?: unknown };
  const r = (row.resolution ?? null) as { approved?: unknown; answer?: unknown } | null;
  const choices = Array.isArray(p.choices)
    ? p.choices
        .map((c) => (c && typeof c === "object" ? (c as { value?: unknown }).value : null))
        .filter((v): v is string => typeof v === "string")
    : [];
  return {
    id: row.id,
    question: row.title,
    detail: typeof p.detail === "string" ? p.detail : null,
    choices,
    status: row.status as LeadRequest["status"],
    answer: typeof r?.answer === "string" ? r.answer : null,
    declined: r?.approved === false,
    answeredBy: row.resolvedBy ? (names.get(row.resolvedBy) ?? null) : null,
    askedBy: typeof lead.askedBy === "string" ? (names.get(lead.askedBy) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
  };
}

async function namesOf(tx: Tx, rows: ItemRow[]): Promise<Map<string, string | null>> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.resolvedBy) ids.add(r.resolvedBy);
    const by = ((r.payload ?? {}) as { leadRequest?: { askedBy?: unknown } }).leadRequest?.askedBy;
    if (typeof by === "string") ids.add(by);
  }
  if (ids.size === 0) return new Map();
  const users = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, [...ids]));
  return new Map(users.map((u) => [u.id, u.name ?? u.email]));
}

/**
 * Puts the request on the client admin's Desk as a `request` item, from the lead: no run waits on
 * it, and its answer is read back with `leadRequests`.
 */
// DECISION: a plain `request` item with subject `lead_request`, so the Desk shows and resolves it
// as it does every question (choices as quick answers, else a written answer, or decline), and the
// client is notified as for any item. Nothing is applied by an answer: the lead reads it.
export async function createLeadRequest(
  tx: Tx,
  tenantId: string,
  input: LeadRequestCreateInput,
  by: { userId: string; name: string | null },
): Promise<LeadRequest> {
  const [row] = await tx
    .insert(inboxItem)
    .values({
      tenantId,
      kind: "request",
      subjectType: LEAD_REQUEST_SUBJECT,
      subjectId: tenantId,
      assigneeRole: "client_admin",
      title: input.question.trim(),
      payload: {
        ...(input.detail ? { detail: input.detail.trim() } : {}),
        from: by.name ? `${by.name}, your Mezonas lead` : "Your Mezonas lead",
        ...(input.choices ? { choices: input.choices.map((c) => ({ value: c, label: c })) } : {}),
        leadRequest: { askedBy: by.userId },
      },
    })
    .returning();
  if (!row) throw new Error("inbox insert returned nothing");
  return read(row, await namesOf(tx, [row]));
}

export async function leadRequests(tx: Tx, tenantId: string): Promise<LeadRequest[]> {
  const rows = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.tenantId, tenantId), eq(inboxItem.subjectType, LEAD_REQUEST_SUBJECT)))
    .orderBy(desc(inboxItem.createdAt))
    .limit(100);
  const names = await namesOf(tx, rows);
  return rows.map((r) => read(r, names));
}

export function leadRequestRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsLeadRequestCreate, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return {
      request: await createLeadRequest(ctx.tx, ctx.params.id, ctx.body, {
        userId: ctx.session.user.id,
        name: ctx.session.user.name ?? null,
      }),
    };
  });
  mount(app, routes.opsLeadRequests, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { items: await leadRequests(ctx.tx, ctx.params.id) };
  });
}
