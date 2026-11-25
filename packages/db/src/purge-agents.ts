// The one-off agent purge (docs/step-model-plan.md §12, R0; owner, 2026-11-25: "ok to purge.. we
// can start from scratch"). Every agent, version, run, build, skill and automation goes, templates
// and the platform's own agents included, and so does every row that can't exist without one of
// them (a run's steps and model calls, a build's items, an agent's grants and daily usage). Rows
// that only point at one of them where they may (a booking's agent version, a vendor item's) stay,
// with that link cleared: the client's records, connections, documents, catalog and ledger are kept.
// The audit log stays. The platform's agents come back from the seed (`db:seed`).
//
// What is touched is read from the schema's foreign keys, as the client purge does
// (`./purge`), so a table added later is covered. A key that pairs the client's column with
// another (`(tenant_id, agent_id)`) is judged by the other column: where that one may be null, the
// row stays and only it is cleared.
//
// Run by hand as cs_owner (`db:purge-agents`), never by the Worker: cs_runtime has no DELETE on
// history, and the history triggers refuse deletes, so they are disabled for this transaction only
// (foreign-key checks stay on). A dry run does everything, reports it, and rolls it back.

import { type SQL, sql } from "drizzle-orm";
import type { Db, Tx } from "./client";
import { deleteOrder, PurgeRefused } from "./purge";

/** The tables emptied outright; everything that can't outlive their rows follows. */
export const AGENT_PURGE_ROOTS = [
  "agent",
  "skill",
  "automation",
  "build",
  "builder_session",
] as const;

export interface AgentPurgeReport {
  database: string;
  dryRun: boolean;
  /** Rows deleted per table, children before parents. */
  deleted: { table: string; rows: number }[];
  /** Links to deleted rows cleared on rows that stay or go. */
  cleared: { table: string; column: string; rows: number }[];
}

interface Key {
  child: string;
  parent: string;
  columns: string[];
  refColumns: string[];
  /** Whether a column other than the client's may be null: the row can lose the link and stay. */
  optional: boolean;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const list = (names: readonly string[]) => names.map(ident).join(", ");

async function keys(db: Db | Tx): Promise<Key[]> {
  const rows = await db.execute<{
    child: string;
    parent: string;
    columns: string[];
    ref_columns: string[];
    optional: boolean;
  }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
      (select json_agg(a.attname::text order by k.n)
       from unnest(c.conkey) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
      (select json_agg(a.attname::text order by k.n)
       from unnest(c.confkey) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as ref_columns,
      exists (select 1 from pg_attribute a
              where a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                and a.attname <> 'tenant_id' and not a.attnotnull) as optional
    from pg_constraint c
    where c.contype = 'f' and c.conrelid <> c.confrelid
      and c.connamespace = 'public'::regnamespace`);
  const bare = (name: string) => name.replace(/^public\./, "");
  return [...rows].map((r) => ({
    child: bare(r.child),
    parent: bare(r.parent),
    columns: r.columns,
    refColumns: r.ref_columns,
    optional: r.optional,
  }));
}

export interface AgentPurgePlan {
  /** The tables rows are deleted from, children before parents. */
  order: string[];
  /** Each table's rows that go. */
  rowsOf: Map<string, SQL>;
  /** Optional links into those rows, cleared first: the columns set to null and on which rows. */
  clear: { table: string; columns: string[]; where: SQL }[];
}

export async function agentPurgePlan(db: Db | Tx): Promise<AgentPurgePlan> {
  const all = await keys(db);
  const rowsOf = new Map<string, SQL>(AGENT_PURGE_ROOTS.map((t) => [t, sql`true`]));
  const required = (k: Key) => !k.optional && rowsOf.has(k.parent) && k.parent !== k.child;
  // Rows that can't outlive a deleted row, down to the last level.
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of all) {
      if (!required(k) || rowsOf.has(k.child)) continue;
      const via = all.filter((x) => x.child === k.child && required(x));
      rowsOf.set(
        k.child,
        sql.join(
          via.map(
            (x) =>
              sql`(${sql.raw(list(x.columns))}) in (select ${sql.raw(list(x.refColumns))}
                from ${sql.raw(ident(x.parent))} where ${rowsOf.get(x.parent) as SQL})`,
          ),
          sql` or `,
        ),
      );
      grew = true;
    }
  }
  const tables = [...rowsOf.keys()];
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const k of all) {
    if (!k.optional && rowsOf.has(k.child) && rowsOf.has(k.parent)) {
      parents.get(k.child)?.add(k.parent);
    }
  }
  const order = deleteOrder(parents);
  // Every optional link into a row that goes: cleared, so the row keeps everything else (or, for a
  // row that goes too, so the order above holds: an agent and its live version point at each other).
  const clear = all
    .filter((k) => k.optional && rowsOf.has(k.parent))
    .map((k) => ({
      table: k.child,
      columns: k.columns.filter((c) => c !== "tenant_id"),
      where: sql`(${sql.raw(list(k.columns))}) in (select ${sql.raw(list(k.refColumns))}
        from ${sql.raw(ident(k.parent))} where ${rowsOf.get(k.parent) as SQL})`,
    }))
    .filter((c) => c.columns.length > 0);
  return { order, rowsOf, clear };
}

class DryRun extends Error {
  constructor(readonly report: AgentPurgeReport) {
    super("dry run");
  }
}

/**
 * Purges every agent (§12, R0). Refuses unless `confirmDatabase` is the name of the database it is
 * connected to, so a command meant for staging can't run on production. With `dryRun`, everything
 * runs and is rolled back, and the report says what would have gone.
 */
export async function purgeAgents(
  db: Db,
  options: { confirmDatabase: string; dryRun?: boolean },
): Promise<AgentPurgeReport> {
  const dryRun = options.dryRun ?? false;
  try {
    return await db.transaction(async (tx) => {
      const [current] = [
        ...(await tx.execute<{ name: string }>(sql`select current_database() as name`)),
      ];
      const database = current?.name ?? "";
      if (options.confirmDatabase.trim() !== database) {
        throw new PurgeRefused("the database name typed doesn't match the one connected to");
      }
      const plan = await agentPurgePlan(tx);
      const touched = [...new Set([...plan.order, ...plan.clear.map((c) => c.table)])];
      for (const table of touched) {
        await tx.execute(sql.raw(`alter table ${ident(table)} disable trigger user`));
      }
      const count = (result: unknown) => Number((result as { count?: number }).count ?? 0);
      const cleared: AgentPurgeReport["cleared"] = [];
      const deleted: AgentPurgeReport["deleted"] = [];
      for (const c of plan.clear) {
        // DECISION: a row whose own check needs the link (a statement line of kind `agent` names
        // its agent) can't keep the rest without it, so it goes instead of being cleared.
        try {
          const result = await tx.transaction((sp) =>
            sp.execute(
              sql`update ${sql.raw(ident(c.table))}
                  set ${sql.raw(c.columns.map((col) => `${ident(col)} = null`).join(", "))}
                  where ${c.where}`,
            ),
          );
          cleared.push({ table: c.table, column: c.columns.join(", "), rows: count(result) });
        } catch (error) {
          if ((error as { cause?: { code?: string } }).cause?.code !== "23514") throw error;
          const result = await tx.execute(
            sql`delete from ${sql.raw(ident(c.table))} where ${c.where}`,
          );
          deleted.push({ table: c.table, rows: count(result) });
        }
      }
      for (const table of plan.order) {
        const result = await tx.execute(
          sql`delete from ${sql.raw(ident(table))} where ${plan.rowsOf.get(table) as SQL}`,
        );
        deleted.push({ table, rows: count(result) });
      }
      for (const table of touched) {
        await tx.execute(sql.raw(`alter table ${ident(table)} enable trigger user`));
      }
      const report: AgentPurgeReport = { database, dryRun, deleted, cleared };
      if (dryRun) throw new DryRun(report);
      const total = deleted.reduce((n, d) => n + d.rows, 0);
      await tx.execute(sql`
        insert into audit_event (tenant_id, actor_kind, action, outcome, target)
        values (null, 'system', 'agents.purge', 'ok', ${JSON.stringify({ rows: String(total) })}::jsonb)`);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}
