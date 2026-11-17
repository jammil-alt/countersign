// Settling at scale and over time (docs/plan.md §1.79), as cs_worker, each case on its own client:
// skipped history never holds new transactions back; a second identical charge is never matched
// to the Bookkeeper's own earlier write; a transfer whose sides arrive on different days is booked
// once; a bill or invoice payment goes to a person rather than becoming a second expense or
// income; a wrong transfer pairing, once undone, frees the other side; generic bank words make no
// rule.

import { closeDb, createDb, type Db, type Tx, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKINGS_REVIEW, BOOKKEEPING_ACTIONS, BOOKKEEPING_REVIEWS } from "./api";
import { addRule, bookByPerson, propose, settle } from "./bookings";
import { importFeeds } from "./feed";
import { BOOKKEEPING_HANDLERS } from "./manifest";
import type { PackToolContext } from "./pack";
import { isGenericPayeeKey, payeeKey } from "./payee";
import { bankAccountLink, bankTxn, booking, bookingRule } from "./schema";
import { AMEX, type BooksFixture, CHECKING, insertBooks } from "./testing.test-helper";

const online = await databaseAvailable();

const SAVINGS = { id: "acc-savings", name: "Savings", mask: "0002", type: "depository" };

describe("generic payee keys", () => {
  it("are the bank's words for how money moved, with no one named", () => {
    expect(payeeKey("CHECK 1041")).toBe("check");
    expect(payeeKey("CHECK 1042")).toBe("check");
    expect(isGenericPayeeKey(payeeKey("CHECK 1041"))).toBe(true);
    expect(isGenericPayeeKey(payeeKey("MOBILE DEPOSIT"))).toBe(true);
    expect(isGenericPayeeKey(payeeKey("WIRE TRANSFER OUT"))).toBe(true);
    expect(isGenericPayeeKey(payeeKey("ATM WITHDRAWAL 0042"))).toBe(true);
    expect(isGenericPayeeKey(payeeKey("ZELLE PAYMENT"))).toBe(true);
    expect(isGenericPayeeKey("")).toBe(true);
    expect(isGenericPayeeKey(payeeKey("ZELLE TO JOHN SMITH"))).toBe(false);
    expect(isGenericPayeeKey(payeeKey("SQ *BLUE BOTTLE 1234"))).toBe(false);
    expect(isGenericPayeeKey(payeeKey("ACH PMT ADOBE INC"))).toBe(false);
  });
});

describe.skipIf(!online)("settling (database, as cs_worker)", () => {
  let t: TestDatabase;
  let db: Db;
  let n = 0;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  /** A client of its own, its feed's accounts read and linked. */
  async function books(
    links: {
      account: { id: string };
      ledger: string;
      mode?: "book" | "suggest";
      bookFrom?: string;
    }[],
    feed: Parameters<BooksFixture["feed"]>[0][],
  ) {
    const A = await insertBooks(t.db, `Shop ${++n}`);
    // Each linked account needs a transaction on the feed to be seen.
    for (const f of feed) await A.feed(f);
    // Savings in the chart of accounts is "Savings".
    await withTenant(db, A.tenantId, (tx) => importFeeds(tx, A.tenantId));
    for (const l of links) {
      const link = await linkOf(A, l.account.id);
      await action(A, "link-account", {
        linkId: link.id,
        ledgerAccountId: A.accounts[l.ledger],
        mode: l.mode ?? "book",
        ...(l.bookFrom ? { bookFrom: l.bookFrom } : {}),
      });
    }
    const who = { tenantId: A.tenantId, agentVersionId: A.agentVersionId, runId: null };
    const person = { tenantId: A.tenantId, userId: A.userId };
    const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, A.tenantId, fn);
    const txn = async (externalId: string) => {
      const [row] = await t.db
        .select()
        .from(bankTxn)
        .where(and(eq(bankTxn.tenantId, A.tenantId), eq(bankTxn.externalId, externalId)));
      if (!row) throw new Error(`no bank_txn ${externalId}`);
      return row;
    };
    const liveOf = async (externalId: string) => {
      const id = (await txn(externalId)).id;
      const rows = await t.db.select().from(booking).where(eq(booking.bankTxnId, id));
      return rows.find((b) => ["proposed", "approved", "posted"].includes(b.status)) ?? null;
    };
    const ctx = (): PackToolContext => ({
      tenantId: A.tenantId,
      agentVersionId: A.agentVersionId,
      runId: null,
      mode: "live",
      settings: {},
      db,
      llm: null,
    });
    const posted = (bookingId: string, entity: string, qboId: string | null) =>
      tool("bookkeeping.booking.posted").run({ bookingId, entity, qboId }, ctx());
    const more = async (...f: Parameters<BooksFixture["feed"]>[0][]) => {
      for (const x of f) await A.feed(x);
      await inA((tx) => importFeeds(tx, A.tenantId));
    };
    return { A, who, person, inA, txn, liveOf, posted, more };
  }
  async function linkOf(A: BooksFixture, externalAccountId: string) {
    const [row] = await t.db
      .select()
      .from(bankAccountLink)
      .where(
        and(
          eq(bankAccountLink.tenantId, A.tenantId),
          eq(bankAccountLink.externalAccountId, externalAccountId),
        ),
      );
    if (!row) throw new Error(`no link ${externalAccountId}`);
    return row;
  }
  function action(A: BooksFixture, name: string, input: unknown) {
    const handler = BOOKKEEPING_ACTIONS[name];
    if (!handler) throw new Error(name);
    return handler.run(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      input: handler.input.parse(input),
    });
  }
  function tool(id: string) {
    const h = BOOKKEEPING_HANDLERS[id];
    if (!h) throw new Error(id);
    return h;
  }

  it("reaches new transactions however many skipped ones came before them", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking", bookFrom: "2026-11-01" }],
      [1, 2, 3, 4, 5].map((i) => ({
        id: `new-${i}`,
        amount: `${10 + i}.00`,
        date: `2026-11-1${i}`,
        merchantName: `Shop number ${"abcde"[i - 1]}`,
      })),
    );
    // The feed's 90 days of history, before the day booking starts: skipped, and stays so.
    const link = await linkOf(b.A, CHECKING.id);
    const raw = (await b.txn("new-1")).rawRecordId;
    await t.db.execute(sql`
      insert into bank_txn (tenant_id, connection_id, account_link_id, external_id, raw_record_id,
        txn_date, amount, currency, direction, payee, payee_key, status)
      select ${b.A.tenantId}, ${b.A.feedConnectionId}, ${link.id}, 'old-' || g, ${raw},
        date '2026-08-01' + (g % 90), 12.5, 'USD', 'out', 'Old charge', 'old charge', 'skipped'
      from generate_series(1, 600) g`);
    const r = await b.inA((tx) => settle(tx, b.who));
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async (i) => (await b.txn(`new-${i}`)).id));
    expect(r.open.sort()).toEqual(ids.sort());
    expect(r.checked).toBe(5);
    // A skipped one becomes bookable once booking starts earlier.
    await action(b.A, "link-account", {
      linkId: link.id,
      ledgerAccountId: b.A.accounts.Checking,
      mode: "book",
      bookFrom: "2026-10-30",
    });
    await t.db.execute(sql`
      update bank_txn set txn_date = '2026-10-31' where tenant_id = ${b.A.tenantId} and external_id = 'old-1'`);
    const again = await b.inA((tx) => settle(tx, b.who));
    expect(again.open).toEqual([(await b.txn("old-1")).id, ...ids]);
    expect(again.checked).toBe(6);
  });

  it("never matches a charge to the Bookkeeper's own earlier write of the same amount", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [
        { id: "s-1", amount: "9.99", date: "2026-11-03", merchantName: "Spotify" },
        { id: "p-1", amount: "5.00", date: "2026-11-03", merchantName: "City parking" },
      ],
    );
    expect((await b.inA((tx) => settle(tx, b.who))).open).toHaveLength(2);
    for (const [ext, qboId] of [
      ["s-1", "601"],
      ["p-1", "602"],
    ] as const) {
      const { bookingId } = await b.inA(async (tx) =>
        propose(tx, b.who, {
          bankTxnId: (await b.txn(ext)).id,
          lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
          confidence: 0.95,
          reason: "a subscription",
        }),
      );
      await b.posted(bookingId, "purchase", qboId);
    }
    // Synced back from QuickBooks: one with the booking's mark in its memo, one without.
    const s1 = await b.liveOf("s-1");
    await b.A.qboPurchase({
      id: "601",
      total: "9.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Spotify [Mezonas bk-${s1?.id}]`,
    });
    await b.A.qboPurchase({ id: "602", total: "5.0000", date: "2026-11-03", accountQboId: "35" });
    // The next month's charge and the next day's parking: the same amounts, a day later.
    await b.more(
      { id: "s-2", amount: "9.99", date: "2026-11-04", merchantName: "Spotify" },
      { id: "p-2", amount: "5.00", date: "2026-11-04", merchantName: "City parking" },
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.matched).toBe(0);
    expect(r.open.sort()).toEqual([(await b.txn("s-2")).id, (await b.txn("p-2")).id].sort());
    // The bank drops the posted charge and sends it again under a new id: that is the same money,
    // matched to the record already written for it.
    await b.A.feedRemoved("s-1");
    await b.more({ id: "s-1b", amount: "9.99", date: "2026-11-03", merchantName: "Spotify" });
    expect((await b.txn("s-1")).ext).toMatchObject({ removedAfterPosting: true });
    expect(await b.inA((tx) => settle(tx, b.who))).toMatchObject({ matched: 1 });
    expect(await b.liveOf("s-1b")).toMatchObject({ kind: "match", qboId: "601" });
    expect((await b.txn("s-2")).status).toBe("new");
  });

  it("books a transfer once when its other side arrives after the first was booked", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "x-out", amount: "2000.00", date: "2026-11-03", description: "AMEX EPAYMENT" },
        { id: "c-0", account: AMEX, amount: "12.00", date: "2026-11-01", merchantName: "Shell" },
      ],
    );
    // The card side is still pending: nothing to pair with; the model proposes a transfer.
    const first = await b.inA((tx) => settle(tx, b.who));
    expect(first.open).toContain((await b.txn("x-out")).id);
    const { bookingId } = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("x-out")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
        confidence: 0.95,
        reason: "a card payment",
      }),
    );
    expect((await b.liveOf("x-out"))?.kind).toBe("transfer");
    await b.posted(bookingId, "transfer", "701");
    // Two days later the card side posts.
    await b.more({
      id: "x-in",
      account: AMEX,
      amount: "2000.00",
      direction: "in",
      date: "2026-11-05",
      description: "PAYMENT THANK YOU",
    });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).not.toContain((await b.txn("x-in")).id);
    expect(r.transfers).toBe(1);
    expect(await b.txn("x-in")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: bookingId },
    });
    expect(await b.liveOf("x-in")).toBeNull();
    // A second card payment of the same amount isn't paired with the booking already taken.
    await b.more({
      id: "x-in-2",
      account: AMEX,
      amount: "2000.00",
      direction: "in",
      date: "2026-11-06",
      description: "PAYMENT THANK YOU",
    });
    expect((await b.inA((tx) => settle(tx, b.who))).open).toContain((await b.txn("x-in-2")).id);
  });

  it("sends a payment of an open bill or invoice to a person instead of proposing it", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "seen", amount: "1.00", date: "2026-11-01", merchantName: "Shell" }],
    );
    const hardwood = await b.A.vendor("Hardwood Supply", "56");
    const bill = await b.A.qboBill({
      id: "301",
      total: "4200.0000",
      balance: "4200.0000",
      date: "2026-10-20",
      vendorId: hardwood,
    });
    // Paid already: not a candidate.
    await b.A.qboBill({ id: "302", total: "300.0000", balance: "0", date: "2026-10-21" });
    const invoice = await b.A.qboInvoice({
      id: "1044",
      total: "1500.0000",
      balance: "1500.0000",
      date: "2026-10-15",
      customer: "Kitchen job",
    });
    await b.more(
      { id: "bp", amount: "4200.00", date: "2026-11-03", description: "ACH HARDWOOD SUPPLY" },
      { id: "dep", amount: "1500.00", direction: "in", date: "2026-11-04", description: "DEPOSIT" },
      { id: "paid", amount: "300.00", date: "2026-11-04", merchantName: "Lumber yard" },
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open.sort()).toEqual([(await b.txn("seen")).id, (await b.txn("paid")).id].sort());
    expect(await b.txn("bp")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { kind: "bill", transactionId: bill, docNumber: null } },
    });
    expect(await b.txn("dep")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { kind: "invoice", receivableId: invoice, docNumber: "1044" } },
    });
    // The card names the candidate.
    const card = BOOKKEEPING_REVIEWS[BOOKINGS_REVIEW];
    const view = await b.inA(
      async (tx) =>
        (await card?.load(tx, b.A.tenantId, { bankTxnIds: [(await b.txn("bp")).id] })) as {
          transactions: { openItem: { kind: string; name: string | null; balance: string } }[];
        },
    );
    expect(view.transactions[0]?.openItem).toMatchObject({
      kind: "bill",
      name: "Hardwood Supply",
      balance: "4200.0000",
    });
    // The model's proposal, however sure, doesn't take it past the person.
    const out = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("bp")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Job Materials"] ?? "" }],
        confidence: 0.99,
        reason: "materials",
      }),
    );
    expect(out.status).toBe("needs_review");
    // Settling again changes nothing.
    expect((await b.inA((tx) => settle(tx, b.who))).open).not.toContain((await b.txn("bp")).id);
  });

  it("frees the other side of a transfer when its booking is replaced, refused or not written", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: SAVINGS, ledger: "Savings" },
      ],
      [
        { id: "chk", amount: "1000.00", date: "2026-11-03", description: "CHECK 1050" },
        {
          id: "dep",
          account: SAVINGS,
          amount: "1000.00",
          direction: "in",
          date: "2026-11-05",
          description: "DEPOSIT",
        },
        { id: "chk-2", amount: "700.00", date: "2026-11-10", description: "CHECK 1051" },
        {
          id: "dep-2",
          account: SAVINGS,
          amount: "700.00",
          direction: "in",
          date: "2026-11-11",
          description: "DEPOSIT",
        },
      ],
    );
    const first = await b.inA((tx) => settle(tx, b.who));
    expect(first.transfers).toBe(2);
    expect((await b.txn("dep")).status).toBe("matched");
    // A person books the check as an expense: the pairing was wrong.
    await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("chk")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
      }),
    );
    expect((await b.txn("dep")).status).toBe("new");
    expect((await b.txn("dep")).ext).not.toHaveProperty("transferBookingId");
    expect((await b.inA((tx) => settle(tx, b.who))).open).toContain((await b.txn("dep")).id);
    // The second transfer isn't written to QuickBooks.
    const second = await b.liveOf("chk-2");
    await b.posted(second?.id ?? "", "transfer", null);
    expect((await b.txn("dep-2")).status).toBe("new");
  });

  it("learns and applies no rule for generic bank words", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [
        { id: "k-1", amount: "2400.00", date: "2026-11-01", description: "CHECK 1041" },
        { id: "k-2", amount: "2400.00", date: "2026-11-02", description: "CHECK 1042" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    for (const ext of ["k-1", "k-2"]) {
      await b.inA(async (tx) =>
        bookByPerson(tx, b.person, {
          bankTxnId: (await b.txn(ext)).id,
          lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
        }),
      );
    }
    expect(
      await t.db.select().from(bookingRule).where(eq(bookingRule.tenantId, b.A.tenantId)),
    ).toEqual([]);
    // Nor by a person's hand.
    await expect(
      b.inA((tx) =>
        addRule(tx, b.person, {
          payeeKey: "CHECK",
          direction: "out",
          ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "",
        }),
      ),
    ).rejects.toThrow("names no payee");
    // A rule stored before for such words is never applied.
    await t.db.insert(bookingRule).values({
      tenantId: b.A.tenantId,
      payeeKey: "check",
      direction: "out",
      ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "",
      source: "learned",
    });
    await b.more({ id: "k-3", amount: "18400.00", date: "2026-11-05", description: "CHECK 1043" });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.ruled).toBe(0);
    expect(r.open).toEqual([(await b.txn("k-3")).id]);
  });
});
