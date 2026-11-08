// Migrations: the journal's order (no database), then on a throwaway database: they apply to an
// empty database, applying again changes nothing, the result matches the Drizzle schema, and every
// table with a tenant_id has forced row-level security.

import { readFileSync } from "node:fs";
import { DEFAULT_PERMISSIONS } from "@countersign/core";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { OPERATOR_ONLY_TABLES, OPERATOR_TABLES, TENANT_TABLES } from "./schema";
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

  // Pack tables carry the comment `pack:<id>` (docs/plan.md §1.12, §1.63): the platform's schema
  // doesn't know them (it never imports a pack), so their columns are the pack's own test's
  // business; their row-level security is checked here like every other table's.
  const packTables = async () =>
    new Set(
      (
        await t.db.$client<{ relname: string }[]>`
          select c.relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where c.relkind = 'r' and obj_description(c.oid, 'pg_class') like 'pack:%'`
      ).map((r) => r.relname),
    );

  it("match the Drizzle schema: every table and column, with its nullability", async () => {
    const packs = await packTables();
    const cols = (
      await t.db.$client<{ table_name: string; column_name: string; is_nullable: string }[]>`
        select table_name, column_name, is_nullable from information_schema.columns
        where table_schema = 'public'`
    ).filter((c) => !packs.has(c.table_name));
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
    // P-1 (0032): the Materials pack's four tables are the only pack tables, and they are checked
    // for RLS below like every other.
    // P-5 (0033): its purchase requests and quotes are the pack's too.
    const packs = await packTables();
    expect([...packs].sort()).toEqual([
      "catalog_item",
      "item_alias",
      "item_match",
      "price_observation",
      "purchase_request",
      "purchase_request_line",
      "quote_line",
      "quote_request",
    ]);
    expect(
      rows
        .map((r) => r.relname)
        .filter((n) => !packs.has(n))
        .sort(),
    ).toEqual([...TENANT_TABLES].sort());
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
      "document",
      "doc_extraction",
      "doc_line",
      "tenant_change",
      "feedback",
      "contact",
      "contact_change",
      "knowledge_entry",
      "knowledge_entry_version",
      "billing_setting",
      "billing_usage_report",
      "billing_event",
      "billing_agent_day",
      "billing_statement",
      "reach_out",
      "tenant_key",
      "agent_grant",
      "access_release",
      "organization",
      "organization_change",
      "audit_event",
      // Wave 1 (0018–0025): nothing gets DELETE.
      "usage_platform_daily",
      "notification",
      "weekly_table",
      "thread_read",
      "model_call",
      "receivable",
      // Wave 2 (0026–0029): nothing gets DELETE either.
      "automation",
      "automation_version",
      "test_case",
      "test_suite_run",
      "test_case_result",
      "oversight_decision",
      // Wave 3 (0030): a conversation is closed, never deleted.
      "builder_session",
      "builder_turn",
      // v0.14 capture (0031): a WhatsApp conversation and its log stay.
      "conversation",
      "conversation_change",
      // P-1 (0032): alerts and the Materials pack's tables are kept; a merge repoints, never deletes.
      "alert",
      "catalog_item",
      "item_alias",
      "item_match",
      "price_observation",
      // P-5 (0033): a request is cancelled or closed and a quote declined or expired, never deleted.
      "purchase_request",
      "purchase_request_line",
      "quote_request",
      "quote_line",
      // P-7 (0034): a translation is kept beside its original, never removed.
      "message_translation",
    ]) {
      expect(await can(table, "DELETE"), `${table} DELETE`).toBe(false);
    }
    // P-7 (0034): insert only, like a document's reading.
    expect(await can("message_translation", "UPDATE")).toBe(false);
    // A session's draft changes in place; a turn only gains `undone_at` (trigger, 0030).
    expect(await can("builder_session", "UPDATE")).toBe(true);
    expect(await can("builder_turn", "UPDATE")).toBe(true);
    // Insert only (0028, 0029); a version's status changes (0027), like skill_version's.
    expect(await can("test_case_result", "UPDATE")).toBe(false);
    expect(await can("oversight_decision", "UPDATE")).toBe(false);
    // v0.14 capture (0031): a conversation's capture changes in place; its log is insert only.
    expect(await can("conversation", "UPDATE")).toBe(true);
    expect(await can("conversation_change", "UPDATE")).toBe(false);
    // P-1 (0032): a person accepts or dismisses an alert; catalog items, aliases and prices are
    // corrected in place; a matching decision is a log (a person's decision is a new row).
    for (const table of ["alert", "catalog_item", "item_alias", "price_observation"]) {
      expect(await can(table, "SELECT"), `${table} SELECT`).toBe(true);
      expect(await can(table, "INSERT"), `${table} INSERT`).toBe(true);
      expect(await can(table, "UPDATE"), `${table} UPDATE`).toBe(true);
    }
    expect(await can("item_match", "INSERT")).toBe(true);
    expect(await can("item_match", "UPDATE")).toBe(false);
    // P-5 (0033): a request's status and fields, a quote's status and its lines change in place.
    for (const table of [
      "purchase_request",
      "purchase_request_line",
      "quote_request",
      "quote_line",
    ]) {
      expect(await can(table, "SELECT"), `${table} SELECT`).toBe(true);
      expect(await can(table, "INSERT"), `${table} INSERT`).toBe(true);
      expect(await can(table, "UPDATE"), `${table} UPDATE`).toBe(true);
    }
    for (const table of ["automation", "automation_version", "test_case", "test_suite_run"]) {
      expect(await can(table, "UPDATE"), `${table} UPDATE`).toBe(true);
    }
    expect(await can("model_call", "UPDATE")).toBe(false);
    for (const table of [
      "usage_platform_daily",
      "notification",
      "weekly_table",
      "thread_read",
      "receivable",
    ]) {
      expect(await can(table, "UPDATE"), `${table} UPDATE`).toBe(true);
    }
    expect(await can("audit_event", "UPDATE")).toBe(false);
    expect(await can("contact_change", "UPDATE")).toBe(false);
    expect(await can("organization_change", "UPDATE")).toBe(false);
    expect(await can("knowledge_entry_version", "UPDATE")).toBe(false);
    expect(await can("billing_event", "UPDATE")).toBe(false);
    expect(await can("billing_agent_day", "UPDATE")).toBe(false);
    expect(await can("connection_change", "UPDATE")).toBe(false);
    expect(await can("agent_change", "UPDATE")).toBe(false);
    expect(await can("doc_extraction", "UPDATE")).toBe(false);
    expect(await can("doc_line", "UPDATE")).toBe(false);
    expect(await can("tenant_change", "UPDATE")).toBe(false);
    // The browser site catalogue (0012): sites change in place, versions are only inserted.
    for (const table of OPERATOR_ONLY_TABLES) {
      expect(await can(table, "SELECT"), `${table} SELECT`).toBe(true);
      expect(await can(table, "INSERT"), `${table} INSERT`).toBe(true);
      expect(await can(table, "TRUNCATE"), `${table} TRUNCATE`).toBe(false);
    }
    expect(await can("browser_site", "DELETE")).toBe(false);
    expect(await can("browser_site_version", "DELETE")).toBe(false);
    // Saved views (0023) aren't history: an operator deletes their own (§14).
    expect(await can("saved_view", "DELETE")).toBe(true);
    expect(await can("browser_site", "UPDATE")).toBe(true);
    expect(await can("browser_site_version", "UPDATE")).toBe(false);
    expect(await can("saved_view", "UPDATE")).toBe(true);
    // The connectors catalog (0026): settings change in place, never deleted.
    expect(await can("connector_setting", "UPDATE")).toBe(true);
    expect(await can("connector_setting", "DELETE")).toBe(false);
    // A synced transaction's lines mirror the tool's current lines (0015, QuickBooks sync); the
    // versions behind them stay in raw_record.
    expect(await can("transaction_line", "DELETE")).toBe(true);
  });

  it("force RLS on the operator-only tables, with policies on app.operator alone", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; quals: string }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select string_agg(pg_get_expr(p.polqual, p.polrelid), ' | ') from pg_policy p
         where p.polrelid = c.oid) as quals
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client([...OPERATOR_ONLY_TABLES])}
      order by c.relname`;
    expect(rows.map((r) => r.relname)).toEqual([...OPERATOR_ONLY_TABLES].sort());
    for (const r of rows) {
      expect(r.rls && r.forced, `${r.relname} forces RLS`).toBe(true);
      expect(r.quals, r.relname).toBe("app_is_operator()");
    }
  });

  it("seed the billing settings and let only operator sessions change them", async () => {
    const [row] = await t.db.$client<{ a: number; m: string }[]>`
      select allowance_credits_per_agent as a, meter_event_name as m from billing_setting`;
    expect({ ...row }).toEqual({ a: 2000, m: "mezonas_credits" });
    const costs = await t.db.$client<{ measure: string; unit_cost: string; per_units: number }[]>`
      select measure, unit_cost, per_units from billing_unit_cost order by measure`;
    expect(costs.map((c) => [c.measure, c.unit_cost, c.per_units])).toEqual([
      ["call_seconds", "0.1000", 60],
      ["cost_usd", "1.0000", 1],
      ["messages", "0.0083", 1],
    ]);
    const updated = async (operator: boolean) =>
      t.db.$client.begin(async (tx) => {
        await tx`select set_config('app.operator', ${operator ? "on" : "off"}, true)`;
        await tx`set local role cs_worker`;
        return (await tx`update billing_setting set allowance_credits_per_agent = 2000`).count;
      });
    expect(await updated(false)).toBe(0);
    expect(await updated(true)).toBe(1);
    // §1.32's defaults: placeholders until the owner sets prices; auto-send off.
    const [defaults] = await t.db.$client<{ p: string; c: string; s: boolean }[]>`
      select default_agent_price as p, credit_price as c, auto_send as s from billing_setting`;
    expect({ ...defaults }).toEqual({ p: "250.0000", c: "0.0200", s: false });
  });

  it("let every session read template prices and only operator sessions write them", async () => {
    const [template] = await t.db.$client<{ id: string }[]>`
      insert into agent (kind, slug, name) values ('template', 'priced', 'Priced') returning id`;
    const write = async (operator: boolean) =>
      t.db.$client.begin(async (tx) => {
        await tx`select set_config('app.operator', ${operator ? "on" : "off"}, true)`;
        await tx`set local role cs_worker`;
        const inserted = await tx`
          insert into billing_template_price (template_id, monthly_price, included_credits)
          values (${template?.id ?? ""}, 100, 1000)
          on conflict (template_id) do update set monthly_price = 120 returning template_id`;
        return inserted.length;
      });
    await expect(write(false)).rejects.toThrow(/row-level security/);
    expect(await write(true)).toBe(1);
    const read = await t.db.$client.begin(async (tx) => {
      await tx`set local role cs_worker`;
      return tx`select monthly_price from billing_template_price`;
    });
    expect(read.map((r) => r.monthly_price)).toEqual(["100.0000"]);
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
