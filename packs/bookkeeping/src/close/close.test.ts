// docs/plan.md §1.232: the Close pack at the pack's level, as cs_worker. October's close of a
// cabinet shop: the checklist from books health's checks and the Bookkeeping area's records (one
// account reconciled, two not, an uncategorized purchase), an accrual proposed from the landlord's
// billing pattern, a recurring journal proposed by the model with its sources; each written only
// through its external action, turned down or recorded by what became of it; lines waived with a
// reason; the month signed off, after which nothing changes. November reverses the accrual and
// repeats the recurring journal. A test run keeps nothing; one client never sees another's close.

import { closeDb, createDb, type Db, externalAction, rawRecord, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackToolContext } from "../pack";
import { reconciliation } from "../schema";
import { type BooksFixture, insertBooks } from "../testing.test-helper";
import { CLOSE_REPORTS, CLOSE_REVIEW, CLOSE_REVIEWS } from "./api";
import { accrualPatterns, booksAsOf, entryTotal } from "./engine";
import { CLOSE_HANDLERS, closeManifest } from "./manifest";
import { closeEntry, closeEntryLine, closePeriod } from "./schema";
import {
  type CheckOutput,
  type CloseView,
  checkClose,
  closeView,
  JOURNAL_CREATE_TOOL,
  readyEntries,
} from "./store";

const online = await databaseAvailable();

describe("the Close pack's engine", () => {
  const bill = (id: string, vendor: string, account: string, day: string, amount: number) => ({
    entity: "Bill",
    externalId: id,
    source: `raw-${id}`,
    payload: {
      Id: id,
      TxnDate: day,
      VendorRef: { value: vendor },
      Line: [{ Amount: amount, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } }],
    },
  });
  const snapshot = {
    currency: "USD",
    records: [
      {
        entity: "Vendor",
        externalId: "900",
        source: "raw-v",
        payload: { Id: "900", DisplayName: "Landlord LLC" },
      },
      bill("1", "900", "62", "2026-07-01", 1250),
      bill("2", "900", "62", "2026-08-01", 1300),
      bill("3", "900", "62", "2026-09-01", 1250),
      // Two months only: no pattern.
      bill("4", "901", "84", "2026-08-03", 40),
      bill("5", "901", "84", "2026-09-03", 40),
      // Billed in the period already: nothing to accrue.
      bill("6", "902", "86", "2026-07-09", 10),
      bill("7", "902", "86", "2026-08-09", 10),
      bill("8", "902", "86", "2026-09-09", 10),
      bill("9", "902", "86", "2026-10-09", 10),
      // After the period: cut off.
      bill("10", "900", "62", "2026-11-01", 1250),
    ],
  };

  it("accrues a vendor billed every month before and not yet in the period, at the middle month", () => {
    const books = booksAsOf(snapshot, "2026-10-31");
    expect(books.records.some((r) => r.externalId === "10")).toBe(false);
    const patterns = accrualPatterns(books, { start: "2026-10-01", end: "2026-10-31" }, 3);
    expect(patterns).toEqual([
      {
        key: "accrual:900:62",
        vendorId: "900",
        vendorName: "Landlord LLC",
        accountId: "62",
        amount: "1250.0000",
        months: [
          { month: "2026-07", amount: "1250.0000" },
          { month: "2026-08", amount: "1300.0000" },
          { month: "2026-09", amount: "1250.0000" },
        ],
        sources: ["raw-1", "raw-2", "raw-3"],
      },
    ]);
    // Two months are enough when the client says so.
    expect(
      accrualPatterns(books, { start: "2026-10-01", end: "2026-10-31" }, 2).map((p) => p.key),
    ).toEqual(["accrual:900:62", "accrual:901:84"]);
  });

  it("balances an entry in decimal", () => {
    expect(
      entryTotal([
        { ledgerAccountId: "a", posting: "debit", amount: "0.10" },
        { ledgerAccountId: "a", posting: "debit", amount: "0.20" },
        { ledgerAccountId: "b", posting: "credit", amount: "0.30" },
      ]),
    ).toEqual({ total: "0.3000" });
    expect(
      entryTotal([
        { ledgerAccountId: "a", posting: "debit", amount: "10" },
        { ledgerAccountId: "b", posting: "credit", amount: "9.99" },
      ]),
    ).toEqual({ problem: "the debits (10.00) and credits (9.99) don't balance" });
  });

  it("is a pack of its own in the Bookkeeping area", () => {
    expect(closeManifest).toMatchObject({
      id: "close",
      area: "bookkeeping",
      extends: "bookkeeping",
    });
    expect(closeManifest.reports).toEqual(["close"]);
    expect(closeManifest.templates.map((t) => t.slug)).toEqual(["month-end-close"]);
  });
});

describe.skipIf(!online)("the Close pack (database, as cs_worker)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: BooksFixture;
  let B: BooksFixture;
  const raws: Record<string, string> = {};
  const TODAY = new Date("2026-11-05T12:00:00Z");
  const ctx = (books: BooksFixture, mode: "live" | "test" = "live"): PackToolContext => ({
    tenantId: books.tenantId,
    agentVersionId: books.agentVersionId,
    runId: null,
    mode,
    settings: {},
    db,
    llm: null,
  });
  const actor = (books: BooksFixture, mode: "live" | "test" = "live") => ({
    tenantId: books.tenantId,
    agentVersionId: books.agentVersionId,
    runId: null,
    mode,
  });
  const check = (books: BooksFixture, month?: string, mode: "live" | "test" = "live") =>
    withTenant(db, books.tenantId, (tx) =>
      checkClose(tx, actor(books, mode), { month, today: TODAY }),
    );
  const view = (books: BooksFixture, periodId: string) =>
    withTenant(
      db,
      books.tenantId,
      async (tx) => (await closeView(tx, books.tenantId, periodId)) as CloseView,
    );
  const card = CLOSE_REVIEWS[CLOSE_REVIEW];
  const report = CLOSE_REPORTS.close;
  if (!card || !report) throw new Error("the card and the report are registered");
  const decide = (books: BooksFixture, periodId: string, decision: object) =>
    card.decide(db, {
      tenantId: books.tenantId,
      userId: books.userId,
      payload: { periodId },
      decision,
      testRun: false,
    });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("it was not refused");
  };
  /** The write the template's step proposes for an entry, as the platform keeps it. */
  const proposeWrite = async (books: BooksFixture, entryId: string, input: object, key: string) => {
    const [row] = await t.db
      .insert(externalAction)
      .values({
        tenantId: books.tenantId,
        connectionId: books.qboConnectionId,
        tool: JOURNAL_CREATE_TOOL,
        input: input as Record<string, unknown>,
        idempotencyKey: `run-1:write-entry:${key}`,
      })
      .returning();
    if (!row) throw new Error(`no action for ${entryId}`);
    return row.id;
  };
  let october: CheckOutput;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertBooks(t.db, "Cabinet shop A");
    B = await insertBooks(t.db, "Cabinet shop B");
    for (const books of [A, B]) {
      await t.db.execute(sql`
        update connection set status = 'connected', last_sync_at = now()
        where id = ${books.qboConnectionId}`);
      await t.db.execute(sql`
        insert into ledger_account (tenant_id, connection_id, connector, external_id, name,
          full_name, account_type, kind, classification)
        values
          (${books.tenantId}, ${books.qboConnectionId}, 'qbo', '62', 'Rent', 'Rent', 'Expense',
            'expense', 'expense'),
          (${books.tenantId}, ${books.qboConnectionId}, 'qbo', '2100', 'Accrued Liabilities',
            'Accrued Liabilities', 'Other Current Liability', 'other_current_liability',
            'liability'),
          (${books.tenantId}, ${books.qboConnectionId}, 'qbo', '1500', 'Prepaid Insurance',
            'Prepaid Insurance', 'Other Current Asset', 'other_current_asset', 'asset')`);
    }
    const accounts = await t.db.execute<{ id: string; external_id: string }>(sql`
      select id, external_id from ledger_account where tenant_id = ${A.tenantId}`);
    for (const a of accounts) A.accounts[`qbo:${a.external_id}`] = a.id;
    const qbo = async (entity: string, id: string, payload: object) => {
      const [row] = await t.db
        .insert(rawRecord)
        .values({
          tenantId: A.tenantId,
          connectionId: A.qboConnectionId,
          connector: "qbo",
          entityType: entity,
          externalId: id,
          externalVersion: "0",
          payload: { Id: id, ...payload },
        })
        .returning();
      raws[`${entity}:${id}`] = row?.id ?? "";
    };
    await qbo("Account", "99", {
      Name: "Uncategorized Expense",
      AccountType: "Expense",
      Active: true,
    });
    await qbo("Vendor", "900", { DisplayName: "Landlord LLC", Active: true });
    for (const [id, day, amount] of [
      ["b1", "2026-07-01", 1250],
      ["b2", "2026-08-01", 1300],
      ["b3", "2026-09-01", 1250],
    ] as const) {
      await qbo("Bill", id, {
        TxnDate: day,
        TotalAmt: amount,
        Balance: 0,
        VendorRef: { value: "900", name: "Landlord LLC" },
        Line: [{ Amount: amount, AccountBasedExpenseLineDetail: { AccountRef: { value: "62" } } }],
      });
    }
    await qbo("Purchase", "p1", {
      TxnDate: "2026-10-10",
      TotalAmt: 75,
      AccountRef: { value: "35" },
      Line: [{ Amount: 75, AccountBasedExpenseLineDetail: { AccountRef: { value: "99" } } }],
    });
    // Checking signed off with us through October 31.
    await t.db.insert(reconciliation).values({
      tenantId: A.tenantId,
      pairKey: `bank:x|qbo:${A.qboConnectionId}:35`,
      aLabel: "Checking",
      bLabel: "QuickBooks",
      periodStart: "2026-10-01",
      asOf: "2026-10-31",
      aClosing: "1000.0000",
      bClosing: "1000.0000",
      difference: "0.0000",
      residual: "0.0000",
      outcome: "explained",
      status: "signed_off",
      signedOffBy: A.userId,
      signedOffAt: new Date(),
    });
  });
  afterAll(async () => {
    await closeDb(db);
    await t?.drop();
  });

  it("checks last month: the checklist with its numbers and an accrual from the billing pattern", async () => {
    october = await check(A);
    expect(october).toMatchObject({
      month: "2026-10",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      status: "open",
      added: 1,
      proposed: 1,
      readyToSignOff: false,
    });
    const byKey = Object.fromEntries(october.items.map((i) => [i.key, i]));
    expect(byKey[`reconciliation:${A.accounts.Checking}`]).toMatchObject({
      status: "done",
      summary: "Checking is reconciled through Oct 31.",
    });
    expect(byKey[`reconciliation:${A.accounts.Savings}`]).toMatchObject({
      status: "open",
      summary: "Savings isn't reconciled through Oct 31 yet.",
    });
    expect(byKey[`reconciliation:${A.accounts.Amex}`]?.status).toBe("open");
    expect(byKey.uncategorized?.status).toBe("open");
    expect(byKey.duplicate_bills?.status).toBe("done");
    expect(byKey.duplicate_vendors?.status).toBe("done");
    expect(byKey.unbooked?.status).toBe("done");
    expect(byKey.entries).toMatchObject({ status: "open" });
    expect(october.summary).toBe("October 2026: 4 of 8 lines still open.");

    const v = await view(A, october.periodId);
    const uncategorized = v.items.find((i) => i.key === "uncategorized");
    expect(uncategorized).toMatchObject({ amount: "75.0000", count: 1 });
    // Evidence: the purchase's raw record (invariant 10).
    expect(uncategorized?.sources).toContain(raws["Purchase:p1"]);
    const [accrual] = v.entries;
    expect(accrual).toMatchObject({
      kind: "accrual",
      status: "proposed",
      txnDate: "2026-10-31",
      reverseOn: "2026-11-01",
      amount: "1250.0000",
      memo: "Accrued Landlord LLC, October 2026",
      lines: [
        { accountName: "Rent", posting: "debit", amount: "1250.0000" },
        { accountName: "Accrued Liabilities", posting: "credit", amount: "1250.0000" },
      ],
    });
    expect(accrual?.reason).toBe(
      "Landlord LLC billed Rent every month before ($1,250.00, $1,300.00, $1,250.00) and hasn't billed October 2026 yet.",
    );
    expect([...(accrual?.sources ?? [])].sort()).toEqual(
      [raws["Bill:b1"], raws["Bill:b2"], raws["Bill:b3"]].sort(),
    );
  });

  it("never proposes the same entry twice", async () => {
    const again = await check(A);
    expect(again).toMatchObject({ periodId: october.periodId, added: 0, proposed: 1 });
  });

  it("refuses a model's entry without sources or out of balance, and keeps one with them", async () => {
    const propose = CLOSE_HANDLERS["close.entry.propose"];
    if (!propose) throw new Error("no propose tool");
    const base = {
      periodId: october.periodId,
      kind: "recurring",
      key: "recurring:insurance",
      txnDate: "2026-10-31",
      memo: "Insurance, October",
      reason: "The policy's yearly premium, a twelfth each month.",
      lines: [
        { ledgerAccountId: A.accounts["qbo:62"], posting: "debit", amount: "200.00" },
        { ledgerAccountId: A.accounts["qbo:1500"], posting: "credit", amount: "200.00" },
      ],
    };
    expect(await refusal(propose.run({ ...base, sources: [] }, ctx(A)))).toContain("sources");
    expect(
      await refusal(
        propose.run(
          {
            ...base,
            sources: [raws["Vendor:900"]],
            lines: [base.lines[0], { ...base.lines[1], amount: "150.00" }],
          },
          ctx(A),
        ),
      ),
    ).toContain("don't balance");
    // Another client's account isn't one of this company's.
    expect(
      await refusal(
        propose.run(
          {
            ...base,
            sources: [raws["Vendor:900"]],
            lines: [{ ...base.lines[0], ledgerAccountId: B.accounts.Fuel }, base.lines[1]],
          },
          ctx(A),
        ),
      ),
    ).toContain("active accounts");
    const kept = (await propose.run({ ...base, sources: [raws["Vendor:900"]] }, ctx(A))) as {
      entryId: string;
      proposed: boolean;
    };
    expect(kept.proposed).toBe(true);
  });

  it("lays out each entry as its QuickBooks journal entry, once, and records what became of it", async () => {
    const ready = await withTenant(db, A.tenantId, (tx) =>
      readyEntries(tx, A.tenantId, october.periodId),
    );
    expect(ready).toHaveLength(2);
    const accrual = ready.find((e) => e.kind === "accrual");
    const recurring = ready.find((e) => e.kind === "recurring");
    if (!accrual || !recurring) throw new Error("both entries are ready");
    expect(accrual.journal).toEqual({
      txnDate: "2026-10-31",
      currency: "USD",
      expectedTotal: "1250.00",
      privateNote: "Accrued Landlord LLC, October 2026",
      reference: `ce-${accrual.entryId}`,
      lines: [
        { accountId: "62", posting: "debit", amount: "1250.00", description: "Landlord LLC" },
        { accountId: "2100", posting: "credit", amount: "1250.00", description: "Landlord LLC" },
      ],
    });
    // The accrual's write waits for a signature: not laid out again, not turned down here.
    const actionId = await proposeWrite(A, accrual.entryId, accrual.journal, "1");
    const after = await withTenant(db, A.tenantId, (tx) =>
      readyEntries(tx, A.tenantId, october.periodId),
    );
    expect(after.map((e) => e.entryId)).toEqual([recurring.entryId]);
    expect(
      (await view(A, october.periodId)).entries.find((e) => e.id === accrual.entryId)?.write,
    ).toBe("proposed");
    expect(
      await refusal(
        decide(A, october.periodId, { action: "reject", input: { entryId: accrual.entryId } }),
      ),
    ).toContain("waiting for a signature");
    // Signed and made: recorded as posted with its journal's id on the next check.
    await t.db
      .update(externalAction)
      .set({ status: "done", result: { id: "J-501", total: "1250.0000" } })
      .where(eq(externalAction.id, actionId));
    // The recurring one's write is turned down at its signature (the loop goes on).
    const turnedDown = await proposeWrite(A, recurring.entryId, recurring.journal, "2");
    await t.db
      .update(externalAction)
      .set({ status: "rejected" })
      .where(eq(externalAction.id, turnedDown));
    october = await check(A);
    const v = await view(A, october.periodId);
    expect(v.entries.find((e) => e.id === accrual.entryId)).toMatchObject({
      status: "posted",
      qboId: "J-501",
    });
    expect(v.entries.find((e) => e.id === recurring.entryId)?.status).toBe("rejected");
    expect(v.items.find((i) => i.key === "entries")).toMatchObject({
      status: "done",
      summary: "1 journal entries recorded in the accounting system.",
    });
  });

  it("signs off only once every line is done or waived, with a reason", async () => {
    expect(await refusal(decide(A, october.periodId, { action: "sign_off", input: {} }))).toContain(
      "3 checklist lines are still open",
    );
    const open = (await view(A, october.periodId)).items.filter((i) => i.status === "open");
    expect(
      await refusal(
        decide(A, october.periodId, { action: "waive", input: { itemId: open[0]?.id, note: " " } }),
      ),
    ).toBeTruthy();
    for (const i of open) {
      await decide(A, october.periodId, {
        action: "waive",
        input: { itemId: i.id, note: "Reconciled in QuickBooks by the client's accountant" },
      });
    }
    // A waiver stands when the month is checked again.
    october = await check(A);
    expect(october.readyToSignOff).toBe(true);
    expect(october.items.filter((i) => i.status === "waived")).toHaveLength(3);
    await decide(A, october.periodId, { action: "sign_off", input: { note: "October closed" } });
    const v = await view(A, october.periodId);
    expect(v.period).toMatchObject({ status: "signed_off", note: "October closed" });
    expect(v.period.signedOffBy).toBe("Owner 1");
  });

  it("never changes a signed-off month", async () => {
    const again = await check(A, "2026-10");
    expect(again).toMatchObject({ status: "signed_off", added: 0 });
    expect(
      await refusal(
        decide(A, october.periodId, { action: "unwaive", input: { itemId: again.items[1]?.key } }),
      ),
    ).toBeTruthy();
    const waived = (await view(A, october.periodId)).items.find((i) => i.status === "waived");
    expect(
      await refusal(
        decide(A, october.periodId, { action: "unwaive", input: { itemId: waived?.id } }),
      ),
    ).toContain("signed off");
  });

  it("reverses last month's accrual in November, its sides swapped", async () => {
    const november = await check(A, "2026-11");
    const v = await view(A, november.periodId);
    const reversal = v.entries.find((e) => e.kind === "reversal");
    expect(reversal).toMatchObject({
      status: "proposed",
      txnDate: "2026-11-01",
      amount: "1250.0000",
      memo: "Reversal: Accrued Landlord LLC, October 2026",
      lines: [
        { accountName: "Rent", posting: "credit", amount: "1250.0000" },
        { accountName: "Accrued Liabilities", posting: "debit", amount: "1250.0000" },
      ],
    });
    // The recurring journal was turned down in October, so it isn't repeated.
    expect(v.entries.some((e) => e.kind === "recurring")).toBe(false);
    // No accrual: the landlord didn't bill October.
    expect(v.entries.some((e) => e.kind === "accrual")).toBe(false);
  });

  it("keeps nothing on a test run", async () => {
    const before = await t.db
      .select()
      .from(closePeriod)
      .where(eq(closePeriod.tenantId, A.tenantId));
    const tried = await check(A, "2026-12", "test");
    expect(tried).toMatchObject({ month: "2026-12", status: "open" });
    const afterRows = await t.db
      .select()
      .from(closePeriod)
      .where(eq(closePeriod.tenantId, A.tenantId));
    expect(afterRows).toHaveLength(before.length);
    const lines = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(closeEntryLine)
      .where(eq(closeEntryLine.tenantId, A.tenantId));
    const entries = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(closeEntry)
      .where(and(eq(closeEntry.tenantId, A.tenantId)));
    expect(lines[0]?.n).toBeGreaterThan(0);
    expect(entries[0]?.n).toBe(3);
  });

  it("shows one client only its own close, on the card and in the report", async () => {
    const mine = await withTenant(db, A.tenantId, (tx) =>
      report.json(tx, A.tenantId, "2026-11-05", {}),
    );
    expect((mine.periods as unknown[]).length).toBe(2);
    expect((mine.close as CloseView).period.periodStart).toBe("2026-11-01");
    const picked = await withTenant(db, A.tenantId, (tx) =>
      report.json(tx, A.tenantId, "2026-11-05", { periodId: october.periodId }),
    );
    expect((picked.close as CloseView).period.status).toBe("signed_off");
    const theirs = await withTenant(db, B.tenantId, (tx) =>
      report.json(tx, B.tenantId, "2026-11-05", { periodId: october.periodId }),
    );
    expect(theirs).toEqual({ periods: [], close: null });
    const loaded = await withTenant(db, B.tenantId, (tx) =>
      card.load(tx, B.tenantId, { periodId: october.periodId }),
    );
    expect(loaded).toEqual({ close: null });
    expect(await refusal(decide(B, october.periodId, { action: "sign_off", input: {} }))).toContain(
      "isn't this client's",
    );
    const csv = await withTenant(db, A.tenantId, (tx) =>
      report.csv(tx, A.tenantId, "2026-11-05", { periodId: october.periodId }),
    );
    expect(csv.split("\n")[0]).toBe("period_end,line,status,amount,count,summary,note");
    expect(csv).toContain("Accrued Landlord LLC");
    // Nothing on the report names an agent, a prompt or a cost.
    expect(JSON.stringify(picked)).not.toMatch(/agentVersion|instructions|prompt|cost/i);
  });
});
