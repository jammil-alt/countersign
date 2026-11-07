// v0.12 W1-E: the actions a retry may carry (ARCHITECTURE §10.10; docs/plan.md §1.40). A retry's
// write step looks at what the same step proposed in the runs before it (the run retried and,
// for a retry of a retry, the runs that one retried), each under its original idempotency key
// `<run id>:<node id>:<index>`. Read and reopened in the client's own transaction.

import { type Db, externalAction, run, type Tx, withTenant } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CarriedActionsPort, CarryCandidate } from "../runtime/ports";

/** The run and the runs it retried, newest first (a retry of a retry walks back to the first). */
async function retryChain(tx: Tx, tenantId: string, runId: string): Promise<string[]> {
  const chain: string[] = [];
  let next: string | null = runId;
  // Bounded: a chain is as long as the times the operator retried.
  while (next && chain.length < 100 && !chain.includes(next)) {
    chain.push(next);
    const [row] = await tx
      .select({ retryOf: run.retryOf })
      .from(run)
      .where(and(eq(run.id, next), eq(run.tenantId, tenantId)));
    next = row?.retryOf ?? null;
  }
  return chain;
}

export function dbCarriedActions(db: Db): CarriedActionsPort {
  return {
    candidates(tenantId, { retryOf, nodeId }) {
      return withTenant(db, tenantId, async (tx) => {
        const runs = await retryChain(tx, tenantId, retryOf);
        if (runs.length === 0) return [];
        const rows = await tx
          .select()
          .from(externalAction)
          .where(
            and(
              eq(externalAction.tenantId, tenantId),
              inArray(externalAction.runId, runs),
              sql`starts_with(${externalAction.idempotencyKey}, ${externalAction.runId}::text || ':' || ${nodeId} || ':')`,
            ),
          )
          .orderBy(externalAction.createdAt);
        // Only this node's own writes: `<run>:<node>:<index>`, not a deeper node's.
        return rows
          .filter((r) => /^\d+$/.test(r.idempotencyKey.slice(`${r.runId}:${nodeId}:`.length)))
          .map(
            (r): CarryCandidate => ({
              id: r.id,
              tool: r.tool,
              connectionId: r.connectionId,
              input: r.input,
              idempotencyKey: r.idempotencyKey,
              status: r.status,
              approvedAt: r.approvedAt,
              approvedBy: r.approvedBy,
              result: r.result,
              error: r.error,
            }),
          );
      });
    },

    reopen(tenantId, actionId) {
      return withTenant(db, tenantId, async (tx) => {
        // A failed write goes back to approved so it is claimed and executed once more under its
        // original key; one left `executing` by a crash is executed again as it is.
        const [row] = await tx
          .update(externalAction)
          .set({ status: "approved" })
          .where(
            and(
              eq(externalAction.id, actionId),
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.status, "failed"),
            ),
          )
          .returning({ id: externalAction.id });
        if (row) return true;
        const [current] = await tx
          .select({ status: externalAction.status })
          .from(externalAction)
          .where(and(eq(externalAction.id, actionId), eq(externalAction.tenantId, tenantId)));
        return current?.status === "approved" || current?.status === "executing";
      });
    },
  };
}
