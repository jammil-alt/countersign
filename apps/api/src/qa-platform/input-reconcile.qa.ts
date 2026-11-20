// INPUT lens: bookkeeping reconciliation inputs (currencies, amounts at the column's edge, the
// period's day). Driven through the pack's real tools (`bookkeeping.reconcile`,
// `bookkeeping.reconcile.pairs`) as cs_worker, as store.test.ts does.

import { closeDb, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importFeeds } from "../../../../packs/bookkeeping/src/feed";
import { BOOKKEEPING_HANDLERS } from "../../../../packs/bookkeeping/src/manifest";
import type { PackToolContext } from "../../../../packs/bookkeeping/src/pack";
import { monthPeriod } from "../../../../packs/bookkeeping/src/reconcile/store";
import { bankTxn, reconciliation } from "../../../../packs/bookkeeping/src/schema";
import {
  type BooksFixture,
  insertBooks,
} from "../../../../packs/bookkeeping/src/testing.test-helper";

const online = await databaseAvailable();

describe("monthPeriod (the period `bookkeeping.reconcile.pairs` uses with no month named)", () => {
  it("INPUT-3: last month is the client's last month, not UTC's (Los Angeles, Nov 30 at 17:00)", () => {
    // 2026-11-30 17:00 in America/Los_Angeles is 2026-12-01 01:00 UTC. The client is still in
    // November, so "last month" is October. The tool has no time zone to pass: it calls
    // monthPeriod(new Date(), input.month).
    const at = new Date("2026-12-01T01:00:00Z");
    expect(monthPeriod(at)).toEqual({ periodStart: "2026-10-01", asOf: "2026-10-31" });
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
    if (db) await closeDb(db);
    await t?.drop();
  });

  const id = (ext: string) => {
    const v = ids[ext];
    if (!v) throw new Error(`no bank txn ${ext}: ${JSON.stringify(ids)}`);
    return v;
  };

  it("INPUT-1: refuses to sum a USD and a CAD bank transaction into one side", async () => {
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
    // Expected: a refusal (US$100 + C$100 is not 200 of anything). Today it balances.
    await expect(run).rejects.toThrow(/currenc/i);
  });

  it("INPUT-2: keeps side B's currency when side A is a statement given by a step", async () => {
    // A Canadian statement read by a step (side A, given) against the CAD account's transactions.
    const out = (await tool("bookkeeping.reconcile").run(
      {
        a: {
          source: "given",
          label: "Statement",
          closing: "60.00",
          items: [
            { id: "s-1", date: "2026-10-06", effect: "100.00" },
            { id: "s-2", date: "2026-10-07", effect: "-40.00" },
          ],
        },
        b: { source: "records", label: "CAD account", bankTxnIds: [id("cad-1"), id("cad-2")] },
        asOf: "2026-10-31",
        pairKey: "cad-pair",
      },
      ctx(A),
    )) as { reconciliationId: string; summary: string };
    const [row] = await t.db
      .select()
      .from(reconciliation)
      .where(eq(reconciliation.id, out.reconciliationId));
    // Expected: CAD (or a refusal to compare an unknown currency with CAD). Today: "USD", and the
    // client reads "Statement $60.00, CAD account $60.00".
    expect({ currency: row?.currency, summary: out.summary }).toEqual({
      currency: "CAD",
      summary: expect.not.stringContaining("$"),
    });
  });

  it("INPUT-4: an amount the input schema accepts is refused plainly, not by a database overflow", async () => {
    // The tool's Money accepts 12 integer digits; numeric(14,4) holds 10. A statement read with an
    // account number in the amount column (a common misread) reaches the insert.
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
  });
});
