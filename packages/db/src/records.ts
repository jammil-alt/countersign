// A record type's store over one table (docs/step-model-plan.md §10f): what most areas need to
// offer the standard record actions on a table they already own. Each built-in field reads one
// column; custom values sit in the table's `ext` column under `custom` (core `CUSTOM_EXT_KEY`), so
// the area's own keys in `ext` are never touched. Every query filters by the client's id as well as
// running under its row-level security (invariant 1).
//
// DECISION: here, beside the schema, so a pack and the platform build their stores the same way
// without either importing the other (invariant 2). The SQL is made from columns an area declared in
// code; nothing a person or a model writes ever becomes a column or a query.

import {
  CUSTOM_EXT_KEY,
  type RecordStore,
  type RecordType,
  type StoredRecord,
  type steps,
} from "@countersign/core";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "./client";

export interface TableRecordStoreOptions {
  type: RecordType;
  table: PgTable;
  id: AnyPgColumn;
  tenantId: AnyPgColumn;
  ext: AnyPgColumn;
  /** Newest first by this column. */
  order: AnyPgColumn;
  /** Each built-in field's column (every field of the record type). */
  columns: Readonly<Record<string, AnyPgColumn>>;
  /** Rows that aren't records of the type (a merged master item): left out everywhere. */
  where?: SQL;
}

/**
 * A value as a step reads it: dates as YYYY-MM-DD, times as ISO text, numerics as decimals, and a
 * group (a jsonb column) as its declared fields only, each as text or null, so it is the type the
 * record type says (a vendor's `external_refs` by connector).
 */
function present(value: unknown, field: steps.Field | undefined): unknown {
  if (value instanceof Date) {
    return field?.type === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (field?.type === "group") {
    const obj = asObject(value);
    return Object.fromEntries(
      (field.of ?? []).map((f) => {
        const v = obj[f.name];
        return [f.name, v === undefined || v === null || v === "" ? null : String(v)];
      }),
    );
  }
  return value ?? null;
}

const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function tableRecordStore(o: TableRecordStoreOptions): RecordStore<Tx> {
  const fieldOf = new Map(o.type.fields.map((f) => [f.name, f]));
  const missing = o.type.fields.filter((f) => !o.columns[f.name]).map((f) => f.name);
  if (missing.length > 0) {
    throw new Error(`${o.type.id}: no column for ${missing.join(", ")}`);
  }
  const select = {
    __id: o.id,
    __ext: o.ext,
    ...Object.fromEntries(Object.entries(o.columns).map(([k, c]) => [k, c])),
  } as Record<string, AnyPgColumn>;
  const scoped = (tenantId: string, ...more: (SQL | undefined)[]) =>
    and(eq(o.tenantId, tenantId), o.where, ...more);
  const toRecord = (row: Record<string, unknown>): StoredRecord => {
    const values: Record<string, unknown> = {};
    for (const name of Object.keys(o.columns)) values[name] = present(row[name], fieldOf.get(name));
    return { id: String(row.__id), values, ext: asObject(row.__ext) };
  };

  async function get(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
    options: { lock?: boolean } = {},
  ) {
    if (ids.length === 0) return [];
    const query = tx
      .select(select)
      .from(o.table)
      .where(scoped(tenantId, inArray(o.id, [...ids])));
    const rows = options.lock ? await query.for("update") : await query;
    return rows.map(toRecord);
  }

  return {
    type: o.type,
    get,
    async list(tx, tenantId, limit) {
      const rows = await tx
        .select(select)
        .from(o.table)
        .where(scoped(tenantId))
        .orderBy(desc(o.order), desc(o.id))
        .limit(limit + 1);
      return { rows: rows.slice(0, limit).map(toRecord), truncated: rows.length > limit };
    },
    ...(o.type.operations.update
      ? {
          async update(tx, tenantId, id, input) {
            const set: Record<string, unknown> = {};
            for (const [name, value] of Object.entries(input.values)) {
              const column = o.columns[name];
              if (!column || !o.type.writable.includes(name)) {
                throw new Error(`${name} can't be changed on a ${o.type.name.toLowerCase()}`);
              }
              set[column.name] = value;
            }
            // The custom values whole, under `custom`; every other key of `ext` as it was.
            const ext = sql`jsonb_set(coalesce(${o.ext}, '{}'::jsonb), ${`{${CUSTOM_EXT_KEY}}`}::text[], ${JSON.stringify(input.custom)}::jsonb, true)`;
            const sets = [
              ...Object.entries(set).map(([col, v]) => sql`${sql.identifier(col)} = ${v}`),
              sql`${sql.identifier(o.ext.name)} = ${ext}`,
            ];
            const updated = await tx.execute<{ id: string }>(
              sql`update ${o.table} set ${sql.join(sets, sql`, `)}
                  where ${scoped(tenantId, eq(o.id, id))} returning ${o.id} as id`,
            );
            if ([...updated].length === 0) return null;
            const [after] = await get(tx, tenantId, [id]);
            return after ?? null;
          },
        }
      : {}),
    async holdsCustom(tx, name) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(o.table)
        .where(and(o.where, sql`(${o.ext} -> ${CUSTOM_EXT_KEY}) ? ${name}`));
      return (row?.n ?? 0) > 0;
    },
  } satisfies RecordStore<Tx>;
}
