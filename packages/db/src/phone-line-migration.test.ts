// Agent phone lines (migration 0069, docs/plan.md §1.160) as the Worker's role sees it: a line's
// days are one client's, read and inserted only inside that client; they are never changed or
// deleted. A `phone_line` statement line names its agent, as an `agent` line does. The price of a
// line defaults to $10 a month.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  billingPhoneLineDay,
  billingSetting,
  billingStatement,
  billingStatementLine,
} from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

describe.skipIf(!online)("agent phone lines (0069)", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("prices a line at $10 a month by default", async () => {
    const [s] = await t.db.select().from(billingSetting).where(eq(billingSetting.id, 1));
    expect(s?.phoneLinePrice).toBe("10.0000");
    expect(await errorCode(t.db.update(billingSetting).set({ phoneLinePrice: "-1.0000" }))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("keeps a client's line days to that client", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx.select().from(billingPhoneLineDay);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenantId === A.tenantId)).toBe(true);
    const wrong = await errorCode(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(billingPhoneLineDay).values({
          tenantId: B.tenantId,
          day: "2026-10-02",
          phoneNumber: "+15555550199",
          agentId: B.agentId,
          agentName: "B's agent",
          monthlyPrice: "10.0000",
        });
      }),
    );
    expect(wrong).toBeDefined();
  });

  it("only inserts line days, once per number and day", async () => {
    const added = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .insert(billingPhoneLineDay)
        .values({
          tenantId: A.tenantId,
          day: "2026-10-01",
          phoneNumber: "+15555550123",
          agentId: A.agentId,
          agentName: "Test agent",
          monthlyPrice: "12.0000",
        })
        .onConflictDoNothing()
        .returning();
    });
    expect(added).toEqual([]);
    expect(await errorCode(t.db.update(billingPhoneLineDay).set({ monthlyPrice: "1.0000" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await errorCode(t.db.delete(billingPhoneLineDay))).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(
        t.db.insert(billingPhoneLineDay).values({
          tenantId: A.tenantId,
          day: "2026-10-03",
          phoneNumber: "555-0123",
          agentId: A.agentId,
          agentName: "Test agent",
          monthlyPrice: "10.0000",
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("bills a phone line on a statement, naming its agent", async () => {
    const [st] = await t.db
      .insert(billingStatement)
      .values({
        tenantId: A.tenantId,
        period: "2026-09-01",
        periodEnd: "2026-09-30",
        daysInMonth: 30,
        status: "draft",
        creditsUsed: 0,
        creditsIncluded: 0,
        extraCredits: 0,
        creditPrice: "0.0200",
      })
      .returning();
    const line = {
      tenantId: A.tenantId,
      statementId: st?.id ?? "",
      position: 1,
      kind: "phone_line" as const,
      description: "Phone line +1 555-555-0123 (Test agent)",
      amount: "10.0000",
    };
    expect(
      await errorCode(t.db.insert(billingStatementLine).values({ ...line, agentId: null })),
    ).toBe(CHECK_VIOLATION);
    await t.db.insert(billingStatementLine).values({ ...line, agentId: A.agentId });
    const [n] = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from billing_statement_line where kind = 'phone_line'`,
    );
    expect(Number(n?.n)).toBe(1);
  });
});
