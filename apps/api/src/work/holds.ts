// The safety hold (docs/plan.md §1.124.1; docs/cases-plan.md §3.2, B3). On a critical issue the
// client agent's writes and messages stop: the permission gate adds an approval ceiling for every
// external tool while held (packages/agents runtime), sends are never automatic, approving a held
// agent's Desk items answers 409, and redelivery waits. Its runs go on as drafts. Placing a hold
// only makes things safer, so Reggie may; only a person releases it, through the operator route.
//
// DECISION: only a critical issue holds an agent; a high one does not (owner, 2026-11-17).
// DECISION: no phone alert for a hold yet (owner, 2026-11-17).

import { type AgentHold, type HoldView, holdNotice, readHold } from "@countersign/core";
import {
  agent,
  agentVersion,
  externalAction,
  inboxItem,
  issue,
  issueEvent,
  reachOut,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { addTodo, inOperatorTx } from "./todos-store";

type AgentRow = typeof agent.$inferSelect;

const serviceName = (a: Pick<AgentRow, "serviceName" | "name">) => a.serviceName ?? a.name;

/** The client agent, in one of the request's clients, locked for the change. */
async function clientAgent(tx: Tx, agentId: string, tenantIds?: readonly string[]) {
  const [row] = await tx.select().from(agent).where(eq(agent.id, agentId)).for("update");
  if (!row || row.tenantId === null || (tenantIds && !tenantIds.includes(row.tenantId))) {
    throw notFound("agent");
  }
  // DECISION: a hold is set only on a client agent, never on a template (the column's comment).
  if (row.kind !== "client") {
    throw new HttpError(422, "not_a_client_agent", "only a client's agent can be held");
  }
  return row as AgentRow & { tenantId: string };
}

/** True when the agent is on a safety hold now (read fresh, in the caller's transaction). */
export async function agentHeld(tx: Tx, tenantId: string, agentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ hold: agent.hold })
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
  return readHold(row?.hold ?? null) !== null;
}

/**
 * Puts the agent on a safety hold for the issue. A hold already in place stays as it is (the
 * first one is kept). Writes the issue's `hold` event and, in an operator's transaction, a to-do
 * to tell the client, with the plain notice as the draft. Returns the hold in force.
 */
export async function placeHold(
  tx: Tx,
  input: {
    agentId: string;
    issueId: string;
    by: "reggie" | "operator";
    userId: string | null;
    reason: string;
    tenantIds?: readonly string[];
    now?: Date;
  },
): Promise<AgentHold> {
  const a = await clientAgent(tx, input.agentId, input.tenantIds);
  const existing = readHold(a.hold);
  if (existing) return existing;
  const [iss] = await tx
    .select({ id: issue.id, tenantId: issue.tenantId })
    .from(issue)
    .where(and(eq(issue.id, input.issueId), eq(issue.tenantId, a.tenantId)));
  if (!iss) throw notFound("issue");
  const at = (input.now ?? new Date()).toISOString();
  const hold: AgentHold = {
    issueId: iss.id,
    by: input.by,
    userId: input.userId,
    at,
    reason: input.reason.slice(0, 500),
  };
  await tx
    .update(agent)
    .set({ hold })
    .where(and(eq(agent.id, a.id), eq(agent.tenantId, a.tenantId)));
  await tx.insert(issueEvent).values({
    tenantId: a.tenantId,
    issueId: iss.id,
    kind: "hold",
    toValue: a.id,
    reason: hold.reason,
    actor: input.by,
    userId: input.userId,
    payload: { agentId: a.id },
  });
  if (await inOperatorTx(tx)) {
    const [client] = await tx
      .select({ name: tenant.name })
      .from(tenant)
      .where(eq(tenant.id, a.tenantId));
    await addTodo(tx, {
      title: `Tell ${client?.name ?? "the client"} about the safety hold`,
      owner: "operator",
      clientId: a.tenantId,
      about: { kind: "issue", id: iss.id },
      source: "system",
      why: "A held agent's items wait: the client should hear it from us first.",
      dueAt: new Date(Date.parse(at) + 60 * 60 * 1000),
      draft: { to: "client", channel: "portal_email", text: holdNotice(serviceName(a)) },
      primaryAction: { label: "Send", kind: "send_reply", ref: { issueId: iss.id } },
      dedupeKey: `hold:${a.id}:${at}`,
      createdBy: input.userId,
    });
  }
  return hold;
}

/** Releases the hold (an operator only; the caller is the operator route). */
export async function releaseHold(
  tx: Tx,
  input: { agentId: string; userId: string; reason: string; tenantIds: readonly string[] },
): Promise<AgentHold | null> {
  const a = await clientAgent(tx, input.agentId, input.tenantIds);
  const was = readHold(a.hold);
  if (!was) return null;
  await tx
    .update(agent)
    .set({ hold: null })
    .where(and(eq(agent.id, a.id), eq(agent.tenantId, a.tenantId)));
  // What was approved while held waited for this release (runs/resume.ts); its delivery is due
  // from now, so a hold longer than the redelivery window doesn't strand it. An undo window still
  // open keeps its end.
  await tx
    .update(inboxItem)
    .set({ deliverAfter: sql`greatest(${inboxItem.deliverAfter}, now())` })
    .where(
      and(
        eq(inboxItem.tenantId, a.tenantId),
        eq(inboxItem.agentId, a.id),
        eq(inboxItem.status, "resolved"),
        isNotNull(inboxItem.runId),
        isNull(inboxItem.runReceivedAt),
      ),
    );
  if (was.issueId) {
    const [iss] = await tx
      .select({ id: issue.id })
      .from(issue)
      .where(and(eq(issue.id, was.issueId), eq(issue.tenantId, a.tenantId)));
    if (iss) {
      await tx.insert(issueEvent).values({
        tenantId: a.tenantId,
        issueId: iss.id,
        kind: "release",
        fromValue: a.id,
        reason: input.reason,
        actor: "operator",
        userId: input.userId,
        payload: { agentId: a.id, heldSince: was.at },
      });
    }
  }
  return was;
}

/** The held agents among the clients, with what waits on each since its hold. */
export async function holdViews(
  tx: Tx,
  tenantIds: readonly string[],
  only?: { agentId?: string },
): Promise<HoldView[]> {
  if (tenantIds.length === 0) return [];
  const rows = await tx
    .select({
      id: agent.id,
      name: agent.name,
      serviceName: agent.serviceName,
      tenantId: agent.tenantId,
      hold: agent.hold,
      clientName: tenant.name,
    })
    .from(agent)
    .innerJoin(tenant, eq(tenant.id, agent.tenantId))
    .where(
      and(
        inArray(agent.tenantId, [...tenantIds]),
        isNotNull(agent.hold),
        ...(only?.agentId ? [eq(agent.id, only.agentId)] : []),
      ),
    );
  const out: HoldView[] = [];
  for (const r of rows) {
    const hold = readHold(r.hold);
    if (!hold || !r.tenantId) continue;
    const since = new Date(hold.at);
    const [writes] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(externalAction)
      .innerJoin(agentVersion, eq(agentVersion.id, externalAction.agentVersionId))
      .where(
        and(
          eq(externalAction.tenantId, r.tenantId),
          eq(agentVersion.agentId, r.id),
          eq(externalAction.status, "proposed"),
          gte(externalAction.createdAt, since),
        ),
      );
    const [messages] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reachOut)
      .where(
        and(
          eq(reachOut.tenantId, r.tenantId),
          eq(reachOut.agentId, r.id),
          eq(reachOut.status, "awaiting_approval"),
          gte(reachOut.createdAt, since),
        ),
      );
    const [iss] = hold.issueId
      ? await tx
          .select({ number: issue.number })
          .from(issue)
          .where(and(eq(issue.id, hold.issueId), eq(issue.tenantId, r.tenantId)))
      : [];
    out.push({
      agent: { id: r.id, name: serviceName(r) },
      client: { id: r.tenantId, name: r.clientName },
      since: hold.at,
      by: hold.by,
      reason: hold.reason,
      issueId: hold.issueId,
      issueNumber: iss?.number ?? null,
      held: { writes: writes?.n ?? 0, messages: messages?.n ?? 0 },
    });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}
