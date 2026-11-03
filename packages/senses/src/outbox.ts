// The senses outbox (docs/plan.md §1.2 "Senses outbox"). `emit` inserts the event in the caller's
// transaction, so the event exists exactly when the change it reports commits. After commit
// apps/api hands it to the trigger router and stamps `dispatched_at`; the every-minute cron sweeps
// up whatever is still undispatched. Dispatching twice is harmless: triggered run ids are derived
// from the event id (core's eventRunId).
//
// Every function takes the caller's transaction (withTenant / withTenants): RLS decides which
// clients' events it may write and see, so the cron sweep names the clients it sweeps.

import { isUuid, type PlatformEventType } from "@countersign/core";
import { event, type Tx } from "@countersign/db";
import { and, inArray, isNull, sql } from "drizzle-orm";
import type { PlatformEventPayloads } from "./platform";
import { type EventTypeRegistry, platformRegistry } from "./registry";

export type EventRow = typeof event.$inferSelect;

interface EmitBase {
  tenantId: string;
  subjectType?: string | null;
  subjectId?: string | null;
}

/** Platform types are typed by their payload; pack types are checked against the registry. */
export type EmitInput =
  | {
      [K in PlatformEventType]: EmitBase & { type: K; payload: PlatformEventPayloads[K] };
    }[PlatformEventType]
  | (EmitBase & { type: string; payload: Record<string, unknown> });

export interface EmitOptions {
  /** Default: the platform's types only. Pass apps/api's registry to emit pack types. */
  registry?: EventTypeRegistry;
  /**
   * A test run (ARCHITECTURE §10.4) emits nothing, so it can never start another workflow. The
   * caller passes the run's mode through; `emit` returns null.
   */
  testRun?: boolean;
}

const defaultRegistry = platformRegistry();

/** Validates the payload and inserts the event in `tx`. Returns the row, or null for a test run. */
export async function emit(
  tx: Tx,
  input: EmitInput,
  options: EmitOptions = {},
): Promise<EventRow | null> {
  const registry = options.registry ?? defaultRegistry;
  const payload = registry.parsePayload(input.type, input.payload);
  if (!isUuid(input.tenantId)) throw new Error(`not a client id: ${input.tenantId}`);
  if (input.subjectId != null && !isUuid(input.subjectId)) {
    throw new Error(`not a subject id: ${input.subjectId}`);
  }
  if (options.testRun) return null;
  const subjectType = input.subjectType ?? registry.get(input.type)?.subjectType ?? null;
  const [row] = await tx
    .insert(event)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      subjectType,
      subjectId: input.subjectId ?? null,
      payload,
    })
    .returning();
  if (!row) throw new Error("event insert returned nothing");
  return row;
}

export interface UndispatchedOptions {
  /** Only events older than this (the after-commit dispatch gets the first chance). Default 30. */
  olderThanSeconds?: number;
  /** Default 500. */
  limit?: number;
}

/** Events still waiting for dispatch, oldest first, among the clients `tx` is scoped to. */
export function undispatched(tx: Tx, options: UndispatchedOptions = {}): Promise<EventRow[]> {
  const seconds = options.olderThanSeconds ?? 30;
  const limit = options.limit ?? 500;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("olderThanSeconds must be >= 0");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return tx.query.event.findMany({
    where: (e, { and, isNull, lt, sql }) =>
      and(
        isNull(e.dispatchedAt),
        lt(e.createdAt, sql`now() - make_interval(secs => ${seconds}::double precision)`),
      ),
    orderBy: (e, { asc }) => [asc(e.createdAt), asc(e.id)],
    limit,
  });
}

/**
 * Stamps `dispatched_at` on the given events that are not stamped yet; returns the ids it stamped.
 * Ids outside the transaction's clients are invisible to it and so left alone.
 */
export async function markDispatched(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  for (const id of ids) if (!isUuid(id)) throw new Error(`not an event id: ${id}`);
  const rows = await tx
    .update(event)
    .set({ dispatchedAt: sql`now()` })
    .where(and(inArray(event.id, [...new Set(ids)]), isNull(event.dispatchedAt)))
    .returning({ id: event.id });
  return rows.map((r) => r.id);
}
