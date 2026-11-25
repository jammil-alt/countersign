// Unusual read volume (docs/plan.md §1.245): every 5 minutes, the audit log's last hour, per person
// and per client: a person reading far more than people do (a scrape, a stolen session, a script
// on someone's sign-in) raises an alert. Each alert is a back-office to-do for the operators who
// serve the client, an email to the security officer and a Sentry warning, at most once per person,
// client, kind and hour. It says what to look at and how to lock the client; it locks nothing itself.
//
// Counts only: the audit log holds ids, never content (invariant 14), and so does an alert.

import {
  activeClient,
  auditEvent,
  type Db,
  type Tx,
  tenant,
  todo,
  withOperator,
} from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import type { Mailer } from "../notify/mailer";
import { reportHandled, reportProblem } from "../observability/report";
import { addTodo } from "../work/todos-store";

/**
 * When a person's reads are unusual. Polls the app marks as a refresh don't count, nor the
 * security officer's investigation of a locked client (each is tagged in the audit log).
 */
// DECISION (owner, 2026-11-25: alert on mass downloads): fixed limits, well above a busy person's
// day (a page is a few reads; polls are excluded), to tune once production shows its real spread.
export const VOLUME_LIMITS = {
  /** Reads of one client's data by one person in an hour. */
  readsPerHour: 1000,
  /** Of those, reads of documents (a document, its file link, its readings). */
  documentReadsPerHour: 150,
  /** Exports (client data, accountant, audit) one person starts in a day. */
  exportsPerDay: 3,
} as const;
export type VolumeLimits = {
  readsPerHour: number;
  documentReadsPerHour: number;
  exportsPerDay: number;
};

/** The pass runs every this many minutes, over the last hour. */
export const VOLUME_PASS_MINUTES = 5;

export type VolumeKind = "reads" | "documents" | "exports";

export interface VolumeFinding {
  kind: VolumeKind;
  actorUserId: string;
  email: string | null;
  /** The client read; null for the back office's reads across clients. */
  tenantId: string | null;
  count: number;
  limit: number;
  /** The window counted, in hours. */
  hours: number;
}

const READ = sql`(${auditEvent.action} like 'GET %' or ${auditEvent.action} like 'mcp GET %')`;
const COUNTED = sql`${auditEvent.actorKind} = 'user' and ${auditEvent.outcome} = 'ok'
  and ${auditEvent.actorUserId} is not null
  and coalesce(${auditEvent.target}->>'refresh', '') <> '1'
  and coalesce(${auditEvent.target}->>'investigate', '') <> '1'`;
const DOCUMENT = sql`${auditEvent.action} like '%/documents%'`;
const EXPORT = sql`${auditEvent.action} like '%export%'`;

/** The unusual volumes the audit log shows at `now`, in the transaction's scope. */
export async function findUnusualVolume(
  tx: Tx,
  now: Date,
  limits: VolumeLimits = VOLUME_LIMITS,
): Promise<VolumeFinding[]> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const reads = await tx
    .select({
      actorUserId: sql<string>`${auditEvent.actorUserId}::text`,
      email: sql<string | null>`max(${auditEvent.actorEmail})`,
      tenantId: sql<string | null>`${auditEvent.tenantId}::text`,
      reads: sql<number>`count(*)::int`,
      documents: sql<number>`(count(*) filter (where ${DOCUMENT}))::int`,
    })
    .from(auditEvent)
    .where(
      sql`${auditEvent.createdAt} >= ${hourAgo.toISOString()}::timestamptz and ${READ} and ${COUNTED}`,
    )
    .groupBy(auditEvent.actorUserId, auditEvent.tenantId)
    .having(
      sql`count(*) > ${limits.readsPerHour}
        or count(*) filter (where ${DOCUMENT}) > ${limits.documentReadsPerHour}`,
    );
  const exports = await tx
    .select({
      actorUserId: sql<string>`${auditEvent.actorUserId}::text`,
      email: sql<string | null>`max(${auditEvent.actorEmail})`,
      tenantId: sql<string | null>`${auditEvent.tenantId}::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(auditEvent)
    .where(
      sql`${auditEvent.createdAt} >= ${dayAgo.toISOString()}::timestamptz and ${EXPORT} and ${COUNTED}`,
    )
    .groupBy(auditEvent.actorUserId, auditEvent.tenantId)
    .having(sql`count(*) > ${limits.exportsPerDay}`);

  const found: VolumeFinding[] = [];
  for (const r of reads) {
    const base = { actorUserId: r.actorUserId, email: r.email, tenantId: r.tenantId, hours: 1 };
    if (r.reads > limits.readsPerHour) {
      found.push({ ...base, kind: "reads", count: r.reads, limit: limits.readsPerHour });
    }
    if (r.documents > limits.documentReadsPerHour) {
      found.push({
        ...base,
        kind: "documents",
        count: r.documents,
        limit: limits.documentReadsPerHour,
      });
    }
  }
  for (const r of exports) {
    found.push({
      kind: "exports",
      actorUserId: r.actorUserId,
      email: r.email,
      tenantId: r.tenantId,
      count: r.n,
      limit: limits.exportsPerDay,
      hours: 24,
    });
  }
  return found;
}

const WHAT: Record<VolumeKind, string> = {
  reads: "reads",
  documents: "document reads",
  exports: "exports",
};

function sentence(f: VolumeFinding, client: string): string {
  const who = f.email ?? "Someone";
  const window = f.hours === 1 ? "in the last hour" : "in the last day";
  return `${who} made ${f.count} ${WHAT[f.kind]} of ${client} ${window} (the alert is at ${f.limit}).`;
}

export interface VolumeDeps {
  db: Db;
  mailer: Mailer;
  /** SECURITY_OFFICER_EMAILS. */
  officers: readonly string[];
  /** APP_ORIGIN, for the email's link. */
  origin?: string | undefined;
}

/**
 * The minute cron's call: every VOLUME_PASS_MINUTES, finds unusual volumes and raises each new one.
 * Answers how many new alerts it raised.
 */
export async function volumeTick(
  deps: VolumeDeps,
  scheduledTime: Date,
  limits: VolumeLimits = VOLUME_LIMITS,
): Promise<number> {
  const now = new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000);
  if (now.getUTCMinutes() % VOLUME_PASS_MINUTES !== 0) return 0;
  const clients = await deps.db
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(activeClient());
  const names = new Map(clients.map((c) => [c.id, c.name]));
  // Every client's rows and the back office's own (operator scope over every client).
  const found = await withOperator(
    deps.db,
    clients.map((c) => c.id),
    (tx) => findUnusualVolume(tx, now, limits),
  );
  const hour = now.toISOString().slice(0, 13);
  let raised = 0;
  for (const f of found) {
    const client = f.tenantId ? (names.get(f.tenantId) ?? "a client") : "the back office";
    const text = sentence(f, client);
    const key = `volume:${f.kind}:${f.actorUserId}:${f.tenantId ?? "ops"}:${hour}`;
    try {
      const fresh = await withOperator(deps.db, f.tenantId ? [f.tenantId] : [], async (tx) => {
        const [seen] = await tx.select({ id: todo.id }).from(todo).where(eq(todo.dedupeKey, key));
        if (seen) return false;
        await addTodo(tx, {
          title: `Unusual activity: ${f.email ?? "someone"}, ${f.count} ${WHAT[f.kind]}`,
          owner: "operator",
          clientId: f.tenantId,
          source: "system",
          why: "More reads than a person makes: check it isn't a scrape or a stolen sign-in.",
          detail: [
            text,
            "",
            "Look at their rows in Security → Audit log. If it isn't them, or isn't expected,",
            "lock the client down (its settings → Lockdown) and remove the person's access.",
          ].join("\n"),
          dueAt: new Date(now.getTime() + 60 * 60 * 1000),
          dedupeKey: key,
        });
        return true;
      });
      if (!fresh) continue;
      raised += 1;
      reportProblem("unusual read volume", {
        kind: "audit_volume",
        volume: f.kind,
        actor: f.actorUserId,
        ...(f.tenantId ? { client: f.tenantId } : {}),
      });
      await notifyOfficers(deps, f, text, key);
    } catch (error) {
      reportHandled("raising an unusual-volume alert failed", error, { job: "audit_volume" });
    }
  }
  return raised;
}

async function notifyOfficers(deps: VolumeDeps, f: VolumeFinding, text: string, key: string) {
  if (!deps.mailer.isConfigured || deps.officers.length === 0) return;
  const audit = deps.origin ? `${deps.origin}/ops/security/audit` : "Security → Audit log";
  for (const to of deps.officers) {
    await deps.mailer
      .send({
        to,
        subject: `Unusual activity: ${f.email ?? "someone"}`,
        text: [
          text,
          "",
          `Their rows: ${audit}.`,
          "If it isn't expected, lock the client down (its settings → Lockdown) and remove the",
          "person's access. Nothing has been locked for you.",
        ].join("\n"),
        idempotencyKey: `${key}:${to}`,
      })
      .catch((error: unknown) =>
        reportHandled("an unusual-volume email failed to send", error, { job: "audit_volume" }),
      );
  }
}
