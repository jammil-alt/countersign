// The one-off agent purge (docs/step-model-plan.md §12, R0): every agent, run, build, skill and
// automation goes, and what can't outlive them; the client's records stay with their links cleared.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertClient, insertOperatorRows } from "./fixtures.test-helper";
import { PurgeRefused } from "./purge";
import { AGENT_PURGE_ROOTS, agentPurgePlan, purgeAgents } from "./purge-agents";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("purgeAgents", () => {
  let t: TestDatabase;
  let database = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    await insertClient(t.db, "A");
    await insertClient(t.db, "B");
    await insertOperatorRows(t.db);
    const [row] = [
      ...(await t.db.execute<{ name: string }>(sql`select current_database() as name`)),
    ];
    database = row?.name ?? "";
  });
  afterAll(async () => {
    await t?.drop();
  });

  const rows = async (table: string) =>
    Number(
      [...(await t.db.execute<{ n: string }>(sql.raw(`select count(*) as n from ${table}`)))][0]
        ?.n ?? 0,
    );

  // The client's own records, which stay.
  const KEPT = [
    "tenant",
    "connection",
    "raw_record",
    "vendor",
    "document",
    "doc_extraction",
    "ledger_account",
    "audit_event",
  ];

  it("refuses when the database name typed isn't the one connected to", async () => {
    await expect(purgeAgents(t.db, { confirmDatabase: "production" })).rejects.toBeInstanceOf(
      PurgeRefused,
    );
    expect(await rows("agent")).toBeGreaterThan(0);
  });

  it("goes from the roots to everything that can't outlive them, and keeps the client's records", async () => {
    const plan = await agentPurgePlan(t.db);
    for (const root of AGENT_PURGE_ROOTS) expect(plan.order).toContain(root);
    for (const table of ["agent_version", "run", "step_run", "skill_version", "build_item"]) {
      expect(plan.order, table).toContain(table);
    }
    for (const table of KEPT) expect(plan.order, table).not.toContain(table);
    // Children before parents.
    expect(plan.order.indexOf("step_run")).toBeLessThan(plan.order.indexOf("run"));
    expect(plan.order.indexOf("agent_version")).toBeLessThan(plan.order.indexOf("agent"));
  });

  it("a dry run reports what would go and changes nothing", async () => {
    const before = await rows("agent");
    const report = await purgeAgents(t.db, { confirmDatabase: database, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.deleted.find((d) => d.table === "agent")?.rows).toBe(before);
    expect(await rows("agent")).toBe(before);
    expect([
      ...(await t.db.execute(sql`select 1 from audit_event where action = 'agents.purge'`)),
    ]).toHaveLength(0);
  });

  it("deletes every agent, run, build, skill and automation, keeps the rest, and records it", async () => {
    const kept = Object.fromEntries(
      await Promise.all(KEPT.map(async (table) => [table, await rows(table)])),
    );
    const plan = await agentPurgePlan(t.db);
    const report = await purgeAgents(t.db, { confirmDatabase: ` ${database} ` });
    expect(report.dryRun).toBe(false);
    for (const table of plan.order) expect(await rows(table), table).toBe(0);
    // A row whose check needs its agent goes with it rather than lose the link (a statement
    // line of an agent, an agent's memory note); the others in its table stay.
    for (const table of ["billing_statement_line", "memory_note"]) {
      expect(
        report.deleted.some((d) => d.table === table),
        table,
      ).toBe(true);
    }
    for (const table of KEPT) {
      const now = await rows(table);
      if (table === "audit_event") expect(now).toBe((kept[table] as number) + 1);
      else expect(now, table).toBe(kept[table]);
    }
    // A record an agent made keeps everything but the link to the version that made it.
    expect(
      Number(
        [
          ...(await t.db.execute<{ n: string }>(
            sql`select count(*) as n from doc_extraction where agent_version_id is not null`,
          )),
        ][0]?.n,
      ),
    ).toBe(0);
    expect([
      ...(await t.db.execute(sql`select 1 from audit_event where action = 'agents.purge'`)),
    ]).toHaveLength(1);
    // The history triggers are back on, on every table it touched.
    const off = [
      ...(await t.db.execute<{ t: string }>(
        sql`select tgrelid::regclass::text as t from pg_trigger
            where not tgisinternal and tgenabled = 'D'`,
      )),
    ];
    expect(off).toEqual([]);
  });
});
