// Client isolation (CLAUDE.md invariant 1) as the Worker's role sees it: a client session sees its
// own rows only, on every tenant table; an operator session sees the clients it names plus the
// templates; no scope sees nothing. Plus the privileges that make it hold: cs_worker can't bypass RLS.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDb,
  ScopeError,
  type Tx,
  withOperator,
  withTenant,
  withTenants,
  withUser,
} from "./client";
import { type ClientFixture, insertClient, insertOperatorRows } from "./fixtures.test-helper";
import { userMemberships } from "./queries";
import { OPERATOR_TABLES, TENANT_TABLES, type TenantTable } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const INSUFFICIENT_PRIVILEGE = "42501";

async function tenantIdsIn(tx: Tx, table: TenantTable): Promise<(string | null)[]> {
  const rows = await tx.execute<{ t: string | null }>(
    sql.raw(`select tenant_id::text as t from ${table}`),
  );
  return [...rows].map((r) => r.t);
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("row-level security, as cs_worker", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let C: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    C = await insertClient(t.db, "C");
    await insertOperatorRows(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("the fixture has a row of every client in every tenant table", async () => {
    // The superuser bypasses RLS: this is the ground truth the sessions below are compared with.
    for (const table of TENANT_TABLES) {
      const ids = await t.db.transaction((tx) => tenantIdsIn(tx, table));
      for (const c of [A, B, C]) expect(ids, table).toContain(c.tenantId);
    }
  });

  it("a client session sees its own rows and nothing of any other client, on every table", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_TABLES) {
        const ids = await tenantIdsIn(tx, table);
        expect(ids.length, `${table} shows A's rows`).toBeGreaterThan(0);
        expect(new Set(ids), table).toEqual(new Set([A.tenantId]));
      }
    });
  });

  it("an operator session for {A, B} sees both and the templates, and nothing of C", async () => {
    await withOperator(t.db, [A.tenantId, B.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_TABLES) {
        const ids = new Set(await tenantIdsIn(tx, table));
        const expected = new Set<string | null>([A.tenantId, B.tenantId]);
        if ((OPERATOR_TABLES as readonly string[]).includes(table)) expected.add(null);
        expect(ids, table).toEqual(expected);
      }
    });
  });

  it("several clients without the operator flag see no templates", async () => {
    await withTenants(t.db, [A.tenantId, B.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of OPERATOR_TABLES) {
        expect(new Set(await tenantIdsIn(tx, table)), table).toEqual(
          new Set([A.tenantId, B.tenantId]),
        );
      }
    });
  });

  it("no client ids: no rows anywhere, operator or not", async () => {
    await t.db.transaction(async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_TABLES) expect(await tenantIdsIn(tx, table), table).toEqual([]);
    });
    await withTenants(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_TABLES) expect(await tenantIdsIn(tx, table), table).toEqual([]);
    });
    // Operator with no clients: only the operator's own rows.
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_TABLES) {
        const ids = await tenantIdsIn(tx, table);
        expect(
          ids.every((id) => id === null),
          table,
        ).toBe(true);
      }
    });
  });

  it("a client session cannot write another client's rows or a template", async () => {
    const write = (statement: string) =>
      errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(sql.raw(statement));
        }),
      );
    expect(
      await write(`insert into event (tenant_id, type) values ('${B.tenantId}', 'sneaky')`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await write(`insert into agent (kind, slug, name) values ('template', 'sneaky', 'Sneaky')`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // Moving one's own row to another client is refused too (WITH CHECK).
    expect(
      await write(
        `update thread set tenant_id = '${B.tenantId}' where tenant_id = '${A.tenantId}'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);

    // Updating B's rows silently matches nothing.
    const updated = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const rows = await tx.execute(
        sql`update thread set title = 'mine now' where tenant_id = ${B.tenantId} returning id`,
      );
      return rows.length;
    });
    expect(updated).toBe(0);
  });

  it("deletes transaction lines in the client's own scope only", async () => {
    // Synced lines mirror the tool's current lines (0015); deleting B's from A matches nothing.
    const deleted = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const rows = await tx.execute(
        sql`delete from transaction_line where tenant_id = ${B.tenantId} returning id`,
      );
      return rows.length;
    });
    expect(deleted).toBe(0);
    const left = await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return (await tenantIdsIn(tx, "transaction_line")).length;
    });
    expect(left).toBeGreaterThan(0);
    // Transactions themselves are still never deleted.
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(sql`delete from transaction where tenant_id = ${A.tenantId}`);
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("the settings last for the transaction only", async () => {
    const read = (tx: Tx) =>
      tx.execute<{ ids: string | null; op: string | null }>(sql`
        select current_setting('app.tenant_ids', true) as ids,
               current_setting('app.operator', true) as op`);
    // One connection, so the second transaction runs on the very session the first one used.
    const single = createDb(t.url, { max: 1 });
    try {
      const inside = await withOperator(
        single,
        [A.tenantId],
        async (tx) => [...(await read(tx))][0],
      );
      expect(inside).toEqual({ ids: `{${A.tenantId}}`, op: "on" });
      const after = await single.transaction(async (tx) => [...(await read(tx))][0]);
      expect(after?.ids ?? "").toBe("");
      expect(after?.op ?? "").toBe("");
    } finally {
      await closeDb(single);
    }
  });

  it("refuses ids that are not uuids before touching the database", async () => {
    await expect(withTenant(t.db, "not-a-uuid", async () => 1)).rejects.toBeInstanceOf(ScopeError);
    await expect(
      withOperator(t.db, [A.tenantId, "x'; drop table run; --"], async () => 1),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("sign-in sees the user's own memberships only", async () => {
    await withUser(t.db, A.userId, async (tx) => {
      await asWorker(tx);
      const rows = await tx.execute<{ user_id: string }>(sql`select user_id::text from membership`);
      expect([...rows].map((r) => r.user_id)).toEqual([A.userId]);
      // Nothing else of A's client is visible from the user scope.
      expect(await tenantIdsIn(tx, "event")).toEqual([]);
    });
    const memberships = await userMemberships(t.db, B.userId);
    expect(memberships).toEqual([{ tenantId: B.tenantId, tenantName: "B", role: "client_admin" }]);
  });
});

describe.skipIf(!online)("cs_worker privileges", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("is a plain login, member of cs_runtime only, never of neon_superuser", async () => {
    const [role] = await t.db.$client<
      { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; rolcreaterole: boolean }[]
    >`select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole from pg_roles where rolname = 'cs_worker'`;
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreaterole: false,
    });
    // Effective membership, inheritance included.
    const [m] = await t.db.$client<{ neon: boolean; runtime: boolean; owner: boolean }[]>`
      select pg_has_role('cs_worker', 'neon_superuser', 'MEMBER') as neon,
             pg_has_role('cs_worker', 'cs_runtime', 'MEMBER') as runtime,
             pg_has_role('cs_worker', 'cs_owner', 'MEMBER') as owner`;
    expect(m).toEqual({ neon: false, runtime: true, owner: false });
    // Distinct: Postgres 16 keeps one membership row per grantor.
    const direct = await t.db.$client<{ rolname: string }[]>`
      select distinct g.rolname from pg_auth_members am
      join pg_roles g on g.oid = am.roleid
      join pg_roles w on w.oid = am.member
      where w.rolname = 'cs_worker'`;
    expect(direct.map((r) => r.rolname)).toEqual(["cs_runtime"]);
    // cs_runtime itself can't log in or skip RLS either.
    const [runtime] = await t.db.$client<{ rolcanlogin: boolean; rolbypassrls: boolean }[]>`
      select rolcanlogin, rolbypassrls from pg_roles where rolname = 'cs_runtime'`;
    expect(runtime).toEqual({ rolcanlogin: false, rolbypassrls: false });
  });

  it("owns nothing and cannot read the migration log", async () => {
    const owned = await t.db.$client`
      select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname in ('cs_worker', 'cs_runtime')`;
    expect(owned).toEqual([]);
    const code = await errorCode(
      t.db.transaction(async (tx) => {
        await asWorker(tx);
        await tx.execute(sql`select * from drizzle.__drizzle_migrations`);
      }),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
