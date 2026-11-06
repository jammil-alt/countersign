// The client's audit export and a run's audit trail (ARCHITECTURE §11.7; docs/plan.md §1.50, W2-G).
// Both read only the client's own `audit_event` rows (tenant_id is the client, invariant 1): never
// sign-ins, never rows without a client, never another client's. The client's people are named;
// Mezonas' people are "Mezonas", except the client's lead, by name. The export is a CSV streamed
// a page at a time, each page in its own client-scoped transaction after the request's commits,
// so a year of rows never sits in memory; a request covers at most 366 days.

import { type AuditPeriod, isPlainObject, type RunAuditEntry, routes } from "@countersign/core";
import {
  appUser,
  auditEvent,
  type Db,
  inboxItem,
  membership,
  run,
  type Tx,
  withTenant,
} from "@countersign/db";
import { and, asc, eq, inArray, isNull, ne, notLike, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { auditInTx } from "../audit";
import { CSV_BOM, CSV_TYPE, type CsvValue, csvLine, jsonCell } from "../exports/csv";
import { periodOf } from "../exports/period";
import { type AppEnv, auditActor, mount, mountStream, notFound } from "../http";
import { leadUserId, tenantRow } from "../notify/people";

type ClientRole = "client_admin" | "client_user";
const isClientRole = (r: string | null | undefined): r is ClientRole =>
  r === "client_admin" || r === "client_user";

/** Rows read per page of the stream. */
export const AUDIT_PAGE_ROWS = 1000;

/** What Mezonas' people are called, the lead excepted. */
export const MEZONAS = "Mezonas";

// ── Who a row names ──────────────────────────────────────────────────────────────────────────────

export interface AuditPeople {
  lead: { id: string; name: string } | null;
  members: Map<string, { name: string | null; email: string; role: string }>;
}

/** The client's members and its lead, read once per request. */
export async function auditPeople(tx: Tx, tenantId: string): Promise<AuditPeople> {
  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email, role: membership.role })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
  const members = new Map(rows.map((r) => [r.id, { name: r.name, email: r.email, role: r.role }]));
  const leadId = leadUserId(t);
  let lead: AuditPeople["lead"] = null;
  if (leadId) {
    const [u] = await tx.select({ name: appUser.name }).from(appUser).where(eq(appUser.id, leadId));
    // DECISION: a lead with no name on record is shown as Mezonas, like the rest of us.
    lead = { id: leadId, name: u?.name ?? MEZONAS };
  }
  return { lead, members };
}

export interface Named {
  who: string;
  side: "client" | "mezonas" | "";
  /** client_admin, client_user, lead, or blank. */
  role: string;
}

/**
 * The name a row shows: the client's own people by name (else their email), the lead by name,
 * everyone else of Mezonas (operators, the system) as "Mezonas".
 */
// DECISION: a row is the client's person's when it was made in a client role (`actor_role`), or,
// with no role recorded, when the user is a client member now; a person who has since left is
// named by the email the row kept.
export function nameOf(
  people: AuditPeople,
  actor: {
    kind: string;
    userId: string | null;
    role: string | null;
    email: string | null;
  },
): Named {
  if (actor.kind === "anonymous") return { who: "Not signed in", side: "", role: "" };
  if (actor.kind === "system") return { who: MEZONAS, side: "mezonas", role: "" };
  if (actor.userId && people.lead?.id === actor.userId) {
    return { who: people.lead.name, side: "mezonas", role: "lead" };
  }
  const m = actor.userId ? people.members.get(actor.userId) : undefined;
  const role = isClientRole(actor.role)
    ? actor.role
    : !actor.role && isClientRole(m?.role)
      ? m?.role
      : null;
  if (role) {
    return { who: m?.name ?? m?.email ?? actor.email ?? "", side: "client", role };
  }
  return { who: MEZONAS, side: "mezonas", role: "" };
}

// ── The export ───────────────────────────────────────────────────────────────────────────────────

export const AUDIT_CSV_HEADER = [
  "time",
  "who",
  "side",
  "role",
  "action",
  "outcome",
  "http_status",
  "target",
  "ip",
  "user_agent",
  "id",
] as const;

type AuditRow = typeof auditEvent.$inferSelect & { at: string };

/** One page of the client's rows in the period, after the cursor, oldest first. */
async function auditPage(
  tx: Tx,
  input: { tenantId: string; start: Date; end: Date; after: { at: string; id: string } | null },
): Promise<AuditRow[]> {
  const rows = await tx
    .select({ e: auditEvent, at: sql<string>`${auditEvent.createdAt}::text` })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.tenantId, input.tenantId),
        sql`${auditEvent.createdAt} >= ${input.start.toISOString()}::timestamptz`,
        sql`${auditEvent.createdAt} < ${input.end.toISOString()}::timestamptz`,
        // Sign-ins carry no client today; never shown to one all the same.
        notLike(auditEvent.action, "session.%"),
        input.after
          ? sql`(${auditEvent.createdAt}, ${auditEvent.id}) > (${input.after.at}::timestamptz, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(auditEvent.createdAt), asc(auditEvent.id))
    .limit(AUDIT_PAGE_ROWS);
  return rows.map((r) => ({ ...r.e, at: r.at }));
}

/** A row as the CSV has it: IP and browser only for the client's own people. */
export function auditCsvRow(people: AuditPeople, e: typeof auditEvent.$inferSelect): CsvValue[] {
  const n = nameOf(people, {
    kind: e.actorKind,
    userId: e.actorUserId,
    role: e.actorRole,
    email: e.actorEmail,
  });
  const own = n.side === "client";
  return [
    e.createdAt,
    n.who,
    n.side,
    n.role,
    e.action,
    e.outcome,
    e.httpStatus,
    jsonCell(e.target),
    own ? e.ip : null,
    own ? e.userAgent : null,
    e.id,
  ];
}

/**
 * The CSV as a stream: the header, then a page at a time, each read in its own transaction scoped
 * to the client. `done` settles when the stream ends, fails or is cancelled.
 */
export function auditCsvStream(
  db: Db,
  input: { tenantId: string; start: Date; end: Date; people: AuditPeople },
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  const encoder = new TextEncoder();
  let after: { at: string; id: string } | null = null;
  let started = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(CSV_BOM + csvLine(AUDIT_CSV_HEADER)));
          return;
        }
        const rows = await withTenant(db, input.tenantId, (tx) =>
          auditPage(tx, { ...input, after }),
        );
        const last = rows.at(-1);
        if (last) {
          after = { at: last.at, id: last.id };
          controller.enqueue(
            encoder.encode(rows.map((e) => csvLine(auditCsvRow(input.people, e))).join("")),
          );
        }
        if (rows.length < AUDIT_PAGE_ROWS) {
          controller.close();
          finish();
        }
      } catch (error) {
        console.error("audit export stopped", error);
        controller.error(error);
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
  return { stream, done };
}

// ── A run's audit trail ──────────────────────────────────────────────────────────────────────────

/** Opening a run, from the portal, the back office or the back office's MCP server. */
const OPEN_RUN_ACTIONS = [
  "GET /api/runs/:id",
  "GET /api/ops/runs/:id",
  "mcp GET /api/ops/runs/:id",
];

/** What a request on one of the run's items did. */
// DECISION: resolving shows as the signature (from the item's resolution), not also as a request.
const ITEM_ACTIONS: Record<string, RunAuditEntry["kind"]> = {
  "POST /api/inbox/:id/edit": "item_edit",
  "POST /api/inbox/:id/snooze": "item_snooze",
  "POST /api/inbox/:id/undo": "item_undo",
  "POST /api/ops/inbox/:id/undo": "item_undo",
  "mcp POST /api/ops/inbox/:id/undo": "item_undo",
};

function resolutionKind(resolution: unknown): RunAuditEntry["kind"] {
  const r = isPlainObject(resolution) ? resolution : {};
  if (r.approved === true || r.decision === "approve") return "signed";
  if (r.approved === false || r.decision === "reject") return "declined";
  return "answered";
}

/** At most this many audit rows make one run's trail (a page polled for days stays bounded). */
const TRAIL_MAX_ROWS = 5000;

/**
 * Who opened a live run or its items and who signed, in order: the client's audit rows naming the
 * run or one of its items (never the operator's items), and the items' resolutions. Consecutive
 * same lines (a run page polled while open) are one line with how many.
 */
export async function runAuditTrail(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<RunAuditEntry[]> {
  const [r] = await tx
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId), eq(run.mode, "live")));
  if (!r) throw notFound("run");
  const people = await auditPeople(tx, tenantId);
  const items = await tx
    .select({
      id: inboxItem.id,
      resolution: inboxItem.resolution,
      resolvedBy: inboxItem.resolvedBy,
      resolvedAt: inboxItem.resolvedAt,
    })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.runId, runId),
        or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
      ),
    );
  const itemIds = items.map((i) => i.id);
  const rows = await tx
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.tenantId, tenantId),
        eq(auditEvent.outcome, "ok"),
        or(
          and(
            inArray(auditEvent.action, OPEN_RUN_ACTIONS),
            sql`${auditEvent.target} ->> 'id' = ${runId}`,
          ),
          itemIds.length > 0
            ? and(
                inArray(auditEvent.action, Object.keys(ITEM_ACTIONS)),
                inArray(sql<string>`${auditEvent.target} ->> 'id'`, itemIds),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(asc(auditEvent.createdAt), asc(auditEvent.id))
    .limit(TRAIL_MAX_ROWS);

  type Line = Omit<RunAuditEntry, "times"> & { order: number };
  const lines: Line[] = [];
  for (const e of rows) {
    const n = nameOf(people, {
      kind: e.actorKind,
      userId: e.actorUserId,
      role: e.actorRole,
      email: e.actorEmail,
    });
    const itemKind = ITEM_ACTIONS[e.action];
    const target = isPlainObject(e.target) ? e.target : {};
    lines.push({
      at: e.createdAt.toISOString(),
      who: n.who,
      side: n.side === "client" ? "client" : "mezonas",
      kind: itemKind ?? "opened_run",
      itemId: itemKind && typeof target.id === "string" ? target.id : null,
      order: e.createdAt.getTime(),
    });
  }
  for (const i of items) {
    if (!i.resolvedAt) continue;
    const n = nameOf(people, { kind: "user", userId: i.resolvedBy, role: null, email: null });
    lines.push({
      at: i.resolvedAt.toISOString(),
      who: n.who,
      side: n.side === "client" ? "client" : "mezonas",
      kind: resolutionKind(i.resolution),
      itemId: i.id,
      order: i.resolvedAt.getTime(),
    });
  }
  lines.sort((a, b) => a.order - b.order);
  const out: RunAuditEntry[] = [];
  for (const { order: _o, ...l } of lines) {
    const prev = out.at(-1);
    if (prev && prev.who === l.who && prev.kind === l.kind && prev.itemId === l.itemId) {
      prev.times += 1;
    } else {
      out.push({ ...l, times: 1 });
    }
  }
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

export function auditExportRoutes(app: Hono<AppEnv>): void {
  mountStream(
    app,
    routes.portalAuditExportCsv,
    async ({ c, tx, tenantIds, query, session, services, defer }) => {
      const tenantId = tenantIds[0] as string;
      const p: AuditPeriod = query;
      const period = await periodOf(tx, tenantId, p);
      const people = await auditPeople(tx, tenantId);
      // The export's own row, beside the request's: what it covered.
      await auditInTx(tx, c, {
        ...auditActor(session),
        tenantId,
        action: "export.audit",
        outcome: "ok",
        httpStatus: 200,
        target: { from: p.from, to: p.to },
      });
      const { stream, done } = auditCsvStream(services.db, {
        tenantId,
        start: period.start,
        end: period.end,
        people,
      });
      // The database closes after the deferred work: wait for the stream's last page.
      defer(() => done);
      return {
        filename: `mezonas-audit-log-${p.from}-to-${p.to}.csv`,
        contentType: CSV_TYPE as typeof CSV_TYPE,
        stream,
      };
    },
  );

  mount(app, routes.portalRunAudit, async ({ tx, tenantIds, params }) => ({
    entries: await runAuditTrail(tx, tenantIds[0] as string, params.id),
  }));
}
