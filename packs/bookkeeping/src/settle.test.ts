// Settling at scale and over time (docs/plan.md §1.79), as cs_worker, each case on its own client:
// skipped history never holds new transactions back; a second identical charge is never matched
// to the Bookkeeper's own earlier write; a transfer whose sides arrive on different days is booked
// once; a bill or invoice payment goes to a person rather than becoming a second expense or
// income; a wrong transfer pairing, once undone, frees the other side; generic bank words make no
// rule.

import {
  closeDb,
  createDb,
  type Db,
  rawRecord,
  type Tx,
  transaction,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKINGS_REVIEW, BOOKKEEPING_ACTIONS, BOOKKEEPING_REVIEWS } from "./api";
import { addRule, bookByPerson, exclude, propose, settle } from "./bookings";
import { importFeeds } from "./feed";
import { BOOKKEEPING_HANDLERS } from "./manifest";
import type { PackToolContext } from "./pack";
import { isGenericPayeeKey, payeeKey } from "./payee";
import { qboInput } from "./posting";
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
    return { A, who, person, inA, txn, liveOf, posted, more, ctx };
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
      {
        id: "dep",
        amount: "1500.00",
        direction: "in",
        date: "2026-11-04",
        description: "DEPOSIT KITCHEN JOB",
      },
      { id: "paid", amount: "300.00", date: "2026-11-04", merchantName: "Lumber yard" },
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open.sort()).toEqual([(await b.txn("seen")).id, (await b.txn("paid")).id].sort());
    expect(await b.txn("bp")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { kind: "bill", transactionId: bill, docNumber: null, confirmed: true } },
    });
    expect(await b.txn("dep")).toMatchObject({
      status: "needs_review",
      ext: {
        openItem: { kind: "invoice", receivableId: invoice, docNumber: "1044", confirmed: true },
      },
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

  it("frees the other side of a transfer only when a person books the first some other way", async () => {
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
    expect(await b.txn("dep")).toMatchObject({
      status: "matched",
      ext: { pairedTxnId: (await b.txn("chk")).id },
    });
    // A person books the check as an expense: the pairing was wrong.
    await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("chk")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
      }),
    );
    expect((await b.txn("dep")).status).toBe("new");
    expect((await b.txn("dep")).ext).not.toHaveProperty("transferBookingId");
    expect((await b.txn("dep")).ext).not.toHaveProperty("pairedTxnId");
    expect((await b.inA((tx) => settle(tx, b.who))).open).toContain((await b.txn("dep")).id);
    // A side the bank dropped after it was matched is never changed.
    await b.A.feedRemoved("dep-2", SAVINGS.id);
    await b.inA((tx) => importFeeds(tx, b.A.tenantId));
    expect((await b.txn("dep-2")).ext).toMatchObject({ removedAfterPosting: true });
    await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("chk-2")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
      }),
    );
    expect((await b.txn("dep-2")).status).toBe("matched");
  });

  it("holds the other side for a person when the transfer isn't written or is left out, and books it once", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "out", amount: "2000.00", date: "2026-11-03", description: "AMEX EPAYMENT" },
        {
          id: "in",
          account: AMEX,
          amount: "2000.00",
          direction: "in",
          date: "2026-11-05",
          description: "PAYMENT THANK YOU",
        },
        { id: "out-2", amount: "700.00", date: "2026-11-10", description: "AMEX EPAYMENT" },
        {
          id: "in-2",
          account: AMEX,
          amount: "700.00",
          direction: "in",
          date: "2026-11-11",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    expect((await b.inA((tx) => settle(tx, b.who))).transfers).toBe(2);
    // QuickBooks refuses the first (the client had entered it): nothing written.
    const b1 = await b.liveOf("out");
    await b.posted(b1?.id ?? "", "transfer", null);
    expect((await b.txn("out")).status).toBe("needs_review");
    expect(await b.txn("in")).toMatchObject({
      status: "needs_review",
      ext: { pairedTxnId: (await b.txn("out")).id, heldWhy: "not_written" },
    });
    expect((await b.txn("in")).ext).not.toHaveProperty("transferBookingId");
    // Not the model's: it isn't settled or proposed on its own.
    expect((await b.inA((tx) => settle(tx, b.who))).open).not.toContain((await b.txn("in")).id);
    const held = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("in")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Fuel ?? "" }],
        confidence: 0.95,
        reason: "a refund",
      }),
    );
    expect(held.status).toBe("needs_review");
    // The card names the other side.
    const card = BOOKKEEPING_REVIEWS[BOOKINGS_REVIEW];
    const view = (await b.inA(async (tx) =>
      card?.load(tx, b.A.tenantId, { bankTxnIds: [(await b.txn("in")).id] }),
    )) as { transactions: { pairedWith: { id: string; why: string } | null }[] };
    expect(view.transactions[0]?.pairedWith).toMatchObject({
      id: (await b.txn("out")).id,
      why: "not_written",
    });
    // A person books the first side as the transfer again: the other side is matched to it,
    // and only one transfer is ready to write.
    const again = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("out")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
      }),
    );
    expect(await b.txn("in")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: again, pairedTxnId: (await b.txn("out")).id },
    });
    expect(await b.liveOf("in")).toBeNull();
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: { bookingId: string; kind: string }[];
    };
    expect(ready.bookings.map((x) => x.bookingId).sort()).toEqual(
      [again, (await b.liveOf("out-2"))?.id].sort(),
    );
    // Left out: the other side waits for a person too.
    await b.inA(async (tx) =>
      exclude(tx, b.person, { bankTxnId: (await b.txn("out-2")).id, why: "already entered" }),
    );
    expect(await b.txn("in-2")).toMatchObject({
      status: "needs_review",
      ext: { pairedTxnId: (await b.txn("out-2")).id, heldWhy: "left_out" },
    });
    expect((await b.inA((tx) => settle(tx, b.who))).open).not.toContain((await b.txn("in-2")).id);
  });

  it("pairs a transfer again when the bank changes its booked side", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "out", amount: "2000.00", date: "2026-11-03", description: "AMEX EPAYMENT" },
        {
          id: "in",
          account: AMEX,
          amount: "2000.00",
          direction: "in",
          date: "2026-11-05",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    expect((await b.inA((tx) => settle(tx, b.who))).transfers).toBe(1);
    // The bank moves the date: the proposal gives way, the other side waits.
    await b.more({
      id: "out",
      amount: "2000.00",
      date: "2026-11-04",
      description: "AMEX EPAYMENT",
    });
    expect((await b.txn("out")).status).toBe("new");
    expect(await b.txn("in")).toMatchObject({
      status: "needs_review",
      ext: { heldWhy: "changed" },
    });
    // Settled again, the two are one transfer again.
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.transfers).toBe(1);
    expect((await b.txn("in")).status).toBe("matched");
    expect((await b.liveOf("out"))?.kind).toBe("transfer");
  });

  it("matches a card payment that posts more than three days after the transfer was booked", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "x-out", amount: "1500.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        { id: "c-0", account: AMEX, amount: "12.00", date: "2026-11-01", merchantName: "Shell" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("x-out")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
        confidence: 0.95,
        reason: "a card payment",
      }),
    );
    // Friday's payment reaches the card on Wednesday.
    await b.more({
      id: "x-in",
      account: AMEX,
      amount: "1500.00",
      direction: "in",
      date: "2026-11-11",
      description: "PAYMENT THANK YOU",
    });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.transfers).toBe(1);
    expect(await b.txn("x-in")).toMatchObject({
      status: "matched",
      ext: { matchedBy: { agentVersionId: b.A.agentVersionId } },
    });
  });

  it("reaches new transactions however many proposals wait on accounts set to suggest", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking", mode: "suggest" }],
      [{ id: "seen", amount: "1.00", date: "2026-11-15", merchantName: "Shell" }],
    );
    const link = await linkOf(b.A, CHECKING.id);
    const raw = (await b.txn("seen")).rawRecordId;
    await t.db.execute(sql`
      insert into bank_txn (tenant_id, connection_id, account_link_id, external_id, raw_record_id,
        txn_date, amount, currency, direction, payee, payee_key, status)
      select ${b.A.tenantId}, ${b.A.feedConnectionId}, ${link.id}, 'dep-' || g, ${raw},
        date '2026-05-01' + (g % 180), 100, 'USD', 'in', 'Deposit', 'deposit', 'proposed'
      from generate_series(1, 500) g`);
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([(await b.txn("seen")).id]);
    // Nothing the match step could take: none of them is read again.
    expect(r.checked).toBe(1);
  });

  it("hands on at most as many open transactions as the next step reads", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "seen", amount: "1.00", date: "2026-11-15", merchantName: "Shell" }],
    );
    const link = await linkOf(b.A, CHECKING.id);
    const raw = (await b.txn("seen")).rawRecordId;
    await t.db.execute(sql`
      insert into bank_txn (tenant_id, connection_id, account_link_id, external_id, raw_record_id,
        txn_date, amount, currency, direction, payee, payee_key, status)
      select ${b.A.tenantId}, ${b.A.feedConnectionId}, ${link.id}, 'n-' || g, ${raw},
        date '2026-10-01' + (g % 40), 10 + g, 'USD', 'out', 'Shop ' || g, 'shop', 'new'
      from generate_series(1, 150) g`);
    const out = (await tool("bookkeeping.transactions.settle").run({}, b.ctx())) as {
      open: string[];
      openCount: number;
    };
    expect(out.open).toHaveLength(100);
    expect(out.openCount).toBe(151);
    await expect(
      tool("bookkeeping.transactions.open").run({ ids: out.open }, b.ctx()),
    ).resolves.toBeTruthy();
  });

  it("keeps the client's rule over an open bill of another vendor's, and drops a stale candidate", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "seen", amount: "1.00", date: "2026-11-01", merchantName: "Shell" }],
    );
    await b.inA((tx) =>
      addRule(tx, b.person, {
        payeeKey: "Adobe",
        direction: "out",
        ledgerAccountId: b.A.accounts.Software ?? "",
      }),
    );
    const uline = await b.A.vendor("Uline", "57");
    await b.A.qboBill({
      id: "401",
      total: "52.99",
      balance: "52.99",
      date: "2026-06-10",
      vendorId: uline,
    });
    // No vendor at all on this one: a hint, never a decision.
    await b.A.qboBill({ id: "402", total: "88.00", balance: "88.00", date: "2026-10-01" });
    const hardwood = await b.A.vendor("Hardwood Supply", "56");
    const bill = await b.A.qboBill({
      id: "403",
      total: "4200.00",
      balance: "4200.00",
      date: "2026-10-20",
      vendorId: hardwood,
    });
    await b.more(
      { id: "adobe", amount: "52.99", date: "2026-11-05", merchantName: "Adobe" },
      { id: "misc", amount: "88.00", date: "2026-11-05", merchantName: "Corner store" },
      { id: "bp", amount: "4200.00", date: "2026-11-05", description: "ACH HARDWOOD SUPPLY" },
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.ruled).toBe(1);
    expect(r.review).toBe(1);
    expect((await b.txn("adobe")).status).toBe("proposed");
    expect(await b.txn("misc")).toMatchObject({
      status: "new",
      ext: { openItem: { kind: "bill", confirmed: false } },
    });
    expect(r.open).toContain((await b.txn("misc")).id);
    expect(await b.txn("bp")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { transactionId: bill, confirmed: true } },
    });
    // The bill is paid in QuickBooks: the transaction goes back to be decided, without it.
    const [paid] = await t.db
      .insert(rawRecord)
      .values({
        tenantId: b.A.tenantId,
        connectionId: b.A.qboConnectionId,
        connector: "qbo",
        entityType: "Bill",
        externalId: "403",
        externalVersion: "v2:paid",
        payload: { Id: "403", TotalAmt: 4200, Balance: 0 },
      })
      .returning();
    await t.db
      .update(transaction)
      .set({ sourceRawRecordId: paid?.id ?? "" })
      .where(eq(transaction.id, bill));
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).status).toBe("new");
    expect((await b.txn("bp")).ext).not.toHaveProperty("openItem");
    expect((await b.inA((tx) => settle(tx, b.who))).open).toContain((await b.txn("bp")).id);
  });

  it("books what a person decided even when the rule they asked for can't be made", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "k", amount: "2400.00", date: "2026-11-01", description: "CHECK 1041" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("k")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
        makeRule: true,
      }),
    );
    expect(await b.txn("k")).toMatchObject({
      status: "approved",
      ext: { ruleNotMade: "names no payee" },
    });
    expect(
      await t.db.select().from(bookingRule).where(eq(bookingRule.tenantId, b.A.tenantId)),
    ).toEqual([]);
  });

  it("finds a write made for an earlier booking of the same transaction, and matches nothing else to it", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s-1", amount: "19.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    const first = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s-1")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "a subscription",
      }),
    );
    const firstInput = await b.inA((tx) => qboInput(tx, b.A.tenantId, first.bookingId));
    // The write is made, but nobody records it; a person books the transaction again.
    await b.posted(first.bookingId, "purchase", null);
    const second = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s-1")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
      }),
    );
    const secondInput = await b.inA((tx) => qboInput(tx, b.A.tenantId, second));
    // One reference for the transaction: QuickBooks' tool finds the first write as its own.
    expect(secondInput.purchase?.reference).toBe(firstInput.purchase?.reference);
    expect(secondInput.purchase?.reference).toBe(`bt-${(await b.txn("s-1")).id}`);
    // That record, synced back, is never matched to another charge of the same amount.
    await b.A.qboPurchase({
      id: "611",
      total: "19.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas ${secondInput.purchase?.reference}]`,
    });
    await b.more({ id: "s-2", amount: "19.99", date: "2026-11-04", merchantName: "Figma" });
    expect((await b.inA((tx) => settle(tx, b.who))).matched).toBe(0);
  });

  it("refuses to write again what an earlier booking wrote under its own reference", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s-1", amount: "29.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    const first = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s-1")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "a subscription",
      }),
    );
    await b.posted(first.bookingId, "purchase", null);
    // Written before references named the transaction, and synced back.
    await b.A.qboPurchase({
      id: "612",
      total: "29.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas bk-${first.bookingId}]`,
    });
    const second = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s-1")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    await expect(b.inA((tx) => qboInput(tx, b.A.tenantId, second))).rejects.toThrow(
      "already in QuickBooks (Purchase 612)",
    );
  });

  it("on an account set to suggest, matches the transaction's own write and no other's", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking", mode: "suggest" }],
      [
        { id: "a", amount: "45.00", date: "2026-11-03", merchantName: "Rockler" },
        { id: "z", amount: "45.00", date: "2026-11-03", merchantName: "Rockler" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    for (const ext of ["a", "z"]) {
      await b.inA(async (tx) =>
        propose(tx, b.who, {
          bankTxnId: (await b.txn(ext)).id,
          lines: [{ ledgerAccountId: b.A.accounts["Shop Supplies"] ?? "" }],
          confidence: 0.95,
          reason: "supplies",
        }),
      );
    }
    // A record marked as written for "z" is z's, never a's.
    await b.A.qboPurchase({
      id: "613",
      total: "45.0000",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Rockler [Mezonas bt-${(await b.txn("z")).id}]`,
    });
    expect((await b.inA((tx) => settle(tx, b.who))).matched).toBe(1);
    expect((await b.txn("a")).status).toBe("proposed");
    expect((await b.txn("z")).status).toBe("matched");
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
