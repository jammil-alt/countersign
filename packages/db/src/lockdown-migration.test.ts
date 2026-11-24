// Migration 0101 (docs/plan.md §1.243, docs/lockdown-plan.md K0): `tenant.locked_at` and
// `tenant.lock`, `platform_lock`, and `app_scope_tenant_ids`. It applies on a database the previous
// Worker used, leaves its tenant rows unlocked, and the function answers each scope mode as the
// plan says, as the Worker's role.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "./client";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

/** A client and one of its people, as the previous Worker would have made them. */
interface ClientFixture {
  tenantId: string;
  userId: string;
}

const CLIENT_LOCKED = "MZLCK";
const CHECK_VIOLATION = "23514";
const READ_ONLY = "25006";

describe.skipIf(!online)("0101 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  /** As the Worker, in a transaction of its own (read only when asked). */
  const asWorkerTx = <T>(work: (tx: Tx) => Promise<T>, readOnly = false) =>
    t.db.transaction(async (tx) => {
      if (readOnly) await tx.execute(sql`set transaction read only`);
      await asWorker(tx);
      return work(tx);
    });

  const scope = (ids: string[], mode: string, readOnly = false) =>
    asWorkerTx(async (tx) => {
      const rows = await tx.execute<{ ids: string[] }>(
        sql`select app_scope_tenant_ids(${`{${ids.join(",")}}`}::uuid[], ${mode}) as ids`,
      );
      return [...rows][0]?.ids ?? [];
    }, readOnly);

  const lockClient = (c: ClientFixture) =>
    asWorkerTx((tx) =>
      tx.execute(sql`update tenant set locked_at = now(),
        lock = ${JSON.stringify({ side: "operator", by: c.userId, at: "2026-11-24T14:02:00Z", reason: "test" })}::jsonb
        where id = ${c.tenantId}`),
    );
  const unlockClient = (c: ClientFixture) =>
    asWorkerTx((tx) =>
      tx.execute(sql`update tenant set locked_at = null, lock = null where id = ${c.tenantId}`),
    );
  const lockEverything = (c: ClientFixture) =>
    asWorkerTx((tx) =>
      tx.execute(sql`insert into platform_lock (locked_by, reason) values (${c.userId}, 'test')`),
    );
  const unlockEverything = () => asWorkerTx((tx) => tx.execute(sql`delete from platform_lock`));

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0100_ap" });
    // Plain SQL: the schema in this package already has 0101's columns.
    const oldClient = async (name: string): Promise<ClientFixture> => {
      const [tenant] = await t.db.$client<{ id: string }[]>`
        insert into tenant (name) values (${name}) returning id`;
      const [user] = await t.db.$client<{ id: string }[]>`
        insert into app_user (email) values (${`${name.toLowerCase()}@example.com`}) returning id`;
      if (!tenant || !user) throw new Error("no client");
      return { tenantId: tenant.id, userId: user.id };
    };
    A = await oldClient("A");
    B = await oldClient("B");
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("leaves existing clients unlocked, and the previous Worker's tenant insert works", async () => {
    const rows = await t.db.$client<{ locked: number }[]>`
      select count(*)::int as locked from tenant where locked_at is not null or lock is not null`;
    expect(rows[0]?.locked).toBe(0);
    await asWorkerTx((tx) => tx.execute(sql`insert into tenant (name) values ('Old Worker Ltd')`));
  });

  it("answers every id while nothing is locked", async () => {
    expect(await scope([A.tenantId], "one")).toEqual([A.tenantId]);
    expect(await scope([A.tenantId, B.tenantId], "some")).toEqual([A.tenantId, B.tenantId]);
    expect(await scope([], "some")).toEqual([]);
  });

  it("refuses a locked client's own scope and leaves it out of a wider one", async () => {
    await lockClient(A);
    try {
      expect(await errorCode(scope([A.tenantId], "one"))).toBe(CLIENT_LOCKED);
      expect(await scope([B.tenantId], "one")).toEqual([B.tenantId]);
      expect(await scope([A.tenantId, B.tenantId], "some")).toEqual([B.tenantId]);
    } finally {
      await unlockClient(A);
    }
    expect(await scope([A.tenantId], "one")).toEqual([A.tenantId]);
  });

  it("aborts the transaction, so nothing after the refused scope runs", async () => {
    await lockClient(A);
    try {
      const code = await errorCode(
        asWorkerTx(async (tx) => {
          await tx.execute(sql`select app_scope_tenant_ids(${`{${A.tenantId}}`}::uuid[], 'one')`);
          await tx.execute(sql`update tenant set name = 'Changed' where id = ${B.tenantId}`);
        }),
      );
      expect(code).toBe(CLIENT_LOCKED);
      const [row] = await t.db.$client<{ name: string }[]>`
        select name from tenant where id = ${B.tenantId}`;
      expect(row?.name).not.toBe("Changed");
    } finally {
      await unlockClient(A);
    }
  });

  it("locks every client while the platform is locked", async () => {
    await lockEverything(A);
    try {
      expect(await errorCode(scope([B.tenantId], "one"))).toBe(CLIENT_LOCKED);
      expect(await scope([A.tenantId, B.tenantId], "some")).toEqual([]);
    } finally {
      await unlockEverything();
    }
    expect(await scope([A.tenantId, B.tenantId], "some")).toEqual([A.tenantId, B.tenantId]);
  });

  it("opens an investigation of a locked client only in a read-only transaction", async () => {
    await lockClient(A);
    await lockEverything(A);
    try {
      expect(await errorCode(scope([A.tenantId], "investigate"))).toBe(READ_ONLY);
      expect(await scope([A.tenantId], "investigate", true)).toEqual([A.tenantId]);
    } finally {
      await unlockEverything();
      await unlockClient(A);
    }
  });

  it("refuses an unknown mode", async () => {
    expect(await errorCode(scope([A.tenantId], "all"))).toBe("22023");
  });

  it("keeps a lock whole: a time and its record together, the record an object", async () => {
    const set = (assignments: string) =>
      errorCode(
        asWorkerTx((tx) =>
          tx.execute(sql.raw(`update tenant set ${assignments} where id = '${A.tenantId}'`)),
        ),
      );
    expect(await set("locked_at = now()")).toBe(CHECK_VIOLATION);
    expect(await set(`lock = '{"side":"client"}'::jsonb`)).toBe(CHECK_VIOLATION);
    expect(await set(`locked_at = now(), lock = '[]'::jsonb`)).toBe(CHECK_VIOLATION);
  });

  it("holds the platform lock to one row with a reason", async () => {
    const insert = (values: string) =>
      errorCode(
        asWorkerTx((tx) =>
          tx.execute(sql.raw(`insert into platform_lock (id, locked_by, reason) values ${values}`)),
        ),
      );
    expect(await insert(`(false, '${A.userId}', 'second row')`)).toBe(CHECK_VIOLATION);
    expect(await insert(`(true, '${A.userId}', '')`)).toBe(CHECK_VIOLATION);
    await lockEverything(A);
    try {
      expect(await insert(`(true, '${B.userId}', 'again')`)).toBe("23505");
    } finally {
      await unlockEverything();
    }
  });

  it("lets the runtime lock and unlock, but never rewrite a platform lock", async () => {
    const can = async (privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', 'platform_lock', ${privilege}) as ok`
      )[0]?.ok;
    expect(await can("SELECT")).toBe(true);
    expect(await can("INSERT")).toBe(true);
    expect(await can("DELETE")).toBe(true);
    expect(await can("UPDATE")).toBe(false);
    expect(await can("TRUNCATE")).toBe(false);
    const [fn] = await t.db.$client<{ runtime: boolean; everyone: boolean }[]>`
      select
        has_function_privilege('cs_runtime', 'app_scope_tenant_ids(uuid[], text)', 'EXECUTE') as runtime,
        exists (
          select 1 from pg_proc p, aclexplode(p.proacl) a
          where p.proname = 'app_scope_tenant_ids' and a.grantee = 0
        ) as everyone`;
    expect(fn).toEqual({ runtime: true, everyone: false });
  });
});
