// Reconciliation inputs (PLATFORM_QA INPUT-1 to INPUT-4): currencies on each side, amounts at the
// column's edge, and the client's own "last month". Driven through the pack's real tools as
// cs_worker, as store.test.ts does.

import { closeDb, createDb, type Db, tenant, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importFeeds } from "../feed";
import { BOOKKEEPING_HANDLERS } from "../manifest";
import type { PackToolContext } from "../pack";
import { bankTxn, reconciliation } from "../schema";
import { type BooksFixture, insertBooks } from "../testing.test-helper";
import { monthPeriod, ReconMoney } from "./store";

const online = await databaseAvailable();

describe("monthPeriod on the client's calendar", () => {
  it("(PLATFORM_QA INPUT-3) last month is the client's last month, not UTC's (Los Angeles, Nov 30 at 17:00)", () => {
    // 2026-11-30 17:00 in America/Los_Angeles is 2026-12-01 01:00 UTC. The client is still in
    // November, so "last month" is October.
    const at = new Date("2026-12-01T01:00:00Z");
    expect(monthPeriod(at, undefined, "America/Los_Angeles")).toEqual({
      periodStart: "2026-10-01",
      asOf: "2026-10-31",
    });
    // With no zone it is UTC's, as before; January's last month is last year's December.
    expect(monthPeriod(at)).toEqual({ periodStart: "2026-11-01", asOf: "2026-11-30" });
    expect(monthPeriod(new Date("2026-01-01T07:00:00Z"), undefined, "America/Los_Angeles")).toEqual(
      { periodStart: "2025-11-01", asOf: "2025-11-30" },
    );
  });
});

describe.skipIf(!online)("reconciliation inputs (database, as cs_worker)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: BooksFixture;
  const ctx = (books: BooksFixture): PackToolContext => ({
    tenantId: books.tenantId,
    agentVersionId: books.agentVersionId,
    runId: null,
    mode: "live",
    settings: {},
    db,
    llm: null,
  });
  const tool = (id: string) => {
    const h = BOOKKEEPING_HANDLERS[id];
    if (!h) throw new Error(id);
    return h;
  };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    for (const level of ["warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertBooks(t.db, "Cabinet shop A");
    await A.feed({ id: "usd-1", amount: "100.00", direction: "in", date: "2026-10-05" });
    await A.feed({ id: "cad-1", amount: "100.00", direction: "in", date: "2026-10-06" });
    await A.feed({ id: "cad-2", amount: "40.00", date: "2026-10-07" });
    await withTenant(db, A.tenantId, (tx) => importFeeds(tx, A.tenantId));
    const rows = await t.db.select().from(bankTxn).where(eq(bankTxn.tenantId, A.tenantId));
    for (const r of rows) {
      const ext = String(r.externalId ?? "");
      ids[ext] = r.id;
      // A Canadian-dollar account on the feed: Plaid gives CAD for these.
      if (ext.startsWith("cad-")) {
        await t.db.update(bankTxn).set({ currency: "CAD" }).where(eq(bankTxn.id, r.id));
      }
    }
  });
  afterAll(async () => {
    vi.useRealTimers();
    if (db) await closeDb(db);
    await t?.drop();
  });

  const id = (ext: string) => {
    const v = ids[ext];
    if (!v) throw new Error(`no bank txn ${ext}: ${JSON.stringify(ids)}`);
    return v;
  };

  it("(PLATFORM_QA INPUT-1) refuses to sum a USD and a CAD bank transaction into one side", async () => {
    const run = tool("bookkeeping.reconcile").run(
      {
        a: { source: "records", bankTxnIds: [id("usd-1"), id("cad-1")] },
        b: {
          source: "given",
          label: "Statement",
          closing: "200.00",
          items: [
            { id: "s-1", date: "2026-10-05", effect: "100.00" },
            { id: "s-2", date: "2026-10-06", effect: "100.00" },
          ],
        },
        asOf: "2026-10-31",
        pairKey: "mixed-a",
      },
      ctx(A),
    );
    await expect(run).rejects.toThrow(/currenc/i);
  });

  it("(PLATFORM_QA INPUT-2) keeps side B's currency when side A is a statement given by a step, and refuses two that differ", async () => {
    // A Canadian statement read by a step (side A, given) against the CAD account's transactions.
    const statement = {
      source: "given",
      label: "Statement",
      closing: "60.00",
      items: [
        { id: "s-1", date: "2026-10-06", effect: "100.00" },
        { id: "s-2", date: "2026-10-07", effect: "-40.00" },
      ],
    };
    const cad = { source: "records", label: "CAD account", bankTxnIds: [id("cad-1"), id("cad-2")] };
    const out = (await tool("bookkeeping.reconcile").run(
      { a: statement, b: cad, asOf: "2026-10-31", pairKey: "cad-pair" },
      ctx(A),
    )) as { reconciliationId: string; summary: string };
    const [row] = await t.db
      .select()
      .from(reconciliation)
      .where(eq(reconciliation.id, out.reconciliationId));
    expect({ currency: row?.currency, summary: out.summary }).toEqual({
      currency: "CAD",
      summary: expect.not.stringContaining("$"),
    });
    // A statement that says USD against the CAD account is refused.
    await expect(
      tool("bookkeeping.reconcile").run(
        { a: { ...statement, currency: "USD" }, b: cad, asOf: "2026-10-31", pairKey: "cad-usd" },
        ctx(A),
      ),
    ).rejects.toThrow(/same currency/);
  });

  it("(PLATFORM_QA INPUT-4) an amount past numeric(14,4) is refused plainly, not by a database overflow", async () => {
    // A statement read with an account number in the amount column (a common misread).
    const run = tool("bookkeeping.reconcile").run(
      {
        a: {
          source: "given",
          label: "Statement",
          closing: "123456789012.00",
          items: [{ id: "s-1", date: "2026-10-06", effect: "123456789012.00" }],
        },
        b: {
          source: "given",
          label: "QuickBooks",
          closing: "100.00",
          items: [{ id: "q-1", date: "2026-10-06", effect: "100.00" }],
        },
        asOf: "2026-10-31",
        pairKey: "overflow",
      },
      ctx(A),
    );
    await expect(run).rejects.toThrow(/amount|too large|at most/i);
    await expect(run).rejects.not.toThrow(/numeric field overflow|Failed query/i);
    // The tool's input refuses it before any work, in plain words.
    expect(ReconMoney.safeParse("123456789012.00").error?.issues[0]?.message).toMatch(
      /at most 10 digits before the point/,
    );
    expect(ReconMoney.safeParse("1234567890.1234").success).toBe(true);
    // Each figure fits, but the difference doesn't.
    await expect(
      tool("bookkeeping.reconcile").run(
        {
          a: { source: "given", label: "Statement", closing: "9999999999.00", items: [] },
          b: { source: "given", label: "QuickBooks", closing: "-9999999999.00", items: [] },
          asOf: "2026-10-31",
          pairKey: "overflow-difference",
        },
        ctx(A),
      ),
    ).rejects.toThrow(/difference is .*at most 10 digits/i);
  });

  it("(PLATFORM_QA INPUT-3) reconcile.pairs takes last month on the client's calendar", async () => {
    await t.db
      .update(tenant)
      .set({ timezone: "America/Los_Angeles" })
      .where(eq(tenant.id, A.tenantId));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T01:00:00Z"));
    try {
      const out = (await tool("bookkeeping.reconcile.pairs").run({}, ctx(A))) as {
        periodStart: string;
        asOf: string;
      };
      expect({ periodStart: out.periodStart, asOf: out.asOf }).toEqual({
        periodStart: "2026-10-01",
        asOf: "2026-10-31",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
