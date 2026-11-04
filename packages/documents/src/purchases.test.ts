// The upload connector's CSV import (packages/connectors/src/upload/purchases.ts), against a real
// database as cs_worker. It lives here because this package has the database harness.

import { importPurchasesCsv, PurchasesCsvError } from "@countersign/connectors";
import { rawRecord, transaction, vendor } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.test-helper";

const h = await createHarness();
afterAll(() => h?.close());

const csv = (text: string) => new TextEncoder().encode(text);
const FILE = `Date,Vendor,Amount,Memo,Cardholder
10/28/2026,Northline Panel Supply,"$9,742.35",J-1182,Dana
10/30/2026,Cedar Ridge Hardwoods,5843.35,J-1185,Dana
11/02/2026,"Keystone Hardware & Finishes, Inc.",8832.40,J-1190,Sam
11/03/2026,Northline Panel Supply,(120.00),Return,Dana
not a date,Someone,1.00,,
`;

describe.skipIf(!h)("purchases CSV import", () => {
  const harness = h as Harness;
  const { A, B } = harness;
  const run = (bytes: Uint8Array, c = A) =>
    harness.as(c, (tx) =>
      importPurchasesCsv(tx, {
        tenantId: c.tenantId,
        connectionId: c.uploadConnectionId,
        filename: "card.csv",
        bytes,
      }),
    );

  it("stores each row as a raw record and makes a transaction from it", async () => {
    const r = await run(csv(FILE));
    expect(r.rows).toBe(5);
    expect(r.created).toHaveLength(4);
    expect(r.errors).toEqual([{ row: 5, message: 'not a date: "not a date"' }]);
    const raws = await harness.as(A, (tx) =>
      tx.select().from(rawRecord).where(eq(rawRecord.connector, "upload")),
    );
    expect(raws).toHaveLength(4);
    const byTotal = Object.fromEntries(r.created.map((t) => [t.total, t]));
    expect(byTotal["9742.3500"]).toMatchObject({
      kind: "purchase",
      txnDate: "2026-10-28",
      memo: "J-1182",
      purchaserRef: "Dana",
      status: "needs_doc",
    });
    expect(byTotal["120.0000"]?.kind).toBe("vendor_credit");
    // One vendor per name, suffixes and case aside.
    const vendors = await harness.as(A, (tx) =>
      tx.select().from(vendor).where(eq(vendor.tenantId, A.tenantId)),
    );
    expect(vendors.map((v) => v.normalizedName).sort()).toEqual([
      "cedar ridge hardwoods",
      "keystone hardware and finishes",
      "northline panel supply",
    ]);
    expect(raws.every((raw) => r.created.some((t) => t.sourceRawRecordId === raw.id))).toBe(true);
  });

  it("imports nothing twice, even from a later export that repeats rows", async () => {
    const again = await run(csv(FILE));
    expect(again.created).toHaveLength(0);
    expect(again.duplicates).toBe(4);
    const later = await run(csv(`${FILE}11/04/2026,Cedar Ridge Hardwoods,310.00,J-1191,Sam\n`));
    expect(later.created.map((t) => t.total)).toEqual(["310.0000"]);
  });

  it("keeps clients apart: the same file makes B its own transactions", async () => {
    const r = await run(csv(FILE), B);
    expect(r.created).toHaveLength(4);
    const aRows = await harness.as(A, (tx) => tx.select().from(transaction));
    expect(aRows.every((t) => t.tenantId === A.tenantId)).toBe(true);
  });

  it("refuses a file without the columns it needs", async () => {
    await expect(run(csv("Date,Memo\n2026-11-02,x\n"))).rejects.toThrow(PurchasesCsvError);
    await expect(run(csv("Date,Memo\n2026-11-02,x\n"))).rejects.toThrow(/no vendor, amount column/);
  });
});
