// Migrations 0032 and 0033 as the pack sees them: its tables match this pack's Drizzle schema, are
// marked as the pack's, force row-level security, give the runtime no DELETE, keep one alias per
// key, and one client never sees or writes another's catalog, requests or quotes (CLAUDE.md
// invariant 1). P-5 (0033): purchase requests, quotes, prices from QuickBooks bill lines. P-9
// (0036): a request line with no quantity yet, and a quote's reach-out.

import { document, type Tx, withTenant, withTenants } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import {
  catalogItem,
  itemAlias,
  itemMatch,
  MATERIALS_TABLES,
  priceObservation,
  purchaseRequest,
  purchaseRequestLine,
  quoteLine,
  quoteRequest,
} from "./schema";
import { insertShop, type ShopFixture } from "./testing.test-helper";

const online = await databaseAvailable();
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const HASH = "a".repeat(64);

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

async function tenantIdsIn(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx.execute<{ t: string }>(
    sql.raw(`select tenant_id::text as t from ${table}`),
  );
  return [...rows].map((r) => r.t);
}

describe.skipIf(!online)("materials tables (migration 0032)", () => {
  let t: TestDatabase;
  let A: ShopFixture;
  let B: ShopFixture;

  /** One row of the client in each of the pack's tables. */
  async function seedCatalog(shop: ShopFixture) {
    const vendorId = await shop.vendor("Northline Plywood");
    const [lineId] = await shop.invoice(vendorId, [{ description: "3/4 BB/BB BALTIC BIRCH 5X5" }]);
    const [item] = await t.db
      .insert(catalogItem)
      .values({
        tenantId: shop.tenantId,
        category: "sheet_goods",
        canonicalName: "Baltic birch plywood 3/4in 60x60in BB/BB",
        attributes: { material: "plywood", species: "baltic_birch" },
        standardUom: "sheet",
      })
      .returning();
    if (!item || !lineId) throw new Error("no item");
    await t.db.insert(itemAlias).values({
      tenantId: shop.tenantId,
      vendorId,
      descriptionHash: HASH,
      catalogItemId: item.id,
      source: "human",
    });
    await t.db.insert(itemMatch).values({
      tenantId: shop.tenantId,
      docLineId: lineId,
      catalogItemId: item.id,
      decision: "matched",
      confidence: "0.950",
      method: "rules",
      agentVersionId: shop.agentVersionId,
    });
    await t.db.insert(priceObservation).values({
      tenantId: shop.tenantId,
      catalogItemId: item.id,
      vendorId,
      observedOn: "2026-11-02",
      unitPriceStd: "92.5000",
      qtyStd: "10.0000",
      standardUom: "sheet",
      docLineId: lineId,
    });
    // P-5: a request with one line, an RFQ to the vendor and its answer.
    const [request] = await t.db
      .insert(purchaseRequest)
      .values({
        tenantId: shop.tenantId,
        channel: "sms",
        requestedByContactId: await shop.contact("Sam Ortiz"),
        neededBy: "2026-11-20",
        fulfillment: "delivery",
        agentVersionId: shop.agentVersionId,
      })
      .returning();
    if (!request) throw new Error("no request");
    const [requestLine] = await t.db
      .insert(purchaseRequestLine)
      .values({
        tenantId: shop.tenantId,
        purchaseRequestId: request.id,
        lineNo: 1,
        catalogItemId: item.id,
        matchMethod: "rules",
        description: "10 sheets 3/4 baltic birch",
        qty: "10",
        unit: "sheets",
      })
      .returning();
    if (!requestLine) throw new Error("no request line");
    const [quote] = await t.db
      .insert(quoteRequest)
      .values({ tenantId: shop.tenantId, purchaseRequestId: request.id, vendorId })
      .returning();
    if (!quote) throw new Error("no quote");
    await t.db.insert(quoteLine).values({
      tenantId: shop.tenantId,
      quoteRequestId: quote.id,
      purchaseRequestLineId: requestLine.id,
      catalogItemId: item.id,
      qty: "10",
      unit: "SHT",
      unitPrice: "61.2500",
      unitPriceStd: "61.2500",
      standardUom: "sheet",
      leadTimeDays: 2,
    });
    return {
      vendorId,
      itemId: item.id,
      lineId,
      requestId: request.id,
      requestLineId: requestLine.id,
      quoteId: quote.id,
    };
  }

  let rowsA: Awaited<ReturnType<typeof seedCatalog>>;
  let rowsB: Awaited<ReturnType<typeof seedCatalog>>;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    rowsA = await seedCatalog(A);
    rowsB = await seedCatalog(B);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("match this pack's Drizzle schema, every column with its nullability", async () => {
    const cols = await t.db.$client<
      { table_name: string; column_name: string; is_nullable: string }[]
    >`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name in ${t.db.$client([...MATERIALS_TABLES])}`;
    const actual = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable]));
    const expected = new Set<string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        expected.add(key);
        expect(actual.get(key), key).toBe(column.notNull ? "NO" : "YES");
      }
    }
    expect([...actual.keys()].filter((k) => !expected.has(k))).toEqual([]);
    expect(tables.map((x) => getTableConfig(x).name).sort()).toEqual([...MATERIALS_TABLES].sort());
  });

  it("are marked as the pack's and force RLS with a policy", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; policies: number; owner: string }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
        obj_description(c.oid, 'pg_class') as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client([...MATERIALS_TABLES])}`;
    expect(rows).toHaveLength(MATERIALS_TABLES.length);
    for (const r of rows) {
      expect(r.rls && r.forced, r.relname).toBe(true);
      expect(r.policies, r.relname).toBeGreaterThan(0);
      expect(r.owner, r.relname).toBe("pack:materials");
    }
  });

  it("give the runtime no DELETE, and only inserts on matching decisions", async () => {
    for (const table of [
      "purchase_request",
      "purchase_request_line",
      "quote_request",
      "quote_line",
    ]) {
      const update = (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, 'UPDATE') as ok`
      )[0]?.ok;
      expect(update, table).toBe(true);
    }
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of MATERIALS_TABLES) {
      expect(await can(table, "SELECT"), table).toBe(true);
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
      expect(await can(table, "TRUNCATE"), table).toBe(false);
    }
    expect(await can("catalog_item", "UPDATE")).toBe(true);
    expect(await can("item_alias", "UPDATE")).toBe(true);
    expect(await can("price_observation", "UPDATE")).toBe(true);
    expect(await can("item_match", "UPDATE")).toBe(false);
  });

  it("a client session sees only its own catalog, aliases, matches, prices, requests and quotes", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of MATERIALS_TABLES) {
        const ids = await tenantIdsIn(tx, table);
        expect(ids.length, table).toBeGreaterThan(0);
        expect(new Set(ids), table).toEqual(new Set([A.tenantId]));
      }
    });
    await withTenants(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of MATERIALS_TABLES) expect(await tenantIdsIn(tx, table), table).toEqual([]);
    });
  });

  it("a client session cannot write into another client's catalog", async () => {
    const asA = (fn: (tx: Tx) => Promise<unknown>) =>
      errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await fn(tx);
        }),
      );
    expect(
      await asA((tx) =>
        tx.insert(catalogItem).values({
          tenantId: B.tenantId,
          category: "hardware",
          canonicalName: "x",
          standardUom: "each",
        }),
      ),
    ).toBe("42501");
    // B's rows are invisible, so an update reaches nothing.
    const updated = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .update(catalogItem)
        .set({ canonicalName: "stolen" })
        .where(sql`${catalogItem.id} = ${rowsB.itemId}`)
        .returning();
    });
    expect(updated).toEqual([]);
  });

  it("never lets a row point at another client's rows (composite keys)", async () => {
    // As the superuser, past RLS: the foreign keys alone refuse it.
    expect(
      await errorCode(
        t.db.insert(itemAlias).values({
          tenantId: A.tenantId,
          vendorId: rowsA.vendorId,
          vendorSku: "X1",
          catalogItemId: rowsB.itemId,
          source: "auto",
        }),
      ),
    ).toBe("23503");
  });

  it("keeps one alias per (vendor, sku, description hash), either part absent", async () => {
    const insert = (values: { vendorSku?: string; descriptionHash?: string }) =>
      errorCode(
        t.db.insert(itemAlias).values({
          tenantId: A.tenantId,
          vendorId: rowsA.vendorId,
          catalogItemId: rowsA.itemId,
          source: "auto",
          ...values,
        }),
      );
    expect(await insert({ descriptionHash: HASH })).toBe("23505");
    expect(await insert({ vendorSku: "BB34-55" })).toBeUndefined();
    expect(await insert({ vendorSku: "BB34-55" })).toBe("23505");
    expect(await insert({ vendorSku: "BB34-55", descriptionHash: HASH })).toBeUndefined();
    expect(await insert({})).toBe("23514");
  });

  it("keeps one live item per key signature, and allows it again once merged", async () => {
    const item = (keySignature: string) =>
      t.db
        .insert(catalogItem)
        .values({
          tenantId: A.tenantId,
          category: "hardware",
          canonicalName: keySignature,
          standardUom: "each",
          keySignature,
        })
        .returning();
    const [first] = await item("hardware|blum|71b3550|nickel");
    expect(await errorCode(item("hardware|blum|71b3550|nickel"))).toBe("23505");
    const [other] = await item("hardware|blum|71b3590|nickel");
    if (!first || !other) throw new Error("no items");
    await t.db
      .update(catalogItem)
      .set({ mergedIntoId: other.id })
      .where(sql`${catalogItem.id} = ${first.id}`);
    expect(await errorCode(item("hardware|blum|71b3550|nickel"))).toBeUndefined();
  });
  it("never lets a request, quote or quote line point at another client's rows", async () => {
    // Past RLS (superuser): the composite foreign keys alone refuse each.
    expect(
      await errorCode(
        t.db.insert(purchaseRequestLine).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsB.requestId,
          lineNo: 9,
          description: "x",
          qty: "1",
        }),
      ),
    ).toBe("23503");
    expect(
      await errorCode(
        t.db.insert(quoteRequest).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsA.requestId,
          vendorId: rowsB.vendorId,
        }),
      ),
    ).toBe("23503");
    expect(
      await errorCode(
        t.db.insert(quoteLine).values({
          tenantId: A.tenantId,
          quoteRequestId: rowsA.quoteId,
          purchaseRequestLineId: rowsB.requestLineId,
        }),
      ),
    ).toBe("23503");
  });

  it("checks statuses, channels, quantities and one RFQ per vendor", async () => {
    const request = (values: Record<string, unknown>) =>
      errorCode(
        t.db
          .insert(purchaseRequest)
          .values({ tenantId: A.tenantId, channel: "email", ...values } as never),
      );
    expect(await request({ status: "shipped" })).toBe("23514");
    expect(await request({ channel: "fax" })).toBe("23514");
    expect(await request({ fulfillment: "drone" })).toBe("23514");
    expect(await request({ orderConnector: "qbo" })).toBe("23514");
    expect(
      await request({ requestedByContactId: await A.contact("x"), requestedByUserId: A.userId }),
    ).toBe("23514");
    expect(await request({ orderConnector: "qbo", orderExternalId: "PO-1" })).toBeUndefined();
    expect(
      await errorCode(
        t.db.insert(purchaseRequestLine).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsA.requestId,
          lineNo: 2,
          description: "nothing",
          qty: "0",
        }),
      ),
    ).toBe("23514");
    // A matched line says how it was matched.
    expect(
      await errorCode(
        t.db.insert(purchaseRequestLine).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsA.requestId,
          lineNo: 2,
          catalogItemId: rowsA.itemId,
          description: "x",
          qty: "1",
        }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.insert(quoteRequest).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsA.requestId,
          vendorId: rowsA.vendorId,
        }),
      ),
    ).toBe("23505");
    expect(
      await errorCode(
        t.db
          .update(quoteRequest)
          .set({ status: "lost" as never })
          .where(sql`${quoteRequest.id} = ${rowsA.quoteId}`),
      ),
    ).toBe("23514");
    // A standard-unit price names its unit.
    expect(
      await errorCode(
        t.db
          .update(quoteLine)
          .set({ standardUom: null })
          .where(sql`${quoteLine.quoteRequestId} = ${rowsA.quoteId}`),
      ),
    ).toBe("23514");
  });

  it("keeps one price per QuickBooks bill line version, and allows doc-line prices beside them", async () => {
    const bill = await A.qboBill({
      id: "301",
      vendorId: rowsA.vendorId,
      date: "2026-10-02",
      lines: [{ id: "1", item: "BB 3/4", qty: 5, unitPrice: 60 }],
    });
    const price = (rawLineId: string | null, rawRecordId: string | null = bill.rawRecordId) =>
      errorCode(
        t.db.insert(priceObservation).values({
          tenantId: A.tenantId,
          catalogItemId: rowsA.itemId,
          vendorId: rowsA.vendorId,
          observedOn: "2026-10-02",
          unitPriceStd: "60",
          qtyStd: "5",
          standardUom: "sheet",
          transactionId: bill.transactionId,
          rawRecordId,
          rawLineId,
        }),
      );
    expect(await price("1")).toBeUndefined();
    expect(await price("1")).toBe("23505");
    expect(await price("2")).toBeUndefined();
    expect(await price(null)).toBe("23514");
    expect(await price(null, null)).toBeUndefined();
    expect(await price(null, null)).toBeUndefined();
  });

  it("lets a document be one a tool generated", async () => {
    const insert = (source: string) =>
      errorCode(
        t.db.insert(document).values({
          tenantId: A.tenantId,
          source: source as never,
          storageKey: `tenants/${A.tenantId}/content/ab/${source}`,
          mimeType: "application/pdf",
          filename: "PO.pdf",
          sizeBytes: 10,
          sha256: (source === "generated" ? "b" : "c").repeat(64),
        }),
      );
    expect(await insert("generated")).toBeUndefined();
    expect(await insert("made-up")).toBe("23514");
  });
  // P-9 (0036): a line may wait for its quantity; a quote names its reach-out, on the same client.
  it("lets a request line wait for its quantity, and ties a quote to a reach-out of its own client", async () => {
    const line = (lineNo: number, qty: string | null) =>
      errorCode(
        t.db.insert(purchaseRequestLine).values({
          tenantId: A.tenantId,
          purchaseRequestId: rowsA.requestId,
          lineNo,
          description: "some birch",
          qty,
        }),
      );
    expect(await line(20, null)).toBeUndefined();
    expect(await line(21, "0")).toBe("23514");
    expect(
      await errorCode(
        t.db
          .update(quoteRequest)
          .set({ reachOutId: "0190a1b2-0000-7000-8000-000000000001" })
          .where(sql`${quoteRequest.id} = ${rowsA.quoteId}`),
      ),
    ).toBe("23503");
    const fk = await t.db.execute<{ cols: string }>(sql`
      select array_to_string(array(
        select a.attname from unnest(c.conkey) k join pg_attribute a
          on a.attrelid = c.conrelid and a.attnum = k order by a.attname), ',') as cols
      from pg_constraint c where c.conname = 'quote_request_reach_out_fk'`);
    expect([...fk].map((r) => r.cols)).toEqual(["reach_out_id,tenant_id"]);
  });
});
