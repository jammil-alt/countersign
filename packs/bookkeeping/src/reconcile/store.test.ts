// R-1 (docs/plan.md §1.80) at the pack's level, as cs_worker: a month of the bank feed against
// QuickBooks' register explained by a deposit in transit, signed off on the card and carried into
// the next month where it clears; a side that doesn't add up refused; a residual a person explains
// before signing off; the model's proposal accepted on the card; a payout deposit against its
// statement as one group; test runs record nothing; one client never sees another's.

import { closeDb, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKKEEPING_ACTIONS, BOOKKEEPING_REPORTS, BOOKKEEPING_REVIEWS } from "../api";
import { importFeeds } from "../feed";
import { BOOKKEEPING_HANDLERS } from "../manifest";
import type { PackToolContext } from "../pack";
import { bankAccountLink, bankTxn, reconciliation, reconciliationItem } from "../schema";
import { type BooksFixture, CHECKING, insertBooks } from "../testing.test-helper";
import { RECONCILIATION_REVIEW } from "./api";
import { monthPeriod } from "./store";

const online = await databaseAvailable();

describe("monthPeriod", () => {
  it("is last month, or the month named", () => {
    expect(monthPeriod(new Date("2026-11-03T12:00:00Z"))).toEqual({
      periodStart: "2026-10-01",
      asOf: "2026-10-31",
    });
    expect(monthPeriod(new Date("2026-01-03T12:00:00Z"))).toEqual({
      periodStart: "2025-12-01",
      asOf: "2025-12-31",
    });
    expect(monthPeriod(new Date(), "2024-02")).toEqual({
      periodStart: "2024-02-01",
      asOf: "2024-02-29",
    });
  });
});

describe.skipIf(!online)("reconciliation (database, as cs_worker)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: BooksFixture;
  let B: BooksFixture;
  const ctx = (books: BooksFixture, mode: "live" | "test" = "live"): PackToolContext => ({
    tenantId: books.tenantId,
    agentVersionId: books.agentVersionId,
    runId: null,
    mode,
    settings: {},
    db,
    llm: null,
  });
  const tool = (id: string) => {
    const h = BOOKKEEPING_HANDLERS[id];
    if (!h) throw new Error(id);
    return h;
  };
  const card = BOOKKEEPING_REVIEWS[RECONCILIATION_REVIEW];
  const recReport = BOOKKEEPING_REPORTS.reconciliations;
  if (!card || !recReport) throw new Error("the reconciliation card and report are registered");
  const decide = (books: BooksFixture, reconciliationId: string, decision: object) =>
    card.decide(db, {
      tenantId: books.tenantId,
      userId: books.userId,
      payload: { reconciliationId },
      decision,
      testRun: false,
    });
  const load = (books: BooksFixture, reconciliationId: string) =>
    withTenant(db, books.tenantId, async (tx) => {
      const r = await card.load(tx, books.tenantId, { reconciliationId });
      return (r as { reconciliation: ReconView }).reconciliation;
    });
  interface ReconView {
    status: string;
    outcome: string;
    residual: string;
    summary: string;
    items: {
      id: string;
      side: string;
      ref: string;
      effect: string;
      state: string;
      label: string | null;
      carried: boolean;
    }[];
    matches: { id: string; method: string; status: string }[];
  }
  // QuickBooks' register for the checking account (`qbo.account.register`'s output, as given).
  const qbo = (
    opening: string,
    closing: string,
    items: { id: string; date: string; effect: string; reference?: string }[],
  ) => ({ source: "given" as const, label: "QuickBooks", opening, closing, items });
  let october = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertBooks(t.db, "Cabinet shop A");
    B = await insertBooks(t.db, "Cabinet shop B");
    // October and early November on the checking account, as the feed reads it.
    await A.feed({ id: "o-1", amount: "500.00", direction: "in", date: "2026-10-05" });
    await A.feed({ id: "o-2", amount: "80.00", date: "2026-10-12", merchantName: "Rockler" });
    await A.feed({ id: "o-3", amount: "120.00", date: "2026-10-20", description: "CHECK 1042" });
    await A.feed({ id: "n-1", amount: "250.00", direction: "in", date: "2026-11-02" });
    await A.feed({ id: "n-2", amount: "50.00", date: "2026-11-02", merchantName: "Shell" });
    await A.feed({ id: "n-3", amount: "9.00", date: "2026-11-03", pending: true });
    await withTenant(db, A.tenantId, (tx) => importFeeds(tx, A.tenantId));
    const [link] = await t.db
      .select()
      .from(bankAccountLink)
      .where(
        and(
          eq(bankAccountLink.tenantId, A.tenantId),
          eq(bankAccountLink.externalAccountId, CHECKING.id),
        ),
      );
    if (!link) throw new Error("no link");
    const handler = BOOKKEEPING_ACTIONS["link-account"];
    await handler?.run(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      input: handler.input.parse({
        linkId: link.id,
        ledgerAccountId: A.accounts.Checking,
        mode: "suggest",
      }),
    });
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("lists each linked account against its QuickBooks account, with its balance today", async () => {
    const out = (await tool("bookkeeping.reconcile.pairs").run(
      { month: "2026-10", accounts: [{ id: CHECKING.id, balances: { current: "1550.00" } }] },
      ctx(A),
    )) as { periodStart: string; asOf: string; pairs: Record<string, unknown>[] };
    expect(out).toMatchObject({ periodStart: "2026-10-01", asOf: "2026-10-31" });
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]).toMatchObject({
      ledgerExternalId: "35",
      ledgerName: "Checking",
      current: "1550.00",
      lastAsOf: null,
    });
    expect(String(out.pairs[0]?.pairKey)).toMatch(/^bank:.+\|qbo:.+:35$/);
    // Accounts the feed didn't answer for aren't listed; another client has none.
    const none = (await tool("bookkeeping.reconcile.pairs").run(
      { accounts: [{ id: "elsewhere", balances: { current: "1" } }] },
      ctx(A),
    )) as { count: number };
    expect(none.count).toBe(0);
    const other = (await tool("bookkeeping.reconcile.pairs").run({}, ctx(B))) as { count: number };
    expect(other.count).toBe(0);
  });

  it("explains October's difference with a deposit in transit, and a test run keeps nothing", async () => {
    const pairs = (await tool("bookkeeping.reconcile.pairs").run(
      { month: "2026-10", accounts: [{ id: CHECKING.id, balances: { current: "1550.00" } }] },
      ctx(A),
    )) as { pairs: { accountLinkId: string; pairKey: string; current: string }[] };
    const pair = pairs.pairs[0];
    if (!pair) throw new Error("no pair");
    const input = {
      a: { source: "bank_feed", accountLinkId: pair.accountLinkId, current: pair.current },
      b: qbo("1050.00", "1600.00", [
        { id: "qbo:Deposit:1", date: "2026-10-04", effect: "500.00" },
        { id: "qbo:Purchase:2", date: "2026-10-12", effect: "-80.00" },
        { id: "qbo:Check:3", date: "2026-10-20", effect: "-120.00", reference: "1042" },
        { id: "qbo:Deposit:4", date: "2026-10-31", effect: "250.00" },
      ]),
      periodStart: "2026-10-01",
      asOf: "2026-10-31",
      pairKey: pair.pairKey,
    };
    const dry = (await tool("bookkeeping.reconcile").run(input, ctx(A, "test"))) as Record<
      string,
      unknown
    >;
    expect(dry).toMatchObject({ recorded: false, reconciliationId: null, outcome: "explained" });
    expect(await t.db.select().from(reconciliation)).toHaveLength(0);

    const out = (await tool("bookkeeping.reconcile").run(input, ctx(A))) as Record<string, unknown>;
    // Today's 1,550 less November's +250 and −50 (the pending 9.00 isn't in the balance).
    expect(out).toMatchObject({
      recorded: true,
      outcome: "explained",
      aClosing: "1350.0000",
      bClosing: "1600.0000",
      difference: "-250.0000",
      residual: "0.0000",
      matched: 3,
      leftovers: 1,
      needsPerson: true,
    });
    expect(out.summary).toBe(
      "Checking …0001 $1,350.00, QuickBooks $1,600.00, difference −$250.00: 1 item left: QuickBooks $250.00 on 2026-10-31 (timing).",
    );
    // Its sources: the feed's raw records and QuickBooks' postings.
    expect((out.sources as string[]).filter((s) => s.startsWith("qbo:"))).toHaveLength(4);
    october = String(out.reconciliationId);
    const view = await load(A, october);
    expect(view.items.filter((i) => i.state === "unmatched")).toEqual([
      expect.objectContaining({ side: "b", ref: "qbo:Deposit:4", label: "timing" }),
    ]);
    expect(view.matches.map((m) => m.method).sort()).toEqual([
      "amount_date",
      "amount_date",
      "amount_date",
    ]);
  });

  it("refuses a side that doesn't add up", async () => {
    await expect(
      tool("bookkeeping.reconcile").run(
        {
          a: { source: "given", label: "Statement", opening: "100", closing: "150", items: [] },
          b: qbo("100", "100", []),
          asOf: "2026-10-31",
        },
        ctx(A),
      ),
    ).rejects.toThrow("Statement doesn't add up");
  });

  it("signs October off on the card, after which it never changes; another client can't see it", async () => {
    await decide(A, october, { action: "sign-off", input: { note: "Deposit cleared Nov 2" } });
    const view = await load(A, october);
    expect(view.status).toBe("signed_off");
    await expect(
      decide(A, october, {
        action: "add-item",
        input: { side: "a", effect: "1.00", description: "x" },
      }),
    ).rejects.toThrow("signed off and can't change");
    await expect(load(B, october)).rejects.toThrow("isn't one of this client's");
    await expect(decide(B, october, { action: "sign-off", input: {} })).rejects.toThrow(
      "isn't one of this client's",
    );
  });

  it("carries the deposit in transit into November, where it clears", async () => {
    const pairs = (await tool("bookkeeping.reconcile.pairs").run(
      { month: "2026-11", accounts: [{ id: CHECKING.id, balances: { current: "1550.00" } }] },
      ctx(A),
    )) as { pairs: { accountLinkId: string; pairKey: string; lastAsOf: string }[] };
    const pair = pairs.pairs[0];
    if (!pair) throw new Error("no pair");
    expect(pair.lastAsOf).toBe("2026-10-31");
    const out = (await tool("bookkeeping.reconcile").run(
      {
        a: { source: "bank_feed", accountLinkId: pair.accountLinkId, balance: "1550.00" },
        b: qbo("1600.00", "1550.00", [
          { id: "qbo:Purchase:5", date: "2026-11-02", effect: "-50.00" },
        ]),
        periodStart: "2026-11-01",
        asOf: "2026-11-30",
        pairKey: pair.pairKey,
      },
      ctx(A),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ outcome: "balanced", residual: "0.0000", matched: 2 });
    const view = await load(A, String(out.reconciliationId));
    expect(view.items.find((i) => i.carried)).toMatchObject({
      ref: "qbo:Deposit:4",
      state: "matched",
    });
    const [row] = await t.db
      .select()
      .from(reconciliation)
      .where(eq(reconciliation.id, String(out.reconciliationId)));
    expect(row?.carriedFromId).toBe(october);
  });

  it("won't sign off what isn't explained, until a person adds what one side is missing", async () => {
    const out = (await tool("bookkeeping.reconcile").run(
      {
        a: {
          source: "given",
          label: "Card statement",
          closing: "-35.00",
          items: [
            { id: "1", date: "2026-10-03", effect: "-20.00" },
            { id: "2", date: "2026-10-09", effect: "-15.00" },
          ],
        },
        b: {
          source: "given",
          label: "QuickBooks",
          closing: "-20.00",
          items: [{ id: "q1", date: "2026-10-03", effect: "-20.00" }],
        },
        asOf: "2026-10-31",
        pairKey: "test:card",
      },
      ctx(A),
    )) as Record<string, unknown>;
    // The statement's 15.00 isn't in QuickBooks: explained, as missing.
    expect(out).toMatchObject({ outcome: "explained", leftovers: 1 });
    const id = String(out.reconciliationId);

    const short = (await tool("bookkeeping.reconcile").run(
      {
        a: { source: "given", label: "Bank", closing: "100.00", items: [] },
        b: { source: "given", label: "QuickBooks", closing: "90.00", items: [] },
        asOf: "2026-10-31",
        pairKey: "test:short",
      },
      ctx(A),
    )) as Record<string, unknown>;
    expect(short).toMatchObject({ outcome: "unexplained", residual: "10.0000" });
    expect(short.summary).toContain("$10.00 isn't explained by the items we have.");
    const sid = String(short.reconciliationId);
    await expect(decide(A, sid, { action: "sign-off", input: {} })).rejects.toThrow(
      "isn't explained yet",
    );
    await decide(A, sid, {
      action: "add-item",
      input: { side: "a", date: "2026-10-30", effect: "10.00", description: "Interest not booked" },
    });
    const after = await load(A, sid);
    expect(after).toMatchObject({ outcome: "explained", residual: "0.0000" });
    await decide(A, sid, { action: "sign-off", input: {} });
    expect((await load(A, sid)).status).toBe("signed_off");

    // A person relabels the leftover and can sign the first one off as is.
    const left = (await load(A, id)).items.find((i) => i.state === "unmatched");
    await decide(A, id, { action: "label", input: { itemId: left?.id, label: "timing" } });
    expect((await load(A, id)).items.find((i) => i.id === left?.id)?.label).toBe("timing");
  });

  it("keeps the model's proposal for a person, who accepts it; a mismatched one is refused", async () => {
    const out = (await tool("bookkeeping.reconcile").run(
      {
        a: {
          source: "given",
          label: "Bank",
          closing: "300.00",
          items: [{ id: "b1", date: "2026-10-01", effect: "300.00", reference: "WIRE 77" }],
        },
        b: {
          source: "given",
          label: "QuickBooks",
          closing: "300.00",
          // Three weeks apart: outside the window, so code leaves it.
          items: [{ id: "q1", date: "2026-10-22", effect: "300.00", reference: "wire-77" }],
        },
        asOf: "2026-10-31",
        pairKey: "test:wire",
      },
      ctx(A),
    )) as Record<string, unknown>;
    const id = String(out.reconciliationId);
    expect(out).toMatchObject({ matched: 0, leftovers: 2 });
    const open = (await tool("bookkeeping.reconcile.open").run(
      { reconciliationId: id },
      ctx(A),
    )) as { unmatched: { id: string; side: string }[] };
    const a = open.unmatched.filter((i) => i.side === "a").map((i) => i.id);
    const b = open.unmatched.filter((i) => i.side === "b").map((i) => i.id);
    const proposed = (await tool("bookkeeping.reconcile.propose").run(
      {
        reconciliationId: id,
        aItemIds: a,
        bItemIds: b,
        reason: "The same wire, booked when the invoice was entered",
        confidence: 0.8,
      },
      ctx(A),
    )) as { matchId: string };
    // Proposals never count by themselves.
    let view = await load(A, id);
    expect(view.items.every((i) => i.state === "unmatched")).toBe(true);
    expect(view.matches).toEqual([
      expect.objectContaining({ id: proposed.matchId, method: "model", status: "proposed" }),
    ]);
    await decide(A, id, { action: "accept", input: { matchId: proposed.matchId } });
    view = await load(A, id);
    expect(view).toMatchObject({ outcome: "balanced", residual: "0.0000" });
    expect(view.items.every((i) => i.state === "matched")).toBe(true);
    // And a person can take it back.
    await decide(A, id, { action: "unmatch", input: { matchId: proposed.matchId } });
    expect((await load(A, id)).outcome).toBe("explained");

    const other = (await tool("bookkeeping.reconcile").run(
      {
        a: {
          source: "given",
          label: "Bank",
          closing: "5.00",
          items: [{ id: "x", effect: "5.00" }],
        },
        b: { source: "given", label: "QB", closing: "6.00", items: [{ id: "y", effect: "6.00" }] },
        asOf: "2026-10-31",
        pairKey: "test:mismatch",
      },
      ctx(A),
    )) as Record<string, unknown>;
    const oid = String(other.reconciliationId);
    const items = (await load(A, oid)).items;
    await expect(
      tool("bookkeeping.reconcile.propose").run(
        {
          reconciliationId: oid,
          aItemIds: items.filter((i) => i.side === "a").map((i) => i.id),
          bItemIds: items.filter((i) => i.side === "b").map((i) => i.id),
          reason: "close enough",
          confidence: 0.9,
        },
        ctx(A),
      ),
    ).rejects.toThrow("not the same money");
  });

  it("matches a payout deposit to its statement's lines as one group, and lists it in the report", async () => {
    const [deposit] = await t.db
      .select()
      .from(bankTxn)
      .where(and(eq(bankTxn.tenantId, A.tenantId), eq(bankTxn.externalId, "n-1")));
    const out = (await tool("bookkeeping.reconcile").run(
      {
        a: { source: "records", label: "Bank deposit", bankTxnIds: [deposit?.id] },
        b: {
          source: "given",
          label: "Payout statement",
          opening: null,
          closing: "250.00",
          items: [
            { id: "1", date: "2026-10-30", effect: "180.00", description: "Charge, Smith" },
            { id: "2", date: "2026-10-31", effect: "80.00", description: "Charge, Lee" },
            { id: "3", date: "2026-10-31", effect: "-2.50", description: "Refund" },
            { id: "4", date: "2026-10-31", effect: "-7.50", description: "Fees" },
          ],
        },
      },
      ctx(A),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ outcome: "balanced", matched: 1 });
    const view = await load(A, String(out.reconciliationId));
    expect(view.matches).toEqual([expect.objectContaining({ method: "group" })]);
    // Another client's transaction can't be named.
    await expect(
      tool("bookkeeping.reconcile").run(
        {
          a: { source: "records", bankTxnIds: [deposit?.id] },
          b: { source: "given", label: "x", closing: "250.00", items: [] },
        },
        ctx(B),
      ),
    ).rejects.toThrow("isn't one of this client's");
    const report = (await withTenant(db, A.tenantId, (tx) =>
      recReport.json(tx, A.tenantId, "2026-11-08"),
    )) as { reconciliations: { status: string }[] };
    expect(report.reconciliations.length).toBeGreaterThanOrEqual(6);
    const empty = (await withTenant(db, B.tenantId, (tx) =>
      recReport.json(tx, B.tenantId, "2026-11-08"),
    )) as { reconciliations: unknown[] };
    expect(empty.reconciliations).toEqual([]);
    const csv = await withTenant(db, A.tenantId, (tx) =>
      recReport.csv(tx, A.tenantId, "2026-11-08"),
    );
    expect(csv.split("\n")[0]).toBe(
      "as_of,side_a,balance_a,side_b,balance_b,difference,unexplained,currency,outcome,status",
    );
    expect(csv).toContain(",-250.0000,");
  });

  it("supersedes an open reconciliation of the same pair and day when run again", async () => {
    const run = () =>
      tool("bookkeeping.reconcile").run(
        {
          a: { source: "given", label: "A", closing: "1.00", items: [{ id: "1", effect: "1.00" }] },
          b: { source: "given", label: "B", closing: "0.00", items: [] },
          asOf: "2026-10-31",
          pairKey: "test:again",
        },
        ctx(A),
      ) as Promise<Record<string, unknown>>;
    const first = await run();
    const second = await run();
    const rows = await t.db
      .select({ id: reconciliation.id, status: reconciliation.status })
      .from(reconciliation)
      .where(eq(reconciliation.pairKey, "test:again"));
    expect(rows.find((r) => r.id === first.reconciliationId)?.status).toBe("superseded");
    expect(rows.find((r) => r.id === second.reconciliationId)?.status).toBe("open");
    const items = await t.db
      .select()
      .from(reconciliationItem)
      .where(eq(reconciliationItem.reconciliationId, String(second.reconciliationId)));
    expect(items).toHaveLength(1);
  });
});
