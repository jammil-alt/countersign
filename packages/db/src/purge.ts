// Purging a retired client (docs/plan.md §1.35): every row that belongs to it, in every table that
// references `tenant`, then the client itself, and its users who belong to no other client. The
// audit log stays (it has no foreign key to `tenant` and holds ids, never content).
//
// Run by the owner as cs_owner (`db:purge-client`), never by the Worker: cs_runtime has no DELETE on
// history, and the history triggers refuse deletes, so they are disabled for this transaction only
// (`DISABLE TRIGGER USER` leaves foreign-key checks on). That takes each table's lock briefly.

import { sql } from "drizzle-orm";
import type { Db } from "./client";

export const PURGE_AFTER_DAYS = 30;

export interface PurgeReport {
  tenantId: string;
  name: string;
  /** Rows deleted per table, in the order they were deleted. */
  deleted: { table: string; rows: number }[];
  usersDeleted: number;
}

export class PurgeRefused extends Error {
  override name = "PurgeRefused";
}

interface Reference {
  table: string;
  column: string;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Tables with a single-column foreign key to tenant(id), and the column. */
async function tenantReferences(db: Db): Promise<Reference[]> {
  const rows = await db.execute<{ table: string; column: string }>(sql`
    select c.conrelid::regclass::text as table, a.attname as column
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.tenant'::regclass
      and cardinality(c.conkey) = 1`);
  return [...rows].map((r) => ({ table: r.table.replace(/^public\./, ""), column: r.column }));
}

interface Link {
  child: string;
  parent: string;
  /** The child's referencing columns. */
  columns: string[];
  /** Whether every one of them may be null. */
  nullable: boolean;
}

/** Foreign keys between `tables` (child → parent), self-references left out. */
async function links(db: Db, tables: readonly string[]): Promise<Link[]> {
  const rows = await db.execute<{
    child: string;
    parent: string;
    columns: string[];
    nullable: boolean;
  }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
      (select json_agg(a.attname::text) from pg_attribute a
       where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as columns,
      not exists (select 1 from pg_attribute a
                  where a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                    and a.attnotnull) as nullable
    from pg_constraint c
    where c.contype = 'f' and c.conrelid <> c.confrelid`);
  const set = new Set(tables);
  return [...rows]
    .map((r) => ({
      child: r.child.replace(/^public\./, ""),
      parent: r.parent.replace(/^public\./, ""),
      columns: r.columns,
      nullable: r.nullable,
    }))
    .filter((l) => set.has(l.child) && set.has(l.parent));
}

function parentsOf(tables: readonly string[], required: readonly Link[]) {
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
 * Deletes everything of one retired client. Refuses unless it was retired at least
 * PURGE_AFTER_DAYS ago and its files are gone (`settings.purge.files_deleted_at`, set by the
 * Worker's hourly sweep), unless `force` (tests, or a client whose files were removed by hand).
 */
export async function purgeClient(
  db: Db,
  tenantId: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<PurgeReport> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [t] = [
      ...(await tx.execute<{ name: string; retired_at: Date | null; settings: unknown }>(sql`
        select name, retired_at, settings from tenant where id = ${tenantId} for update`)),
    ];
    if (!t) throw new PurgeRefused(`no client ${tenantId}`);
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

    const refs = (await tenantReferences(db)).filter((r) => r.table !== "tenant");
    const tables = refs.map((r) => r.table);
    const columnOf = new Map(refs.map((r) => [r.table, r.column]));
    // Some tables point at each other (an agent at its live version, the version at its agent).
    // The nullable links are cleared first, on this client's rows only, which leaves an order.
    const all = await links(db, tables);
    const order = deleteOrder(
      parentsOf(
        tables,
        all.filter((l) => !l.nullable),
      ),
    );
    const clear = all.filter((l) => l.nullable);
    // Its users: those whose only memberships were in this client.
    const users = [
      ...(await tx.execute<{ user_id: string }>(sql`
        select m.user_id from membership m where m.tenant_id = ${tenantId}
          and not exists (select 1 from membership o
                          where o.user_id = m.user_id and o.tenant_id <> ${tenantId})`)),
    ].map((r) => r.user_id);

    for (const table of tables) {
      await tx.execute(sql.raw(`alter table ${ident(table)} disable trigger user`));
    }
    for (const l of clear) {
      const column = columnOf.get(l.child);
      if (!column) continue;
      const sets = l.columns.map((col) => `${ident(col)} = null`).join(", ");
      const anySet = l.columns.map((col) => `${ident(col)} is not null`).join(" or ");
      await tx.execute(
        sql`update ${sql.raw(ident(l.child))} set ${sql.raw(sets)}
            where ${sql.raw(ident(column))} = ${tenantId} and (${sql.raw(anySet)})`,
      );
    }
    const deleted: PurgeReport["deleted"] = [];
    for (const table of order) {
      const column = columnOf.get(table);
      if (!column) continue;
      const result = await tx.execute(
        sql`delete from ${sql.raw(ident(table))} where ${sql.raw(ident(column))} = ${tenantId}`,
      );
      deleted.push({ table, rows: Number((result as { count?: number }).count ?? 0) });
    }
    for (const table of tables) {
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
    return { tenantId, name: t.name, deleted, usersDeleted };
  });
}
