// The Bookkeeping area end to end at the pack's level (docs/plan.md §1.79), as cs_worker: the import
// from the feed's raw records, settling (skip, match, transfer, rule), the model's proposals, a
// person's decisions and learning, the chart's notes and questions, the QuickBooks inputs, and
// nothing of one client in another's.

import {
  closeDb,
  createDb,
  type Db,
  ledgerAccountNote,
  type Tx,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAccounts, unclearAccounts } from "./accounts";
import {
  ACCOUNT_QUESTIONS,
  BOOKINGS_REVIEW,
  BOOKKEEPING_ACTIONS,
  BOOKKEEPING_REPORTS,
  BOOKKEEPING_REVIEWS,
} from "./api";
import { learn, propose, settle } from "./bookings";
import { importFeeds } from "./feed";
import { BOOKKEEPING_HANDLERS } from "./manifest";
import type { PackToolContext } from "./pack";
import { payeeKey } from "./payee";
import { qboInput } from "./posting";
import { bankAccountLink, bankTxn, booking, bookingLine, bookingRule } from "./schema";
import { AMEX, type BooksFixture, CHECKING, insertBooks } from "./testing.test-helper";

const online = await databaseAvailable();

describe("payeeKey", () => {
  it("keeps who was paid and drops store numbers, card words and processors", () => {
    expect(payeeKey("SQ *BLUE BOTTLE 1234 OAKLAND CA")).toBe("blue bottle oakland ca");
    expect(payeeKey("SQ *BLUE BOTTLE 5678 OAKLAND CA")).toBe("blue bottle oakland ca");
    expect(payeeKey("POS DEBIT HOME DEPOT #4521")).toBe("home depot");
    expect(payeeKey("ACH PMT ADOBE INC")).toBe("adobe");
    expect(payeeKey("Shell")).toBe("shell");
    expect(payeeKey("12345 678")).toBe("");
    expect(payeeKey(null)).toBe("");
  });
});

describe.skipIf(!online)("bookkeeping (database, as cs_worker)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: BooksFixture;
  let B: BooksFixture;
  const who = () => ({ tenantId: A.tenantId, agentVersionId: A.agentVersionId, runId: null });
  const person = () => ({ tenantId: A.tenantId, userId: A.userId });
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, A.tenantId, fn);
  const txnId = async (externalId: string) => {
    const [row] = await t.db.select().from(bankTxn).where(eq(bankTxn.externalId, externalId));
    if (!row) throw new Error(`no bank_txn ${externalId}`);
    return row;
  };
  const linkOf = async (externalAccountId: string, books = A) => {
    const [row] = await t.db
      .select()
      .from(bankAccountLink)
      .where(
        and(
          eq(bankAccountLink.tenantId, books.tenantId),
          eq(bankAccountLink.externalAccountId, externalAccountId),
        ),
      );
    if (!row) throw new Error(`no link ${externalAccountId}`);
    return row;
  };
  const action = (name: string, input: unknown, books = A) => {
    const handler = BOOKKEEPING_ACTIONS[name];
    if (!handler) throw new Error(name);
    return handler.run(db, {
      tenantId: books.tenantId,
      userId: books.userId,
      input: handler.input.parse(input),
    });
  };
  const toolCtx = (mode: "live" | "test" = "live", settings = {}): PackToolContext => ({
    tenantId: A.tenantId,
    agentVersionId: A.agentVersionId,
    runId: null,
    mode,
    settings,
    db,
    llm: null,
  });
  const tool = (id: string) => {
    const h = BOOKKEEPING_HANDLERS[id];
    if (!h) throw new Error(id);
    return h;
  };

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertBooks(t.db, "Cabinet shop A");
    B = await insertBooks(t.db, "Cabinet shop B");
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("imports the feed: accounts off until linked, pending then posted once, a removal, nothing twice", async () => {
    await A.feed({
      id: "p-1",
      amount: "12.50",
      date: "2026-11-01",
      pending: true,
      merchantName: "Shell",
    });
    await A.feed({
      id: "t-2",
      amount: "64.00",
      date: "2026-11-02",
      merchantName: "Home Depot #4521",
    });
    await A.feed({ id: "t-3", amount: "9.99", date: "2026-11-02", merchantName: "Spotify" });
    await A.feed({
      id: "c-1",
      account: AMEX,
      amount: "48.10",
      date: "2026-11-03",
      merchantName: "Rockler",
    });
    const first = await inA((tx) => importFeeds(tx, A.tenantId));
    expect(first).toMatchObject({
      connections: 1,
      read: 4,
      accounts: 2,
      added: 4,
      removed: 0,
      more: false,
    });
    expect((await linkOf(CHECKING.id)).mode).toBe("off");
    expect((await linkOf(AMEX.id)).kind).toBe("card");
    expect((await txnId("p-1")).status).toBe("pending");
    // It posts under a new id, and the bank drops the third.
    await A.feed({
      id: "t-1",
      amount: "12.50",
      date: "2026-11-01",
      pendingTransactionId: "p-1",
      merchantName: "Shell",
    });
    await A.feedRemoved("p-1");
    await A.feedRemoved("t-3");
    const second = await inA((tx) => importFeeds(tx, A.tenantId));
    expect(second).toMatchObject({ read: 3, added: 1, removed: 2 });
    expect((await txnId("p-1")).status).toBe("removed");
    expect((await txnId("p-1")).ext).toMatchObject({ postedAs: "t-1" });
    expect(await txnId("t-1")).toMatchObject({
      status: "new",
      amount: "12.5000",
      payeeKey: "shell",
    });
    expect((await txnId("t-3")).status).toBe("removed");
    const again = await inA((tx) => importFeeds(tx, A.tenantId));
    expect(again).toMatchObject({ read: 0, added: 0 });
  });

  it("skips what isn't on; a person links an account and switches it on", async () => {
    const off = await inA((tx) => settle(tx, who()));
    expect(off).toMatchObject({ skipped: 3, open: [] });
    await expect(
      action("link-account", {
        linkId: (await linkOf(CHECKING.id)).id,
        ledgerAccountId: A.accounts["Fuel"],
        mode: "book",
      }),
    ).rejects.toThrow("not a bank or card account");
    await expect(
      action("link-account", {
        linkId: (await linkOf(CHECKING.id)).id,
        ledgerAccountId: null,
        mode: "book",
      }),
    ).rejects.toThrow("before switching it on");
    await action("link-account", {
      linkId: (await linkOf(CHECKING.id)).id,
      ledgerAccountId: A.accounts.Checking,
      mode: "book",
      bookFrom: "2026-11-01",
    });
    await action("link-account", {
      linkId: (await linkOf(AMEX.id)).id,
      ledgerAccountId: A.accounts.Amex,
      mode: "book",
    });
    await expect(
      action("link-account", {
        linkId: (await linkOf(AMEX.id)).id,
        ledgerAccountId: A.accounts.Checking,
        mode: "book",
      }),
    ).rejects.toThrow("already linked");
  });

  it("matches what is already in QuickBooks, pairs a card payment, applies a person's rule, leaves the rest", async () => {
    // Already in QuickBooks: the Amex charge, entered by the client, two days later.
    const existing = await A.qboPurchase({
      id: "501",
      total: "48.1000",
      date: "2026-11-05",
      accountQboId: "41",
    });
    // A card payment: out of checking, into the card, a day apart.
    await A.feed({
      id: "x-out",
      amount: "500.00",
      date: "2026-11-04",
      description: "AMEX EPAYMENT ACH PMT",
    });
    await A.feed({
      id: "x-in",
      account: AMEX,
      amount: "500.00",
      direction: "in",
      date: "2026-11-05",
      description: "PAYMENT THANK YOU",
    });
    // A rule for Home Depot.
    await action("add-rule", {
      payee: "HOME DEPOT",
      direction: "out",
      ledgerAccountId: A.accounts["Job Materials"],
    });
    await inA((tx) => importFeeds(tx, A.tenantId));
    const r = await inA((tx) => settle(tx, who()));
    expect(r).toMatchObject({ matched: 1, transfers: 1, ruled: 1 });
    expect(r.open).toEqual([(await txnId("t-1")).id]);
    expect((await txnId("c-1")).status).toBe("matched");
    const [m] = await t.db
      .select()
      .from(booking)
      .where(eq(booking.bankTxnId, (await txnId("c-1")).id));
    expect(m).toMatchObject({
      kind: "match",
      status: "posted",
      matchedTransactionId: existing,
      qboId: "501",
    });
    expect((await txnId("x-out")).status).toBe("proposed");
    expect((await txnId("x-in")).status).toBe("matched");
    const [xfer] = await t.db
      .select()
      .from(booking)
      .where(eq(booking.bankTxnId, (await txnId("x-out")).id));
    expect(xfer).toMatchObject({
      kind: "transfer",
      decidedBy: "match",
      transferLinkId: (await linkOf(AMEX.id)).id,
    });
    const [hd] = await t.db
      .select()
      .from(booking)
      .where(eq(booking.bankTxnId, (await txnId("t-2")).id));
    expect(hd).toMatchObject({ kind: "expense", decidedBy: "rule", confidence: "1.000" });
    const [line] = await t.db
      .select()
      .from(bookingLine)
      .where(eq(bookingLine.bookingId, hd?.id ?? ""));
    expect(line).toMatchObject({ ledgerAccountId: A.accounts["Job Materials"], amount: "64.0000" });
    // Again: nothing new.
    expect(await inA((tx) => settle(tx, who()))).toMatchObject({
      matched: 0,
      transfers: 0,
      ruled: 0,
    });
  });

  it("takes the model's proposal: lines must add up, accounts must be active; unsure goes to a person", async () => {
    const shell = await txnId("t-1");
    await expect(
      inA((tx) =>
        propose(tx, who(), {
          bankTxnId: shell.id,
          lines: [
            { ledgerAccountId: A.accounts.Fuel ?? "", amount: "10.00" },
            { ledgerAccountId: A.accounts["Shop Supplies"] ?? "", amount: "2.00" },
          ],
          confidence: 0.9,
          reason: "split",
        }),
      ),
    ).rejects.toThrow("add up to 12.0000");
    await expect(
      inA((tx) =>
        propose(tx, who(), {
          bankTxnId: shell.id,
          lines: [{ ledgerAccountId: B.accounts.Fuel ?? "" }],
          confidence: 0.9,
          reason: "another client's account",
        }),
      ),
    ).rejects.toThrow("isn't one of this client's accounts");
    // Through the tool, in a test run: nothing recorded.
    const preview = await tool("bookkeeping.booking.propose").run(
      {
        bankTxnId: shell.id,
        lines: [{ ledgerAccountId: A.accounts.Fuel }],
        confidence: 0.6,
        reason: "Gas station",
      },
      toolCtx("test"),
    );
    expect(preview).toMatchObject({ recorded: false, status: "needs_review" });
    expect((await txnId("t-1")).status).toBe("new");
    const out = await tool("bookkeeping.booking.propose").run(
      {
        bankTxnId: shell.id,
        lines: [{ ledgerAccountId: A.accounts.Fuel }],
        confidence: 0.6,
        reason: "Shell is a gas station",
        alternatives: [A.accounts["Shop Supplies"]],
      },
      toolCtx(),
    );
    expect(out).toMatchObject({ recorded: true, status: "needs_review" });
    expect((await txnId("t-1")).status).toBe("needs_review");
    const listed = await tool("bookkeeping.transactions.to-review").run({}, toolCtx());
    expect(listed).toEqual({ bankTxnIds: [shell.id], count: 1 });
  });

  it("a person decides on the card: the 'why' becomes the client's note; two approvals learn a rule", async () => {
    const shell = await txnId("t-1");
    const card = BOOKKEEPING_REVIEWS[BOOKINGS_REVIEW];
    if (!card) throw new Error("no card");
    const view = await inA((tx) => card.load(tx, A.tenantId, { bankTxnIds: [shell.id] }));
    const txns = view.transactions as {
      id: string;
      booking: { decidedBy: string; reason: string; alternatives: string[] };
    }[];
    expect(txns[0]?.booking).toMatchObject({
      decidedBy: "model",
      reason: "Shell is a gas station",
      alternatives: [A.accounts["Shop Supplies"]],
    });
    expect((view.accounts as unknown[]).length).toBe(8);
    // Not part of this card: refused.
    await expect(
      card.decide(db, {
        tenantId: A.tenantId,
        userId: A.userId,
        payload: { bankTxnIds: [shell.id] },
        decision: { action: "approve", input: { bankTxnId: (await txnId("t-2")).id } },
        testRun: false,
      }),
    ).rejects.toThrow("isn't part of this review");
    await card.decide(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: { bankTxnIds: [shell.id] },
      decision: {
        action: "book",
        input: {
          bankTxnId: shell.id,
          lines: [{ ledgerAccountId: A.accounts.Fuel }],
          why: "Gas for the delivery van",
        },
      },
      testRun: false,
    });
    expect((await txnId("t-1")).status).toBe("approved");
    const notes = await t.db
      .select()
      .from(ledgerAccountNote)
      .where(eq(ledgerAccountNote.ledgerAccountId, A.accounts.Fuel ?? ""));
    expect(notes.map((n) => [n.note, n.source, n.userId])).toEqual([
      ["Gas for the delivery van", "client", A.userId],
    ]);
    // One approval isn't a rule yet; a second Shell, approved, is.
    expect(await t.db.select().from(bookingRule).where(eq(bookingRule.payeeKey, "shell"))).toEqual(
      [],
    );
    await A.feed({ id: "t-4", amount: "40.00", date: "2026-11-06", merchantName: "SHELL 5741" });
    await inA((tx) => importFeeds(tx, A.tenantId));
    expect((await inA((tx) => settle(tx, who()))).open).toEqual([(await txnId("t-4")).id]);
    const t4 = await txnId("t-4");
    await inA((tx) =>
      propose(tx, who(), {
        bankTxnId: t4.id,
        lines: [{ ledgerAccountId: A.accounts.Fuel ?? "" }],
        confidence: 0.95,
        reason: "Shell again",
      }),
    );
    expect((await txnId("t-4")).status).toBe("proposed");
    await card.decide(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: { bankTxnIds: [t4.id] },
      decision: { action: "approve", input: { bankTxnId: t4.id } },
      testRun: false,
    });
    const [rule] = await t.db
      .select()
      .from(bookingRule)
      .where(and(eq(bookingRule.tenantId, A.tenantId), eq(bookingRule.payeeKey, "shell")));
    expect(rule).toMatchObject({
      source: "learned",
      active: true,
      ledgerAccountId: A.accounts.Fuel,
    });
    // The next Shell is booked by the rule; a person who books it elsewhere turns the rule off.
    await A.feed({ id: "t-5", amount: "35.00", date: "2026-11-07", merchantName: "Shell" });
    await inA((tx) => importFeeds(tx, A.tenantId));
    expect(await inA((tx) => settle(tx, who()))).toMatchObject({ ruled: 1 });
    const t5 = await txnId("t-5");
    await card.decide(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: { bankTxnIds: [t5.id] },
      decision: {
        action: "book",
        input: { bankTxnId: t5.id, lines: [{ ledgerAccountId: A.accounts["Shop Supplies"] }] },
      },
      testRun: false,
    });
    const [after] = await t.db
      .select()
      .from(bookingRule)
      .where(eq(bookingRule.id, rule?.id ?? ""));
    expect(after?.active).toBe(false);
    const t5Bookings = await t.db.select().from(booking).where(eq(booking.bankTxnId, t5.id));
    expect(t5Bookings.map((b) => [b.decidedBy, b.status]).sort()).toEqual([
      ["person", "approved"],
      ["rule", "superseded"],
    ]);
    // A person may leave one out.
    await card.decide(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: { bankTxnIds: [t5.id] },
      decision: { action: "exclude", input: { bankTxnId: t5.id, why: "Personal" } },
      testRun: false,
    });
    expect((await txnId("t-5")).status).toBe("excluded");
    // learn() is safe to call with nothing to learn.
    expect(await inA(async (tx) => learn(tx, person(), await txnId("t-2")))).toBeNull();
  });

  it("lists the chart with the client's words first and the payees booked there; asks about the undescribed", async () => {
    await expect(
      tool("bookkeeping.account.note").run(
        { ledgerAccountId: A.accounts.Fuel, note: "Gas for the vans", sources: [] },
        toolCtx(),
      ),
    ).rejects.toThrow();
    const shellBooking = (
      await t.db
        .select()
        .from(booking)
        .where(eq(booking.bankTxnId, (await txnId("t-4")).id))
    )[0];
    await tool("bookkeeping.account.note").run(
      {
        ledgerAccountId: A.accounts.Fuel,
        note: "Shell, every week or so.",
        sources: [shellBooking?.id],
      },
      toolCtx(),
    );
    const [fuel] = await inA((tx) =>
      listAccounts(tx, A.tenantId, { ids: [A.accounts.Fuel ?? ""] }),
    );
    expect(fuel?.notes.map((n) => n.source)).toEqual(["client", "agent"]);
    // One payee however the bank spelled it.
    expect(fuel?.examples).toHaveLength(1);
    expect(fuel?.examples[0]?.times).toBe(2);
    expect(["Shell", "SHELL 5741"]).toContain(fuel?.examples[0]?.payee);
    const unclear = await inA((tx) =>
      unclearAccounts(tx, A.tenantId, { prefer: [A.accounts.Software ?? ""] }),
    );
    expect(unclear[0]?.name).toBe("Software");
    expect(unclear.map((a) => a.name)).not.toContain("Fuel");
    expect(unclear.map((a) => a.name)).not.toContain("Checking");
    // The client answers the question card: its own note, and Software is no longer unclear.
    const q = BOOKKEEPING_REVIEWS[ACCOUNT_QUESTIONS];
    if (!q) throw new Error("no card");
    const view = await inA((tx) =>
      q.load(tx, A.tenantId, { ledgerAccountIds: [A.accounts.Software] }),
    );
    expect((view.accounts as { fullName: string }[])[0]?.fullName).toBe("Software");
    await q.decide(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: { ledgerAccountIds: [A.accounts.Software] },
      decision: {
        action: "answer",
        input: { ledgerAccountId: A.accounts.Software, answer: "Design software subscriptions" },
      },
      testRun: false,
    });
    const after = await inA((tx) => unclearAccounts(tx, A.tenantId));
    expect(after.map((a) => a.name)).not.toContain("Software");
  });

  it("lays out each approved booking as the QuickBooks write it needs", async () => {
    // The Home Depot rule booking and the card payment, approved.
    const card = BOOKKEEPING_REVIEWS[BOOKINGS_REVIEW];
    if (!card) throw new Error("no card");
    for (const ext of ["t-2", "x-out"]) {
      const id = (await txnId(ext)).id;
      await card.decide(db, {
        tenantId: A.tenantId,
        userId: A.userId,
        payload: { bankTxnIds: [id] },
        decision: { action: "approve", input: { bankTxnId: id } },
        testRun: false,
      });
    }
    const ready = (await tool("bookkeeping.bookings.ready").run({}, toolCtx())) as {
      bookings: { bookingId: string; kind: string }[];
    };
    expect(ready.bookings.map((b) => b.kind).sort()).toEqual([
      "expense",
      "expense",
      "expense",
      "transfer",
    ]);
    const byTxn = async (ext: string) =>
      (
        await t.db
          .select()
          .from(booking)
          .where(and(eq(booking.bankTxnId, (await txnId(ext)).id), eq(booking.status, "approved")))
      )[0]?.id ?? "";
    const hd = await inA(async (tx) => qboInput(tx, A.tenantId, await byTxn("t-2")));
    expect(hd).toMatchObject({
      entity: "purchase",
      purchase: {
        accountId: "35",
        paymentType: "Cash",
        credit: false,
        expectedTotal: "64.00",
        txnDate: "2026-11-02",
        lines: [{ accountId: "80", amount: "64.00" }],
      },
    });
    expect(hd.purchase?.reference).toMatch(/^bk-/);
    const xfer = await inA(async (tx) => qboInput(tx, A.tenantId, await byTxn("x-out")));
    expect(xfer).toMatchObject({
      entity: "transfer",
      transfer: { fromAccountId: "35", toAccountId: "41", amount: "500.00", txnDate: "2026-11-04" },
    });
    // Posted: the booking and the transaction say so; a second record of it changes nothing.
    const posted = tool("bookkeeping.booking.posted");
    const bk = await byTxn("t-2");
    expect(
      await posted.run({ bookingId: bk, entity: "purchase", qboId: "601" }, toolCtx()),
    ).toMatchObject({ recorded: true, status: "posted" });
    expect(
      await posted.run({ bookingId: bk, entity: "purchase", qboId: "601" }, toolCtx()),
    ).toMatchObject({ recorded: false });
    expect((await txnId("t-2")).status).toBe("posted");
    // An account set to suggest only: not ready, and its input is refused.
    await action("link-account", {
      linkId: (await linkOf(AMEX.id)).id,
      ledgerAccountId: A.accounts.Amex,
      mode: "suggest",
    });
    const shellBk = await byTxn("t-1");
    expect(await inA((tx) => qboInput(tx, A.tenantId, shellBk))).toMatchObject({
      entity: "purchase",
    });
  });

  it("on an account set to suggest, a proposal gives way once the client enters it in QuickBooks", async () => {
    await action("add-rule", {
      payee: "Rockler",
      direction: "out",
      ledgerAccountId: A.accounts["Shop Supplies"],
    });
    await A.feed({
      id: "c-2",
      account: AMEX,
      amount: "22.40",
      date: "2026-11-07",
      merchantName: "Rockler",
    });
    await inA((tx) => importFeeds(tx, A.tenantId));
    expect(await inA((tx) => settle(tx, who()))).toMatchObject({ ruled: 1 });
    expect((await txnId("c-2")).status).toBe("proposed");
    // Not ready to write: the account only suggests.
    const ready = (await tool("bookkeeping.bookings.ready").run({}, toolCtx())) as {
      bookings: unknown[];
    };
    const c2 = await txnId("c-2");
    const live = await t.db.select().from(booking).where(eq(booking.bankTxnId, c2.id));
    expect(ready.bookings).not.toContainEqual(expect.objectContaining({ bookingId: live[0]?.id }));
    // Nothing in QuickBooks yet: the proposal stands.
    expect(await inA((tx) => settle(tx, who()))).toMatchObject({ matched: 0 });
    expect((await txnId("c-2")).status).toBe("proposed");
    // The client enters it; the next pass matches it.
    await A.qboPurchase({ id: "502", total: "22.4000", date: "2026-11-07", accountQboId: "41" });
    expect(await inA((tx) => settle(tx, who()))).toMatchObject({ matched: 1 });
    expect((await txnId("c-2")).status).toBe("matched");
    const after = await t.db.select().from(booking).where(eq(booking.bankTxnId, c2.id));
    expect(after.map((b) => [b.kind, b.status]).sort()).toEqual([
      ["expense", "superseded"],
      ["match", "posted"],
    ]);
  });

  it("reports the transactions and the rules; client B sees none of A's", async () => {
    const report: Record<string, unknown> = await inA(
      (tx) =>
        BOOKKEEPING_REPORTS.transactions?.json(tx, A.tenantId, "2026-11-08") ?? Promise.resolve({}),
    );
    expect((report.counts as Record<string, number>).posted).toBe(1);
    expect((report.accounts as unknown[]).length).toBe(2);
    const csv = await inA(
      (tx) => BOOKKEEPING_REPORTS.transactions?.csv(tx, A.tenantId, "") ?? Promise.resolve(""),
    );
    expect(csv.split("\n")[0]).toBe(
      "date,account,payee,direction,amount,currency,status,booked_to",
    );
    await withTenant(db, B.tenantId, async (tx) => {
      expect(await tx.select().from(bankTxn)).toEqual([]);
      expect(await tx.select().from(booking)).toEqual([]);
      expect(await tx.select().from(bookingRule)).toEqual([]);
      expect(await tx.select().from(ledgerAccountNote)).toEqual([]);
      const b = await BOOKKEEPING_REPORTS.transactions?.json(tx, B.tenantId, "");
      expect(b?.transactions).toEqual([]);
    });
    // B's link action can't reach A's account.
    await expect(
      action(
        "link-account",
        { linkId: (await linkOf(AMEX.id)).id, ledgerAccountId: B.accounts.Amex, mode: "book" },
        B,
      ),
    ).rejects.toThrow("isn't on this client's feed");
  });
});
