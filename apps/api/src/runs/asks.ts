// PLATFORM_QA STATE-8: an ask a run's step makes (`inbox.create`, a budget's review) is made once.
// Cloudflare Workflows runs a skill step again when its first try's result was lost (a timeout, an
// evicted Worker); the step's model then asks again. External writes are found again by their
// idempotency keys; this finds the step's ask again by what it asks.

import type { PlatformStore } from "@countersign/agents";
import { type Db, inboxItem, withTenant } from "@countersign/db";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * The platform store with `createInboxItem` made once per ask: an item a run's step (its
 * `payload.stepId`, the durable node) creates is the open item of that run and step with the same
 * kind, title, details and assignee, when there is one.
 */
// DECISION (PLATFORM_QA STATE-8): asks are keyed by what they ask, not by call position, so a try
// whose model words its calls in another order still finds its own; the key is the run and the
// step's durable node, so each loop pass and each oversight retry with a corrected input
// (`${node}:o${seq}`) asks for itself. Only an open item is found again: one a person already
// answered or that expired is not the run's to reuse. No migration: a retry runs after its first
// try, never beside it, so a read before the insert holds.
export function oneAskPerStep(inner: PlatformStore, db: Db): PlatformStore {
  return {
    ...inner,
    async createInboxItem(tenantId, item) {
      const stepId = item.payload.stepId;
      if (!item.runId || typeof stepId !== "string") return inner.createInboxItem(tenantId, item);
      const details = typeof item.payload.details === "string" ? item.payload.details : null;
      const [existing] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: inboxItem.id })
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, tenantId),
              eq(inboxItem.runId, item.runId as string),
              eq(inboxItem.status, "open"),
              eq(inboxItem.kind, item.kind),
              eq(inboxItem.title, item.title),
              item.assigneeRole
                ? eq(inboxItem.assigneeRole, item.assigneeRole)
                : isNull(inboxItem.assigneeRole),
              item.assigneeUserId
                ? eq(inboxItem.assigneeUserId, item.assigneeUserId)
                : isNull(inboxItem.assigneeUserId),
              sql`${inboxItem.payload}->>'stepId' = ${stepId}`,
              sql`${inboxItem.payload}->>'details' is not distinct from ${details}`,
            ),
          )
          .limit(1),
      );
      if (existing) return { id: existing.id };
      return inner.createInboxItem(tenantId, item);
    },
  };
}
