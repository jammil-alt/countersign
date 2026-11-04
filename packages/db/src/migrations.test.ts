// Migrations: the journal's order (no database), then on a throwaway database: they apply to an
// empty database, applying again changes nothing, the result matches the Drizzle schema, and every
// table with a tenant_id has forced row-level security.

import { readFileSync } from "node:fs";
import { DEFAULT_PERMISSIONS } from "@countersign/core";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { OPERATOR_TABLES, TENANT_TABLES } from "./schema";
import {
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

type Entry = { idx: number; when: number; tag: string };
const journal = JSON.parse(
  readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Entry[] };

describe("migration journal", () => {
  const entries = journal.entries;

  // DECISION: parallel streams reserve migration numbers ahead (docs/plan.md §1.21), so a branch's
  // journal may skip numbers; tags must still be numbered, unique and in ascending order.
  it("lists idx 0..n-1 with numbered, unique, ascending tags", () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
    const numbers = entries.map((e) => {
      expect(e.tag).toMatch(/^\d{4}_/);
      return Number(e.tag.slice(0, 4));
    });
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1] ?? -1);
    }
  });

  // Drizzle's migrator applies only entries whose `when` is later than the last applied one, so an
  // out-of-order `when` would be skipped silently on every database that already has the later one.
  it("has strictly increasing `when`", () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.when).toBeGreaterThan(entries[i - 1]?.when ?? 0);
    }
  });
});

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

const online = await databaseAvailable();

describe.skipIf(!online)("migrations on an empty database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("apply every journal entry once, and re-applying changes nothing", async () => {
    const count = async () =>
      (await t.db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n;
    expect(await count()).toBe(journal.entries.length);
    const schemaBefore = await t.db.$client`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' order by 1, 2`;
    await migrateAsOwner(t.url);
    expect(await count()).toBe(journal.entries.length);
    const schemaAfter = await t.db.$client`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' order by 1, 2`;
    expect(schemaAfter).toEqual(schemaBefore);
  });

  it("leave the tables owned by cs_owner, not the superuser", async () => {
    const rows = await t.db.$client`
      select tablename, tableowner from pg_tables where schemaname = 'public'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tableowner, r.tablename).toBe("cs_owner");
  });

  it("match the Drizzle schema: every table and column, with its nullability", async () => {
    const cols = await t.db.$client<
      { table_name: string; column_name: string; is_nullable: string }[]
    >`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public'`;
    const actual = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable]));
    const expected = new Set<string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        expected.add(key);
        expect(actual.get(key), key).toBe(column.notNull ? "NO" : "YES");
      }
    }
    expect([...actual.keys()].filter((k) => !expected.has(k))).toEqual([]);
  });

  it("force RLS with a policy on every table that has a tenant_id, and only those listed", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r'
        and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by c.relname`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.rls && r.forced, `${r.relname} forces RLS`).toBe(true);
      expect(r.policies, `${r.relname} has a policy`).toBeGreaterThan(0);
    }
    // Operator tables allow tenant_id null; every other tenant table requires it.
    const nullable = await t.db.$client<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'YES'`;
    expect(nullable.map((r) => r.table_name).sort()).toEqual([...OPERATOR_TABLES].sort());
  });

  it("give cs_runtime what the runtime needs and no DELETE on history", async () => {
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of [...TENANT_TABLES, "tenant", "app_user"]) {
      expect(await can(table, "SELECT"), `${table} SELECT`).toBe(true);
      expect(await can(table, "INSERT"), `${table} INSERT`).toBe(true);
      expect(await can(table, "TRUNCATE"), `${table} TRUNCATE`).toBe(false);
    }
    for (const table of [
      "agent_version",
      "skill_version",
      "raw_record",
      "connection_change",
      "agent_change",
      "event",
      "tenant",
      "app_user",
      "vendor",
      "transaction",
      "transaction_line",
      "document",
      "doc_extraction",
      "doc_line",
      "tenant_change",
      "feedback",
      "contact",
      "contact_change",
      "reach_out",
    ]) {
      expect(await can(table, "DELETE"), `${table} DELETE`).toBe(false);
    }
    expect(await can("contact_change", "UPDATE")).toBe(false);
    expect(await can("connection_change", "UPDATE")).toBe(false);
    expect(await can("agent_change", "UPDATE")).toBe(false);
    expect(await can("doc_extraction", "UPDATE")).toBe(false);
    expect(await can("doc_line", "UPDATE")).toBe(false);
    expect(await can("tenant_change", "UPDATE")).toBe(false);
  });

  it("default ids to uuid v7, in creation order", async () => {
    const rows = await t.db.$client<{ id: string }[]>`
      select uuid_generate_v7()::text as id from generate_series(1, 50)`;
    for (const r of rows)
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    const ms = (id: string) => Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    const first = rows[0]?.id ?? "";
    expect(Math.abs(ms(first) - Date.now())).toBeLessThan(60_000);
  });

  it("default a connection's permissions to core's DEFAULT_PERMISSIONS", async () => {
    const [row] = await t.db.$client<{ d: string }[]>`
      select column_default as d from information_schema.columns
      where table_name = 'connection' and column_name = 'permissions'`;
    const json = /^'(.*)'::jsonb$/.exec(row?.d ?? "")?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(DEFAULT_PERMISSIONS);
  });
});
