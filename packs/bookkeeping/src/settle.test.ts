// Settling at scale and over time (docs/plan.md §1.79), as cs_worker, each case on its own client:
// skipped history never holds new transactions back; a second identical charge is never matched
// to the Bookkeeper's own earlier write; a transfer whose sides arrive on different days is booked
// once; a bill or invoice payment goes to a person rather than becoming a second expense or
// income; a wrong transfer pairing, once undone, frees the other side; generic bank words make no
// rule.

import { BANKING_TOOLS } from "@countersign/connectors";
import {
  closeDb,
  createDb,
  type Db,
  externalAction,
  ledgerAccountNote,
  rawRecord,
  type Tx,
  transaction,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKINGS_REVIEW, BOOKKEEPING_ACTIONS, BOOKKEEPING_REVIEWS } from "./api";
import { addRule, approve, bookByPerson, exclude, propose, settle } from "./bookings";
import { importFeeds } from "./feed";
import { BOOKKEEPING_HANDLERS } from "./manifest";
import type { PackToolContext } from "./pack";
import { isGenericPayeeKey, payeeKey } from "./payee";
import { qboInput, writeCheck } from "./posting";
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
    // Sorted copies: `ids` stays in date order (new-1 to new-5) for the second settle below.
    expect([...r.open].sort()).toEqual([...ids].sort());
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
    // The bill is changed to another amount: the transaction goes back to be decided, without it.
    const [paid] = await t.db
      .insert(rawRecord)
      .values({
        tenantId: b.A.tenantId,
        connectionId: b.A.qboConnectionId,
        connector: "qbo",
        entityType: "Bill",
        externalId: "403",
        externalVersion: "v2:paid",
        payload: { Id: "403", TotalAmt: 5200, Balance: 5200 },
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

  it("pairs two sides of a card payment five days apart in one pass, for a person", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "x-out", amount: "2000.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        {
          id: "x-in",
          account: AMEX,
          amount: "2000.00",
          direction: "in",
          date: "2026-11-11",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r).toMatchObject({ transfers: 1, open: [] });
    expect((await b.txn("x-in")).status).toBe("matched");
    // Further apart than the bank usually takes: a person confirms it.
    expect((await b.txn("x-out")).status).toBe("needs_review");
    expect((await b.liveOf("x-out"))?.kind).toBe("transfer");
  });

  it("matches a side the model or a person books as a transfer already booked on the other", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "x-out", amount: "2000.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        { id: "c-0", account: AMEX, amount: "12.00", date: "2026-11-01", merchantName: "Shell" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const first = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("x-out")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
        confidence: 0.95,
        reason: "a card payment",
      }),
    );
    await b.more({
      id: "x-in",
      account: AMEX,
      amount: "2000.00",
      direction: "in",
      date: "2026-11-11",
      description: "PAYMENT THANK YOU",
    });
    // Proposed for straight away, before any settling: the model's transfer is the same one.
    const second = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("x-in")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Checking ?? "" }],
        confidence: 0.95,
        reason: "a card payment",
      }),
    );
    expect(second).toEqual({ bookingId: first.bookingId, status: "matched" });
    expect(await b.txn("x-in")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: first.bookingId },
    });
    expect(await b.liveOf("x-in")).toBeNull();
  });

  it("approves the card side's own transfer when a person corrects which account paid it", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
        { account: SAVINGS, ledger: "Savings" },
      ],
      [
        { id: "a", amount: "500.00", date: "2026-11-03", description: "ONLINE TRANSFER" },
        {
          id: "d",
          account: SAVINGS,
          amount: "500.00",
          direction: "in",
          date: "2026-11-03",
          description: "DEPOSIT",
        },
        {
          id: "bb",
          account: AMEX,
          amount: "500.00",
          direction: "in",
          date: "2026-11-04",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("d")).status).toBe("matched");
    // The model takes the card side as a payment from checking, on its own.
    if ((await b.txn("bb")).status === "new") {
      await b.inA(async (tx) =>
        propose(tx, b.who, {
          bankTxnId: (await b.txn("bb")).id,
          lines: [{ ledgerAccountId: b.A.accounts.Checking ?? "" }],
          confidence: 0.95,
          reason: "card payment from checking",
        }),
      );
    }
    const cardSide = await b.liveOf("bb");
    expect(cardSide?.kind).toBe("transfer");
    // A person corrects the checking side: it paid the card, not savings. The card side's own
    // proposal is that transfer (it may already wait for a signature): approved, not replaced.
    const idA = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("a")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
      }),
    );
    expect(idA).toBe(cardSide?.id);
    expect((await b.txn("d")).status).toBe("new");
    expect(await b.txn("a")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: idA, matchedBy: { userId: b.A.userId } },
    });
    expect(await b.liveOf("a")).toBeNull();
    expect(await b.liveOf("bb")).toMatchObject({ id: idA, status: "approved", userId: b.A.userId });
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: { bookingId: string; kind: string }[];
    };
    expect(ready.bookings.filter((x) => x.kind === "transfer").map((x) => x.bookingId)).toEqual([
      idA,
    ]);
  });

  it("keeps a bill payment for a person once the bill is paid in QuickBooks", async () => {
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
    await b.inA((tx) =>
      addRule(tx, b.person, {
        payeeKey: "hardwood supply",
        direction: "out",
        ledgerAccountId: b.A.accounts["Job Materials"] ?? "",
      }),
    );
    await b.more({
      id: "bp",
      amount: "4200.00",
      date: "2026-11-03",
      description: "ACH HARDWOOD SUPPLY",
    });
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).status).toBe("needs_review");
    // The person applies the payment to the bill in QuickBooks, as the card asks.
    await t.db.execute(sql`with r as (insert into raw_record (tenant_id, connection_id, connector,
      entity_type, external_id, external_version, payload) select tenant_id, connection_id,
      connector, entity_type, external_id, 'v2:paid', jsonb_set(payload::jsonb, '{Balance}', '0')
      from raw_record where id = (select source_raw_record_id from transaction where id = ${bill})
      returning id) update transaction set source_raw_record_id = (select id from r)
      where id = ${bill}`);
    await b.inA((tx) => settle(tx, b.who));
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.txn("bp")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { transactionId: bill, paid: true } },
    });
    expect(await b.liveOf("bp")).toBeNull();
  });

  it("matches a posted deposit the bank sends again under a new id to what was written", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [
        {
          id: "d-1",
          amount: "1500.00",
          direction: "in",
          date: "2026-11-03",
          description: "STRIPE TRANSFER",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const p = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("d-1")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Sales ?? "" }],
        confidence: 0.95,
        reason: "sales",
      }),
    );
    await b.posted(p.bookingId, "deposit", "801");
    await b.A.feedRemoved("d-1");
    await b.more({
      id: "d-1b",
      amount: "1500.00",
      direction: "in",
      date: "2026-11-03",
      description: "STRIPE TRANSFER",
    });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([]);
    expect(r.matched).toBe(1);
    expect((await b.txn("d-1b")).status).toBe("matched");
    expect(await b.liveOf("d-1b")).toMatchObject({
      status: "posted",
      decidedBy: "match",
      qboEntity: "Deposit",
      qboId: "801",
    });
    // Only once: a third copy isn't matched to the same write.
    await b.more({
      id: "d-1c",
      amount: "1500.00",
      direction: "in",
      date: "2026-11-03",
      description: "STRIPE TRANSFER",
    });
    expect((await b.inA((tx) => settle(tx, b.who))).open).toEqual([(await b.txn("d-1c")).id]);
  });

  it("records a write nobody recorded as posted once it syncs back, and stops at a different kind", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [
        { id: "s-1", amount: "39.99", date: "2026-11-03", merchantName: "Figma" },
        { id: "s-2", amount: "59.99", date: "2026-11-03", merchantName: "Canva" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const ids: string[] = [];
    for (const ext of ["s-1", "s-2"]) {
      const out = await b.inA(async (tx) =>
        propose(tx, b.who, {
          bankTxnId: (await b.txn(ext)).id,
          lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
          confidence: 0.95,
          reason: "software",
        }),
      );
      ids.push(out.bookingId);
    }
    // s-1 was written; s-2's write is a Purchase too, but s-2 is booked as a transfer now.
    await b.A.qboPurchase({
      id: "621",
      total: "39.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas bt-${(await b.txn("s-1")).id}]`,
    });
    await b.A.qboPurchase({
      id: "622",
      total: "59.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Canva [Mezonas bt-${(await b.txn("s-2")).id}]`,
    });
    const transfer = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s-2")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Savings ?? "" }],
      }),
    );
    // Laid out before any settling: a record of another kind is there already.
    await expect(b.inA((tx) => qboInput(tx, b.A.tenantId, transfer))).rejects.toThrow(
      "already in QuickBooks (Purchase 622)",
    );
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.liveOf("s-1")).toMatchObject({
      id: ids[0],
      status: "posted",
      qboEntity: "Purchase",
      qboId: "621",
    });
    expect((await b.txn("s-1")).status).toBe("posted");
    expect((await b.txn("s-2")).status).toBe("needs_review");
    expect(await b.liveOf("s-2")).toBeNull();
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: unknown[];
    };
    expect(ready.bookings).toEqual([]);
  });

  it("offers the model the transactions it hasn't seen before the ones it left", async () => {
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
    const settleTool = tool("bookkeeping.transactions.settle");
    const first = (await settleTool.run({}, b.ctx())) as { open: string[] };
    const second = (await settleTool.run({}, b.ctx())) as { open: string[] };
    // The second pass hands on the 51 not offered yet first.
    expect(second.open.filter((id) => !first.open.includes(id))).toHaveLength(51);
    expect(new Set([...first.open, ...second.open]).size).toBe(151);
    // A new one arrives: it goes first.
    await b.more({ id: "late", amount: "3.00", date: "2026-11-16", merchantName: "Bakery" });
    const third = (await settleTool.run({}, b.ctx())) as { open: string[] };
    expect(third.open[0]).toBe((await b.txn("late")).id);
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

  // ── Transactions the bank removes and sends again (a person decides, unless already written) ──

  it("matches the re-sent side of a posted transfer to that transfer, and books nothing again", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "c", amount: "2000.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        {
          id: "a",
          account: AMEX,
          amount: "2000.00",
          direction: "in",
          date: "2026-11-07",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const transfer = await b.liveOf("c");
    expect(transfer?.kind).toBe("transfer");
    expect((await b.txn("a")).status).toBe("matched");
    await b.posted(transfer?.id ?? "", "transfer", "901");
    await b.A.feedRemoved("a", AMEX.id);
    await b.more({
      id: "a2",
      account: AMEX,
      amount: "2000.00",
      direction: "in",
      date: "2026-11-07",
      description: "PAYMENT THANK YOU",
    });
    expect((await b.txn("a")).ext).toMatchObject({ removedAfterPosting: true });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([]);
    const a2 = await b.txn("a2");
    expect(a2).toMatchObject({
      status: "matched",
      ext: {
        transferBookingId: transfer?.id,
        pairedTxnId: (await b.txn("c")).id,
        resentOf: (await b.txn("a")).id,
        matchedBy: { agentVersionId: b.A.agentVersionId },
      },
    });
    expect((await b.txn("a")).ext).toMatchObject({ resentAs: a2.id });
    // The model can't book it as a transfer of its own.
    await expect(
      b.inA((tx) =>
        propose(tx, b.who, {
          bankTxnId: a2.id,
          lines: [{ ledgerAccountId: b.A.accounts.Checking ?? "" }],
          confidence: 0.95,
          reason: "card payment",
        }),
      ),
    ).rejects.toThrow("only an undecided one");
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: unknown[];
    };
    expect(ready.bookings).toEqual([]);
  });

  it("matches a later copy of a removed side to the posted transfer it was the other side of", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "c", amount: "2000.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        {
          id: "a",
          account: AMEX,
          amount: "2000.00",
          direction: "in",
          date: "2026-11-07",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const transfer = await b.liveOf("c");
    await b.posted(transfer?.id ?? "", "transfer", "901");
    // The bank drops the card side and sends it again dated the next day.
    await b.A.feedRemoved("a", AMEX.id);
    await b.more({
      id: "a2",
      account: AMEX,
      amount: "2000.00",
      direction: "in",
      date: "2026-11-08",
      description: "PAYMENT THANK YOU",
    });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([]);
    expect(await b.txn("a2")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: transfer?.id },
    });
  });

  it("joins a person's booking of a re-sent side to the transfer proposed from the other side", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "c", amount: "800.00", date: "2026-11-06", description: "AMEX EPAYMENT" },
        {
          id: "a",
          account: AMEX,
          amount: "800.00",
          direction: "in",
          date: "2026-11-07",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    const transfer = await b.liveOf("c");
    expect(transfer).toMatchObject({ kind: "transfer", status: "proposed" });
    expect((await b.txn("a")).status).toBe("matched");
    // The card side is removed and sent again before the transfer is written: a person decides.
    await b.A.feedRemoved("a", AMEX.id);
    await b.more({
      id: "a2",
      account: AMEX,
      amount: "800.00",
      direction: "in",
      date: "2026-11-07",
      description: "PAYMENT THANK YOU",
    });
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("a2")).status).toBe("needs_review");
    const decided = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("a2")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Checking ?? "" }],
      }),
    );
    expect(decided).toBe(transfer?.id);
    expect(await b.txn("a2")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: transfer?.id },
    });
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: { bookingId: string }[];
    };
    expect(ready.bookings.map((x) => x.bookingId)).toEqual([transfer?.id]);
  });

  it("sends a re-sent copy of an approved, proposed or left-out transaction to a person, and writes neither", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [
        { id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" },
        { id: "p", amount: "59.99", date: "2026-11-03", merchantName: "Canva" },
        { id: "x", amount: "75.00", date: "2026-11-03", merchantName: "Acme Hardware" },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    for (const ext of ["s", "p"]) {
      await b.inA(async (tx) =>
        propose(tx, b.who, {
          bankTxnId: (await b.txn(ext)).id,
          lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
          confidence: 0.95,
          reason: "software",
        }),
      );
    }
    const approved = await b.inA(async (tx) => approve(tx, b.person, (await b.txn("s")).id));
    await b.inA(async (tx) => exclude(tx, b.person, { bankTxnId: (await b.txn("x")).id }));
    // Each is removed by the bank and sent again under a new id, the same day and amount.
    for (const ext of ["s", "p", "x"]) await b.A.feedRemoved(ext);
    await b.more(
      { id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" },
      { id: "p2", amount: "59.99", date: "2026-11-03", merchantName: "Canva" },
      { id: "x2", amount: "75.00", date: "2026-11-03", merchantName: "Acme Hardware" },
    );
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([]);
    expect(r.review).toBe(3);
    for (const ext of ["s", "p", "x"]) {
      const copy = await b.txn(`${ext}2`);
      expect(copy, ext).toMatchObject({
        status: "needs_review",
        ext: {
          resentOf: (await b.txn(ext)).id,
          note: "The bank sent this again after removing an earlier copy",
        },
      });
      expect((await b.txn(ext)).ext, ext).toMatchObject({ resentAs: copy.id });
    }
    // The card says why it waits.
    const card = BOOKKEEPING_REVIEWS[BOOKINGS_REVIEW];
    const view = await b.inA(
      async (tx) =>
        (await card?.load(tx, b.A.tenantId, { bankTxnIds: [(await b.txn("s2")).id] })) as {
          transactions: { resent: boolean }[];
        },
    );
    expect(view.transactions[0]?.resent).toBe(true);
    // The approval of the earlier copy is not written; nothing is ready.
    expect(await b.liveOf("s")).toBeNull();
    expect((await t.db.select().from(booking).where(eq(booking.id, approved)))[0]?.status).toBe(
      "superseded",
    );
    const ready = () =>
      tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx()) as Promise<{
        bookings: unknown[];
      }>;
    expect((await ready()).bookings).toEqual([]);
    await expect(b.inA((tx) => qboInput(tx, b.A.tenantId, approved))).rejects.toThrow(
      "nothing to write",
    );
    // The model's suggestion for one still waits for a person.
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s2")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "software",
      }),
    );
    expect((await b.txn("s2")).status).toBe("needs_review");
    expect((await ready()).bookings).toEqual([]);
    // Settling again changes none of them.
    expect((await b.inA((tx) => settle(tx, b.who))).open).toEqual([]);
    for (const ext of ["s2", "p2", "x2"]) expect((await b.txn(ext)).status).toBe("needs_review");
    // A person approves the copy; a write made for the earlier copy after all, synced back, is
    // this money's too, and the copy isn't written again.
    const decided = await b.inA(async (tx) => approve(tx, b.person, (await b.txn("s2")).id));
    await b.A.qboPurchase({
      id: "641",
      total: "39.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas bt-${(await b.txn("s")).id}]`,
    });
    await expect(b.inA((tx) => qboInput(tx, b.A.tenantId, decided))).rejects.toThrow(
      "already in QuickBooks (Purchase 641)",
    );
  });

  it("records the earlier copy's write when it goes out after all, and the re-sent copy as written", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "software",
      }),
    );
    const approved = await b.inA(async (tx) => approve(tx, b.person, (await b.txn("s")).id));
    // Laid out for a signature before the bank sent it again.
    await b.inA((tx) => qboInput(tx, b.A.tenantId, approved));
    await b.A.feedRemoved("s");
    await b.more({ id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("s2")).status).toBe("needs_review");
    // The signature comes and the write is made: it is recorded, and the copy is that write.
    await b.posted(approved, "purchase", "631");
    expect(await b.liveOf("s")).toMatchObject({ id: approved, status: "posted", qboId: "631" });
    expect((await b.txn("s2")).status).toBe("matched");
    expect(await b.liveOf("s2")).toMatchObject({
      status: "posted",
      qboEntity: "Purchase",
      qboId: "631",
    });
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: unknown[];
    };
    expect(ready.bookings).toEqual([]);
  });

  it("keeps the other side's proposed transfer when a person books this side as that transfer", async () => {
    const b = await books(
      [
        { account: CHECKING, ledger: "Checking" },
        { account: AMEX, ledger: "Amex" },
      ],
      [
        { id: "seen", amount: "1.00", date: "2026-11-01", merchantName: "Shell" },
        {
          id: "a",
          account: AMEX,
          amount: "500.00",
          direction: "in",
          date: "2026-11-02",
          description: "PAYMENT THANK YOU",
        },
      ],
    );
    await b.inA((tx) => settle(tx, b.who));
    // The model took the card side for a refund, unsure: it waits for a person.
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("a")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Sales ?? "" }],
        confidence: 0.4,
        reason: "a refund",
      }),
    );
    // The checking side arrives and is proposed as a transfer to the card, ready to write.
    await b.more({ id: "c", amount: "500.00", date: "2026-11-03", description: "AMEX EPAYMENT" });
    await b.inA((tx) => settle(tx, b.who));
    const proposed = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("c")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Amex ?? "" }],
        confidence: 0.95,
        reason: "a card payment",
      }),
    );
    expect(proposed.status).toBe("proposed");
    // A run lays it out for a signature.
    await b.inA((tx) => qboInput(tx, b.A.tenantId, proposed.bookingId));
    // A person books the card side as that same transfer, saying why.
    const decided = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("a")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Checking ?? "" }],
        why: "We pay the card from checking",
      }),
    );
    expect(decided).toBe(proposed.bookingId);
    // The person's words are kept as the client's note, as when booked on this side.
    const notes = await t.db
      .select()
      .from(ledgerAccountNote)
      .where(eq(ledgerAccountNote.tenantId, b.A.tenantId));
    expect(notes.map((x) => [x.ledgerAccountId, x.note, x.source])).toEqual([
      [b.A.accounts.Checking, "We pay the card from checking", "client"],
    ]);
    expect(await b.liveOf("c")).toMatchObject({
      id: proposed.bookingId,
      status: "approved",
      userId: b.A.userId,
    });
    expect(await b.txn("a")).toMatchObject({
      status: "matched",
      ext: { transferBookingId: proposed.bookingId, matchedBy: { userId: b.A.userId } },
    });
    expect(await b.liveOf("a")).toBeNull();
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: { bookingId: string }[];
    };
    expect(ready.bookings.map((x) => x.bookingId)).toEqual([proposed.bookingId]);
  });

  it("asks again about a bill paid in QuickBooks once the payment there is undone, and holds it otherwise", async () => {
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
    await b.more({
      id: "bp",
      amount: "4200.00",
      date: "2026-11-03",
      description: "ACH HARDWOOD SUPPLY",
    });
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).status).toBe("needs_review");
    const balance = (value: string, version: string) =>
      t.db.execute(sql`with r as (insert into raw_record (tenant_id, connection_id, connector,
      entity_type, external_id, external_version, payload) select tenant_id, connection_id,
      connector, entity_type, external_id, ${version}, jsonb_set(payload::jsonb, '{Balance}',
      ${value}::jsonb) from raw_record where id = (select source_raw_record_id from transaction
      where id = ${bill}) returning id) update transaction set source_raw_record_id =
      (select id from r) where id = ${bill}`);
    await balance("0", "v2");
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).ext).toMatchObject({ openItem: { paid: true } });
    // The payment is undone in QuickBooks: the bill is open again, and the card asks as before.
    await balance("4200", "v3");
    await b.inA((tx) => settle(tx, b.who));
    const open = await b.txn("bp");
    expect(open.status).toBe("needs_review");
    expect(open.ext).toMatchObject({
      openItem: { transactionId: bill, balance: "4200.0000", confirmed: true },
    });
    expect((open.ext as { openItem?: { paid?: boolean } }).openItem?.paid).not.toBe(true);
    // Paid again, then the bill edited to a higher total (300 more owed): the payment stays
    // applied there, so it stays with a person, still paid, and nothing is ready to write.
    await balance("0", "v4");
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).ext).toMatchObject({ openItem: { paid: true } });
    await balance("300", "v5");
    for (let i = 0; i < 2; i++) {
      const r = await b.inA((tx) => settle(tx, b.who));
      expect(r.open).not.toContain((await b.txn("bp")).id);
      expect(await b.txn("bp")).toMatchObject({
        status: "needs_review",
        ext: { openItem: { transactionId: bill, paid: true } },
      });
    }
    // The model's suggestion doesn't take it past the person.
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("bp")).id,
        lines: [{ ledgerAccountId: b.A.accounts["Job Materials"] ?? "" }],
        confidence: 0.95,
        reason: "materials",
      }),
    );
    expect((await b.txn("bp")).status).toBe("needs_review");
    const ready = (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
      bookings: unknown[];
    };
    expect(ready.bookings).toEqual([]);
    // The bill deleted: once paid, a person still decides.
    await t.db.execute(
      sql`update transaction set ext = jsonb_set(ext, '{qbo,deleted}', 'true') where id = ${bill}`,
    );
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.txn("bp")).toMatchObject({
      status: "needs_review",
      ext: { openItem: { paid: true } },
    });
  });

  it("records a posted charge the bank sends again twice as the one write", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    const p = await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "software",
      }),
    );
    await b.posted(p.bookingId, "purchase", "555");
    // The write syncs back from QuickBooks with its reference.
    await b.A.qboPurchase({
      id: "555",
      total: "39.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas bt-${(await b.txn("s")).id}]`,
    });
    await b.A.feedRemoved("s");
    await b.more({ id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.liveOf("s2")).toMatchObject({ status: "posted", qboId: "555" });
    await b.A.feedRemoved("s2");
    await b.more({ id: "s3", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    const r = await b.inA((tx) => settle(tx, b.who));
    expect(r.open).toEqual([]);
    expect((await b.txn("s3")).status).toBe("matched");
    expect(await b.liveOf("s3")).toMatchObject({ status: "posted", qboId: "555" });
  });

  it("refuses to write a copy when the write for any earlier copy in its chain is there", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "software",
      }),
    );
    await b.inA(async (tx) => approve(tx, b.person, (await b.txn("s")).id));
    // Removed and re-sent twice before anything is written: each copy waits for a person.
    await b.A.feedRemoved("s");
    await b.more({ id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) => exclude(tx, b.person, { bankTxnId: (await b.txn("s2")).id }));
    await b.A.feedRemoved("s2");
    await b.more({ id: "s3", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.txn("s3")).toMatchObject({
      status: "needs_review",
      ext: { resentOf: (await b.txn("s2")).id },
    });
    // The first copy's write was made after all and syncs back under its mark.
    await b.A.qboPurchase({
      id: "556",
      total: "39.9900",
      date: "2026-11-03",
      accountQboId: "35",
      memo: `Figma [Mezonas bt-${(await b.txn("s")).id}]`,
    });
    const id = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s3")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    await expect(b.inA((tx) => qboInput(tx, b.A.tenantId, id))).rejects.toThrow(
      "already in QuickBooks (Purchase 556)",
    );
  });

  it("keeps the open-bill question on a held payment the bank sends again", async () => {
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
    await b.more({
      id: "bp",
      amount: "4200.00",
      date: "2026-11-03",
      description: "ACH HARDWOOD SUPPLY",
    });
    await b.inA((tx) => settle(tx, b.who));
    expect((await b.txn("bp")).status).toBe("needs_review");
    await b.A.feedRemoved("bp");
    await b.more({
      id: "bp2",
      amount: "4200.00",
      date: "2026-11-03",
      description: "ACH HARDWOOD SUPPLY",
    });
    await b.inA((tx) => settle(tx, b.who));
    await b.inA((tx) => settle(tx, b.who));
    expect(await b.txn("bp2")).toMatchObject({
      status: "needs_review",
      ext: {
        resentOf: (await b.txn("bp")).id,
        openItem: { kind: "bill", transactionId: bill, confirmed: true },
      },
    });
  });

  // docs/plan.md §1.187: the check right before each write (template v6).
  it("refuses a copy's write while the earlier copy's waits for a signature, and records the one write", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    await b.inA(async (tx) =>
      propose(tx, b.who, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
        confidence: 0.95,
        reason: "software",
      }),
    );
    const first = await b.inA(async (tx) => approve(tx, b.person, (await b.txn("s")).id));
    // Laid out, checked and proposed for a signature, as the posting loop does.
    const laid = await b.inA((tx) => qboInput(tx, b.A.tenantId, first));
    expect(laid.references).toEqual([`bt-${(await b.txn("s")).id}`]);
    expect(await b.inA((tx) => writeCheck(tx, b.A.tenantId, first))).toMatchObject({
      clear: true,
    });
    const [proposal] = await t.db
      .insert(externalAction)
      .values({
        tenantId: b.A.tenantId,
        connectionId: b.A.qboConnectionId,
        tool: BANKING_TOOLS.purchaseCreate,
        input: laid.purchase ?? {},
        idempotencyKey: `run-s:write-purchase:${first}`,
      })
      .returning();
    if (!proposal) throw new Error("no proposal");
    // The bank sends it again; a person books the new copy.
    await b.A.feedRemoved("s");
    await b.more({ id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    const second = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s2")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    const ready = async () =>
      (
        (await tool("bookkeeping.bookings.ready").run({ limit: 25 }, b.ctx())) as {
          bookings: { bookingId: string }[];
        }
      ).bookings.map((x) => x.bookingId);
    expect(await ready()).toEqual([second]);
    // Its layout names both copies' marks, its own first; the check refuses its write.
    const copy = await b.inA((tx) => qboInput(tx, b.A.tenantId, second));
    expect(copy.references).toEqual([
      `bt-${(await b.txn("s2")).id}`,
      `bt-${(await b.txn("s")).id}`,
    ]);
    const check = () => tool("bookkeeping.booking.write-check").run({ bookingId: second }, b.ctx());
    await expect(check()).rejects.toThrow(
      "An earlier copy of this transaction is waiting for a signature",
    );
    // Signed and being made, made, or perhaps made: still refused.
    for (const [status, words] of [
      ["approved", "is being written to QuickBooks"],
      ["executing", "is being written to QuickBooks"],
      ["failed", "may have reached QuickBooks"],
      ["done", "was written to QuickBooks (631)"],
    ] as const) {
      await t.db
        .update(externalAction)
        .set({ status, result: status === "done" ? { id: "631" } : null })
        .where(eq(externalAction.id, proposal.id));
      await expect(check(), status).rejects.toThrow(words);
    }
    // The earlier copy's write is recorded: the copy is that write, and nothing is ready.
    await b.posted(first, "purchase", "631");
    expect(await b.liveOf("s2")).toMatchObject({ status: "posted", qboId: "631" });
    expect(await ready()).toEqual([]);
    await expect(check()).rejects.toThrow("nothing to write");
  });

  it("lets a copy be written once the earlier copy's write was turned down or never sent", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    const first = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    const laid = await b.inA((tx) => qboInput(tx, b.A.tenantId, first));
    const [proposal] = await t.db
      .insert(externalAction)
      .values({
        tenantId: b.A.tenantId,
        connectionId: b.A.qboConnectionId,
        tool: BANKING_TOOLS.purchaseCreate,
        input: laid.purchase ?? {},
        idempotencyKey: `run-s:write-purchase:${first}`,
        status: "rejected",
      })
      .returning();
    if (!proposal) throw new Error("no proposal");
    await b.A.feedRemoved("s");
    await b.more({ id: "s2", amount: "39.99", date: "2026-11-03", merchantName: "Figma" });
    await b.inA((tx) => settle(tx, b.who));
    // A person books the new copy.
    const second = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s2")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    expect(await b.inA((tx) => writeCheck(tx, b.A.tenantId, second))).toMatchObject({
      clear: true,
    });
    // A write the platform knows wasn't sent is no write either.
    await t.db
      .update(externalAction)
      .set({ status: "failed", error: { message: "held", notWritten: true } })
      .where(eq(externalAction.id, proposal.id));
    expect(await b.inA((tx) => writeCheck(tx, b.A.tenantId, second))).toMatchObject({
      clear: true,
    });
  });

  it("refuses a booking's write while this transaction's write for an earlier booking waits or was made", async () => {
    const b = await books(
      [{ account: CHECKING, ledger: "Checking" }],
      [{ id: "s", amount: "39.99", date: "2026-11-03", merchantName: "Figma" }],
    );
    await b.inA((tx) => settle(tx, b.who));
    const first = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Software ?? "" }],
      }),
    );
    const laid = await b.inA((tx) => qboInput(tx, b.A.tenantId, first));
    const [proposal] = await t.db
      .insert(externalAction)
      .values({
        tenantId: b.A.tenantId,
        connectionId: b.A.qboConnectionId,
        tool: BANKING_TOOLS.purchaseCreate,
        input: laid.purchase ?? {},
        idempotencyKey: `run-s:write-purchase:${first}`,
      })
      .returning();
    if (!proposal) throw new Error("no proposal");
    // While the purchase waits for its signature, a person books it again: a transfer now.
    const second = await b.inA(async (tx) =>
      bookByPerson(tx, b.person, {
        bankTxnId: (await b.txn("s")).id,
        lines: [{ ledgerAccountId: b.A.accounts.Savings ?? "" }],
      }),
    );
    expect(second).not.toBe(first);
    expect((await b.inA((tx) => qboInput(tx, b.A.tenantId, second))).entity).toBe("transfer");
    const check = () => b.inA((tx) => writeCheck(tx, b.A.tenantId, second));
    await expect(check()).rejects.toThrow(
      "This transaction's write from an earlier run is waiting for a signature",
    );
    for (const [status, words] of [
      ["approved", "is being written to QuickBooks"],
      ["executing", "is being written to QuickBooks"],
      ["done", "was written to QuickBooks (632): this booking isn't written again"],
    ] as const) {
      await t.db
        .update(externalAction)
        .set({ status, result: status === "done" ? { id: "632" } : null })
        .where(eq(externalAction.id, proposal.id));
      await expect(check(), status).rejects.toThrow(words);
    }
    // Turned down, or failed: the transfer may be written (a retry of a failed write is the next
    // run's read of QuickBooks and the connector's to catch).
    for (const status of ["rejected", "failed"] as const) {
      await t.db
        .update(externalAction)
        .set({ status, result: null })
        .where(eq(externalAction.id, proposal.id));
      expect(await check(), status).toMatchObject({ clear: true });
    }
  });
});
