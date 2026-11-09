// Parameters go to Postgres typed `unknown` (docs/plan.md §1.83): the server still decides each
// one's type from the query, so every kind of value the platform sends reads back as before.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("parameters typed unknown", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const one = async <T>(query: ReturnType<typeof sql>) =>
    [...(await t.db.execute<T & Record<string, unknown>>(query))][0] as T;

  it("lets the server type each value from where it is used", async () => {
    const id = "00000000-0000-4000-8000-0000000000aa";
    const at = new Date("2026-11-09T12:34:56.789Z");
    const row = await one<{
      same: boolean;
      at: string;
      day: string;
      flag: boolean;
      n: number;
      big: string;
      doc: unknown;
      ids: number;
      money: string;
    }>(sql`select
      ${id}::uuid = ${id} as same,
      to_char(${at}::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') as at,
      ${at}::date::text as day,
      (${true} and not ${false}) as flag,
      ${41} + 1 as n,
      (${"9007199254740993"}::int8 + 1)::text as big,
      ${JSON.stringify({ a: [1, "two"] })}::jsonb as doc,
      cardinality(${`{${id},${id}}`}::uuid[]) as ids,
      (${"12.3400"}::numeric(14,4) * 2)::text as money`);
    expect(row).toEqual({
      same: true,
      at: "2026-11-09T12:34:56.789",
      day: "2026-11-09",
      flag: true,
      n: 42,
      big: "9007199254740994",
      doc: { a: [1, "two"] },
      ids: 2,
      money: "24.6800",
    });
    // Bytes keep the describe-first path (their text depends on the type).
    const bytes = await one<{ hex: string }>(
      sql`select encode(${new Uint8Array([1, 2, 255])}::bytea, 'hex') as hex`,
    );
    expect(bytes.hex).toBe("0102ff");
  });

  it("keeps nulls and runs inside transactions and savepoints", async () => {
    const out = await t.db.transaction(async (tx) => {
      const [a] = [...(await tx.execute<{ v: string | null }>(sql`select ${null}::text as v`))];
      const inner = await tx.transaction(async (sp) => [
        ...(await sp.execute<{ v: string }>(sql`select ${"in savepoint"}::text as v`)),
      ]);
      return { a: a?.v, b: inner[0]?.v };
    });
    expect(out).toEqual({ a: null, b: "in savepoint" });
  });
});
