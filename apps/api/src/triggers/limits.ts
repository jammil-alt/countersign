// A webhook trigger's guards (ARCHITECTURE §10.8; docs/plan.md §1.48 "Dedupe and limits"): the rate
// limit is counted from the runs the trigger started in its window (no counter table); a delivery
// over it starts no run and is counted on the hook (`connection.sync_cursor.hooks[hookId].limited`),
// where the client's connection page and the triggers list can read it. Dedupe is the run id.

import { connection, run, type Tx } from "@countersign/db";
import type { RunLimit, RunRequest } from "@countersign/workflows";
import { and, count, eq, gt, sql } from "drizzle-orm";

/** Whether the trigger already started `max` live runs in its window. */
// DECISION: counted from `run.trigger->>'triggerId'`; two dispatches at the same instant may each
// let one more through (the hook's own 60 a minute still holds).
export async function overLimit(tx: Tx, request: RunRequest, now = new Date()): Promise<boolean> {
  const limit = request.limit;
  if (!limit) return false;
  const since = new Date(now.getTime() - limit.windowSeconds * 1000);
  const [row] = await tx
    .select({ n: count() })
    .from(run)
    .where(
      and(
        eq(run.tenantId, request.tenantId),
        eq(run.agentId, request.agentId),
        eq(run.workflowSlug, request.workflowSlug),
        eq(run.mode, "live"),
        sql`${run.trigger}->>'triggerId' = ${limit.triggerId}`,
        gt(run.createdAt, since),
      ),
    );
  return (row?.n ?? 0) >= limit.max;
}

export interface HookCounts {
  limited: number;
  lastLimitedAt: string | null;
}

/** The hook counts kept on the connection's sync cursor. */
export function hookCountsOf(syncCursor: unknown, hookId: string): HookCounts {
  const hooks = (syncCursor as { hooks?: Record<string, unknown> } | null)?.hooks;
  const h = hooks && Object.hasOwn(hooks, hookId) ? (hooks[hookId] as Partial<HookCounts>) : null;
  return {
    limited: typeof h?.limited === "number" ? h.limited : 0,
    lastLimitedAt: typeof h?.lastLimitedAt === "string" ? h.lastLimitedAt : null,
  };
}

/** Counts one limited delivery on its hook, under the connection's row lock. */
export async function countLimited(
  tx: Tx,
  tenantId: string,
  limit: RunLimit,
  now = new Date(),
): Promise<void> {
  if (!limit.connectionId) return;
  const where = and(eq(connection.id, limit.connectionId), eq(connection.tenantId, tenantId));
  const [fresh] = await tx
    .select({ syncCursor: connection.syncCursor })
    .from(connection)
    .where(where)
    .for("update");
  if (!fresh) return;
  const cursor = (fresh.syncCursor ?? {}) as Record<string, unknown>;
  const hooks = { ...((cursor.hooks as Record<string, unknown> | undefined) ?? {}) };
  const before = hookCountsOf(cursor, limit.hookId);
  hooks[limit.hookId] = { limited: before.limited + 1, lastLimitedAt: now.toISOString() };
  await tx
    .update(connection)
    .set({ syncCursor: { ...cursor, hooks } })
    .where(where);
}
