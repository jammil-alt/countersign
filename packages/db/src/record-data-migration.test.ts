// Migration 0102 (step model §10f, stream N): `custom_field`, the custom fields defined for an
// area's record types (a client's own, or shared with no client), and `record_write`, the log of
// every standard Create or Update of a record. It applies on a database the previous Worker used;
// a client sees only its own fields and writes, an operator also the shared fields; a field is
// unique per client and record type and never deleted; a write is logged once (its key), by an
// agent version or a person, and never changed.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Tx, withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
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

describe.skipIf(!online)("0102 on a database the previous Worker used", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0101_connector_actions" });
    await insertClient(t.db, "Earlier");
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("applies, and the previous Worker's vendors keep their ext as it was", async () => {
    const [n] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from custom_field`;
    expect(n?.n).toBe(0);
    const [v] = await t.db.$client<{ ok: boolean }[]>`
      select to_regclass('public.record_write') is not null as ok`;
    expect(v?.ok).toBe(true);
  });
});

describe.skipIf(!online)("0102: custom_field and record_write", () => {
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

  const as = <T>(scope: "A" | "operator", fn: (tx: Tx) => Promise<T>) => {
    const go = async (tx: Tx) => {
      await asWorker(tx);
      return fn(tx);
    };
    return scope === "A"
      ? withTenant(t.db, A.tenantId, go)
      : withOperator(t.db, [A.tenantId, B.tenantId], go);
  };
  const run = (tx: Tx, q: string) => tx.execute(sql.raw(q));

  it("forces row-level security on both", async () => {
    const rows = await t.db.execute<{ relname: string; rls: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relname in ('custom_field', 'record_write') order by relname`);
    expect([...rows]).toEqual([
      { relname: "custom_field", rls: true, forced: true },
      { relname: "record_write", rls: true, forced: true },
    ]);
  });

  it("shows a client its own fields only, and an operator the shared ones too", async () => {
    await as("operator", (tx) =>
      run(
        tx,
        `insert into custom_field (tenant_id, record_type, name, label, type)
         values ('${A.tenantId}', 'vendor', 'terms', 'Terms', 'text'),
                ('${B.tenantId}', 'vendor', 'terms', 'Terms', 'text'),
                (null, 'vendor', 'terms', 'Terms', 'text')`,
      ),
    );
    const seen = async (scope: "A" | "operator") =>
      [
        ...(await as(scope, (tx) =>
          tx.execute<{ t: string | null }>(sql`
            select tenant_id::text as t from custom_field where name = 'terms'`),
        )),
      ]
        .map((r) => r.t ?? "shared")
        .sort();
    expect(await seen("A")).toEqual([A.tenantId]);
    expect(await seen("operator")).toEqual([A.tenantId, B.tenantId, "shared"].sort());
    // A client can't add a shared field, nor one of another client's.
    expect(
      await errorCode(
        as("A", (tx) =>
          run(
            tx,
            `insert into custom_field (record_type, name, label, type)
             values ('vendor', 'x', 'X', 'text')`,
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        as("A", (tx) =>
          run(
            tx,
            `insert into custom_field (tenant_id, record_type, name, label, type)
             values ('${B.tenantId}', 'vendor', 'y', 'Y', 'text')`,
          ),
        ),
      ),
    ).toBe("42501");
  });

  it("keeps a field's name unique per client and record type, shared ones too, and checks it", async () => {
    const dup = (tenant: string) =>
      errorCode(
        as("operator", (tx) =>
          run(
            tx,
            `insert into custom_field (tenant_id, record_type, name, label, type)
             values (${tenant}, 'vendor', 'terms', 'Again', 'text')`,
          ),
        ),
      );
    expect(await dup(`'${A.tenantId}'`)).toBe("23505");
    expect(await dup("null")).toBe("23505");
    const bad = (values: string) =>
      errorCode(
        as("A", (tx) =>
          run(
            tx,
            `insert into custom_field (tenant_id, record_type, name, label, type)
             values ('${A.tenantId}', ${values})`,
          ),
        ),
      );
    expect(await bad("'vendor', 'ok', 'Ok', 'picture'")).toBe("23514");
    expect(await bad("'vendor', 'Bad name', 'Bad', 'text'")).toBe("23514");
    expect(await bad("'Vendor', 'ok2', 'Ok', 'text'")).toBe("23514");
  });

  it("hides a field rather than deleting it", async () => {
    await as("A", (tx) =>
      run(tx, "update custom_field set hidden_at = now() where name = 'terms'"),
    );
    expect(
      await errorCode(as("A", (tx) => run(tx, "delete from custom_field where name = 'terms'"))),
    ).toBe("42501");
  });

  it("logs each write once, by an agent version or a person (never both), and never changes it", async () => {
    const insert = (key: string, by: string) =>
      as("A", (tx) =>
        run(
          tx,
          `insert into record_write (tenant_id, record_type, record_id, op, key, ${by}, after)
           values ('${A.tenantId}', 'vendor', '${A.agentId}', 'update', '${key}',
                   ${by === "agent_version_id" ? `'${A.agentVersionId}'` : `'${A.userId}'`},
                   '{"custom":{"terms":"Net 30"}}'::jsonb)`,
        ),
      );
    await insert("w1", "agent_version_id");
    await insert("w2", "user_id");
    expect(await errorCode(insert("w1", "agent_version_id"))).toBe("23505");
    expect(
      await errorCode(
        as("A", (tx) =>
          run(
            tx,
            `insert into record_write (tenant_id, record_type, record_id, op, key, agent_version_id,
               user_id, after)
             values ('${A.tenantId}', 'vendor', '${A.agentId}', 'update', 'w3', '${A.agentVersionId}',
                     '${A.userId}', '{}'::jsonb)`,
          ),
        ),
      ),
    ).toBe("23514");
    expect(
      await errorCode(as("A", (tx) => run(tx, "update record_write set op = 'create'"))),
    ).toBeDefined();
    expect(await errorCode(as("A", (tx) => run(tx, "delete from record_write")))).toBeDefined();
    // Another client's write is refused; B's log shows nothing of A's.
    expect(
      await errorCode(
        as("A", (tx) =>
          run(
            tx,
            `insert into record_write (tenant_id, record_type, record_id, op, key, user_id, after)
             values ('${B.tenantId}', 'vendor', '${A.agentId}', 'update', 'w4', '${A.userId}',
                     '{}'::jsonb)`,
          ),
        ),
      ),
    ).toBe("42501");
    const ofB = await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return [
        ...(await tx.execute<{ key: string }>(sql`
          select key from record_write where key in ('w1', 'w2')`)),
      ];
    });
    expect(ofB).toEqual([]);
  });
});
