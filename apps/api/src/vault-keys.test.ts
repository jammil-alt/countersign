// Client data keys against the database as the Worker's role (docs/plan.md §1.26): the first write
// creates the client's key, v1 rows re-encrypt as v2, a master rotation re-wraps keys, a
// destroyed key leaves nothing readable, and each client's keys stay its own.

import {
  CredentialCipher,
  CredentialError,
  destroyClientKeys,
  generateEncryptionKey,
  reencryptClientCredentials,
  rewrapClientKeys,
  tenantKeysIn,
  tenantKeysInDb,
} from "@countersign/connectors";
import { connection, createDb, type Db, tenant, tenantKey, withTenant } from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vaultUpkeep } from "./vault/upkeep";

const t = await createTestDatabase();

function workerUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
}

const secret = { apiKey: "sk-live-123" };

describe.skipIf(!t)("tenant keys in the database", () => {
  const T = t as TestDatabase;
  let db: Db;
  let A: { tenantId: string; connectionId: string };
  let B: { tenantId: string; connectionId: string };
  const oldKey = generateEncryptionKey();

  async function client(name: string) {
    const [row] = await T.db.insert(tenant).values({ name }).returning();
    if (!row) throw new Error("no tenant");
    const [c] = await T.db
      .insert(connection)
      .values({ tenantId: row.id, connector: "acme", status: "connected" })
      .returning();
    if (!c) throw new Error("no connection");
    return { tenantId: row.id, connectionId: c.id };
  }

  const stored = async (c: { tenantId: string; connectionId: string }) =>
    withTenant(db, c.tenantId, async (tx) => {
      const [row] = await tx
        .select({ c: connection.credentialsEncrypted })
        .from(connection)
        .where(eq(connection.id, c.connectionId));
      return row?.c ?? null;
    });

  const store = async (c: { tenantId: string; connectionId: string }, value: unknown) =>
    withTenant(db, c.tenantId, (tx) =>
      tx
        .update(connection)
        .set({ credentialsEncrypted: value as Record<string, unknown> })
        .where(and(eq(connection.id, c.connectionId), eq(connection.tenantId, c.tenantId))),
    );

  beforeAll(async () => {
    db = createDb(workerUrl(T.url), { max: 2 });
    A = await client("A");
    B = await client("B");
  });
  afterAll(async () => {
    await db?.$client.end();
    await T?.drop();
  });

  it("creates the client's key on first write and reads v1 and v2 alike", async () => {
    const master = await CredentialCipher.create({ current: oldKey });
    // A row written before phase 1: v1 under the master key.
    await store(A, await master.encryptV1(secret, A));
    const vault = master.forClients(tenantKeysInDb(db));
    expect(await vault.decrypt(await stored(A), A)).toEqual(secret);
    const keysBefore = await T.db
      .select()
      .from(tenantKey)
      .where(eq(tenantKey.tenantId, A.tenantId));
    expect(keysBefore).toEqual([]);

    await store(B, await vault.encrypt(secret, B));
    const [key] = await T.db.select().from(tenantKey).where(eq(tenantKey.tenantId, B.tenantId));
    expect(key?.status).toBe("active");
    expect(JSON.stringify(key?.wrappedKey)).not.toContain(secret.apiKey);
    expect(await vault.decrypt(await stored(B), B)).toEqual(secret);
  });

  it("re-encrypts v1 rows as v2 in bounded batches", async () => {
    const master = await CredentialCipher.create({ current: oldKey });
    const vault = master.forClients(tenantKeysInDb(db));
    const done = await withTenant(db, A.tenantId, (tx) =>
      reencryptClientCredentials(tx, {
        tenantId: A.tenantId,
        vault: master.forClients(tenantKeysIn(tx)),
        limit: 10,
      }),
    );
    expect(done).toEqual({ reencrypted: 1, failed: 0 });
    const env = (await stored(A)) as { v: number };
    expect(env.v).toBe(2);
    expect(await vault.decrypt(env, A)).toEqual(secret);
    const again = await withTenant(db, A.tenantId, (tx) =>
      reencryptClientCredentials(tx, {
        tenantId: A.tenantId,
        vault: master.forClients(tenantKeysIn(tx)),
        limit: 10,
      }),
    );
    expect(again.reencrypted).toBe(0);
  });

  it("leaves a row alone when a refresh saved newer credentials while it re-encrypted", async () => {
    const master = await CredentialCipher.create({ current: oldKey });
    const vault = master.forClients(tenantKeysInDb(db));
    await store(A, await master.encryptV1(secret, A));
    const newer = { apiKey: "sk-live-456" };
    const done = await withTenant(db, A.tenantId, async (tx) => {
      const inTx = master.forClients(tenantKeysIn(tx));
      return reencryptClientCredentials(tx, {
        tenantId: A.tenantId,
        vault: {
          ...inTx,
          reencrypt: async (envelope: unknown, binding: typeof A) => {
            const out = await inTx.reencrypt(envelope, binding);
            // Another isolate's refresh lands between the read and the write.
            await store(A, await vault.encrypt(newer, A));
            return out;
          },
        } as unknown as typeof inTx,
        limit: 10,
      });
    });
    expect(done).toEqual({ reencrypted: 0, failed: 0 });
    expect(await vault.decrypt(await stored(A), A)).toEqual(newer);
    // Back to what the tests after this one expect.
    await store(A, await vault.encrypt(secret, A));
  });

  it("a ciphertext copied to another client's connection does not open there", async () => {
    const master = await CredentialCipher.create({ current: oldKey });
    const vault = master.forClients(tenantKeysInDb(db));
    const fromA = await stored(A);
    await expect(vault.decrypt(fromA, B)).rejects.toBeInstanceOf(CredentialError);
  });

  it("a master key rotation re-wraps keys, and the envelopes still open", async () => {
    const newKey = generateEncryptionKey();
    const rotating = await CredentialCipher.create({ current: newKey, previous: [oldKey] });
    for (const c of [A, B]) {
      const n = await withTenant(db, c.tenantId, (tx) =>
        rewrapClientKeys(tx, { tenantId: c.tenantId, master: rotating }),
      );
      expect(n).toEqual({ rewrapped: 1, lost: 0 });
    }
    const after = await CredentialCipher.create({ current: newKey });
    const vault = after.forClients(tenantKeysInDb(db));
    expect(await vault.decrypt(await stored(A), A)).toEqual(secret);
    expect(await vault.decrypt(await stored(B), B)).toEqual(secret);
  });

  it("destroying a client's key makes its secrets unreadable at once, and only its own", async () => {
    const master = await CredentialCipher.create({ current: generateEncryptionKey() });
    const n = await withTenant(db, A.tenantId, (tx) => destroyClientKeys(tx, A.tenantId));
    expect(n).toBe(1);
    // Whatever master key the deployment holds, A's envelope can't open.
    const vault = master.forClients(tenantKeysInDb(db));
    await expect(vault.decrypt(await stored(A), A)).rejects.toMatchObject({
      code: "key_destroyed",
    });
    await expect(vault.encrypt(secret, A)).rejects.toMatchObject({ code: "key_destroyed" });
    const [b] = await T.db.select().from(tenantKey).where(eq(tenantKey.tenantId, B.tenantId));
    expect(b?.status).toBe("active");
  });

  it("upkeep skips a key whose master key is lost, and still re-wraps the others", async () => {
    // Staging, 2026-11-21: a deploy replaced the master key; the retired keys it wrapped stay.
    const lostMaster = await CredentialCipher.create({ current: generateEncryptionKey() });
    const previous = generateEncryptionKey();
    const before = await CredentialCipher.create({ current: previous });
    const C = await client("C");
    const raw = () => crypto.getRandomValues(new Uint8Array(32));
    await T.db.insert(tenantKey).values([
      {
        tenantId: C.tenantId,
        status: "retired",
        wrappedKey: await lostMaster.wrap(raw(), C.tenantId),
      },
      { tenantId: C.tenantId, status: "active", wrappedKey: await before.wrap(raw(), C.tenantId) },
    ]);
    await store(C, await before.forClients(tenantKeysInDb(db)).encrypt(secret, C));

    const current = generateEncryptionKey();
    const now = await CredentialCipher.create({ current, previous: [previous] });
    const result = await vaultUpkeep(db, now);
    // A's and B's keys are under a master this test doesn't hold either: lost here too.
    expect(result.lostKeys).toBeGreaterThanOrEqual(1);
    const keys = await T.db.select().from(tenantKey).where(eq(tenantKey.tenantId, C.tenantId));
    const active = keys.find((k) => k.status === "active");
    const retired = keys.find((k) => k.status === "retired");
    expect(active?.wrappedKey).toMatchObject({ kid: now.currentKeyId });
    expect(retired?.wrappedKey).toMatchObject({ kid: lostMaster.currentKeyId });
    // Opens with the current master alone: the previous one can be dropped.
    const only = await CredentialCipher.create({ current: current });
    expect(await only.forClients(tenantKeysInDb(db)).decrypt(await stored(C), C)).toEqual(secret);
  });

  it("the Worker's role sees only the session's client's keys", async () => {
    const seen = await withTenant(db, B.tenantId, (tx) =>
      tx.select({ tenantId: tenantKey.tenantId }).from(tenantKey),
    );
    expect(new Set(seen.map((r) => r.tenantId))).toEqual(new Set([B.tenantId]));
  });
});
