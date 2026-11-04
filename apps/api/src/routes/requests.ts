// Requests (ARCHITECTURE §1 item 7, §11): a client raises one from the portal; it is an inbox item
// of kind `change_request` assigned to the operator, so it lands in the back office's requests
// queue (and never in the client's inbox, which hides the operator's items). The operator resolves
// it as done, linking the client agent or template versions made for it, or declined, with a note
// the client reads. Resolving emits `inbox.resolved` like any other item.
//
// The client sees its requests, their status, the note and which of its services changed; never a
// template, an agent slug or anything of a bundle (invariant 11).

import {
  type OpsRequest,
  type PortalRequest,
  type RequestStatus,
  type Role,
  routes,
} from "@countersign/core";
import { agent, agentVersion, appUser, inboxItem, type Tx, tenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import type { InboxRow } from "../inbox";
import { dispatchEvents } from "../runs/dispatch";

/** What a request keeps in `inbox_item.payload`. */
interface RequestPayload {
  text: string;
  subject: string | null;
  /** Who raised it (inbox items have no author column). */
  raisedBy: string;
}

/** What a resolved request keeps in `inbox_item.resolution`. */
interface RequestResolutionRow {
  outcome: "done" | "declined";
  note: string | null;
  /** agent_version ids. */
  links: string[];
  by: string;
}

const TITLE_MAX = 80;

/** The queue's one-line title: the subject, else the first line of the text, clipped. */
export function requestTitle(subject: string | undefined, text: string): string {
  const line = (subject ?? text.split("\n").find((l) => l.trim()) ?? text).trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

function payloadOf(row: InboxRow): RequestPayload {
  const p = row.payload as Partial<RequestPayload>;
  return {
    text: typeof p.text === "string" ? p.text : row.title,
    subject: typeof p.subject === "string" ? p.subject : null,
    raisedBy: typeof p.raisedBy === "string" ? p.raisedBy : "",
  };
}

function resolutionOf(row: InboxRow): RequestResolutionRow | null {
  if (row.status !== "resolved") return null;
  const r = (row.resolution ?? {}) as Partial<RequestResolutionRow>;
  return {
    outcome: r.outcome === "declined" ? "declined" : "done",
    note: typeof r.note === "string" && r.note ? r.note : null,
    links: Array.isArray(r.links) ? r.links.filter((l): l is string => typeof l === "string") : [],
    by: typeof r.by === "string" ? r.by : (row.resolvedBy ?? ""),
  };
}

function statusOf(row: InboxRow): RequestStatus {
  return resolutionOf(row)?.outcome ?? "open";
}

const isRequest = eq(inboxItem.kind, "change_request");

function statusFilter(status: "open" | "resolved" | "all"): SQL[] {
  return status === "all" ? [] : [eq(inboxItem.status, status)];
}

/** Client users see the requests they raised; the client admin sees all of the client's. */
// DECISION: a client_user's requests are their own (as their inbox is); the client admin, who
// answers for the client, sees everyone's.
function portalScope(role: Role, userId: string): SQL[] {
  return role === "client_admin" ? [] : [sql`${inboxItem.payload}->>'raisedBy' = ${userId}`];
}

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, { email: string; name: string | null }>();
  const rows = await tx
    .select({ id: appUser.id, email: appUser.email, name: appUser.name })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, { email: r.email, name: r.name }]));
}

/** The linked versions with their agents; templates and client agents alike. */
async function linkedVersions(tx: Tx, ids: string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      versionId: agentVersion.id,
      version: agentVersion.version,
      agentId: agent.id,
      kind: agent.kind,
      tenantId: agent.tenantId,
      slug: agent.slug,
      name: agent.name,
      serviceName: agent.serviceName,
      testCopy: agent.testCopy,
    })
    .from(agentVersion)
    .innerJoin(agent, eq(agent.id, agentVersion.agentId))
    .where(inArray(agentVersion.id, [...new Set(ids)]));
}

async function agentsById(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map<string, typeof agent.$inferSelect>();
  const rows = await tx.select().from(agent).where(inArray(agent.id, wanted));
  return new Map(rows.map((a) => [a.id, a]));
}

const serviceName = (a: { serviceName: string | null; name: string }) => a.serviceName ?? a.name;

async function portalRequests(tx: Tx, tenantId: string, rows: InboxRow[]) {
  const names = await people(
    tx,
    rows.map((r) => payloadOf(r).raisedBy),
  );
  const services = await agentsById(
    tx,
    rows.map((r) => r.agentId),
  );
  const versions = await linkedVersions(
    tx,
    rows.flatMap((r) => resolutionOf(r)?.links ?? []),
  );
  return rows.map((r): PortalRequest => {
    const p = payloadOf(r);
    const res = resolutionOf(r);
    const service = r.agentId ? services.get(r.agentId) : undefined;
    const raiser = p.raisedBy ? names.get(p.raisedBy) : undefined;
    return {
      id: r.id,
      subject: r.title,
      text: p.text,
      service: service ? { id: service.id, name: serviceName(service) } : null,
      status: statusOf(r),
      raisedBy: p.raisedBy ? { id: p.raisedBy, name: raiser?.name ?? null } : null,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: iso(r.resolvedAt),
      note: res?.note ?? null,
      // Only this client's own services: templates and test copies stay in the back office.
      changes: (res?.links ?? []).flatMap((id) => {
        const v = versions.find((x) => x.versionId === id);
        if (v?.kind !== "client" || v.tenantId !== tenantId || v.testCopy) return [];
        return [{ service: { id: v.agentId, name: serviceName(v) }, version: v.version }];
      }),
    };
  });
}

async function opsRequests(tx: Tx, rows: InboxRow[]) {
  const names = await people(
    tx,
    rows.flatMap((r) => [payloadOf(r).raisedBy, r.resolvedBy]),
  );
  const agents = await agentsById(
    tx,
    rows.map((r) => r.agentId),
  );
  const versions = await linkedVersions(
    tx,
    rows.flatMap((r) => resolutionOf(r)?.links ?? []),
  );
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const clients =
    tenantIds.length > 0
      ? await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, tenantIds))
      : [];
  const person = (id: string | null | undefined) => {
    if (!id) return null;
    const p = names.get(id);
    return { id, email: p?.email ?? "", name: p?.name ?? null };
  };
  return rows.map((r): OpsRequest => {
    const p = payloadOf(r);
    const res = resolutionOf(r);
    const a = r.agentId ? agents.get(r.agentId) : undefined;
    return {
      id: r.id,
      client: clients.find((c) => c.id === r.tenantId) ?? { id: r.tenantId, name: "" },
      subject: r.title,
      text: p.text,
      agent: a ? { id: a.id, slug: a.slug, name: a.name, serviceName: serviceName(a) } : null,
      status: statusOf(r),
      raisedBy: person(p.raisedBy),
      createdAt: r.createdAt.toISOString(),
      resolvedAt: iso(r.resolvedAt),
      resolvedBy: person(r.resolvedBy),
      note: res?.note ?? null,
      links: (res?.links ?? []).flatMap((id) => {
        const v = versions.find((x) => x.versionId === id);
        if (!v) return [];
        return [
          {
            agentVersionId: v.versionId,
            agentId: v.agentId,
            kind: v.kind,
            tenantId: v.tenantId,
            slug: v.slug,
            name: v.name,
            version: v.version,
          },
        ];
      }),
    };
  });
}

/** A request in the operator's scope, locked for the resolution. */
async function lockRequest(tx: Tx, tenantIds: readonly string[], id: string): Promise<InboxRow> {
  const [row] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, id), isRequest, inArray(inboxItem.tenantId, [...tenantIds])))
    .for("update");
  if (!row) throw notFound("request");
  return row;
}

export function requestRouteHandlers(app: Hono<AppEnv>): void {
  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.portalRequests, async ({ tx, tenantIds, role, session, query }) => {
    const tenantId = tenantIds[0] as string;
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          isRequest,
          ...statusFilter(query.status),
          ...portalScope(role, session.user.id),
        ),
      )
      .orderBy(desc(inboxItem.createdAt), desc(inboxItem.id))
      .limit(200);
    return { items: await portalRequests(tx, tenantId, rows) };
  });

  mount(app, routes.portalRaiseRequest, async ({ tx, tenantIds, session, body }) => {
    const tenantId = tenantIds[0] as string;
    if (body.serviceId) {
      // One of the services the client sees (its overview's list), nothing else.
      const [service] = await tx
        .select({ id: agent.id })
        .from(agent)
        .where(
          and(
            eq(agent.id, body.serviceId),
            eq(agent.tenantId, tenantId),
            eq(agent.kind, "client"),
            eq(agent.testCopy, false),
            inArray(agent.runStatus, ["active", "paused"]),
          ),
        );
      if (!service) throw notFound("service");
    }
    const payload: RequestPayload = {
      text: body.text,
      subject: body.subject ?? null,
      raisedBy: session.user.id,
    };
    const [row] = await tx
      .insert(inboxItem)
      .values({
        tenantId,
        kind: "change_request",
        agentId: body.serviceId ?? null,
        assigneeRole: "operator",
        title: requestTitle(body.subject, body.text),
        payload: { ...payload },
      })
      .returning();
    if (!row) throw new Error("request insert returned nothing");
    const [item] = await portalRequests(tx, tenantId, [row]);
    if (!item) throw new Error("no request");
    return { item };
  });

  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsRequests, async ({ tx, tenantIds, query }) => {
    if (query.client && !tenantIds.includes(query.client)) throw notFound("client");
    const scope = query.client ? [query.client] : [...tenantIds];
    if (scope.length === 0) return { items: [] };
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(and(inArray(inboxItem.tenantId, scope), isRequest, ...statusFilter(query.status)))
      .orderBy(desc(inboxItem.createdAt), desc(inboxItem.id))
      .limit(500);
    return { items: await opsRequests(tx, rows) };
  });

  mount(app, routes.opsResolveRequest, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const row = await lockRequest(tx, tenantIds, params.id);
    if (row.status !== "open") {
      throw new HttpError(409, "already_resolved", "this request was already resolved");
    }
    // Each link is a version of a template or of this client's own agent (not a Sandbox test
    // copy). Another client's agent never resolves this client's request.
    // DECISION: any version counts, draft or published: the operator resolves a request when the
    // work is made, and publishing stays its own step.
    const links = [...new Set(body.links)];
    const found = await linkedVersions(tx, links);
    for (const id of links) {
      const v = found.find((x) => x.versionId === id);
      const ok = !!v && !v.testCopy && (v.kind === "template" || v.tenantId === row.tenantId);
      if (!ok) {
        throw new HttpError(
          422,
          "invalid_link",
          "link versions of a template or of this client's own agents",
        );
      }
    }
    const resolution: RequestResolutionRow = {
      outcome: body.outcome,
      note: body.note?.trim() || null,
      links,
      by: session.user.id,
    };
    const [updated] = await tx
      .update(inboxItem)
      .set({
        status: "resolved",
        resolution: { ...resolution },
        resolvedBy: session.user.id,
        resolvedAt: new Date(),
      })
      .where(and(eq(inboxItem.id, row.id), eq(inboxItem.tenantId, row.tenantId)))
      .returning();
    if (!updated) throw notFound("request");
    const collect: EventRow[] = [];
    const event = await emit(
      tx,
      {
        tenantId: row.tenantId,
        type: "inbox.resolved",
        subjectType: "inbox_item",
        subjectId: row.id,
        payload: {
          inboxItemId: row.id,
          kind: row.kind,
          runId: null,
          approved: body.outcome === "done",
          resolvedBy: session.user.id,
        },
      },
      { registry: services.platform.events },
    );
    if (event) collect.push(event);
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    const [item] = await opsRequests(tx, [updated]);
    if (!item) throw new Error("no request");
    return { item };
  });
}
