// A client user limited to some of the client's agents (docs/plan.md §1.122). Their list is read
// from `membership.agent_ids` in the request's own transaction, so a change by the client admin
// takes effect on their next request (not after the 5-minute carried-account window). A limited
// user reaches only the portal routes core's `ASSIGNED_USER_ROUTES` lists; those that name an
// agent, a run, an item or a document answer only for the agents on the list.

import { seesAgent } from "@countersign/core";
import { inboxItem, membership, run, stepRun, type Tx } from "@countersign/db";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { notFound } from "./http";

/** The agents a person is limited to in one client; null for every agent. */
export async function assignedAgents(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<readonly string[] | null> {
  const [row] = await tx
    .select({ agentIds: membership.agentIds })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  return row?.agentIds ?? null;
}

/** A where clause keeping rows of the agents on the list (none: every agent). */
export function agentWhere(column: PgColumn, agents: readonly string[] | null): SQL | undefined {
  if (agents === null) return undefined;
  if (agents.length === 0) return sql`false`;
  return inArray(column, [...agents]);
}

/** "Not found" for an agent this person may not see, as for another client's agent. */
export function ensureSeesAgent(agents: readonly string[] | null, agentId: string | null): void {
  if (!seesAgent(agents, agentId)) throw notFound("agent");
}

/** "Not found" for a run of an agent this person may not see (a missing run is left to the route). */
export async function ensureSeesRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  agents: readonly string[] | null,
): Promise<void> {
  if (agents === null) return;
  const [row] = await tx
    .select({ agentId: run.agentId })
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
  if (row && !seesAgent(agents, row.agentId)) throw notFound("run");
}

/**
 * "Not found" for a document a limited person's agents never named (PLATFORM_QA SEC-4): a document
 * opens for them only when a run's trigger, a step's input or output, or an inbox item of one of
 * their agents names it, as the portal links it from a run or an item. 404, as for a missing or
 * another client's document, so a guessed id isn't confirmed.
 */
// DECISION (SEC-4, owner 2026-11-20, replacing §1.122's "checked by client, not by agent"): "names"
// is the document's id anywhere in that JSON (`documentId`, `documentIds`, `sources`, an item's
// subject), matched as text: the shapes vary by tool and pack, and an id is a UUID, so a match is
// that document. Every query names the client as well as relying on RLS (invariant 1).
export async function ensureSeesDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
  agents: readonly string[] | null,
): Promise<void> {
  if (agents === null) return;
  if (agents.length === 0) throw notFound("document");
  const names = (column: SQL | PgColumn) => sql`strpos(${column}::text, ${documentId}) > 0`;
  const theirs = [...agents];
  const [byItem] = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        inArray(inboxItem.agentId, theirs),
        or(eq(inboxItem.subjectId, documentId), names(inboxItem.payload)),
      ),
    )
    .limit(1);
  if (byItem) return;
  const [byRun] = await tx
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.tenantId, tenantId), inArray(run.agentId, theirs), names(run.trigger)))
    .limit(1);
  if (byRun) return;
  const [byStep] = await tx
    .select({ id: stepRun.id })
    .from(stepRun)
    .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
    .where(
      and(
        eq(stepRun.tenantId, tenantId),
        inArray(run.agentId, theirs),
        or(names(stepRun.input), names(stepRun.output)),
      ),
    )
    .limit(1);
  if (byStep) return;
  throw notFound("document");
}
