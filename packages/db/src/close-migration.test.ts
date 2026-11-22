// Migration 0090 (docs/plan.md §1.232, the Close pack): `close_period`, `close_item`,
// `close_entry` and `close_entry_line`. The Worker's role sees and writes only its own client's
// rows, never deletes one, changes only the columns each table lets change, and nothing about a
// signed-off close changes or is added to it.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const TABLES = ["close_period", "close_item", "close_entry", "close_entry_line"];

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("0090: the Close pack", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let accountA = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    const [row] = await t.db.$client<{ id: string }[]>`
      insert into ledger_account (tenant_id, connection_id, connector, external_id, name, full_name,
        classification, kind, account_type, active)
      values (${A.tenantId}, ${A.connectionId}, 'qbo', 'close-1', 'Accrued liabilities',
        'Accrued liabilities', 'liability', 'other_current_liability', 'Other Current Liability', true)
      returning id`;
    accountA = row?.id ?? "";
  });
  afterAll(async () => {
    await t?.drop();
  });

  const as = <T>(client: ClientFixture, q: string) =>
    withTenant(t.db, client.tenantId, async (tx) => {
      await asWorker(tx);
      return [...((await tx.execute(sql.raw(q))) as unknown as T[])];
    });

  const period = async (client: ClientFixture, start: string, end: string) => {
    const [row] = await as<{ id: string }>(
      client,
      `insert into close_period (tenant_id, connection_id, period_start, period_end)
       values ('${client.tenantId}', '${client.connectionId}', '${start}', '${end}') returning id`,
    );
    return row?.id ?? "";
  };

  const entry = (client: ClientFixture, periodId: string, key: string, extra = "") =>
    as<{ id: string }>(
      client,
      `insert into close_entry (tenant_id, period_id, kind, entry_key, proposed_by, txn_date, amount,
         memo, agent_version_id${extra ? ", sources" : ""})
       values ('${client.tenantId}', '${periodId}', 'accrual', '${key}', '${extra || "pattern"}',
         '2026-10-31', '1250.0000', 'Accrued rent, October', '${client.agentVersionId}'
         ${extra ? `, '["${client.rawRecordId}"]'::jsonb` : ""})
       returning id`,
    );

  it("forces row-level security and marks each table the Close pack's", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; owner: string }[]
    >`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced,
        obj_description(oid, 'pg_class') as owner
      from pg_class where relname = any(${TABLES}) order by relname`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows)
      expect(r, r.relname).toMatchObject({ rls: true, forced: true, owner: "pack:close" });
  });

  it("shows a client only its own close and refuses a row for another client", async () => {
    const mine = await period(A, "2026-10-01", "2026-10-31");
    expect(mine).not.toBe("");
    await period(B, "2026-10-01", "2026-10-31");
    const seen = await as<{ tenant_id: string }>(A, "select tenant_id from close_period");
    expect(new Set(seen.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(
      await errorCode(
        as(
          A,
          `insert into close_period (tenant_id, connection_id, period_start, period_end)
           values ('${B.tenantId}', '${B.connectionId}', '2026-09-01', '2026-09-30')`,
        ),
      ),
    ).toBe("42501");
    // One close per company and month.
    expect(await errorCode(period(A, "2026-10-01", "2026-10-31"))).toBe("23505");
  });

  it("keeps money as numeric(14,4) and one live entry per key", async () => {
    const periodId = await period(A, "2026-08-01", "2026-08-31");
    const [made] = await entry(A, periodId, "accrual:rent");
    const id = made?.id ?? "";
    expect(await errorCode(entry(A, periodId, "accrual:rent"))).toBe("23505");
    const [amount] = await as<{ amount: string }>(
      A,
      `select amount from close_entry where id = '${id}'`,
    );
    expect(amount?.amount).toBe("1250.0000");
    // Turned down, the key is free for a new proposal.
    await as(
      A,
      `update close_entry set status = 'rejected', decided_at = now() where id = '${id}'`,
    );
    await entry(A, periodId, "accrual:rent");
    // A model's proposal carries its sources.
    expect(await errorCode(entry(A, periodId, "accrual:model", "model"))).toBeUndefined();
    expect(
      await errorCode(
        as(
          A,
          `insert into close_entry (tenant_id, period_id, kind, entry_key, proposed_by, txn_date,
             amount, memo, agent_version_id)
           values ('${A.tenantId}', '${periodId}', 'accrual', 'x', 'model', '2026-08-31', '1', 'x',
             '${A.agentVersionId}')`,
        ),
      ),
    ).toBe("23514");
    // Posted means the accounting tool's id is kept.
    expect(
      await errorCode(as(A, `update close_entry set status = 'posted' where id = '${id}'`)),
    ).toBe("23514");
  });

  it("changes only status columns, and never deletes", async () => {
    const periodId = await period(A, "2026-07-01", "2026-07-31");
    const [made] = await entry(A, periodId, "accrual:utilities");
    const id = made?.id ?? "";
    expect(
      await errorCode(as(A, `update close_entry set amount = '1.0000' where id = '${id}'`)),
    ).toBe("23001");
    expect(await errorCode(as(A, `delete from close_entry where id = '${id}'`))).toBeDefined();
    await as(
      A,
      `insert into close_entry_line (tenant_id, entry_id, line_no, ledger_account_id, posting, amount)
       values ('${A.tenantId}', '${id}', 1, '${accountA}', 'credit', '1250.0000')`,
    );
    expect(
      await errorCode(as(A, `update close_entry_line set amount = '2' where entry_id = '${id}'`)),
    ).toBeDefined();
    expect(
      await errorCode(
        as(A, `update close_period set period_end = '2026-07-30' where id = '${periodId}'`),
      ),
    ).toBe("23001");
    // A line is waived only by a person, with a note.
    await as(
      A,
      `insert into close_item (tenant_id, period_id, key, kind, title)
       values ('${A.tenantId}', '${periodId}', 'uncategorized', 'uncategorized', 'Uncategorized')`,
    );
    expect(
      await errorCode(
        as(A, `update close_item set status = 'waived' where period_id = '${periodId}'`),
      ),
    ).toBe("23514");
    await as(
      A,
      `update close_item set status = 'waived', waived_by = '${A.userId}', note = 'Owner draws'
       where period_id = '${periodId}'`,
    );
  });

  it("never changes a signed-off close, nor adds to it", async () => {
    const periodId = await period(A, "2026-06-01", "2026-06-30");
    const [made] = await entry(A, periodId, "accrual:insurance");
    await as(
      A,
      `insert into close_item (tenant_id, period_id, key, kind, title, status)
       values ('${A.tenantId}', '${periodId}', 'entries', 'entries', 'Entries', 'done')`,
    );
    expect(
      await errorCode(
        as(A, `update close_period set status = 'signed_off' where id = '${periodId}'`),
      ),
    ).toBe("23514");
    await as(
      A,
      `update close_period set status = 'signed_off', signed_off_by = '${A.userId}',
         signed_off_at = now(), note = 'Closed' where id = '${periodId}'`,
    );
    expect(
      await errorCode(as(A, `update close_period set note = 'again' where id = '${periodId}'`)),
    ).toBe("23001");
    expect(
      await errorCode(
        as(A, `update close_entry set status = 'rejected' where id = '${made?.id ?? ""}'`),
      ),
    ).toBe("23001");
    expect(
      await errorCode(as(A, `update close_item set count = 3 where period_id = '${periodId}'`)),
    ).toBe("23001");
    expect(await errorCode(entry(A, periodId, "accrual:late"))).toBe("23001");
  });
});
