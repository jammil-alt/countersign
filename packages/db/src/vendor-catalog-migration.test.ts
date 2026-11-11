// Migration 0047 (docs/plan.md §1.88): the vendor catalog, `vendor_item`, with
// `item_alias.vendor_item_id` and `price_observation.vendor_item_id`. It applies on a database the
// previous Worker used, the backfill fills the catalog from the aliases and prices kept (each in
// its own client), the previous Worker's writes still work, the table forces row-level security,
// and the Worker's role reads and writes only its own client's vendor items, never deleting one.
// The pack's tables aren't in this package's schema (the platform never imports a pack), so this
// test speaks SQL.

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

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

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
  vendorId: string;
  baltic: string;
  screws: string;
  merged: string;
}

describe.skipIf(!online)("0047 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let a: Seeded;
  let b: Seeded;

  /** What the previous Worker kept for a client: items, aliases and prices, as it wrote them. */
  async function seed(c: ClientFixture): Promise<Seeded> {
    const q = t.db.$client;
    const [v] = await q<{ id: string }[]>`
      select id from vendor where tenant_id = ${c.tenantId} limit 1`;
    const vendorId = v?.id ?? "";
    const item = async (name: string, category: string, uom: string) =>
      (
        await q<{ id: string }[]>`
          insert into catalog_item (tenant_id, category, canonical_name, standard_uom)
          values (${c.tenantId}, ${category}, ${name}, ${uom}) returning id`
      )[0]?.id ?? "";
    const baltic = await item("Baltic birch plywood 3/4in 60x60in", "sheet_goods", "sheet");
    const screws = await item("Wood screw #8 x 1-1/4in", "hardware", "each");
    const merged = await item("Baltic birch 3/4 (old)", "sheet_goods", "sheet");
    await q`update catalog_item set merged_into_id = ${baltic} where id = ${merged}`;
    const alias = (sku: string | null, hash: string | null, desc: string | null, itemId: string) =>
      q`insert into item_alias (tenant_id, vendor_id, vendor_sku, description_hash,
          normalized_description, catalog_item_id, source)
        values (${c.tenantId}, ${vendorId}, ${sku}, ${hash}, ${desc}, ${itemId}, 'auto')`;
    await alias("BB34-55", null, null, baltic);
    await alias(null, H1, "3/4 bb/bb baltic birch 5x5", baltic);
    await alias(null, H2, "#8 x 1 1/4 wood screw", screws);
    await alias("OLD-1", null, null, merged);
    // An invoice line with the SKU (older), then a newer price with no line (an import).
    const [line] = await q<{ id: string }[]>`
      insert into doc_line (tenant_id, extraction_id, line_no, raw_description, vendor_sku, qty,
        unit_price, ext_price)
      values (${c.tenantId}, ${c.extractionId}, 2, '3/4 BB/BB BALTIC BIRCH 5X5', 'bb34-55', '10',
        '90', '900')
      returning id`;
    const lineId = line?.id ?? "";
    const price = (itemId: string, on: string, p: string, line: string | null) =>
      q`insert into price_observation (tenant_id, catalog_item_id, vendor_id, observed_on,
          unit_price_std, qty_std, standard_uom, doc_line_id)
        values (${c.tenantId}, ${itemId}, ${vendorId}, ${on}, ${p}, '10', 'sheet', ${line})`;
    await price(baltic, "2026-10-01", "90.0000", lineId);
    await price(baltic, "2026-11-01", "95.0000", null);
    await price(screws, "2026-09-01", "0.0800", null);
    return { vendorId, baltic, screws, merged };
  }

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0046_run_audit" });
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    a = await seed(A);
    b = await seed(B);
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const vendorItems = (tenantId: string) =>
    t.db.$client<
      {
        id: string;
        catalog_item_id: string;
        sku: string | null;
        name: string;
        vendor_uom: string | null;
        std_per_vendor_uom: string | null;
        last_price: string | null;
        last_price_std: string | null;
        last_price_on: string | null;
        last_price_source: string | null;
        last_price_source_id: string | null;
        status: string;
        preferred: boolean;
      }[]
    >`select id, catalog_item_id, sku, name, vendor_uom, std_per_vendor_uom::text,
        last_price::text, last_price_std::text, last_price_on::text, last_price_source,
        last_price_source_id::text, status, preferred
      from vendor_item where tenant_id = ${tenantId} order by sku nulls last`;

  it("adds vendor_item with forced row-level security, as the pack's", async () => {
    const [row] = await t.db.$client<
      { rls: boolean; forced: boolean; owner: string; policies: number }[]
    >`
      select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        obj_description(c.oid, 'pg_class') as owner,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.relname = 'vendor_item'`;
    expect(row).toEqual({ rls: true, forced: true, owner: "pack:materials", policies: 1 });
    const can = async (privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', 'vendor_item', ${privilege}) as ok`
      )[0]?.ok;
    expect([await can("SELECT"), await can("INSERT"), await can("UPDATE")]).toEqual([
      true,
      true,
      true,
    ]);
    expect([await can("DELETE"), await can("TRUNCATE")]).toEqual([false, false]);
  });

  it("backfills a vendor item per SKU, and one per vendor and master item without a SKU", async () => {
    const rows = await vendorItems(A.tenantId);
    // BB34-55 on the Baltic birch; the screws without a SKU; nothing on the merged item.
    expect(rows.map((r) => [r.sku, r.catalog_item_id])).toEqual([
      ["BB34-55", a.baltic],
      [null, a.screws],
    ]);
    const [bb, screws] = rows;
    // Named as the vendor last wrote the item, priced in the standard unit.
    expect(bb).toMatchObject({
      name: "3/4 bb/bb baltic birch 5x5",
      vendor_uom: "sheet",
      std_per_vendor_uom: "1.0000",
      status: "active",
      preferred: false,
    });
    expect(screws?.name).toBe("#8 x 1 1/4 wood screw");
  });

  it("takes the newest price by date as the last price, with its source", async () => {
    const [bb, screws] = await vendorItems(A.tenantId);
    expect(bb).toMatchObject({
      last_price: "95.0000",
      last_price_std: "95.0000",
      last_price_on: "2026-11-01",
      last_price_source: "import",
      last_price_source_id: null,
    });
    expect(screws).toMatchObject({ last_price: "0.0800", last_price_on: "2026-09-01" });
  });

  it("points every alias and price at its vendor item, the merged item's left alone", async () => {
    const [bb, screws] = await vendorItems(A.tenantId);
    const aliases = await t.db.$client<{ key: string; vendor_item_id: string | null }[]>`
      select coalesce(vendor_sku, normalized_description) as key, vendor_item_id::text
      from item_alias where tenant_id = ${A.tenantId} order by key`;
    expect(aliases).toEqual([
      { key: "#8 x 1 1/4 wood screw", vendor_item_id: screws?.id },
      { key: "3/4 bb/bb baltic birch 5x5", vendor_item_id: bb?.id },
      { key: "BB34-55", vendor_item_id: bb?.id },
      { key: "OLD-1", vendor_item_id: null },
    ]);
    const prices = await t.db.$client<{ on: string; vendor_item_id: string | null }[]>`
      select observed_on::text as on, vendor_item_id::text from price_observation
      where tenant_id = ${A.tenantId} order by observed_on`;
    expect(prices).toEqual([
      { on: "2026-09-01", vendor_item_id: screws?.id },
      { on: "2026-10-01", vendor_item_id: bb?.id },
      { on: "2026-11-01", vendor_item_id: bb?.id },
    ]);
  });

  it("keeps each client's backfill in that client", async () => {
    const rowsB = await vendorItems(B.tenantId);
    expect(rowsB.map((r) => r.catalog_item_id).sort()).toEqual([b.baltic, b.screws].sort());
    const crossed = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from vendor_item v
      join catalog_item c on c.id = v.catalog_item_id
      join vendor w on w.id = v.vendor_id
      where c.tenant_id <> v.tenant_id or w.tenant_id <> v.tenant_id`;
    expect(crossed[0]?.n).toBe(0);
  });

  it("lets the previous Worker keep writing aliases and prices without a vendor item", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.execute(
        `insert into item_alias (tenant_id, vendor_id, vendor_sku, catalog_item_id, source)
         values ('${A.tenantId}', '${a.vendorId}', 'NEW-2', '${a.screws}', 'auto')`,
      );
      await tx.execute(
        `insert into price_observation (tenant_id, catalog_item_id, vendor_id, observed_on,
           unit_price_std, qty_std, standard_uom)
         values ('${A.tenantId}', '${a.screws}', '${a.vendorId}', '2026-11-05', '0.0900', '100',
           'each')`,
      );
    });
    const [row] = await t.db.$client<{ vendor_item_id: string | null }[]>`
      select vendor_item_id from item_alias where vendor_sku = 'NEW-2'`;
    expect(row?.vendor_item_id).toBeNull();
  });

  it("keeps one vendor item per SKU, per unit without one, and one preferred per master item", async () => {
    const insert = (values: { sku?: string; uom?: string; preferred?: boolean; item?: string }) =>
      errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(
            `insert into vendor_item (tenant_id, vendor_id, catalog_item_id, sku, name, vendor_uom,
               preferred)
             values ('${A.tenantId}', '${a.vendorId}', '${values.item ?? a.screws}',
               ${values.sku ? `'${values.sku}'` : "null"}, 'x',
               ${values.uom ? `'${values.uom}'` : "null"}, ${values.preferred ?? false})`,
          );
        }),
      );
    expect(await insert({ sku: "BB34-55", item: a.baltic })).toBe("23505");
    // The backfilled screws item is per `each`; a box of them is another vendor item.
    expect(await insert({ uom: "each" })).toBe("23505");
    expect(await insert({ uom: "box" })).toBeUndefined();
    expect(await insert({ sku: "SCR-8-114", preferred: true })).toBeUndefined();
    expect(await insert({ sku: "SCR-8-114-B", preferred: true })).toBe("23505");
  });

  it("shows a client only its own vendor items, refuses writing another's and deleting any", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.execute<{ tenant_id: string }>("select tenant_id::text from vendor_item");
    });
    expect(new Set([...seen].map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute(
            `insert into vendor_item (tenant_id, vendor_id, catalog_item_id, name)
             values ('${B.tenantId}', '${b.vendorId}', '${b.screws}', 'stolen')`,
          );
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.execute("delete from vendor_item");
        }),
      ),
    ).toBe("42501");
    // A vendor item can't point at another client's vendor or master item (composite keys).
    expect(
      await errorCode(
        t.db.$client`insert into vendor_item (tenant_id, vendor_id, catalog_item_id, name)
          values (${A.tenantId}, ${a.vendorId}, ${b.screws}, 'x')`,
      ),
    ).toBe("23503");
  });
});
