// Migration 0096 (Plan entry §1.233): the AP pack's `ap_bill`, `ap_bill_line` and `ap_receipt`.
// New tables only, so it applies on a database the previous Worker used; each forces row-level
// security as the pack's; the Worker's role reads and writes only its own client's rows, never
// deletes one, and never changes a receipt; the checks hold a decision to who and when, a line's
// account to who coded it, and a model's suggestion apart. The pack's tables aren't in this
// package's schema (the platform never imports a pack), so this test speaks SQL.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();
const TABLES = ["ap_bill", "ap_bill_line", "ap_receipt"] as const;

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

interface Seeded {
  transactionId: string;
  requestId: string;
  requestLineId: string;
  accountId: string;
}

describe.skipIf(!online)("0096 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let a: Seeded;
  let b: Seeded;

  async function seed(c: ClientFixture): Promise<Seeded> {
    const q = t.db.$client;
    const [txn] = await q<{ id: string }[]>`
      insert into transaction (tenant_id, kind, connector, external_id, txn_date, total, currency,
        status)
      values (${c.tenantId}, 'bill', 'document', ${c.documentId}, '2026-11-02', '1180.0000', 'USD',
        'extracted')
      returning id`;
    const [req] = await q<{ id: string }[]>`
      insert into purchase_request (tenant_id, channel, status) values (${c.tenantId}, 'portal',
        'ordered') returning id`;
    const [line] = await q<{ id: string }[]>`
      insert into purchase_request_line (tenant_id, purchase_request_id, line_no, description, qty)
      values (${c.tenantId}, ${req?.id ?? ""}, 1, 'Baltic birch 3/4', '10') returning id`;
    const [acct] = await q<{ id: string }[]>`
      insert into ledger_account (tenant_id, connection_id, connector, external_id, name,
        full_name, kind, account_type)
      values (${c.tenantId}, ${c.connectionId}, 'qbo', '80', 'Materials', 'Materials', 'expense',
        'Cost of Goods Sold')
      returning id`;
    return {
      transactionId: txn?.id ?? "",
      requestId: req?.id ?? "",
      requestLineId: line?.id ?? "",
      accountId: acct?.id ?? "",
    };
  }

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0095_metered_usage" });
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    a = await seed(A);
    b = await seed(B);
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const asClient = (c: ClientFixture, statement: string) =>
    withTenant(t.db, c.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.execute(statement);
    });

  const bill = (c: ClientFixture, s: Seeded) =>
    asClient(
      c,
      `insert into ap_bill (tenant_id, transaction_id, amount)
       values ('${c.tenantId}', '${s.transactionId}', '1180') returning id`,
    );

  it("adds three tables with forced row-level security, as the AP pack's", async () => {
    for (const table of TABLES) {
      const [row] = await t.db.$client<
        { rls: boolean; forced: boolean; owner: string; policies: number }[]
      >`
        select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
          obj_description(c.oid, 'pg_class') as owner,
          (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c where c.relname = ${table}`;
      expect(row, table).toEqual({ rls: true, forced: true, owner: "pack:ap", policies: 1 });
    }
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of ["ap_bill", "ap_bill_line"]) {
      expect(await can(table, "UPDATE"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
    }
    expect(await can("ap_receipt", "INSERT")).toBe(true);
    expect(await can("ap_receipt", "UPDATE")).toBe(false);
    expect(await can("ap_receipt", "DELETE")).toBe(false);
  });

  it("keeps one bill per purchase, and a client's rows to that client", async () => {
    expect(await errorCode(bill(A, a))).toBeUndefined();
    expect(await errorCode(bill(A, a))).toBe("23505");
    // B can't point a bill at A's purchase (the composite key), nor see A's.
    expect(await errorCode(bill(B, a))).toBe("23503");
    const seen = await asClient(B, "select count(*)::int as n from ap_bill");
    expect((seen as unknown as { n: number }[])[0]?.n ?? 0).toBe(0);
    // Nor write a row in A's name.
    expect(
      await errorCode(
        asClient(
          B,
          `insert into ap_bill (tenant_id, transaction_id, amount)
           values ('${A.tenantId}', '${b.transactionId}', '1')`,
        ),
      ),
    ).toBe("42501");
  });

  it("holds a decision to its week, who and when", async () => {
    const [row] = await t.db.$client<{ id: string }[]>`
      select id from ap_bill where tenant_id = ${A.tenantId}`;
    const set = (sql: string) => asClient(A, `update ap_bill set ${sql} where id = '${row?.id}'`);
    // Approved with no one deciding, or off any list: refused.
    expect(await errorCode(set("status = 'approved'"))).toBe("23514");
    expect(
      await errorCode(
        set(`status = 'approved', decided_by = '${A.userId}', decided_at = now(), pay_week = null`),
      ),
    ).toBe("23514");
    // A week starts on a Monday.
    expect(await errorCode(set("pay_week = '2026-11-25'"))).toBe("23514");
    expect(
      await errorCode(
        set(
          `status = 'approved', decided_by = '${A.userId}', decided_at = now(), pay_week = '2026-11-23'`,
        ),
      ),
    ).toBeUndefined();
    // An order is named only with a match that found one.
    expect(await errorCode(set(`purchase_request_id = '${a.requestId}'`))).toBe("23514");
    expect(
      await errorCode(set(`purchase_request_id = '${a.requestId}', match_status = 'matched'`)),
    ).toBeUndefined();
    expect(await errorCode(asClient(A, `delete from ap_bill where id = '${row?.id}'`))).toBe(
      "42501",
    );
  });

  it("codes a line only with who coded it, and keeps a model's suggestion apart", async () => {
    const [row] = await t.db.$client<{ id: string }[]>`
      select id from ap_bill where tenant_id = ${A.tenantId}`;
    const line = (cols: string, values: string) =>
      asClient(
        A,
        `insert into ap_bill_line (tenant_id, ap_bill_id, line_no, amount${cols})
         values ('${A.tenantId}', '${row?.id}', ${Math.floor(Math.random() * 1e6) + 1}, '10'${values})`,
      );
    expect(await errorCode(line("", ""))).toBeUndefined();
    expect(
      await errorCode(line(", ledger_account_id, coded_by", `, '${a.accountId}', 'history'`)),
    ).toBeUndefined();
    // An account with nobody saying who: refused; a person without their name: refused.
    expect(await errorCode(line(", ledger_account_id", `, '${a.accountId}'`))).toBe("23514");
    expect(
      await errorCode(line(", ledger_account_id, coded_by", `, '${a.accountId}', 'person'`)),
    ).toBe("23514");
    expect(
      await errorCode(
        line(
          ", ledger_account_id, coded_by, coded_by_user_id",
          `, '${a.accountId}', 'person', '${A.userId}'`,
        ),
      ),
    ).toBeUndefined();
    // A model never codes a line: there is no such coder, and a suggestion names its agent.
    expect(
      await errorCode(line(", ledger_account_id, coded_by", `, '${a.accountId}', 'model'`)),
    ).toBe("23514");
    expect(await errorCode(line(", proposed_ledger_account_id", `, '${a.accountId}'`))).toBe(
      "23514",
    );
    expect(
      await errorCode(
        line(
          ", proposed_ledger_account_id, proposal_agent_version_id, proposal_reason",
          `, '${a.accountId}', '${A.agentVersionId}', 'Lumber goes to Materials'`,
        ),
      ),
    ).toBeUndefined();
    // Another client's account: refused.
    expect(
      await errorCode(line(", ledger_account_id, coded_by", `, '${b.accountId}', 'history'`)),
    ).toBe("23503");
  });

  it("keeps receipts as a log, by a person or an agent", async () => {
    const add = (cols: string, values: string) =>
      asClient(
        A,
        `insert into ap_receipt (tenant_id, purchase_request_id, received_on${cols})
         values ('${A.tenantId}', '${a.requestId}', '2026-11-03'${values}) returning id`,
      );
    expect(await errorCode(add(", recorded_by_user_id", `, '${A.userId}'`))).toBeUndefined();
    expect(
      await errorCode(
        add(
          ", purchase_request_line_id, qty, agent_version_id",
          `, '${a.requestLineId}', '6', '${A.agentVersionId}'`,
        ),
      ),
    ).toBeUndefined();
    // Nobody recording it, a line without a quantity, or zero: refused.
    expect(await errorCode(add("", ""))).toBe("23514");
    expect(
      await errorCode(
        add(
          ", purchase_request_line_id, recorded_by_user_id",
          `, '${a.requestLineId}', '${A.userId}'`,
        ),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        add(
          ", purchase_request_line_id, qty, recorded_by_user_id",
          `, '${a.requestLineId}', '0', '${A.userId}'`,
        ),
      ),
    ).toBe("23514");
    // Never changed, as the owner either.
    expect(
      await errorCode(
        t.db.$client`update ap_receipt set note = 'x' where tenant_id = ${A.tenantId}`,
      ),
    ).toBeDefined();
    expect(
      await errorCode(t.db.$client`delete from ap_receipt where tenant_id = ${A.tenantId}`),
    ).toBeDefined();
  });
});
