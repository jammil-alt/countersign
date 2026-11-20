// A person's second factor (migrations 0042 and 0067, docs/plan.md §1.100 and §1.154) as the
// Worker's role sees it: the person signing in sees and writes only their own rows, an operator
// session sees everyone's, and no scope sees nothing.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withUser } from "./client";
import {
  appUser,
  mcpSessionApproval,
  signInApproval,
  USER_TABLES,
  userFactor,
  userRecoveryCode,
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

describe.skipIf(!online)("second factor tables", () => {
  let t: TestDatabase;
  let ann = "";
  let bob = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const users = await t.db
      .insert(appUser)
      .values([
        { email: "ann@example.com", name: "Ann" },
        { email: "bob@example.com", name: "Bob" },
      ])
      .returning({ id: appUser.id });
    ann = users[0]?.id ?? "";
    bob = users[1]?.id ?? "";
    for (const userId of [ann, bob]) {
      await t.db.insert(userFactor).values({ userId, kind: "sms", phone: "+15550100000" });
      await t.db.insert(userRecoveryCode).values({ userId, codeHash: `h-${userId}` });
      await t.db.insert(mcpSessionApproval).values({
        userId,
        workosSessionId: `session_${userId}`,
        codeHash: `c-${userId}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await t.db.insert(signInApproval).values({ ...approval, userId });
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  const approval = {
    browserKeyHash: "h",
    number: 42,
    browser: "Chrome on macOS",
    expiresAt: new Date(Date.now() + 120_000),
  };

  const owners = async (table: string) =>
    [
      ...(await t.db.execute<{ u: string }>(sql.raw(`select user_id::text as u from ${table}`))),
    ].map((r) => r.u);

  it("force row-level security on every person table", async () => {
    const rows = await t.db.$client<{ relname: string; rls: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client([...USER_TABLES])}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...USER_TABLES].sort());
    for (const r of rows) expect(r.rls && r.forced, r.relname).toBe(true);
  });

  it("show the person signing in only their own rows", async () => {
    await withUser(t.db, ann, async (tx) => {
      await asWorker(tx);
      for (const table of USER_TABLES) {
        const ids = [
          ...(await tx.execute<{ u: string }>(sql.raw(`select user_id::text as u from ${table}`))),
        ].map((r) => r.u);
        expect(new Set(ids), table).toEqual(new Set([ann]));
      }
    });
  });

  it("refuse writing someone else's row", async () => {
    const code = await errorCode(
      withUser(t.db, ann, async (tx) => {
        await asWorker(tx);
        await tx.insert(userFactor).values({ userId: bob, kind: "whatsapp", phone: "+1555" });
      }),
    );
    expect(code).toBe("42501");
  });

  it("show an operator session everyone's rows, and no scope nothing", async () => {
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of USER_TABLES) {
        const ids = [
          ...(await tx.execute<{ u: string }>(sql.raw(`select user_id::text as u from ${table}`))),
        ].map((r) => r.u);
        expect(new Set(ids), table).toEqual(new Set([ann, bob]));
      }
    });
    await t.db.transaction(async (tx) => {
      await asWorker(tx);
      for (const table of USER_TABLES) {
        const rows = [...(await tx.execute(sql.raw(`select 1 from ${table}`)))];
        expect(rows, table).toEqual([]);
      }
    });
    expect((await owners("user_factor")).length).toBe(2);
  });

  it("refuse a factor whose shape doesn't match its kind", async () => {
    expect(
      await errorCode(t.db.insert(userFactor).values({ userId: ann, kind: "totp", phone: "+1" })),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.insert(userFactor).values({ userId: bob, kind: "sms", twilioFactorSid: "YF1" }),
      ),
    ).toBe("23514");
  });

  it("refuse a phone approval in a shape the step never makes", async () => {
    const userId = ann;
    const now = new Date();
    const device = "00000000-0000-7000-8000-000000000001";
    // A number the browser can't show.
    for (const number of [9, 100]) {
      expect(
        await errorCode(t.db.insert(signInApproval).values({ ...approval, userId, number })),
      ).toBe("23514");
    }
    expect(
      await errorCode(
        t.db.insert(signInApproval).values({ ...approval, userId, status: "nope" as never }),
      ),
    ).toBe("23514");
    // Decided without a time, or a time while still pending.
    expect(
      await errorCode(
        t.db.insert(signInApproval).values({ ...approval, userId, status: "denied" }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(t.db.insert(signInApproval).values({ ...approval, userId, decidedAt: now })),
    ).toBe("23514");
    // Approved by no phone; used without an approval.
    expect(
      await errorCode(
        t.db
          .insert(signInApproval)
          .values({ ...approval, userId, status: "approved", decidedAt: now }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db
          .insert(signInApproval)
          .values({ ...approval, userId, status: "denied", decidedAt: now, usedAt: now }),
      ),
    ).toBe("23514");
    // What the step does make.
    await t.db.insert(signInApproval).values([
      { ...approval, userId, status: "denied", decidedAt: now },
      { ...approval, userId, status: "approved", decidedAt: now, deviceId: device, usedAt: now },
    ]);
  });

  it("go with the person when their app_user row is deleted", async () => {
    await t.db.execute(sql`delete from app_user where id = ${bob}`);
    for (const table of USER_TABLES) expect(await owners(table), table).not.toContain(bob);
  });
});
