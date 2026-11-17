// Sales (docs/plan.md §1.123.2; docs/cases-plan.md S1–S2): reading and writing deals, their people
// and their activity in an operator's transaction. Deals are operator-only tables (migration 0063):
// row-level security keeps a deal that names a client to operators serving it, and every query
// here says the same (invariant 1). Money stays a decimal string (invariant 6).

import {
  type DealActivityView,
  type DealDetail,
  type DealKind,
  type DealStage,
  type DealSummary,
  dealIsLate,
  dealStageOf,
  dealStages,
  dealStanding,
  dealStatusText,
  HEALTH_LIMITS,
  isRenewal,
  weightedMrr,
} from "@countersign/core";
import {
  appUser,
  build,
  deal,
  dealActivity,
  dealPerson,
  inboxItem,
  issue,
  type Tx,
  tenant,
  todo,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { iso, notFound } from "../http";

export type DealRow = typeof deal.$inferSelect;
export type DealPersonRow = typeof dealPerson.$inferSelect;

/** Today's date for Sales: due dates and "this month". */
// DECISION: Sales reads its dates in UTC: deals span the operator's clients, and a lead has no
// time zone yet.
export const salesToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Only deals with no client, or for clients this session serves (row-level security says it too). */
export function inSalesScope(tenantIds: readonly string[]) {
  return tenantIds.length > 0
    ? or(isNull(deal.clientId), inArray(deal.clientId, [...tenantIds]))
    : isNull(deal.clientId);
}

export async function readDeal(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<DealRow> {
  const q = tx
    .select()
    .from(deal)
    .where(and(eq(deal.id, id), inSalesScope(tenantIds)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("deal");
  return row;
}

async function clientNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  for (const r of await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, wanted))) {
    out.set(r.id, r.name);
  }
  return out;
}

/**
 * Why each client's expansion deals wait, derived and never stored: an open critical or high
 * issue at the client, else the account at risk.
 */
// DECISION: "at risk" is the command center's bad-health line for escalations: this many open
// back-office items at the client (HEALTH_LIMITS.badEscalations). The clean share and response
// time need a week of runs read per client, which a list of deals doesn't.
export async function heldClients(
  tx: Tx,
  clientIds: (string | null)[],
): Promise<Map<string, { reason: string }>> {
  const ids = [...new Set(clientIds.filter((x): x is string => !!x))];
  const out = new Map<string, { reason: string }>();
  if (ids.length === 0) return out;
  const issues = await tx
    .select({ tenantId: issue.tenantId })
    .from(issue)
    .where(
      and(
        inArray(issue.tenantId, ids),
        ne(issue.stage, "closed"),
        inArray(issue.urgency, ["critical", "high"]),
      ),
    )
    .groupBy(issue.tenantId);
  for (const r of issues) out.set(r.tenantId, { reason: "Held: critical issue" });
  const escalations = await tx
    .select({ tenantId: inboxItem.tenantId, n: sql<number>`count(*)::int` })
    .from(inboxItem)
    .where(
      and(
        inArray(inboxItem.tenantId, ids),
        eq(inboxItem.status, "open"),
        eq(inboxItem.assigneeRole, "operator"),
      ),
    )
    .groupBy(inboxItem.tenantId);
  for (const r of escalations) {
    if (!out.has(r.tenantId) && r.n >= HEALTH_LIMITS.badEscalations) {
      out.set(r.tenantId, { reason: "Held: account at risk" });
    }
  }
  return out;
}

export function toSummary(
  row: DealRow,
  names: Map<string, string>,
  held: Map<string, { reason: string }>,
  today: string,
): DealSummary {
  const kind = row.kind as DealKind;
  const stage = row.stage as DealStage;
  const s = dealStageOf(kind, stage);
  // Only an open expansion deal waits on its client's trouble; a new account has no client yet.
  const heldBy =
    kind === "expansion" && row.outcome === "open" && row.clientId
      ? (held.get(row.clientId) ?? null)
      : null;
  const standing = dealStanding({
    outcome: row.outcome,
    waitingOn: row.waitingOn,
    stuck: row.stuck,
    held: heldBy !== null,
  });
  const wonAt = iso(row.wonAt);
  const closedAt = iso(row.closedAt);
  return {
    id: row.id,
    kind,
    client: row.clientId ? { id: row.clientId, name: names.get(row.clientId) ?? "" } : null,
    company: row.company,
    title: row.title,
    description: row.description,
    stage,
    stageName: s.name,
    likelihood: s.p,
    agentCount: row.agentCount,
    mrr: row.mrr,
    currency: row.currency,
    weighted: weightedMrr(kind, stage, row.mrr),
    renewal: isRenewal({ kind, title: row.title }),
    outcome: row.outcome,
    waitingOn: row.waitingOn,
    statusLine: row.statusLine,
    statusText: dealStatusText({
      standing,
      statusLine: row.statusLine,
      held: heldBy,
      outcome: row.outcome,
      wonAt,
      closedAt,
    }),
    stuck: row.stuck,
    held: heldBy,
    standing,
    late: dealIsLate({ nextDueOn: row.nextDueOn, standing }, today),
    nextStep: row.nextStep,
    nextDueOn: row.nextDueOn,
    source: row.source,
    origin:
      row.originKind && row.originId
        ? ({ kind: row.originKind, id: row.originId } as DealSummary["origin"])
        : null,
    agreedMrr: row.agreedMrr,
    stageAt: iso(row.stageAt) as string,
    wonAt,
    closedAt,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

export async function summariesOf(tx: Tx, rows: DealRow[], today: string): Promise<DealSummary[]> {
  const ids = rows.map((r) => r.clientId);
  const [names, held] = await Promise.all([clientNames(tx, ids), heldClients(tx, ids)]);
  return rows.map((r) => toSummary(r, names, held, today));
}

export interface NewActivity {
  kind: DealActivityView["kind"];
  actor: DealActivityView["actor"];
  userId?: string | null;
  subject?: string | null;
  body?: string;
  meta?: Record<string, unknown>;
  sources?: string[];
}

/** One line on a deal's timeline (insert only). */
export async function addActivity(tx: Tx, dealId: string, a: NewActivity): Promise<void> {
  await tx.insert(dealActivity).values({
    dealId,
    kind: a.kind,
    actor: a.actor,
    userId: a.userId ?? null,
    subject: a.subject ?? null,
    body: a.body ?? "",
    meta: a.meta ?? {},
    sources: a.sources ?? [],
  });
}

/** Who a timeline line is from, in words. */
function whoOf(
  a: typeof dealActivity.$inferSelect,
  users: Map<string, string>,
  people: DealPersonRow[],
): string | null {
  if (a.actor === "reggie") return "Reggie";
  if (a.actor === "system") return null;
  if (a.actor === "operator") return a.userId ? (users.get(a.userId) ?? "Operator") : "Operator";
  const meta = (a.meta ?? {}) as { name?: unknown; personId?: unknown };
  if (typeof meta.name === "string" && meta.name) return meta.name;
  const person = people.find((p) => p.id === meta.personId) ?? people.find((p) => p.isPrimary);
  return person?.name ?? "Contact";
}

export async function dealDetail(tx: Tx, row: DealRow, today: string): Promise<DealDetail> {
  const [summary] = await summariesOf(tx, [row], today);
  if (!summary) throw new Error("no summary");
  const kind = row.kind as DealKind;
  const [people, activity, builds, paid] = await Promise.all([
    tx
      .select()
      .from(dealPerson)
      .where(eq(dealPerson.dealId, row.id))
      .orderBy(desc(dealPerson.isPrimary), asc(dealPerson.createdAt)),
    tx
      .select()
      .from(dealActivity)
      .where(eq(dealActivity.dealId, row.id))
      .orderBy(desc(dealActivity.createdAt), desc(dealActivity.id))
      .limit(200),
    tx
      .select({ id: build.id, title: build.title, status: build.status, phase: build.phase })
      .from(build)
      .where(and(eq(build.originKind, "deal"), eq(build.originId, row.id)))
      .orderBy(asc(build.createdAt)),
    row.clientId
      ? tx
          .select({
            mrr: sql<string>`coalesce(sum(coalesce(${deal.agreedMrr}, ${deal.mrr})), 0)::numeric(14,4)::text`,
          })
          .from(deal)
          .where(and(eq(deal.clientId, row.clientId), eq(deal.outcome, "won")))
      : Promise.resolve([]),
  ]);
  const userIds = [...new Set(activity.map((a) => a.userId).filter((x): x is string => !!x))];
  const users = new Map<string, string>();
  if (userIds.length > 0) {
    for (const u of await tx
      .select({ id: appUser.id, name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, userIds))) {
      users.set(u.id, u.name ?? u.email);
    }
  }
  return {
    deal: {
      ...summary,
      agentsSold: row.agentsSold,
      outcomeReason: row.outcomeReason,
      checkBackOn: row.checkBackOn,
      sourceDetail: row.sourceDetail,
      evidence: row.evidence,
      agreedFrom: row.agreedFrom,
      signedCopy: row.signedCopyKey ? { name: row.signedCopyName ?? "Signed copy.pdf" } : null,
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        role: p.role,
        isPrimary: p.isPrimary,
      })),
    },
    activity: activity.map((a) => ({
      id: a.id,
      kind: a.kind,
      actor: a.actor,
      who: whoOf(a, users, people),
      subject: a.subject,
      body: a.body,
      sources: a.sources,
      createdAt: iso(a.createdAt) as string,
    })),
    builds,
    now: row.clientId ? { mrr: paid[0]?.mrr ?? "0.0000", currency: row.currency } : null,
    stages: dealStages(kind).map((s) => ({ id: s.id, name: s.name, p: s.p })),
  };
}

/** Makes one person the deal's primary one (the others stop being it). */
export async function makePrimary(tx: Tx, dealId: string, personId: string): Promise<void> {
  await tx
    .update(dealPerson)
    .set({ isPrimary: sql`${dealPerson.id} = ${personId}` })
    .where(eq(dealPerson.dealId, dealId));
}

/**
 * Reggie's to-do to check back on a deal that closed without a sale, made once per deal and date.
 */
// DECISION: written straight to `todo` (owner reggie, about the deal) until the shared
// `addTodo` helper (§1.123, stage 0) lands; the dedupe key keeps it to one per check-back.
export async function addCheckBack(
  tx: Tx,
  row: DealRow,
  on: string,
  userId: string,
): Promise<void> {
  const who = row.company ?? row.title;
  await tx
    .insert(todo)
    .values({
      clientId: row.clientId,
      owner: "reggie",
      title: `Check back with ${who}`,
      detail: row.outcomeReason ?? "",
      why: "They said not yet; we said we'd ask again.",
      dueAt: new Date(`${on}T09:00:00Z`),
      aboutKind: "deal",
      aboutId: row.id,
      source: "system",
      dedupeKey: `deal:${row.id}:checkback:${on}`,
      createdBy: userId,
    })
    .onConflictDoNothing();
}
