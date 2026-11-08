// seed:demo-prices and the reports over it (database, as cs_worker): six months of prices for about
// ten items from three vendors, seeded once however often it runs; Price watch's rows, series and
// alerts with their evidence; the catalog; CSV quoting; and nothing of one client in another's.

import { closeDb, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoPrices } from "./demo";
import { catalogCsv, catalogReport, priceWatch, priceWatchCsv, toCsv } from "./reports";
import { priceObservation } from "./schema";
import { insertShop, type ShopFixture } from "./testing.test-helper";

const online = await databaseAvailable();
const TODAY = "2026-11-02";

describe("CSV", () => {
  it("quotes commas, quotes and new lines, and defuses formulas", () => {
    expect(toCsv([["a,b", 'say "hi"', "=SUM(A1)", "-3.5", null]])).toBe(
      '"a,b","say ""hi""",\'=SUM(A1),-3.5,\r\n',
    );
  });
});

describe.skipIf(!online)("demo prices and reports (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("seeds six months for about ten items and three vendors, once", async () => {
    const first = await seedDemoPrices(db, A.tenantId, { today: TODAY });
    expect(first).toMatchObject({ vendors: 3, items: 10 });
    expect(first.observations).toBeGreaterThan(250);
    expect(first.alerts).toBeGreaterThan(0);
    const again = await seedDemoPrices(db, A.tenantId, { today: TODAY });
    expect(again).toMatchObject({ observations: 0, alerts: 0 });
    const rows = await t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.tenantId, A.tenantId));
    expect(rows).toHaveLength(first.observations);
    const days = rows.map((r) => r.observedOn).sort();
    expect(days[0]?.slice(0, 7)).toBe("2026-05");
  });

  it("shows Price watch: item × vendor with the last price, its change and a 90-day series", async () => {
    const report = await withTenant(db, A.tenantId, (tx) =>
      priceWatch(tx, A.tenantId, { today: TODAY }),
    );
    expect(report.totals.items).toBe(10);
    expect(report.totals.vendors).toBe(3);
    const bb = report.rows.find(
      (r) =>
        r.item.startsWith("Baltic birch plywood 3/4in") && r.vendor === "Northline Panel Supply",
    );
    expect(bb).toBeDefined();
    expect(Number(bb?.changePct)).toBeGreaterThan(5);
    expect(bb?.series.length).toBeGreaterThanOrEqual(6);
    expect(bb?.series.every((p) => p.on >= "2026-08-04")).toBe(true);
    expect(bb?.openAlerts).toBeGreaterThan(0);
    const jump = report.alerts.find((a) => a.kind === "price_jump");
    expect(jump).toMatchObject({ status: "open", vendorId: bb?.vendorId });
    expect(jump?.evidence.length).toBeGreaterThan(0);
    expect(Number(report.totals.dollarImpact)).toBeGreaterThan(0);

    const csv = priceWatchCsv(report).split("\r\n");
    expect(csv[0]).toBe(
      "Item,Category,Unit,Vendor,Last price,Last purchased,Price before,Change %,Purchases (90 days),Quantity (90 days),Open alerts",
    );
    expect(csv).toHaveLength(report.rows.length + 2);
  });

  it("lists the catalog with each item's vendors and last price", async () => {
    const report = await withTenant(db, A.tenantId, (tx) => catalogReport(tx, A.tenantId));
    expect(report.items).toHaveLength(10);
    const oak = report.items.find((i) => i.category === "hardwood" && i.name.includes("Red oak"));
    expect(oak).toMatchObject({ standardUom: "board_foot", vendors: 2 });
    expect(oak?.lastPrice).not.toBeNull();
    expect(catalogCsv(report).split("\r\n")[0]).toBe(
      "Item,Category,Unit,Attributes,Vendors,Purchases,Last price,Last purchased",
    );
  });

  it("shows another client nothing of it", async () => {
    const report = await withTenant(db, B.tenantId, (tx) =>
      priceWatch(tx, B.tenantId, { today: TODAY }),
    );
    expect(report.rows).toEqual([]);
    expect(report.alerts).toEqual([]);
    const catalog = await withTenant(db, B.tenantId, (tx) => catalogReport(tx, B.tenantId));
    expect(catalog.items).toEqual([]);
  });
});
