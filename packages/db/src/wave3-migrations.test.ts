// Migration 0030 (the Builder as a conversation, ARCHITECTURE v0.12 §5.5, §9.6) beyond what the RLS,
// immutability and migration tests walk for every table: it applies on a database the previous
// Worker used, the keys and checks the new tables rely on, same-client foreign keys, and who sees
// the shared rows (tenant_id null): operator sessions only.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Tx, withOperator, withTenant } from "./client";
import {
  BUNDLE,
  type ClientFixture,
  insertClient,
  insertOperatorRows,
} from "./fixtures.test-helper";
import { builderSession, builderTurn } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

/** The tenant ids a session sees in a table. */
async function scopeOf(tx: Tx, table: string): Promise<Set<string | null>> {
  const rows = await tx.execute<{ t: string | null }>(
    sql.raw(`select tenant_id::text as t from ${table}`),
  );
  return new Set([...rows].map((r) => r.t));
}

describe.skipIf(!online)("0030 on a database the previous Worker used", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0029_oversight_decision" });
    // The previous Worker's rows: a template and a client agent, untouched by 0030.
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    await t.db.$client`
      insert into agent (kind, slug, name) values ('template', 'collections', 'Collections')`;
    await t.db.$client`
      insert into agent (tenant_id, kind, slug, name, stage)
      values (${tn?.id ?? ""}, 'client', 'remy', 'Remy', 'bench')`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the two tables, empty, and leaves the agents as they were", async () => {
    const [sessions] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from builder_session`;
    const [turns] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from builder_turn`;
    const agents = await t.db.$client<{ slug: string }[]>`select slug from agent order by slug`;
    expect([sessions?.n, turns?.n]).toEqual([0, 0]);
    expect(agents.map((a) => a.slug)).toEqual(["collections", "remy"]);
  });

  it("applies the rest of the journal once", async () => {
    const [row] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(row?.n).toBeGreaterThanOrEqual(31);
  });
});

describe.skipIf(!online)("builder_session and builder_turn (0030)", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    await insertOperatorRows(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("builder_session: kinds and statuses checked; an agent session names no skill", async () => {
    const values = { tenantId: A.tenantId, kind: "agent" as const, bundle: BUNDLE };
    const [row] = await t.db.insert(builderSession).values(values).returning();
    expect(row?.status).toBe("open");
    expect(row?.agentId).toBeNull();
    for (const bad of [
      { ...values, kind: "workflow" as "agent" },
      { ...values, status: "published" as "open" },
    ]) {
      expect(await errorCode(t.db.insert(builderSession).values(bad)), JSON.stringify(bad)).toBe(
        CHECK,
      );
    }
    // An existing skill's id on an agent session, or an agent's on a skill session.
    const [skillRow] = await t.db.execute<{ id: string }>(
      sql`select id from skill where tenant_id = ${A.tenantId} limit 1`,
    );
    expect(
      await errorCode(
        t.db.insert(builderSession).values({ ...values, skillId: skillRow?.id ?? "" }),
      ),
    ).toBe(CHECK);
    expect(
      await errorCode(
        t.db
          .insert(builderSession)
          .values({ ...values, kind: "skill", agentId: A.agentId, bundle: {} }),
      ),
    ).toBe(CHECK);
    const [ok] = await t.db
      .insert(builderSession)
      .values({ ...values, kind: "skill", skillId: skillRow?.id ?? "", bundle: {} })
      .returning();
    expect(ok?.kind).toBe("skill");
  });

  it("builder_session: the agent belongs to the session's client", async () => {
    expect(
      await errorCode(
        t.db
          .insert(builderSession)
          .values({ tenantId: A.tenantId, kind: "agent", agentId: B.agentId, bundle: BUNDLE }),
      ),
    ).toBe(FOREIGN_KEY);
    expect(
      await errorCode(
        t.db.insert(builderSession).values({
          tenantId: A.tenantId,
          kind: "agent",
          agentId: "019a0000-0000-7000-8000-000000000000",
          bundle: BUNDLE,
        }),
      ),
    ).toBe(FOREIGN_KEY);
  });

  it("builder_turn: one per session and seq, checked, of the session's client", async () => {
    const base = {
      tenantId: A.tenantId,
      sessionId: A.builderSessionId,
      role: "operator" as const,
      text: "Make the window five days.",
    };
    expect(await errorCode(t.db.insert(builderTurn).values({ ...base, seq: 1 }))).toBe(UNIQUE);
    const [row] = await t.db
      .insert(builderTurn)
      .values({ ...base, seq: 2, command: "/skill" })
      .returning();
    expect(row?.changes).toEqual([]);
    expect(row?.meta).toEqual({});
    expect(row?.costUsd).toBe("0.0000");
    for (const bad of [
      { ...base, seq: 0 },
      { ...base, seq: 3, role: "client" as "operator" },
      { ...base, seq: 3, changes: { not: "a list" } as unknown as [] },
      { ...base, seq: 3, costUsd: "-1" },
    ]) {
      expect(await errorCode(t.db.insert(builderTurn).values(bad)), JSON.stringify(bad)).toBe(
        CHECK,
      );
    }
    // A's session, written as B's.
    expect(
      await errorCode(t.db.insert(builderTurn).values({ ...base, tenantId: B.tenantId, seq: 3 })),
    ).toBe(FOREIGN_KEY);
  });

  it("shared sessions and turns show only in operator sessions", async () => {
    const tables = ["builder_session", "builder_turn"];
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of tables)
        expect(await scopeOf(tx, table), table).toEqual(new Set([A.tenantId]));
    });
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of tables) expect(await scopeOf(tx, table), table).toEqual(new Set([null]));
    });
    await withOperator(t.db, [B.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of tables) {
        expect(await scopeOf(tx, table), table).toEqual(new Set([null, B.tenantId]));
      }
    });
    // A client session can't write a shared row, nor a row of another client.
    for (const insert of [
      (tx: Tx) => tx.insert(builderSession).values({ kind: "agent", bundle: BUNDLE }),
      (tx: Tx) =>
        tx.insert(builderSession).values({ tenantId: B.tenantId, kind: "agent", bundle: BUNDLE }),
    ]) {
      expect(
        await errorCode(
          withTenant(t.db, A.tenantId, async (tx) => {
            await asWorker(tx);
            await insert(tx);
          }),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("the Worker updates a session's draft and status in place", async () => {
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      await tx
        .update(builderSession)
        .set({ status: "saved", bundle: { ...BUNDLE } })
        .where(eq(builderSession.id, A.builderSessionId));
    });
    const [row] = await t.db
      .select({ status: builderSession.status })
      .from(builderSession)
      .where(eq(builderSession.id, A.builderSessionId));
    expect(row?.status).toBe("saved");
  });
});
