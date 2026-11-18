// Purging a retired client (docs/plan.md §1.35): every row that belongs to it, in every table that
// references `tenant` and every table whose rows can't outlive one of those (a build's items,
// messages and events), then the client itself, and its users who belong to no other client.
// Links to its rows from rows that stay (a template's build tested at it) are cleared. The audit
// log stays (it has no foreign key to `tenant` and holds ids, never content). What is touched is
// read from the schema's foreign keys (`purgePlan`), so a new table is covered as it is added.
//
// Run by the owner as cs_owner (`db:purge-client`), never by the Worker: cs_runtime has no DELETE on
// history, and the history triggers refuse deletes, so they are disabled for this transaction only
// (`DISABLE TRIGGER USER` leaves foreign-key checks on). That takes each table's lock briefly.

import { type SQL, sql } from "drizzle-orm";
import type { Db, Tx } from "./client";

export const PURGE_AFTER_DAYS = 30;

export interface PurgeReport {
  tenantId: string;
  name: string;
  /** Rows deleted per table, in the order they were deleted. */
  deleted: { table: string; rows: number }[];
  /** Links to the client's rows (or to the client) cleared on rows that stay or go. */
  cleared: { table: string; column: string; rows: number }[];
  usersDeleted: number;
}

export class PurgeRefused extends Error {
  override name = "PurgeRefused";
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const list = (names: readonly string[]) => names.map(ident).join(", ");

export interface ForeignKey {
  child: string;
  parent: string;
  /** The child's referencing columns, in the key's order. */
  columns: string[];
  /** The parent's referenced columns, in the same order. */
  refColumns: string[];
  /** Whether every one of the child's columns may be null. */
  nullable: boolean;
}

/** Every foreign key in the public schema, self-references left out. */
async function foreignKeys(db: Db | Tx): Promise<ForeignKey[]> {
  const rows = await db.execute<{
    child: string;
    parent: string;
    columns: string[];
    ref_columns: string[];
    nullable: boolean;
  }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
      (select json_agg(a.attname::text order by k.n)
       from unnest(c.conkey) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
      (select json_agg(a.attname::text order by k.n)
       from unnest(c.confkey) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as ref_columns,
      not exists (select 1 from pg_attribute a
                  where a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                    and a.attnotnull) as nullable
    from pg_constraint c
    where c.contype = 'f' and c.conrelid <> c.confrelid
      and c.connamespace = 'public'::regnamespace`);
  const bare = (name: string) => name.replace(/^public\./, "");
  return [...rows].map((r) => ({
    child: bare(r.child),
    parent: bare(r.parent),
    columns: r.columns,
    refColumns: r.ref_columns,
    nullable: r.nullable,
  }));
}

/**
 * What purging a client touches, read from the schema's foreign keys, so a new table is covered
 * without a change here:
 * - every table with a foreign key to `tenant`: its rows whose owner column names the client
 *   (`tenant_id`; else its one client column, or `client_id`: a build, Reggie's records);
 * - every table whose rows can't exist without such a row (a required key to it: a build's items,
 *   messages and events), and so on down;
 * - nullable links to any of those rows, from any table, are cleared first (an agent's live
 *   version; a template's build tested at the client), and so are other columns naming the client
 *   (a build's `test_client_id`).
 */
export interface PurgePlan {
  /** The tables rows are deleted from, children before parents. */
  order: string[];
  /** Each table's rows of the client. */
  rowsOf: Map<string, (tenantId: string) => SQL>;
  /** Each table's column naming its client (never cleared), where it has one. */
  owner: Map<string, string>;
  /** Other columns naming a client: cleared where they name this one. */
  mentions: { table: string; column: string }[];
  /** Nullable links into the tables above: cleared on `where`'s rows (they point at a row going). */
  clear: { key: ForeignKey; where: (tenantId: string) => SQL }[];
}

export async function purgePlan(db: Db | Tx): Promise<PurgePlan> {
  const keys = await foreignKeys(db);
  const owner = new Map<string, string>();
  const mentions: PurgePlan["mentions"] = [];
  const clientColumns = new Map<string, string[]>();
  for (const k of keys) {
    if (k.parent !== "tenant" || k.child === "tenant" || k.columns.length !== 1) continue;
    clientColumns.set(k.child, [...(clientColumns.get(k.child) ?? []), k.columns[0] as string]);
  }
  for (const [table, columns] of clientColumns) {
    // DECISION: `tenant_id` is a row's client; a table without one names it `client_id` (a build,
    // whose `test_client_id` only says where it is tested), or in its only client column.
    const own = columns.includes("tenant_id")
      ? "tenant_id"
      : columns.length === 1
        ? (columns[0] as string)
        : columns.includes("client_id")
          ? "client_id"
          : null;
    if (!own) throw new Error(`purge: ${table} names a client in ${columns.join(", ")}`);
    owner.set(table, own);
    for (const column of columns) if (column !== own) mentions.push({ table, column });
  }
  const rowsOf = new Map<string, (tenantId: string) => SQL>(
    [...owner].map(([table, column]) => [
      table,
      (id: string) => sql`${sql.raw(ident(column))} = ${id}`,
    ]),
  );
  // Rows that can't outlive a deleted row (a required key to it), down to the last level.
  const inKeys = (k: ForeignKey, id: string) => {
    const parentRows = rowsOf.get(k.parent) as (tenantId: string) => SQL;
    return sql`(${sql.raw(list(k.columns))}) in (select ${sql.raw(list(k.refColumns))}
      from ${sql.raw(ident(k.parent))} where ${parentRows(id)})`;
  };
  const plan = new Set(owner.keys());
  const required = (k: ForeignKey) => !k.nullable && k.child !== "tenant" && plan.has(k.parent);
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of keys) {
      if (required(k) && !plan.has(k.child)) {
        plan.add(k.child);
        grew = true;
      }
    }
  }
  for (const table of plan) {
    if (rowsOf.has(table)) continue;
    const via = keys.filter((k) => k.child === table && required(k));
    rowsOf.set(table, (id) =>
      sql.join(
        via.map((k) => inKeys(k, id)),
        sql` or `,
      ),
    );
  }
  const tables = [...rowsOf.keys()];
  const order = deleteOrder(
    parentsOf(
      tables,
      keys.filter((k) => !k.nullable && rowsOf.has(k.child) && rowsOf.has(k.parent)),
    ),
  );
  // DECISION: a row whose client is `tenant_id` points only at its own client's rows, or, an
  // operator table's (tenant_id null), at a template's or the client's: the clear is limited to
  // those rows, on the indexed client column, so the largest tables (step_run, model_call,
  // message, external_action) are never scanned across clients. A table that names its client
  // otherwise (a build, which may be a template's tested at this client) is cleared wherever it
  // points at a row going.
  const optional = new Set(
    [
      ...(await db.execute<{ table_name: string }>(sql`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id' and is_nullable = 'YES'`)),
    ].map((r) => r.table_name),
  );
  const clear = keys
    .filter((k) => k.nullable && k.child !== "tenant" && rowsOf.has(k.parent))
    .map((key) => {
      const own = owner.get(key.child) === "tenant_id" ? `${ident(key.child)}."tenant_id"` : null;
      const parentRows = rowsOf.get(key.parent) as (tenantId: string) => SQL;
      const pointing = (id: string) =>
        sql`(${sql.raw(list(key.columns))}) in (select ${sql.raw(list(key.refColumns))}
          from ${sql.raw(ident(key.parent))} where ${parentRows(id)})`;
      const where = !own
        ? pointing
        : optional.has(key.child)
          ? (id: string) =>
              sql`(${sql.raw(own)} = ${id} or ${sql.raw(own)} is null) and ${pointing(id)}`
          : (id: string) => sql`${sql.raw(own)} = ${id} and ${pointing(id)}`;
      return { key, where };
    });
  return { order, rowsOf, owner, mentions, clear };
}

function parentsOf(tables: readonly string[], required: readonly ForeignKey[]) {
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const l of required) parents.get(l.child)?.add(l.parent);
  return parents;
}

/** Children before parents, so every delete runs after the rows that point at it are gone. */
export function deleteOrder(parents: Map<string, Set<string>>): string[] {
  const children = new Map<string, Set<string>>([...parents.keys()].map((t) => [t, new Set()]));
  for (const [child, ps] of parents) for (const p of ps) children.get(p)?.add(child);
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t)) return;
    if (visiting.has(t)) throw new Error(`foreign keys form a cycle through ${t}`);
    visiting.add(t);
    for (const child of [...(children.get(t) ?? [])].sort()) visit(child);
    visiting.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of [...parents.keys()].sort()) visit(t);
  return order;
}

/**
 * Deletes everything of one retired client. Refuses when `confirmName` is given and isn't the
 * client's name (case and surrounding spaces aside). Refuses unless it was retired at least
 * PURGE_AFTER_DAYS ago and its files are gone (`settings.purge.files_deleted_at`, set by the
 * Worker's hourly sweep), unless `force` (tests, or a client whose files were removed by hand).
 */
export async function purgeClient(
  db: Db,
  tenantId: string,
  options: { now?: Date; force?: boolean; confirmName?: string } = {},
): Promise<PurgeReport> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [t] = [
      ...(await tx.execute<{ name: string; retired_at: Date | null; settings: unknown }>(sql`
        select name, retired_at, settings from tenant where id = ${tenantId} for update`)),
    ];
    if (!t) throw new PurgeRefused(`no client ${tenantId}`);
    // The client's name typed again, as Retire client asks (apps/api/src/routes/compliance.ts).
    // The refusal doesn't say the real name: a workflow's log shouldn't carry it.
    if (
      options.confirmName !== undefined &&
      options.confirmName.trim().toLowerCase() !== t.name.trim().toLowerCase()
    ) {
      throw new PurgeRefused("the name typed doesn't match this client's name");
    }
    if (!t.retired_at) throw new PurgeRefused(`${t.name} is not retired`);
    const due = new Date(new Date(t.retired_at).getTime() + PURGE_AFTER_DAYS * 86_400_000);
    if (!options.force) {
      if (now < due) {
        throw new PurgeRefused(`${t.name} can be purged from ${due.toISOString()}`);
      }
      const settings = (t.settings ?? {}) as { purge?: { files_deleted_at?: string } };
      if (!settings.purge?.files_deleted_at) {
        throw new PurgeRefused(`${t.name}'s files are not deleted yet (the hourly sweep does it)`);
      }
    }

    // Read in the transaction: the owner's script has one connection.
    const plan = await purgePlan(tx);
    // Its users: those whose only memberships were in this client.
    const users = [
      ...(await tx.execute<{ user_id: string }>(sql`
        select m.user_id from membership m where m.tenant_id = ${tenantId}
          and not exists (select 1 from membership o
                          where o.user_id = m.user_id and o.tenant_id <> ${tenantId})`)),
    ].map((r) => r.user_id);

    const touched = [
      ...new Set([
        ...plan.order,
        ...plan.mentions.map((m) => m.table),
        ...plan.clear.map((c) => c.key.child),
      ]),
    ];
    for (const table of touched) {
      await tx.execute(sql.raw(`alter table ${ident(table)} disable trigger user`));
    }
    const cleared: PurgeReport["cleared"] = [];
    const count = (result: unknown) => Number((result as { count?: number }).count ?? 0);
    // Another column naming this client (a template's build tested at it): it no longer does.
    for (const m of plan.mentions) {
      const result = await tx.execute(
        sql`update ${sql.raw(ident(m.table))} set ${sql.raw(ident(m.column))} = null
            where ${sql.raw(ident(m.column))} = ${tenantId}`,
      );
      cleared.push({ table: m.table, column: m.column, rows: count(result) });
    }
    // Nullable links to a row about to go: cleared, on this client's rows (an agent and its live
    // version point at each other) and on any other (a template's build and its test copy).
    for (const { key: k, where } of plan.clear) {
      // A row's own client column stays: a same-client link where it may be null
      // (test_case_result's run, 0028) is broken by its other columns, and clearing the client
      // would make the row look shared.
      const cols = k.columns.filter((col) => col !== plan.owner.get(k.child));
      if (cols.length === 0) continue;
      const result = await tx.execute(
        sql`update ${sql.raw(ident(k.child))}
            set ${sql.raw(cols.map((col) => `${ident(col)} = null`).join(", "))}
            where ${where(tenantId)}`,
      );
      cleared.push({ table: k.child, column: cols.join(", "), rows: count(result) });
    }
    const deleted: PurgeReport["deleted"] = [];
    for (const table of plan.order) {
      const rows = plan.rowsOf.get(table);
      if (!rows) continue;
      const result = await tx.execute(
        sql`delete from ${sql.raw(ident(table))} where ${rows(tenantId)}`,
      );
      deleted.push({ table, rows: count(result) });
    }
    for (const table of touched) {
      await tx.execute(sql.raw(`alter table ${ident(table)} enable trigger user`));
    }
    await tx.execute(sql`delete from tenant where id = ${tenantId}`);

    // A user still referenced elsewhere (e.g. as the author of another client's record) stays.
    let usersDeleted = 0;
    for (const id of users) {
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`delete from app_user where id = ${id}`);
        });
        usersDeleted++;
      } catch {
        // Kept: something outside this client still points at them.
      }
    }

    await tx.execute(sql`
      insert into audit_event (tenant_id, actor_kind, action, outcome, target)
      values (${tenantId}, 'system', 'client.purge', 'ok',
              ${JSON.stringify({ name: t.name, users: String(usersDeleted) })}::jsonb)`);
    return { tenantId, name: t.name, deleted, cleared, usersDeleted };
  });
}
