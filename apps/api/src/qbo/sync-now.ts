// v0.12 W1-H: "Sync now" is never lost (ARCHITECTURE §6.2, docs/plan.md §1.43). One sync of a
// connection runs at a time. Asking for one when none runs claims the connection and starts an
// instance; asking while one runs sets `sync_cursor.pending`, and the running instance starts one
// more when it ends (its last step). The claim lives beside the QuickBooks cursor in
// `connection.sync_cursor`:
//   running  { instanceId, at }   the sync that holds the connection; `at` moves with each page
//   pending  { reason, at }       one more sync, asked for while it ran
// Every write is under the connection row's lock (`for update`), so two asks never both start.

import { connection, type Db, type Tx, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { QboSyncInstances, QboSyncParams } from "./instances";
import { qboSyncInstanceId } from "./instances";
import { runQboSync, type SyncStepRunner } from "./sync";

/** A sync that hasn't stored a page for this long is taken as dead; the next ask starts afresh. */
// DECISION: 30 minutes: a page step may take its 5-minute timeout three times over with backoff
// (QboSyncWorkflow's PAGE_STEP) before the instance gives up, and a sync that ends any other way
// hands the connection on in its last step.
export const SYNC_LEASE_MS = 30 * 60_000;

interface Running {
  instanceId: string;
  at: string;
  reason?: QboSyncParams["reason"];
  /** The instance that handed over to this one (its last step, so a retry starts the same). */
  from?: string;
}
interface Pending {
  reason: QboSyncParams["reason"];
  at: string;
}

function readState(cursor: unknown): { running: Running | null; pending: Pending | null } {
  const c = (cursor ?? {}) as { running?: unknown; pending?: unknown };
  const r = c.running as Partial<Running> | undefined;
  const p = c.pending as Partial<Pending> | undefined;
  return {
    running:
      r && typeof r.instanceId === "string" && typeof r.at === "string"
        ? {
            instanceId: r.instanceId,
            at: r.at,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.from ? { from: r.from } : {}),
          }
        : null,
    pending:
      p && typeof p.reason === "string" && typeof p.at === "string"
        ? { reason: p.reason as Pending["reason"], at: p.at }
        : null,
  };
}

const live = (r: Running | null, at: Date): r is Running =>
  r !== null && at.getTime() - Date.parse(r.at) < SYNC_LEASE_MS;

async function lockState(tx: Tx, params: Pick<QboSyncParams, "tenantId" | "connectionId">) {
  const [row] = await tx
    .select({ cursor: connection.syncCursor })
    .from(connection)
    .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, params.tenantId)))
    .for("update");
  return row ? { cursor: (row.cursor ?? {}) as Record<string, unknown> } : null;
}

async function writeState(
  tx: Tx,
  params: Pick<QboSyncParams, "tenantId" | "connectionId">,
  cursor: Record<string, unknown>,
  state: { running: Running | null; pending: Pending | null },
) {
  const { running: _r, pending: _p, ...rest } = cursor;
  await tx
    .update(connection)
    .set({
      syncCursor: {
        ...rest,
        ...(state.running ? { running: state.running } : {}),
        ...(state.pending ? { pending: state.pending } : {}),
      },
    })
    .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, params.tenantId)));
}

export type SyncClaim =
  | { kind: "start"; instanceId: string }
  | { kind: "queued"; instanceId: string }
  | { kind: "missing" };

/**
 * In the caller's transaction: claims the connection for a new sync (`start`, with its instance
 * id), or, while one runs, asks it for one more (`queued`). Start the instance after the commit
 * with `startClaimed`.
 */
export async function claimQboSync(
  tx: Tx,
  params: QboSyncParams,
  at: Date = new Date(),
): Promise<SyncClaim> {
  const row = await lockState(tx, params);
  if (!row) return { kind: "missing" };
  const state = readState(row.cursor);
  if (live(state.running, at)) {
    // DECISION: one pending sync is enough however many ask: it reads everything changed since
    // the running one's cursor. The first reason asked is kept, for the logs.
    const pending = state.pending ?? { reason: params.reason, at: at.toISOString() };
    await writeState(tx, params, row.cursor, { running: state.running, pending });
    return { kind: "queued", instanceId: state.running.instanceId };
  }
  const instanceId = qboSyncInstanceId(params.connectionId, params.reason, at);
  await writeState(tx, params, row.cursor, {
    running: { instanceId, at: at.toISOString(), reason: params.reason },
    pending: null,
  });
  return { kind: "start", instanceId };
}

/**
 * Lets the connection go when `instanceId` still holds it (an instance that did not start). With
 * `requeue`, the sync it was for stays asked for (`pending`), so a retry or the next ask runs it.
 */
async function release(
  db: Db,
  params: QboSyncParams,
  instanceId: string,
  requeue?: Pending,
): Promise<void> {
  await withTenant(db, params.tenantId, async (tx) => {
    const row = await lockState(tx, params);
    if (!row) return;
    const state = readState(row.cursor);
    if (state.running?.instanceId !== instanceId) return;
    await writeState(tx, params, row.cursor, {
      running: null,
      pending: state.pending ?? requeue ?? null,
    });
  });
}

/** Starts the instance a claim named, after its transaction committed; a failed start lets go. */
export async function startClaimed(
  db: Db,
  instances: QboSyncInstances,
  params: QboSyncParams,
  instanceId: string,
  requeue?: Pending,
): Promise<"started" | "exists"> {
  try {
    return await instances.start(instanceId, params);
  } catch (error) {
    await release(db, params, instanceId, requeue);
    throw error;
  }
}

export interface SyncAsked {
  started: boolean;
  /** A sync was running: one more runs when it ends. */
  queued: boolean;
  /** The instance started, or the running one the ask waits for; null where sync isn't bound. */
  instanceId: string | null;
}

/** Asks for a sync outside a request's transaction (the cron, webhooks, a new connection). */
export async function requestQboSync(
  db: Db,
  instances: QboSyncInstances | null,
  params: QboSyncParams,
  at: Date = new Date(),
): Promise<SyncAsked> {
  if (!instances) return { started: false, queued: false, instanceId: null };
  const claim = await withTenant(db, params.tenantId, (tx) => claimQboSync(tx, params, at));
  if (claim.kind === "missing") return { started: false, queued: false, instanceId: null };
  if (claim.kind === "queued") {
    return { started: false, queued: true, instanceId: claim.instanceId };
  }
  const r = await startClaimed(db, instances, params, claim.instanceId);
  // A cron or webhook slot the engine has seen already started nothing new: let the claim go.
  if (r === "exists") await release(db, params, claim.instanceId);
  return { started: r === "started", queued: false, instanceId: claim.instanceId };
}

/**
 * A sync's first step: takes the connection. False when another live sync holds it (two asks
 * raced past the claim, or an instance from before this change): this one queues itself and
 * reads nothing.
 */
export async function beginQboSync(
  db: Db,
  params: QboSyncParams,
  instanceId: string,
  at: Date = new Date(),
): Promise<boolean> {
  return withTenant(db, params.tenantId, async (tx) => {
    const row = await lockState(tx, params);
    if (!row) return true;
    const state = readState(row.cursor);
    if (state.running?.instanceId === instanceId) return true;
    if (live(state.running, at)) {
      const pending = state.pending ?? { reason: params.reason, at: at.toISOString() };
      await writeState(tx, params, row.cursor, { running: state.running, pending });
      return false;
    }
    await writeState(tx, params, row.cursor, {
      running: { instanceId, at: at.toISOString(), reason: params.reason },
      pending: state.pending,
    });
    return true;
  });
}

/**
 * A sync's last step: lets the connection go, or, when a sync was asked for while it ran, hands
 * it to the next instance (claimed here, under the lock) and returns that instance to start. A
 * retried last step returns the same next instance (`from`), and starting it again is harmless.
 */
export async function endQboSync(
  db: Db,
  params: QboSyncParams,
  instanceId: string,
  at: Date = new Date(),
  /** False where no follow-on can start: the connection is let go, the ask stays pending. */
  handOver = true,
): Promise<{ instanceId: string; params: QboSyncParams } | null> {
  return withTenant(db, params.tenantId, async (tx) => {
    const row = await lockState(tx, params);
    if (!row) return null;
    const state = readState(row.cursor);
    const next = (id: string, reason: QboSyncParams["reason"]) => ({
      instanceId: id,
      params: { tenantId: params.tenantId, connectionId: params.connectionId, reason },
    });
    if (state.running?.from === instanceId) {
      // This step ran before and handed over; start the same instance again.
      return next(state.running.instanceId, state.running.reason ?? "operator");
    }
    if (state.running && state.running.instanceId !== instanceId) return null;
    if (!state.pending || !handOver) {
      await writeState(tx, params, row.cursor, { running: null, pending: state.pending });
      return null;
    }
    const reason = state.pending.reason;
    // The follow-on always gets a fresh id: a cron or webhook slot may be the one ending.
    const id = qboSyncInstanceId(params.connectionId, "operator", at);
    await writeState(tx, params, row.cursor, {
      running: { instanceId: id, at: at.toISOString(), reason, from: instanceId },
      pending: null,
    });
    return next(id, reason);
  });
}

/**
 * QboSyncWorkflow's whole run: takes the connection, syncs, then lets it go or starts the sync
 * asked for meanwhile, each a durable step. A sync that fails still hands on in its last step.
 */
export async function runQboSyncInstance(
  deps: Parameters<typeof runQboSync>[0] & { instances: QboSyncInstances | null },
  params: QboSyncParams,
  instanceId: string,
  runner: SyncStepRunner,
  dispatch?: (eventIds: string[]) => Promise<unknown>,
): Promise<Awaited<ReturnType<typeof runQboSync>> & { next?: string | null }> {
  const now = deps.now ?? (() => new Date());
  const mine = await runner.do("sync:begin", () =>
    beginQboSync(deps.db, params, instanceId, now()),
  );
  if (!mine) {
    return { pages: 0, stored: 0, documents: 0, skipped: "another sync is running" };
  }
  const end = () =>
    runner.do("sync:end", async () => {
      const at = now();
      const next = await endQboSync(deps.db, params, instanceId, at, deps.instances !== null);
      if (!next || !deps.instances) return null;
      // A start that fails puts the ask back, and the step's retry starts it.
      await startClaimed(deps.db, deps.instances, next.params, next.instanceId, {
        reason: next.params.reason,
        at: at.toISOString(),
      });
      return next.instanceId;
    });
  let result: Awaited<ReturnType<typeof runQboSync>>;
  try {
    result = await runQboSync(deps, params, runner, dispatch);
  } catch (error) {
    await end();
    throw error;
  }
  return { ...result, next: await end() };
}
