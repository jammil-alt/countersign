// Asks and enhancements (docs/plan.md §1.123.1; docs/cases-plan.md §3.2, B4). A client's ask ("an
// idea or a change") stays the client's, in its words, on its own conversation; the operator groups
// asks across clients under an enhancement (operator-only, global, holding no client's words:
// invariant 11), decides it (do, later, no or sell it) and, once shipped, tells everyone who asked.

import type { AskView, EnhancementDetail, OpsEnhancement } from "@countersign/core";
import { standingOf } from "@countersign/core";
import { agent, clientAsk, enhancement, type Tx, tenant, thread } from "@countersign/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { iso, notFound } from "../http";
import { issueTitle, postOnThread, userNames } from "./issues";

export type AskRow = typeof clientAsk.$inferSelect;
export type EnhancementRow = typeof enhancement.$inferSelect;

export const ASK_SUBJECT = "client_ask";

export async function createAsk(
  tx: Tx,
  input: {
    tenantId: string;
    title?: string | null;
    text: string;
    source: AskRow["source"];
    raisedBy?: string | null;
    raisedByEmail?: string | null;
    agentId?: string | null;
    /** Post the text as the raiser's opening message. */
    opening?: boolean;
  },
): Promise<AskRow> {
  if (input.agentId) {
    const [a] = await tx
      .select({ id: agent.id })
      .from(agent)
      .where(
        and(
          eq(agent.id, input.agentId),
          eq(agent.tenantId, input.tenantId),
          eq(agent.kind, "client"),
        ),
      );
    if (!a) throw notFound("agent");
  }
  const title = issueTitle(input.title, input.text);
  const [th] = await tx
    .insert(thread)
    .values({
      tenantId: input.tenantId,
      subjectType: ASK_SUBJECT,
      title,
      createdBy: input.raisedBy ?? null,
    })
    .returning();
  if (!th) throw new Error("thread insert returned nothing");
  const [row] = await tx
    .insert(clientAsk)
    .values({
      tenantId: input.tenantId,
      title,
      text: input.text.slice(0, 4000),
      source: input.source,
      raisedBy: input.raisedBy ?? null,
      raisedByEmail: input.raisedByEmail ?? null,
      agentId: input.agentId ?? null,
      threadId: th.id,
    })
    .returning();
  if (!row) throw new Error("ask insert returned nothing");
  await tx
    .update(thread)
    .set({ subjectId: row.id })
    .where(and(eq(thread.id, th.id), eq(thread.tenantId, input.tenantId)));
  if (input.opening) {
    await postOnThread(tx, {
      tenantId: input.tenantId,
      threadId: th.id,
      senderType: input.raisedBy ? "user" : "system",
      senderId: input.raisedBy ?? null,
      text: input.text.slice(0, 4000),
      audience: "client",
    });
  }
  return row;
}

export async function askViews(tx: Tx, rows: AskRow[]): Promise<AskView[]> {
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const clients = tenantIds.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name })
        .from(tenant)
        .where(inArray(tenant.id, tenantIds))
    : [];
  const agentIds = [...new Set(rows.map((r) => r.agentId).filter((v): v is string => !!v))];
  const agents = agentIds.length
    ? await tx
        .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
        .from(agent)
        .where(inArray(agent.id, agentIds))
    : [];
  const names = await userNames(
    tx,
    rows.map((r) => r.raisedBy),
  );
  return rows.map((r) => {
    const a = agents.find((x) => x.id === r.agentId);
    return {
      id: r.id,
      client: clients.find((c) => c.id === r.tenantId) ?? { id: r.tenantId, name: "" },
      title: r.title,
      text: r.text,
      status: r.status,
      agent: a ? { id: a.id, name: a.serviceName ?? a.name } : null,
      enhancementId: r.enhancementId ?? null,
      issueId: r.issueId ?? null,
      raisedBy: (r.raisedBy && names.get(r.raisedBy)) || r.raisedByEmail || null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export async function readAsk(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<AskRow> {
  if (tenantIds.length === 0) throw notFound("ask");
  const q = tx
    .select()
    .from(clientAsk)
    .where(and(eq(clientAsk.id, id), inArray(clientAsk.tenantId, [...tenantIds])));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("ask");
  return row;
}

export async function readEnhancement(tx: Tx, id: string, lock = false): Promise<EnhancementRow> {
  const q = tx.select().from(enhancement).where(eq(enhancement.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("enhancement");
  return row;
}

export const enhancementDone = (e: Pick<EnhancementRow, "stage" | "decision">) =>
  e.stage === "shipped" || e.decision === "no";

/** The asks grouped under each enhancement, of the clients served (another's never reaches here). */
export async function askCounts(tx: Tx, ids: string[], tenantIds: readonly string[]) {
  const out = new Map<string, number>();
  if (ids.length === 0 || tenantIds.length === 0) return out;
  const rows = await tx
    .select({
      id: clientAsk.enhancementId,
      n: sql<number>`count(distinct ${clientAsk.tenantId})::int`,
    })
    .from(clientAsk)
    .where(and(inArray(clientAsk.enhancementId, ids), inArray(clientAsk.tenantId, [...tenantIds])))
    .groupBy(clientAsk.enhancementId);
  for (const r of rows) if (r.id) out.set(r.id, r.n);
  return out;
}

export function opsEnhancement(e: EnhancementRow, asks: number): OpsEnhancement {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    stage: e.stage,
    decision: e.decision ?? null,
    decisionNote: e.decisionNote ?? null,
    decideBy: e.decideBy ?? null,
    waitingOn: e.waitingOn,
    statusLine: e.statusLine,
    stuck: e.stuck,
    standing: standingOf({ doneish: enhancementDone(e), waitingOn: e.waitingOn, stuck: e.stuck }),
    asks,
    createdAt: e.createdAt.toISOString(),
    decidedAt: iso(e.decidedAt),
    shippedAt: iso(e.shippedAt),
  };
}

export async function enhancementDetail(
  tx: Tx,
  e: EnhancementRow,
  tenantIds: readonly string[],
): Promise<EnhancementDetail> {
  const asks =
    tenantIds.length === 0
      ? []
      : await tx
          .select()
          .from(clientAsk)
          .where(
            and(eq(clientAsk.enhancementId, e.id), inArray(clientAsk.tenantId, [...tenantIds])),
          )
          .orderBy(desc(clientAsk.createdAt))
          .limit(200);
  const clients = new Set(asks.map((a) => a.tenantId)).size;
  return { enhancement: opsEnhancement(e, clients), asks: await askViews(tx, asks) };
}

/** Groups the ask under the enhancement; the enhancement moves on to grouped once it has one. */
export async function groupAsk(tx: Tx, ask: AskRow, e: EnhancementRow): Promise<void> {
  await tx
    .update(clientAsk)
    .set({ enhancementId: e.id, status: ask.status === "open" ? "grouped" : ask.status })
    .where(and(eq(clientAsk.id, ask.id), eq(clientAsk.tenantId, ask.tenantId)));
  if (e.stage === "captured") {
    await tx
      .update(enhancement)
      .set({ stage: "grouped", stageAt: new Date() })
      .where(eq(enhancement.id, e.id));
  }
}

/**
 * Shipped: the note goes on each grouped ask's conversation (of the clients served), and each ask
 * is told.
 */
// DECISION: the note is sent as written, in the operator's words; translating it into each
// client's language is left to the conversation's own translation (§1.69), so English here.
export async function tellAsks(
  tx: Tx,
  e: EnhancementRow,
  input: { note: string; userId: string; tenantIds: readonly string[] },
): Promise<number> {
  if (input.tenantIds.length === 0) return 0;
  const asks = await tx
    .select()
    .from(clientAsk)
    .where(
      and(
        eq(clientAsk.enhancementId, e.id),
        inArray(clientAsk.tenantId, [...input.tenantIds]),
        inArray(clientAsk.status, ["open", "grouped"]),
      ),
    );
  const now = new Date();
  for (const a of asks) {
    await postOnThread(tx, {
      tenantId: a.tenantId,
      threadId: a.threadId,
      senderType: "user",
      senderId: input.userId,
      text: input.note,
      audience: "client",
    });
    await tx
      .update(clientAsk)
      .set({ status: "told", toldAt: now })
      .where(and(eq(clientAsk.id, a.id), eq(clientAsk.tenantId, a.tenantId)));
  }
  await tx
    .update(enhancement)
    .set({ stage: "shipped", shippedAt: now, stageAt: now, waitingOn: "operator" })
    .where(eq(enhancement.id, e.id));
  return asks.length;
}
