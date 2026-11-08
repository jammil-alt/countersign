// P-9 (docs/plan.md §1.71): the Purchasing area's cards and request page against a throwaway
// database as the Worker's role: a person settles an unsure line (item and quantity) on the line
// review, picks a vendor on the vendor choice (only a received quote of this request), the run
// reads that choice, and the request page holds the lines, quotes, comparison, choice and
// documents, and nothing of another client's or of a test run.

import { closeDb, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATERIALS_REPORTS, MATERIALS_REVIEWS } from "../api";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackTool, packToolContext } from "../tools";
import {
  catalogMatchText,
  quoteChosen,
  quoteCreate,
  quoteMarkSent,
  quoteRecord,
  requestCreate,
} from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: outputs are read loosely in tests.
type J = any;

describe.skipIf(!online)("the Purchasing area's cards and page (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  const ctx = (shop: ShopFixture, mode: "live" | "test" = "live") =>
    packToolContext({ tenantId: shop.tenantId, agentVersionId: shop.agentVersionId, mode, db });
  const call = async (tool: PackTool, input: unknown, shop: ShopFixture = A): Promise<J> =>
    tool.output.parse(await tool.run(input, ctx(shop)));
  const lines = MATERIALS_REVIEWS["materials.request-lines"] as NonNullable<
    (typeof MATERIALS_REVIEWS)[string]
  >;
  const choice = MATERIALS_REVIEWS["materials.vendor-choice"] as NonNullable<
    (typeof MATERIALS_REVIEWS)[string]
  >;
  const BB = "3/4 BB/BB BALTIC BIRCH 5X5";
  let requestId: string;
  let lineIds: string[];
  let item: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    // One catalog item, made by the backfill's rules from a first request.
    const v = await A.vendor("Keystone Lumber");
    await A.qboBill({
      id: "9",
      vendorId: v,
      date: "2026-10-01",
      lines: [{ id: "1", item: "Ply", description: BB, qty: 1, unitPrice: 60 }],
    });
    const { backfillFromBills } = await import("./backfill");
    await backfillFromBills(
      db,
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, runId: null, testRun: false },
      { from: "2026-10-01", to: "2026-10-31" },
    );
    item = (await call(catalogMatchText, { descriptions: [BB] })).lines[0].catalogItemId;
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  const decide = (
    review: typeof lines,
    decision: unknown,
    shop: ShopFixture = A,
    payload: Record<string, unknown> = { requestId },
  ) =>
    review
      .decide(db, {
        tenantId: shop.tenantId,
        userId: shop.userId,
        payload,
        decision: decision as never,
        testRun: false,
      })
      .then(
        () => null,
        (e: Error) => e.message,
      );

  it("settles an unsure line on the line review: the item a person picked and how many", async () => {
    const r = await call(requestCreate, {
      channel: "email",
      lines: [
        { description: BB, qty: "12", unit: "sheets" },
        { description: "baltic birch 5x5", qty: null },
      ],
    });
    requestId = r.request.id;
    lineIds = r.request.lines.map((l: J) => l.id);
    const view = (await withTenant(db, A.tenantId, (tx) =>
      lines.load(tx, A.tenantId, { requestId }),
    )) as J;
    expect(view.lines.map((l: J) => l.settled)).toEqual([true, false]);
    expect(view.catalog.map((c: J) => c.id)).toContain(item);
    expect(
      await decide(lines, { action: "line", input: { lineId: lineIds[1], qty: "0" } }),
    ).toMatch(/more than 0/);
    expect(await decide(lines, { action: "line", input: { lineId: lineIds[1] } })).toMatch(
      /say which item/,
    );
    expect(
      await decide(lines, {
        action: "line",
        input: { lineId: lineIds[1], catalogItemId: item, qty: "4" },
      }),
    ).toBeNull();
    const after = (await withTenant(db, A.tenantId, (tx) =>
      lines.load(tx, A.tenantId, { requestId }),
    )) as J;
    expect(after.lines[1]).toMatchObject({
      qty: "4.0000",
      catalogItemId: item,
      matchMethod: "chosen",
      settled: true,
    });
    // Another client's request isn't there to decide.
    expect(
      await decide(lines, { action: "line", input: { lineId: lineIds[1], qty: "2" } }, B),
    ).toMatch(/not found/);
  });

  let quotes: Record<string, string>;

  it("takes a person's vendor choice among this request's received quotes, which the run reads", async () => {
    const k = await A.vendor("Keystone Lumber");
    const n = await A.vendor("Northline Plywood");
    const rfq = await call(quoteCreate, { requestId, vendorIds: [k, n] });
    quotes = Object.fromEntries(rfq.quotes.map((q: J) => [q.vendorName, q.id]));
    for (const id of Object.values(quotes)) {
      await call(quoteMarkSent, { quoteRequestId: id, sentVia: "email" });
    }
    await call(quoteRecord, {
      quoteRequestId: quotes["Keystone Lumber"],
      lines: lineIds.map((id) => ({ requestLineId: id, unitPrice: "58", unit: "SHT" })),
    });
    expect(await quoteChosen.run({ requestId }, ctx(A)).catch((e: Error) => e.message)).toMatch(
      /nobody has picked/,
    );
    // Northline hasn't answered: its quote can't be picked.
    expect(
      await decide(choice, {
        action: "choose",
        input: { kind: "single", quoteRequestId: quotes["Northline Plywood"] },
      }),
    ).toMatch(/pick a quote that came in/);
    expect(
      await decide(choice, {
        action: "choose",
        input: { kind: "single", quoteRequestId: quotes["Keystone Lumber"] },
      }),
    ).toBeNull();
    const view = (await withTenant(db, A.tenantId, (tx) =>
      choice.load(tx, A.tenantId, { requestId }),
    )) as J;
    expect(view.comparison.vendors.map((v: J) => v.vendorName)).toEqual(["Keystone Lumber"]);
    expect(view.choice).toMatchObject({
      kind: "single",
      quoteRequestId: quotes["Keystone Lumber"],
    });
    expect(await call(quoteChosen, { requestId })).toMatchObject({
      kind: "single",
      quoteRequestId: quotes["Keystone Lumber"],
    });
    expect(await quoteChosen.run({ requestId }, ctx(B)).catch((e: Error) => e.message)).toMatch(
      /not found/,
    );
  });

  it("gives the request's page: lines, quotes, comparison and choice; never a test run's or B's", async () => {
    const item = MATERIALS_REPORTS.requests?.item as NonNullable<
      NonNullable<(typeof MATERIALS_REPORTS)[string]>["item"]
    >;
    const page = (await withTenant(db, A.tenantId, (tx) =>
      item(tx, A.tenantId, requestId, "2026-11-08"),
    )) as J;
    expect(page.request).toMatchObject({ id: requestId, status: "quoting" });
    expect(page.request.lines).toHaveLength(2);
    expect(page.request.quotes.map((q: J) => [q.vendorName, q.status])).toEqual([
      ["Keystone Lumber", "received"],
      ["Northline Plywood", "sent"],
    ]);
    expect(page.request.comparison.suggestion.kind).toBe("single");
    expect(page.request.choice.quoteRequestId).toBe(quotes["Keystone Lumber"]);
    expect(JSON.stringify(page)).not.toMatch(/agentVersionId|runId|instructions|userId/);
    expect(
      await withTenant(db, B.tenantId, (tx) => item(tx, B.tenantId, requestId, "2026-11-08")),
    ).toBeNull();
    const test = await requestCreate.run({ channel: "agent", lines: [] }, ctx(A, "test"));
    const testId = (test as J).request.id;
    expect(
      await withTenant(db, A.tenantId, (tx) => item(tx, A.tenantId, testId, "2026-11-08")),
    ).toBeNull();
  });
});
