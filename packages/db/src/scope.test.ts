// The scope goes to the database in the same round trip as a transaction's first queries
// (docs/plan.md §1.82): every statement `fn` issues, even at once and before awaiting anything,
// still runs after the scope is set, and a failing `fn` still rolls back.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDb,
  type Tx,
  withOperator,
  withSession,
  withTenant,
  withUser,
} from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { tenant } from "./schema";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("a transaction's scope", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  const settings = (tx: Tx) =>
    tx
      .execute<{ ids: string; op: string; user: string }>(
        sql`select current_setting('app.tenant_ids', true) as ids,
          current_setting('app.operator', true) as op,
          current_setting('app.user_id', true) as user`,
      )
      .then((rows) => [...rows][0]);

  it("is set before the first statement, issued at once", async () => {
    const first = await withTenant(t.db, A.tenantId, (tx) => settings(tx));
    expect(first).toEqual({ ids: `{${A.tenantId}}`, op: "off", user: "" });
    const user = "00000000-0000-4000-8000-0000000000aa";
    expect(await withUser(t.db, user, (tx) => settings(tx))).toEqual({
      ids: "{}",
      op: "off",
      user,
    });
  });

  it("covers every statement issued together, as a pipelined route issues them", async () => {
    const [ids, op] = await withOperator(t.db, [A.tenantId, B.tenantId], (tx) =>
      Promise.all([settings(tx).then((s) => s?.ids), settings(tx).then((s) => s?.op)]),
    );
    expect(ids).toBe(`{${[A.tenantId, B.tenantId].join(",")}}`);
    expect(op).toBe("on");
  });

  it("rolls back when `fn` fails, even before its first await", async () => {
    await expect(
      withTenant(t.db, A.tenantId, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await tx.execute(sql`create temporary table scope_probe (n int)`);
        throw new Error("late");
      }),
    ).rejects.toThrow("late");
    const left = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_class where relname = 'scope_probe'`,
    );
    expect([...left][0]?.n).toBe(0);
  });

  it("withSession: the user first, then the scope in its place, in one transaction", async () => {
    const user = "00000000-0000-4000-8000-0000000000aa";
    const out = await withSession(
      t.db,
      user,
      async (tx) => {
        const signIn = await settings(tx);
        const pid = await tx
          .execute<{ pid: number; xid: string }>(
            sql`select pg_backend_pid() as pid, txid_current()::text as xid`,
          )
          .then((rows) => [...rows][0]);
        return {
          ok: true as const,
          scope: { tenantIds: [A.tenantId], operator: false },
          value: { signIn, pid },
        };
      },
      async (tx, before) => {
        // Issued at once, as a pipelined handler issues its first statements.
        const [handler, same] = await Promise.all([
          settings(tx),
          tx
            .execute<{ pid: number; xid: string }>(
              sql`select pg_backend_pid() as pid, txid_current()::text as xid`,
            )
            .then((rows) => [...rows][0]),
        ]);
        return { before, handler, same };
      },
    );
    if (!out.ok) throw new Error("refused");
    expect(out.value.before.signIn).toEqual({ ids: "{}", op: "off", user });
    expect(out.value.handler).toEqual({ ids: `{${A.tenantId}}`, op: "off", user: "" });
    // One transaction: the same backend and the same transaction id on both sides.
    expect(out.value.same).toEqual(out.value.before.pid);
  });

  it("withSession rolls the whole transaction back when the handler fails", async () => {
    await expect(
      withSession(
        t.db,
        "00000000-0000-4000-8000-0000000000aa",
        async (tx) => {
          await tx.execute(sql`create temporary table session_probe (n int)`);
          return {
            ok: true as const,
            scope: { tenantIds: [A.tenantId], operator: true },
            value: 0,
          };
        },
        async () => {
          throw new Error("handler");
        },
      ),
    ).rejects.toThrow("handler");
    const left = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_class where relname = 'session_probe'`,
    );
    expect([...left][0]?.n).toBe(0);
  });

  it("withSession: a drizzle select issued at once also runs after the switch", async () => {
    // Drizzle's query builder takes its own path to the connection (not `execute`): a version that
    // reordered statements would show here first.
    const out = await withSession(
      t.db,
      "00000000-0000-4000-8000-0000000000aa",
      async () => ({
        ok: true as const,
        scope: { tenantIds: [A.tenantId, B.tenantId], operator: true },
        value: null,
      }),
      (tx) =>
        Promise.all([
          tx
            .select({
              ids: sql<string>`current_setting('app.tenant_ids', true)`,
              op: sql<string>`current_setting('app.operator', true)`,
              user: sql<string>`current_setting('app.user_id', true)`,
            })
            .from(tenant)
            .where(eq(tenant.id, A.tenantId)),
          settings(tx),
        ]),
    );
    if (!out.ok) throw new Error("refused");
    const [[selected], executed] = out.value;
    expect(selected).toEqual({ ids: `{${A.tenantId},${B.tenantId}}`, op: "on", user: "" });
    expect(executed).toEqual({ ids: `{${A.tenantId},${B.tenantId}}`, op: "on", user: "" });
  });

  it("withSession leaves a pooled connection clean, whatever happened in the request", async () => {
    // One connection, as a Worker request has: whatever the last request did, the next statement
    // outside a transaction sees no client, no operator and no user.
    const one = createDb(t.url, { max: 1 });
    const user = "00000000-0000-4000-8000-0000000000aa";
    const scope = { tenantIds: [A.tenantId], operator: false };
    const left = async () => {
      const rows = await one.execute<{ ids: string; op: string; uid: string }>(
        sql`select coalesce(current_setting('app.tenant_ids', true), '') as ids,
          coalesce(current_setting('app.operator', true), '') as op,
          coalesce(current_setting('app.user_id', true), '') as uid`,
      );
      return [...rows][0];
    };
    const clean = { ids: "", op: "", uid: "" };
    try {
      // A throw while signing in.
      await expect(
        withSession(
          one,
          user,
          async () => {
            throw new Error("sign-in");
          },
          async () => 0,
        ),
      ).rejects.toThrow("sign-in");
      expect(await left()).toEqual(clean);
      // A throw in the handler.
      await expect(
        withSession(
          one,
          user,
          async () => ({ ok: true as const, scope, value: 0 }),
          async () => {
            throw new Error("handler");
          },
        ),
      ).rejects.toThrow("handler");
      expect(await left()).toEqual(clean);
      // A refusal.
      expect(
        await withSession(
          one,
          user,
          async () => ({ ok: false as const, refusal: "no" }),
          async () => 0,
        ),
      ).toEqual({ ok: false, refusal: "no" });
      expect(await left()).toEqual(clean);
      // A SQL error the handler caught and swallowed (the transaction ends rolled back).
      await withSession(
        one,
        user,
        async () => ({ ok: true as const, scope, value: 0 }),
        async (tx) => {
          await tx.execute(sql`select 1/0`).catch(() => undefined);
          return 0;
        },
      ).catch(() => undefined);
      expect(await left()).toEqual(clean);
      // And a request that went well.
      await withSession(
        one,
        user,
        async () => ({ ok: true as const, scope, value: 0 }),
        async (tx) => settings(tx),
      );
      expect(await left()).toEqual(clean);
    } finally {
      await closeDb(one);
    }
  });
});
