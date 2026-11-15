// The build tables (migration 0053, docs/plan.md §1.108) as the Worker's role sees them: operator
// sessions only, and only for builds whose client and test client the session serves; a client's
// session sees nothing; messages and events are kept as written (no UPDATE or DELETE).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import {
  appUser,
  BUILD_TABLES,
  build,
  buildEvent,
  buildItem,
  buildMessage,
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

describe.skipIf(!online)("the build tables", () => {
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
    // A template build (no client), one for A, one for B, and a template build tested at B.
    const rows: { clientId: string | null; testClientId: string | null }[] = [
      { clientId: null, testClientId: null },
      { clientId: a, testClientId: null },
      { clientId: b, testClientId: null },
      { clientId: null, testClientId: b },
    ];
    for (const r of rows) {
      const [made] = await t.db
        .insert(build)
        .values({ kind: "agent", title: "Invoice review", createdBy: ann, ...r })
        .returning({ id: build.id });
      const buildId = made?.id ?? "";
      await t.db
        .insert(buildItem)
        .values({ buildId, phase: "intake", kind: "question", title: "How many?" });
      await t.db
        .insert(buildMessage)
        .values({ buildId, phase: "intake", role: "operator", text: "hi" });
      await t.db
        .insert(buildEvent)
        .values({ buildId, kind: "phase", toPhase: "intake", userId: ann });
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
      where c.relname in ${t.db.$client([...BUILD_TABLES])}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...BUILD_TABLES].sort());
    for (const r of rows) expect(r.rls && r.forced, r.relname).toBe(true);
  });

  it("show an operator session only builds about the clients it serves", async () => {
    await withOperator(t.db, [a], async (tx) => {
      await asWorker(tx);
      // The template build and A's; not B's, nor the template build tested at B.
      for (const table of BUILD_TABLES) expect(await count(tx, table), table).toBe(2);
    });
    await withOperator(t.db, [a, b], async (tx) => {
      await asWorker(tx);
      for (const table of BUILD_TABLES) expect(await count(tx, table), table).toBe(4);
    });
  });

  it("show a client's session nothing, and let it write nothing", async () => {
    await withTenant(t.db, a, async (tx) => {
      await asWorker(tx);
      for (const table of BUILD_TABLES) expect(await count(tx, table), table).toBe(0);
    });
    const code = await errorCode(
      withTenant(t.db, a, async (tx) => {
        await asWorker(tx);
        await tx.insert(build).values({ kind: "agent", title: "x", clientId: a });
      }),
    );
    expect(code).toBe("42501");
  });

  it("refuse an operator a build, or an item, about a client it doesn't serve", async () => {
    expect(
      await errorCode(
        withOperator(t.db, [a], async (tx) => {
          await asWorker(tx);
          await tx.insert(build).values({ kind: "agent", title: "x", clientId: b });
        }),
      ),
    ).toBe("42501");
    const [aboutB] = await t.db.select({ id: build.id }).from(build).where(eq(build.clientId, b));
    expect(
      await errorCode(
        withOperator(t.db, [a], async (tx) => {
          await asWorker(tx);
          await tx
            .insert(buildItem)
            .values({ buildId: aboutB?.id ?? "", phase: "draft", kind: "gap", title: "x" });
        }),
      ),
    ).toBe("42501");
  });

  it("keep messages and events as written", async () => {
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of ["build_message", "build_event"]) {
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "UPDATE"), table).toBe(false);
      expect(await can(table, "DELETE"), table).toBe(false);
    }
    for (const table of ["build", "build_item"]) {
      expect(await can(table, "UPDATE"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
    }
  });

  it("make an item from the same thing once", async () => {
    const [mine] = await t.db.select({ id: build.id }).from(build).where(eq(build.clientId, a));
    const item = {
      buildId: mine?.id ?? "",
      phase: "poc" as const,
      kind: "test" as const,
      title: "Case 3 fails",
      key: "case:3",
    };
    await t.db.insert(buildItem).values(item);
    expect(await errorCode(t.db.insert(buildItem).values(item))).toBe("23505");
  });
});
