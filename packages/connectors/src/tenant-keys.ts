// Client data keys over the database (`tenant_key`, docs/plan.md §1.26): the store the vault
// cipher reads keys from and creates the client's first key in, the hourly upkeep (re-encrypt v1
// envelopes as v2, re-wrap keys after a master key rotation), and destroying a retired client's
// key. Every function runs inside the caller's withTenant() for that one client (invariant 1).

import { connection, type Db, type Tx, tenantKey, withTenant } from "@countersign/db";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  type CredentialCipher,
  CredentialError,
  type TenantKeyRecord,
  type TenantKeyStore,
  type VaultCipher,
  WrappedKey,
} from "./credentials";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recordOf(row: typeof tenantKey.$inferSelect): TenantKeyRecord {
  const wrapped = row.wrappedKey === null ? null : WrappedKey.safeParse(row.wrappedKey);
  if (wrapped && !wrapped.success) throw new CredentialError("malformed", "not a wrapped key");
  return { id: row.id, status: row.status, wrapped: wrapped ? wrapped.data : null };
}

/** The store in `tx`, which must be scoped to the client it is asked about. */
export function tenantKeysIn(tx: Tx): TenantKeyStore {
  const activeRow = async (tenantId: string) => {
    const [row] = await tx
      .select()
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.status, "active")));
    return row;
  };
  return {
    async active(tenantId, wrapNew) {
      const found = await activeRow(tenantId);
      if (found) return recordOf(found);
      const [destroyed] = await tx
        .select({ id: tenantKey.id })
        .from(tenantKey)
        .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.status, "destroyed")))
        .limit(1);
      // DECISION: a client whose key was destroyed gets no new key: destroying is for a retired
      // client, and nothing new should be stored for it.
      if (destroyed) throw new CredentialError("key_destroyed", "the client's key was destroyed");
      // Two first uses at once: the partial unique index keeps one active key, and the loser
      // reads the winner's.
      await tx
        .insert(tenantKey)
        .values({ tenantId, wrappedKey: await wrapNew(), status: "active" })
        .onConflictDoNothing();
      const created = await activeRow(tenantId);
      if (!created) throw new Error("the client's key could not be created");
      return recordOf(created);
    },
    async get(tenantId, id) {
      if (!UUID.test(id)) return null;
      const [row] = await tx
        .select()
        .from(tenantKey)
        .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.id, id)));
      return row ? recordOf(row) : null;
    },
  };
}

/** The store over the database: each call its own short transaction for its client. */
export function tenantKeysInDb(db: Db): TenantKeyStore {
  return {
    active: (tenantId, wrapNew) =>
      withTenant(db, tenantId, (tx) => tenantKeysIn(tx).active(tenantId, wrapNew)),
    get: (tenantId, id) => withTenant(db, tenantId, (tx) => tenantKeysIn(tx).get(tenantId, id)),
  };
}

/**
 * Writes a connection's credentials envelope only if the stored one is still `expected` (null:
 * none stored), in `tx` (scoped to the client): the compare-and-swap behind
 * `encryptedCredentials`'s `saveIf`. True when it was written.
 */
export async function saveCredentialsIf(
  tx: Tx,
  where: { tenantId: string; connectionId: string },
  envelope: unknown,
  expected: unknown,
): Promise<boolean> {
  const stored =
    expected == null
      ? isNull(connection.credentialsEncrypted)
      : sql`${connection.credentialsEncrypted}::jsonb = ${JSON.stringify(expected)}::jsonb`;
  const rows = await tx
    .update(connection)
    .set({ credentialsEncrypted: envelope as Record<string, unknown> })
    .where(
      and(eq(connection.id, where.connectionId), eq(connection.tenantId, where.tenantId), stored),
    )
    .returning({ id: connection.id });
  return rows.length > 0;
}

/**
 * Re-encrypts up to `limit` of the client's v1 envelopes as v2 under its own key. Returns how
 * many were re-encrypted; rows that fail to decrypt are left as they are and counted in `failed`.
 */
export async function reencryptClientCredentials(
  tx: Tx,
  input: { tenantId: string; vault: VaultCipher; limit: number },
): Promise<{ reencrypted: number; failed: number }> {
  const rows = await tx
    .select({ id: connection.id, c: connection.credentialsEncrypted })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, input.tenantId),
        isNotNull(connection.credentialsEncrypted),
        sql`coalesce(${connection.credentialsEncrypted}->>'v', '1') <> '2'`,
      ),
    )
    .orderBy(asc(connection.id))
    .limit(input.limit);
  let reencrypted = 0;
  let failed = 0;
  for (const row of rows) {
    const binding = { tenantId: input.tenantId, connectionId: row.id };
    try {
      const next = await input.vault.reencrypt(row.c, binding);
      // Only over the envelope just read: a refresh saved meanwhile is newer, and is already v2.
      const saved = await saveCredentialsIf(
        tx,
        { tenantId: input.tenantId, connectionId: row.id },
        next,
        row.c,
      );
      if (saved) reencrypted += 1;
    } catch (error) {
      if (!(error instanceof CredentialError)) throw error;
      failed += 1;
    }
  }
  return { reencrypted, failed };
}

/**
 * Re-wraps the client's keys still wrapped by a previous master key. `rewrapped` counts the keys
 * moved under the current master. Keys wrapped by a master key this deployment no longer holds can
 * never be opened again, so they are left as they are and only counted: `lost` the active ones
 * (an alarm: the client's new credentials go under a key nothing can open), `retiredLost` the
 * retired ones (expected once `retire-lost-keys.yml` has run).
 */
// DECISION: a key whose master is unknown is counted, not tried: before, one lost master key
// (staging's, 2026-11-21) made every hourly upkeep throw on the first such key and stop
// (Sentry MEZONAS-API-D). `retire-lost-keys.yml` retires the active ones; retired ones stay.
export async function rewrapClientKeys(
  tx: Tx,
  input: { tenantId: string; master: CredentialCipher },
): Promise<{ rewrapped: number; lost: number; retiredLost: number }> {
  const rows = await tx
    .select()
    .from(tenantKey)
    .where(
      and(
        eq(tenantKey.tenantId, input.tenantId),
        ne(tenantKey.status, "destroyed"),
        isNotNull(tenantKey.wrappedKey),
        sql`${tenantKey.wrappedKey}->>'kid' <> ${input.master.currentKeyId}`,
      ),
    );
  const known = new Set(input.master.keyIds);
  let rewrapped = 0;
  let lost = 0;
  let retiredLost = 0;
  for (const row of rows) {
    const kid = WrappedKey.safeParse(row.wrappedKey);
    if (!kid.success || !known.has(kid.data.kid)) {
      // DECISION (overnight, Sentry MEZONAS-API-K): a retired key under a lost master is what
      // the retire workflow leaves behind, counted apart and never warned about.
      if (row.status === "retired") retiredLost += 1;
      else lost += 1;
      continue;
    }
    const wrapped = await input.master.rewrap(row.wrappedKey, input.tenantId);
    await tx
      .update(tenantKey)
      .set({ wrappedKey: wrapped })
      .where(and(eq(tenantKey.id, row.id), eq(tenantKey.tenantId, input.tenantId)));
    rewrapped += 1;
  }
  return { rewrapped, lost, retiredLost };
}

/**
 * Destroys a client's data keys (for a retired client; an operator action): wipes every wrapped
 * key and marks it destroyed, so every v2 envelope of the client is unreadable at once, and drops
 * any v1 envelope left (those were under the master key, not the client's). Returns the keys
 * destroyed. The caller checks the client is retired and that an operator asked.
 */
// DECISION: destroying also drops the client's remaining v1 envelopes, so "the client's secrets
// are unreadable" holds even before the hourly re-encryption reached them.
export async function destroyClientKeys(tx: Tx, tenantId: string): Promise<number> {
  const destroyed = await tx
    .update(tenantKey)
    .set({
      status: "destroyed",
      wrappedKey: null,
      retiredAt: sql`coalesce(${tenantKey.retiredAt}, now())`,
    })
    .where(and(eq(tenantKey.tenantId, tenantId), ne(tenantKey.status, "destroyed")))
    .returning({ id: tenantKey.id });
  await tx
    .update(connection)
    .set({ credentialsEncrypted: null })
    .where(
      and(
        eq(connection.tenantId, tenantId),
        isNotNull(connection.credentialsEncrypted),
        sql`coalesce(${connection.credentialsEncrypted}->>'v', '1') <> '2'`,
      ),
    );
  return destroyed.length;
}
