// Reggie's tables (migration 0049, docs/plan.md §1.101) as the Worker's role sees them: operator
// sessions only, and only for the clients the session serves where a row names one; a client's
// session (withTenant) and no scope see nothing.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import {
  appUser,
  REGGIE_TABLES,
  reggieAction,
  reggieConversation,
  reggieMessage,
  tenant,
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

describe.skipIf(!online)("Reggie's tables", () => {
  let t: TestDatabase;
  let ann = "";
  let a = "";
  let b = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const [user] = await t.db
      .insert(appUser)
      .values({ email: "ann@example.com", name: "Ann" })
      .returning({ id: appUser.id });
    ann = user?.id ?? "";
    const clients = await t.db
      .insert(tenant)
      .values([{ name: "Client A" }, { name: "Client B" }])
      .returning({ id: tenant.id });
    a = clients[0]?.id ?? "";
    b = clients[1]?.id ?? "";
    for (const clientId of [null, a, b]) {
      const [c] = await t.db
        .insert(reggieConversation)
        .values({ userId: ann, clientId, title: `about ${clientId ?? "everyone"}` })
        .returning({ id: reggieConversation.id });
      const conversationId = c?.id ?? "";
      await t.db.insert(reggieMessage).values({ conversationId, role: "operator", text: "hi" });
      await t.db.insert(reggieAction).values({
        conversationId,
        userId: ann,
        clientId,
        tool: "lead_message_post",
        args: {},
        preview: {},
      });
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = async (tx: Parameters<Parameters<typeof withOperator>[2]>[0], table: string) =>
    Number(
      [...(await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))][0]
        ?.n ?? 0,
    );

  it("force row-level security on every table", async () => {
    const rows = await t.db.$client<{ relname: string; rls: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client([...REGGIE_TABLES])}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...REGGIE_TABLES].sort());
    for (const r of rows) expect(r.rls && r.forced, r.relname).toBe(true);
  });

  it("show an operator session only rows about the clients it serves", async () => {
    await withOperator(t.db, [a], async (tx) => {
      await asWorker(tx);
      // The conversation about no client and the one about A; not B's.
      expect(await count(tx, "reggie_conversation")).toBe(2);
      expect(await count(tx, "reggie_action")).toBe(2);
      expect(await count(tx, "reggie_message")).toBe(3);
    });
    await withOperator(t.db, [a, b], async (tx) => {
      await asWorker(tx);
      expect(await count(tx, "reggie_conversation")).toBe(3);
    });
  });

  it("show a client's session nothing, and let it write nothing", async () => {
    await withTenant(t.db, a, async (tx) => {
      await asWorker(tx);
      for (const table of REGGIE_TABLES) expect(await count(tx, table), table).toBe(0);
    });
    const code = await errorCode(
      withTenant(t.db, a, async (tx) => {
        await asWorker(tx);
        await tx.insert(reggieConversation).values({ userId: ann, clientId: a });
      }),
    );
    expect(code).toBe("42501");
  });

  it("refuse an operator a row about a client it doesn't serve", async () => {
    const code = await errorCode(
      withOperator(t.db, [a], async (tx) => {
        await asWorker(tx);
        await tx.insert(reggieConversation).values({ userId: ann, clientId: b });
      }),
    );
    expect(code).toBe("42501");
  });

  it("keep messages: the Worker can't change or remove one", async () => {
    const code = await errorCode(
      withOperator(t.db, [a, b], async (tx) => {
        await asWorker(tx);
        await tx.update(reggieMessage).set({ text: "changed" });
      }),
    );
    expect(code).toBe("42501");
  });
});
