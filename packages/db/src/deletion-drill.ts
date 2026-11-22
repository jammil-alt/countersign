// The deletion drill (docs/plan.md §1.218; SOC 2 CC6.5, C1.2): the client-deletion procedure run
// end to end on a throwaway Sandbox client, so we can show it works rather than say so. It
//
// 1. makes a Sandbox client with weeks of realistic rows (the demo seed's Harbor Millwork under a
//    new name, its own people and its own operator), counting its rows in every table;
// 2. retires it and purges it with the same `purgeClient` the purge workflow runs;
// 3. checks nothing of it is left: no row in any table names it, the purge deleted exactly its rows
//    in every table that names a client (so nothing of another client), its people are gone and
//    the purge is in the audit log;
// 4. records the result in the audit log (`client.deletion_drill`), which the SOC 2 readiness
//    view reads.
//
// Run as cs_owner (`db:deletion-drill`), on staging or locally: it needs the platform templates the
// seed installs, and it never runs on production (the seed doesn't either).
//
// DECISION (§1.218): a new Sandbox client each time, never the seeded Sandbox, which template test
// runs use. It is marked `sandbox` and `deletion_drill` in its settings, served only by its own
// throwaway operator, so no person's back office lists it during the seconds it exists.
// DECISION (§1.218): its files are references only (the demo seed writes none to storage), so the
// drill marks them deleted itself and purges with `force`, which skips only the 30-day wait and
// that mark; the name check runs as in the workflow.

import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { PurgeRefused, purgeClient, purgePlan } from "./purge";
import { HARBOR_PROFILE, seedDemo } from "./seed-demo";

export const DELETION_DRILL_ACTION = "client.deletion_drill";

export interface DeletionDrillReport {
  ok: boolean;
  /** The drill client's id: gone when the drill passed. */
  tenantId: string | null;
  name: string;
  /** Tables the drill client had rows in, and those rows, before the purge. */
  tables: number;
  rows: number;
  usersDeleted: number;
  /** Every check that failed, in words. Empty when the drill passed. */
  failed: string[];
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Every column that names a client by id (`tenant_id`, `client_id`, `test_client_id`). */
async function clientColumns(db: Db): Promise<{ table: string; column: string }[]> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.column_name in ('tenant_id', 'client_id', 'test_client_id')
    order by c.table_name, c.column_name`);
  return [...rows].map((r) => ({ table: r.table_name, column: r.column_name }));
}

/**
 * The tables still holding a row that names this client (the audit log aside, which keeps its
 * rows on purpose), with how many.
 */
export async function leftovers(
  db: Db,
  tenantId: string,
): Promise<{ table: string; column: string; rows: number }[]> {
  const left: { table: string; column: string; rows: number }[] = [];
  for (const { table, column } of await clientColumns(db)) {
    if (table === "audit_event") continue;
    const [r] = [
      ...(await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.raw(ident(table))}
            where ${sql.raw(ident(column))} = ${tenantId}`,
      )),
    ];
    if ((r?.n ?? 0) > 0) left.push({ table, column, rows: r?.n ?? 0 });
  }
  const [t] = [...(await db.execute(sql`select 1 from tenant where id = ${tenantId}`))];
  if (t) left.push({ table: "tenant", column: "id", rows: 1 });
  return left;
}

/** Runs the drill and records it. Throws only when the audit row itself can't be written. */
export async function runDeletionDrill(
  db: Db,
  options: { now?: Date } = {},
): Promise<DeletionDrillReport> {
  const now = options.now ?? new Date();
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const domain = `drill-${stamp}.deletion-drill.example.com`;
  const name = `Deletion drill ${now.toISOString().slice(0, 16).replace("T", " ")}`;
  const report: DeletionDrillReport = {
    ok: false,
    tenantId: null,
    name,
    tables: 0,
    rows: 0,
    usersDeleted: 0,
    failed: [],
  };

  try {
    // 1. The drill client, its people and its operator.
    const [operator] = [
      ...(await db.execute<{ id: string }>(sql`
        insert into app_user (email, name) values (${`operator@${domain}`}, 'Deletion drill')
        returning id`)),
    ];
    if (!operator) throw new Error("the drill's operator wasn't created");
    const swap = (s: string) => s.replaceAll(HARBOR_PROFILE.domain, domain);
    const seeded = await seedDemo(db, {
      operatorId: operator.id,
      now,
      profile: {
        ...HARBOR_PROFILE,
        key: `deletion-drill:${stamp}`,
        name,
        domain,
        people: {
          admin: { ...HARBOR_PROFILE.people.admin, email: swap(HARBOR_PROFILE.people.admin.email) },
          user: { ...HARBOR_PROFILE.people.user, email: swap(HARBOR_PROFILE.people.user.email) },
        },
        staff: swap(HARBOR_PROFILE.staff),
      },
    });
    const tenantId = seeded.tenantId;
    report.tenantId = tenantId;
    const users = [operator.id, seeded.users.admin, seeded.users.user];

    // What it holds, in every table that names its client (the purge's own reading of the schema).
    const plan = await purgePlan(db);
    const before = new Map<string, number>();
    for (const [table, column] of plan.owner) {
      const [r] = [
        ...(await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.raw(ident(table))}
              where ${sql.raw(ident(column))} = ${tenantId}`,
        )),
      ];
      if ((r?.n ?? 0) > 0) before.set(table, r?.n ?? 0);
    }
    report.tables = before.size;
    report.rows = [...before.values()].reduce((a, b) => a + b, 0);
    if (report.rows === 0) report.failed.push("the drill client had no rows to purge");

    // 2. Retired, its files marked gone (references only, see the top), then purged.
    await db.execute(sql`
      update tenant set retired_at = ${now.toISOString()}::timestamptz,
        settings = settings || ${JSON.stringify({
          sandbox: true,
          deletion_drill: true,
          purge: { files_deleted_at: now.toISOString() },
        })}::jsonb
      where id = ${tenantId}`);
    const purged = await purgeClient(db, tenantId, { force: true, confirmName: name, now });
    report.usersDeleted = purged.usersDeleted;

    // 3. Nothing of it left, and nothing of anyone else taken.
    for (const l of await leftovers(db, tenantId)) {
      report.failed.push(`${l.rows} rows left in ${l.table} (${l.column})`);
    }
    const deleted = new Map(purged.deleted.map((d) => [d.table, d.rows]));
    for (const [table, rows] of before) {
      const gone = deleted.get(table) ?? 0;
      if (gone !== rows)
        report.failed.push(`${table}: had ${rows} rows, the purge deleted ${gone}`);
    }
    const [people] = [
      ...(await db.execute<{ n: number }>(
        sql`select count(*)::int as n from app_user where id in ${users}`,
      )),
    ];
    if ((people?.n ?? 0) > 0) report.failed.push(`${people?.n} of its people are still there`);
    const [logged] = [
      ...(await db.execute(
        sql`select 1 from audit_event where tenant_id = ${tenantId} and action = 'client.purge'`,
      )),
    ];
    if (!logged) report.failed.push("the purge isn't in the audit log");
  } catch (error) {
    report.failed.push(
      error instanceof PurgeRefused
        ? `the purge refused: ${error.message}`
        : `the drill stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  report.ok = report.failed.length === 0;

  // 4. The result, readable by every operator session (no client, no actor: 0071's rule).
  await db.execute(sql`
    insert into audit_event (tenant_id, actor_kind, action, outcome, target)
    values (null, 'system', ${DELETION_DRILL_ACTION}, ${report.ok ? "ok" : "error"},
      ${JSON.stringify({
        client: report.tenantId ?? "",
        tables: String(report.tables),
        rows: String(report.rows),
        users: String(report.usersDeleted),
        ...(report.ok ? {} : { failed: report.failed.join("; ").slice(0, 500) }),
      })}::jsonb)`);
  return report;
}
