// Lockdown (docs/plan.md §1.243, docs/lockdown-plan.md, stream K1): locking and unlocking one
// client or every client, and reading the locks. The enforcement is `app_scope_tenant_ids`
// (migration 0101), which every scope goes through (./client.ts); these only set and clear what it
// reads. Each runs in the caller's transaction, so a route can lock, stop the client's runs and
// write its audit row in one commit. Who may lock or unlock is decided by the caller (stream K2).

import { isUuid } from "@countersign/core";
import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { admitTenant, type Tx } from "./client";
import { platformLock, type TenantLock, tenant, tenantChange } from "./schema";

export const LOCK_SIDES = ["operator", "client"] as const;
export type LockSide = (typeof LOCK_SIDES)[number];
/** A lock's reason or an unlock's note, as `platform_lock`'s check allows. */
export const MAX_LOCK_REASON = 500;

export type LockErrorCode =
  | "invalid_input"
  | "no_such_client"
  | "not_in_scope"
  | "everything_locked";

/** A lock or unlock refused before anything changed. */
export class LockError extends Error {
  override name = "LockError";
  constructor(
    readonly code: LockErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientLockState {
  tenantId: string;
  lockedAt: Date;
  lock: TenantLock;
}

export interface PlatformLockState {
  lockedBy: string;
  lockedAt: Date;
  reason: string;
}

function checkUuid(value: string, what: string): void {
  if (!isUuid(value)) throw new LockError("invalid_input", `not ${what}: ${value}`);
}

function textOf(value: string, what: string): string {
  const text = value.trim();
  if (text.length < 1 || text.length > MAX_LOCK_REASON) {
    throw new LockError("invalid_input", `${what} must be 1 to ${MAX_LOCK_REASON} characters`);
  }
  return text;
}

/** The transaction's clients, and those it asked for that the lockdown left out. */
async function scopeOf(tx: Tx): Promise<{ inScope: string[]; leftOut: string[] }> {
  const rows = await tx.execute<{ ids: string | null; locked: string | null }>(sql`select
    current_setting('app.tenant_ids', true) as ids,
    current_setting('app.locked_tenant_ids', true) as locked`);
  const list = (value: string | null | undefined) =>
    (value ?? "")
      .replace(/^\{|\}$/g, "")
      .split(",")
      .filter(Boolean);
  const row = [...rows][0];
  return { inScope: list(row?.ids), leftOut: list(row?.locked) };
}

async function clientRow(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ id: tenant.id, lockedAt: tenant.lockedAt, lock: tenant.lock })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("update");
  if (!row) throw new LockError("no_such_client", `no client ${tenantId}`);
  return row;
}

/**
 * Locks one client. The client must be in the transaction's scope (it is the one being acted for),
 * which it is only while unlocked; locking one already locked changes nothing and answers its lock.
 * The scope this transaction already has stays as it is, so the caller can go on to stop the
 * client's runs in it; every later transaction is refused.
 */
export async function lockClient(
  tx: Tx,
  input: { tenantId: string; side: LockSide; by: string; reason: string; now?: Date },
): Promise<{ changed: boolean; lock: TenantLock }> {
  checkUuid(input.tenantId, "a client id");
  checkUuid(input.by, "a user id");
  if (!(LOCK_SIDES as readonly string[]).includes(input.side)) {
    throw new LockError("invalid_input", `not a side: ${input.side}`);
  }
  const reason = textOf(input.reason, "The reason");
  const row = await clientRow(tx, input.tenantId);
  if (row.lockedAt && row.lock) return { changed: false, lock: row.lock };
  if (!(await scopeOf(tx)).inScope.includes(input.tenantId)) {
    throw new LockError("not_in_scope", `client ${input.tenantId} is outside this transaction`);
  }
  const now = input.now ?? new Date();
  const lock: TenantLock = { side: input.side, by: input.by, at: now.toISOString(), reason };
  await tx.insert(tenantChange).values({
    tenantId: input.tenantId,
    actorId: input.by,
    change: { lock: { from: null, to: input.side } },
    reason,
  });
  await tx.update(tenant).set({ lockedAt: now, lock }).where(eq(tenant.id, input.tenantId));
  return { changed: true, lock };
}

/**
 * Unlocks one client and admits it to this transaction's scope, so its history row is written in
 * the same commit. The client must be one this transaction asked for (left out because locked, or
 * locked in it). Refused while everything is locked: unlock everything first. Unlocking resumes
 * nothing by itself (docs/lockdown-plan.md §4).
 */
export async function unlockClient(
  tx: Tx,
  input: { tenantId: string; by: string; note: string },
): Promise<{ changed: boolean; was: TenantLock | null }> {
  checkUuid(input.tenantId, "a client id");
  checkUuid(input.by, "a user id");
  const note = textOf(input.note, "The note");
  if (await everythingLock(tx)) {
    throw new LockError("everything_locked", "everything is locked: unlock everything first");
  }
  const row = await clientRow(tx, input.tenantId);
  if (!row.lockedAt || !row.lock) return { changed: false, was: null };
  const scope = await scopeOf(tx);
  if (!scope.inScope.includes(input.tenantId) && !scope.leftOut.includes(input.tenantId)) {
    throw new LockError("not_in_scope", `client ${input.tenantId} is outside this transaction`);
  }
  await tx.update(tenant).set({ lockedAt: null, lock: null }).where(eq(tenant.id, input.tenantId));
  if (!(await admitTenant(tx, input.tenantId))) {
    throw new LockError("not_in_scope", `client ${input.tenantId} could not be admitted`);
  }
  await tx.insert(tenantChange).values({
    tenantId: input.tenantId,
    actorId: input.by,
    change: { lock: { from: row.lock.side, to: null } },
    reason: note,
  });
  return { changed: true, was: row.lock };
}

/**
 * Locks every client. Locking while already locked changes nothing and answers the standing lock.
 * The caller writes the audit row; there is no history row per client.
 */
export async function lockEverything(
  tx: Tx,
  input: { by: string; reason: string; now?: Date },
): Promise<{ changed: boolean; lock: PlatformLockState }> {
  checkUuid(input.by, "a user id");
  const reason = textOf(input.reason, "The reason");
  const [made] = await tx
    .insert(platformLock)
    .values({ lockedBy: input.by, reason, lockedAt: input.now ?? new Date() })
    .onConflictDoNothing()
    .returning();
  if (made) return { changed: true, lock: made };
  const standing = await everythingLock(tx);
  if (!standing) throw new Error("platform_lock: no row after a conflict");
  return { changed: false, lock: standing };
}

/** Unlocks everything; each client locked on its own stays locked. */
export async function unlockEverything(tx: Tx): Promise<{ changed: boolean }> {
  const removed = await tx.delete(platformLock).returning({ id: platformLock.id });
  return { changed: removed.length > 0 };
}

async function everythingLock(tx: Tx): Promise<PlatformLockState | null> {
  const [row] = await tx
    .select({
      lockedBy: platformLock.lockedBy,
      lockedAt: platformLock.lockedAt,
      reason: platformLock.reason,
    })
    .from(platformLock);
  return row ?? null;
}

/**
 * The locks standing now: everything's, and those of the given clients (or every locked client
 * when none are given). Reads `tenant` and `platform_lock`, which have no row-level security, so it
 * works in any transaction, including one the lockdown left a client out of.
 */
export async function lockState(
  tx: Tx,
  tenantIds?: readonly string[],
): Promise<{ everything: PlatformLockState | null; clients: ClientLockState[] }> {
  for (const id of tenantIds ?? []) checkUuid(id, "a client id");
  const where =
    tenantIds === undefined
      ? isNotNull(tenant.lockedAt)
      : and(isNotNull(tenant.lockedAt), inArray(tenant.id, [...tenantIds, NO_CLIENT]));
  const rows = await tx
    .select({ tenantId: tenant.id, lockedAt: tenant.lockedAt, lock: tenant.lock })
    .from(tenant)
    .where(where)
    .orderBy(tenant.lockedAt);
  const clients = rows.flatMap((r) =>
    r.lockedAt && r.lock ? [{ tenantId: r.tenantId, lockedAt: r.lockedAt, lock: r.lock }] : [],
  );
  return { everything: await everythingLock(tx), clients };
}

/** Never a client: keeps `in (…)` valid when no ids are given. */
const NO_CLIENT = "00000000-0000-0000-0000-000000000000";

const INBOUND_KIND = /^[a-z][a-z_]{0,31}$/;

/**
 * Something came in for a locked client and was answered and dropped: adds one to the lock's count
 * for its kind (`webhook`, `email`, `whatsapp`, …). Counts only, never what came. Answers whether it
 * was counted (false when the client isn't locked on its own).
 */
export async function countLockedInbound(tx: Tx, tenantId: string, kind: string): Promise<boolean> {
  checkUuid(tenantId, "a client id");
  if (!INBOUND_KIND.test(kind))
    throw new LockError("invalid_input", `not an inbound kind: ${kind}`);
  const rows = await tx.execute<{ id: string }>(sql`update ${tenant}
    set lock = lock || jsonb_build_object('inbound',
      coalesce(lock->'inbound', '{}'::jsonb)
        || jsonb_build_object(${kind}::text, coalesce((lock->'inbound'->>${kind}::text)::int, 0) + 1))
    where id = ${tenantId} and locked_at is not null
    returning id`);
  return [...rows].length > 0;
}

/**
 * A `tenant` condition for background work: the client isn't locked, and everything isn't. A sweep
 * that lists clients and opens each one's scope leaves locked ones out here, rather than having
 * every one of their transactions refused (docs/lockdown-plan.md §3).
 */
export function notLocked(): SQL {
  return sql`(${tenant.lockedAt} is null and not exists (select 1 from ${platformLock}))`;
}

/** A `tenant` condition for sweeps: neither retired nor locked (`notLocked`). */
export function activeClient(): SQL {
  return sql`(${tenant.retiredAt} is null and ${notLocked()})`;
}
