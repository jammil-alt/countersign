// The senses outbox (docs/plan.md §1.2 "Senses outbox"). `emit` inserts the event in the caller's
// transaction, so the event exists exactly when the change it reports commits. After commit
// apps/api hands it to the trigger router and stamps `dispatched_at`; the every-minute cron sweeps
// up whatever is still undispatched. A dispatcher claims its events first (claimUndispatched: a row
// lock, skipped by any other dispatcher) and stamps them in the same transaction, so an event is
// dispatched once even when the after-commit dispatch and the sweep reach it together. Starting a
// run twice would be harmless anyway: triggered run ids are derived from the event id (eventRunId).
//
// Every function takes the caller's transaction (withTenant / withTenants): RLS decides which
// clients' events it may write and see, so the cron sweep names the clients it sweeps.

import { isUuid, once, type PlatformEventType } from "@countersign/core";
import { event, type Tx } from "@countersign/db";
import { and, asc, gte, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
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

/**
 * The ids of the events a transaction emitted (ARCHITECTURE §8): its caller dispatches them once
 * the transaction commits. Bind one to a transaction with `collectEmitted(tx)`, or pass it to
 * `emit` (`collect`) where the transaction is opened out of the caller's reach.
 */
export class EmittedEvents {
  readonly ids: string[] = [];
  add(id: string): void {
    if (!this.ids.includes(id)) this.ids.push(id);
  }
  /** The ids collected so far, emptied (each dispatch takes its own). */
  take(): string[] {
    return this.ids.splice(0);
  }
}

const perTransaction = new WeakMap<object, EmittedEvents>();

/** Every `emit` in `tx` from now on records its event id in the returned collector. */
export function collectEmitted(tx: Tx, into: EmittedEvents = new EmittedEvents()): EmittedEvents {
  perTransaction.set(tx, into);
  return into;
}

export interface EmitOptions {
  /** Default: the platform's types only. Pass apps/api's registry to emit pack types. */
  registry?: EventTypeRegistry;
  /** Also records the event's id here (besides any collector bound to `tx`). */
  collect?: EmittedEvents;
  /**
   * A test run (ARCHITECTURE §10.4) emits nothing, so it can never start another workflow. The
   * caller passes the run's mode through; `emit` returns null.
   */
  testRun?: boolean;
}

// Worker startup (2026-11-11): built on the first emit, not when the module loads.
const defaultRegistry = once(platformRegistry);

/** Validates the payload and inserts the event in `tx`. Returns the row, or null for a test run. */
export async function emit(
  tx: Tx,
  input: EmitInput,
  options: EmitOptions = {},
): Promise<EventRow | null> {
  const registry = options.registry ?? defaultRegistry();
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
  options.collect?.add(row.id);
  const bound = perTransaction.get(tx);
  if (bound && bound !== options.collect) bound.add(row.id);
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

export interface ClaimOptions {
  /** Only these events (the after-commit dispatch: the ones its transaction emitted). */
  ids?: readonly string[];
  /** Only events at least this old (the cron's sweep: 30 s, after the after-commit dispatch). */
  olderThanSeconds?: number;
  /** Only events at most this old (the after-commit dispatch of a client's fresh events). */
  newerThanSeconds?: number;
  /** Default 500. */
  limit?: number;
}

const seconds = (n: number, name: string) => {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be >= 0`);
  return sql`now() - make_interval(secs => ${n}::double precision)`;
};

/**
 * Claims undispatched events for this transaction, oldest first: their rows are locked until it
 * ends, and events another dispatcher holds are skipped (`for update skip locked`). The caller
 * routes them and stamps them (markDispatched) before committing, so whoever comes next finds them
 * stamped, or locked and skips them: an event is dispatched once.
 */
export async function claimUndispatched(tx: Tx, options: ClaimOptions = {}): Promise<EventRow[]> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const conds: (SQL | undefined)[] = [isNull(event.dispatchedAt)];
  if (options.ids !== undefined) {
    if (options.ids.length === 0) return [];
    for (const id of options.ids) if (!isUuid(id)) throw new Error(`not an event id: ${id}`);
    conds.push(inArray(event.id, [...new Set(options.ids)]));
  }
  if (options.olderThanSeconds !== undefined) {
    conds.push(lt(event.createdAt, seconds(options.olderThanSeconds, "olderThanSeconds")));
  }
  if (options.newerThanSeconds !== undefined) {
    conds.push(gte(event.createdAt, seconds(options.newerThanSeconds, "newerThanSeconds")));
  }
  return tx
    .select()
    .from(event)
    .where(and(...conds))
    .orderBy(asc(event.createdAt), asc(event.id))
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Takes the stamp off events whose dispatch did not finish (a run's instance could not start), so
 * the sweep dispatches them again; starting their runs again is safe (deterministic run ids).
 */
export async function releaseDispatched(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  for (const id of ids) if (!isUuid(id)) throw new Error(`not an event id: ${id}`);
  const rows = await tx
    .update(event)
    .set({ dispatchedAt: null })
    .where(inArray(event.id, [...new Set(ids)]))
    .returning({ id: event.id });
  return rows.map((r) => r.id);
}
