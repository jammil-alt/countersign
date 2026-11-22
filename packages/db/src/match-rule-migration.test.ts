// Migration 0085 (docs/plan.md §1.215, the matching engine): `match_rule`, a client's saved match
// corrections. The Worker's role sees and writes only its own client's rules, never deletes one,
// only retires one (retired_at and retired_by together), and one live rule holds a value.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

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

describe.skipIf(!online)("0085: match_rule", () => {
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

  const asA = <T>(fn: (run: (q: string) => Promise<unknown>) => Promise<T>) =>
    withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return fn((q) => tx.execute(q));
    });

  const add = (tenantId: string, userId: string, aValue: string, config = "invoice_two_systems") =>
    asA((run) =>
      run(`insert into match_rule (tenant_id, config, field, a_value, b_value, created_by)
           values ('${tenantId}', '${config}', 'reference', '${aValue}', 'inv42', '${userId}')
           returning id`),
    ) as Promise<unknown> as Promise<{ id: string }[]>;

  it("forces row-level security", async () => {
    const rows = await t.db.execute<{ rls: boolean; forced: boolean }>(sql`
      select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relname = 'match_rule'`);
    expect([...rows]).toEqual([{ rls: true, forced: true }]);
  });

  it("shows a client only its own rules and refuses one for another client", async () => {
    const rows = (await asA((run) => run("select tenant_id from match_rule"))) as unknown as {
      tenant_id: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(await errorCode(add(B.tenantId, B.userId, "romco42"))).toBe("42501");
  });

  it("keeps one live rule a value, retires but never edits or deletes one", async () => {
    const [made] = await add(A.tenantId, A.userId, "romco42");
    const id = made?.id ?? "";
    expect(await errorCode(add(A.tenantId, A.userId, "romco42"))).toBe("23505");
    // Another configuration may hold the same value.
    await add(A.tenantId, A.userId, "romco42", "bank_to_ledger");
    expect(
      await errorCode(asA((run) => run(`update match_rule set b_value = 'x' where id = '${id}'`))),
    ).toBeDefined();
    expect(
      await errorCode(
        asA((run) => run(`update match_rule set retired_at = now() where id = '${id}'`)),
      ),
    ).toBe("23514");
    await asA((run) =>
      run(
        `update match_rule set retired_at = now(), retired_by = '${A.userId}' where id = '${id}'`,
      ),
    );
    // Retired, the value is free for a new rule.
    await add(A.tenantId, A.userId, "romco42");
    expect(
      await errorCode(asA((run) => run(`delete from match_rule where id = '${id}'`))),
    ).toBeDefined();
  });

  it("checks the configuration's name and the field", async () => {
    expect(await errorCode(add(A.tenantId, A.userId, "x", "Bank To Ledger"))).toBe("23514");
    expect(
      await errorCode(
        asA((run) =>
          run(`insert into match_rule (tenant_id, config, field, a_value, b_value, created_by)
               values ('${A.tenantId}', 'bank_to_ledger', 'amount', '1', '2', '${A.userId}')`),
        ),
      ),
    ).toBe("23514");
  });
});
