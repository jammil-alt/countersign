// The directory's tables (migration 0014, docs/plan.md §1.27): one entry per vendor, links that
// stay inside one client, and the checks on kinds, relationships and sources. RLS on both tables is
// covered with every other tenant table in rls.test.ts.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { contact, organization, vendor } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("the directory's tables", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let vendorA: string;
  let vendorB: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    const [va] = await t.db
      .insert(vendor)
      .values({ tenantId: A.tenantId, name: "Birch & Co", normalizedName: "birch" })
      .returning();
    const [vb] = await t.db
      .insert(vendor)
      .values({ tenantId: B.tenantId, name: "Birch & Co", normalizedName: "birch" })
      .returning();
    if (!va || !vb) throw new Error("no vendors");
    vendorA = va.id;
    vendorB = vb.id;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("links a vendor to one organization only", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .insert(organization)
        .values({ tenantId: A.tenantId, name: "Birch", vendorId: vendorA });
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx
            .insert(organization)
            .values({ tenantId: A.tenantId, name: "Birch again", vendorId: vendorA });
        }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    // Organizations without a vendor are not limited.
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.insert(organization).values([
        { tenantId: A.tenantId, name: "Oak Partners", kinds: ["partner"] },
        { tenantId: A.tenantId, name: "Pine Customers", kinds: ["customer", "partner"] },
      ]);
    });
  });

  it("refuses a link to another client's vendor or organization", async () => {
    expect(
      await errorCode(
        t.db
          .insert(organization)
          .values({ tenantId: A.tenantId, name: "Cross", vendorId: vendorB }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    const [orgB] = await t.db
      .insert(organization)
      .values({ tenantId: B.tenantId, name: "B's own", kinds: ["own"] })
      .returning();
    if (!orgB) throw new Error("no organization");
    expect(
      await errorCode(
        t.db.insert(contact).values({
          tenantId: A.tenantId,
          name: "Sam Cross",
          email: "sam@example.com",
          organizationId: orgB.id,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("checks kinds, relationships and sources", async () => {
    expect(
      await errorCode(
        t.db
          .insert(organization)
          .values({ tenantId: A.tenantId, name: "Odd", kinds: ["supplier" as "vendor"] }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(
        t.db
          .insert(organization)
          .values({ tenantId: A.tenantId, name: "Odd", source: "Not a slug" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(
        t.db.insert(contact).values({
          tenantId: A.tenantId,
          name: "Odd",
          email: "odd@example.com",
          relationship: "friend" as "other",
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("keeps contacts made before the directory valid, with the new fields empty", async () => {
    // The previous Worker's insert: none of the new columns.
    await t.db.execute(
      sql`insert into contact (tenant_id, name, phone) values (${A.tenantId}, 'Old Style', '+15555550199')`,
    );
    const [row] = await t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A.tenantId), eq(contact.name, "Old Style")));
    expect(row).toMatchObject({
      organizationId: null,
      title: null,
      relationship: null,
      source: null,
      externalRefs: {},
    });
  });
});
