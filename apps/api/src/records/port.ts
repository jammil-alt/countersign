// The records port (docs/step-model-plan.md §10f): how the standard record actions (Find, Get by
// id, Create, Update) reach one client's records, over each record type's store. A record type's
// rules run here on every write, wherever it comes from:
//  - one client's transaction (`withTenant`), and every store query filters by its id (invariant 1);
//  - only the fields the record type lets be written, each checked against its type, and the
//    client's custom fields checked by core's `checkCustomValues` (a wrong type, a missing required
//    value, a card number: refused, invariant 14);
//  - the write logged once in `record_write` with the agent version, the run and step, its before
//    and after, and its evidence (invariants 10 and 3); a retried step finds its first write by
//    the key and gets the same record back, never a second write;
//  - a test run checks the write and saves nothing (invariant 8).
// Writes to our own records need no client approval (§10f); the gate has already checked the agent
// version's grant (packages/agents runtime/record-grants.ts).

import type { RecordsPort, RecordValues, RecordWriteMeta } from "@countersign/agents";
import {
  CUSTOM_EXT_KEY,
  type CustomFieldDef,
  checkCustomValues,
  customValuesOf,
  fieldValueProblem,
  holdsCardNumber,
  type RecordStore,
  type RecordType,
  type StoredRecord,
  visibleCustomFields,
} from "@countersign/core";
import { type Db, recordWrite, type Tx, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { customFieldsFor } from "./fields";
import type { RecordCatalog } from "./registry";

/** A refusal of the record type's rules: plain words, the step fails with them. */
export class RecordRuleError extends Error {
  override name = "RecordRuleError";
}

/** A record as a step sees it: `id`, the built-in fields, then the visible custom fields. */
export function presentRecord(
  stored: StoredRecord,
  custom: readonly CustomFieldDef[],
): RecordValues {
  const values = customValuesOf(stored.ext);
  return {
    id: stored.id,
    ...stored.values,
    ...Object.fromEntries(custom.map((d) => [d.name, values[d.name] ?? null])),
  };
}

/** The values a write gives, split into built-in and custom, each checked (throws the problems). */
export function splitWrite(
  type: RecordType,
  custom: readonly CustomFieldDef[],
  values: RecordValues,
  current: StoredRecord | null,
): { builtIn: Record<string, unknown>; custom: Record<string, unknown> } {
  const builtIn: Record<string, unknown> = {};
  const customIn: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = type.fields.find((f) => f.name === name);
    if (field) {
      if (!type.writable.includes(name)) {
        problems.push(`${name} can't be changed on a ${type.name.toLowerCase()}`);
        continue;
      }
      const p = fieldValueProblem(field, value);
      if (p) problems.push(p);
      else if (holdsCardNumber(value)) {
        problems.push(`${name} looks like a card number; card numbers are never stored`);
      } else builtIn[name] = value;
    } else {
      customIn[name] = value;
    }
  }
  if (current === null) {
    for (const f of type.fields) {
      if (f.required && type.writable.includes(f.name) && builtIn[f.name] === undefined) {
        problems.push(`${f.name} is required`);
      }
    }
  }
  const checked = checkCustomValues({
    defs: custom,
    values: customIn,
    current: current ? customValuesOf(current.ext) : undefined,
    creating: current === null,
  });
  if (!checked.ok) problems.push(...checked.problems);
  if (problems.length > 0) throw new RecordRuleError(problems.join("; "));
  return { builtIn, custom: checked.ok ? checked.custom : {} };
}

function storeOf(catalog: RecordCatalog, recordType: string): RecordStore<Tx> {
  const store = catalog.store(recordType);
  if (!store) throw new RecordRuleError(`there is no record type ${recordType}`);
  return store;
}

async function visible(tx: Tx, tenantId: string, recordType: string) {
  return visibleCustomFields(await customFieldsFor(tx, tenantId, recordType), recordType);
}

/** A write logged before under this key: its record as it is now (the retry's answer). */
async function earlier(
  tx: Tx,
  tenantId: string,
  store: RecordStore<Tx>,
  key: string,
  custom: readonly CustomFieldDef[],
): Promise<RecordValues | null> {
  const [row] = await tx
    .select({ recordId: recordWrite.recordId, recordType: recordWrite.recordType })
    .from(recordWrite)
    .where(and(eq(recordWrite.tenantId, tenantId), eq(recordWrite.key, key)));
  if (!row) return null;
  if (row.recordType !== store.type.id) {
    throw new RecordRuleError(`this step's write was already made to a ${row.recordType}`);
  }
  const [rec] = await store.get(tx, tenantId, [row.recordId]);
  return rec ? presentRecord(rec, custom) : null;
}

async function log(
  tx: Tx,
  tenantId: string,
  input: {
    type: RecordType;
    op: "create" | "update";
    recordId: string;
    before: StoredRecord | null;
    after: StoredRecord;
    meta: RecordWriteMeta;
  },
) {
  const state = (r: StoredRecord) => ({
    ...r.values,
    [CUSTOM_EXT_KEY]: customValuesOf(r.ext),
  });
  await tx.insert(recordWrite).values({
    tenantId,
    recordType: input.type.id,
    recordId: input.recordId,
    op: input.op,
    key: input.meta.key,
    agentVersionId: input.meta.agentVersionId,
    runId: input.meta.runId,
    stepRunId: input.meta.stepRunId,
    before: input.before ? state(input.before) : null,
    after: state(input.after),
    sources: input.meta.sources,
  });
}

export function dbRecordsPort(db: Db, catalog: RecordCatalog): RecordsPort {
  return {
    async list(tenantId, recordType, { limit }) {
      const store = storeOf(catalog, recordType);
      return withTenant(db, tenantId, async (tx) => {
        const custom = await visible(tx, tenantId, recordType);
        const { rows, truncated } = await store.list(tx, tenantId, limit);
        return { records: rows.map((r) => presentRecord(r, custom)), truncated };
      });
    },

    async get(tenantId, recordType, ids) {
      const store = storeOf(catalog, recordType);
      return withTenant(db, tenantId, async (tx) => {
        const custom = await visible(tx, tenantId, recordType);
        return (await store.get(tx, tenantId, ids)).map((r) => presentRecord(r, custom));
      });
    },

    async create(tenantId, recordType, values, meta) {
      const store = storeOf(catalog, recordType);
      if (!store.type.operations.create || !store.create) {
        throw new RecordRuleError(`${store.type.plural.toLowerCase()} can't be created here`);
      }
      const create = store.create.bind(store);
      return withTenant(db, tenantId, async (tx) => {
        const custom = await visible(tx, tenantId, recordType);
        const again = await earlier(tx, tenantId, store, meta.key, custom);
        if (again) return again;
        const write = splitWrite(store.type, custom, values, null);
        if (meta.mode === "test") {
          return { id: null, ...write.builtIn, ...write.custom, saved: false };
        }
        const after = await create(tx, tenantId, {
          values: write.builtIn,
          custom: write.custom,
          agentVersionId: meta.agentVersionId,
        });
        await log(tx, tenantId, {
          type: store.type,
          op: "create",
          recordId: after.id,
          before: null,
          after,
          meta,
        });
        return presentRecord(after, custom);
      });
    },

    async update(tenantId, recordType, id, values, meta) {
      const store = storeOf(catalog, recordType);
      if (!store.type.operations.update || !store.update) {
        throw new RecordRuleError(`${store.type.plural.toLowerCase()} can't be changed here`);
      }
      const update = store.update.bind(store);
      return withTenant(db, tenantId, async (tx) => {
        const custom = await visible(tx, tenantId, recordType);
        const again = await earlier(tx, tenantId, store, meta.key, custom);
        if (again) return again;
        const [before] = await store.get(tx, tenantId, [id]);
        if (!before)
          throw new RecordRuleError(`there is no ${store.type.name.toLowerCase()} ${id}`);
        const write = splitWrite(store.type, custom, values, before);
        if (meta.mode === "test") {
          return {
            ...presentRecord(
              {
                ...before,
                values: { ...before.values, ...write.builtIn },
                ext: { [CUSTOM_EXT_KEY]: write.custom },
              },
              custom,
            ),
            saved: false,
          };
        }
        const after = await update(tx, tenantId, id, {
          values: write.builtIn,
          custom: write.custom,
        });
        if (!after) throw new RecordRuleError(`there is no ${store.type.name.toLowerCase()} ${id}`);
        await log(tx, tenantId, {
          type: store.type,
          op: "update",
          recordId: id,
          before,
          after,
          meta,
        });
        return presentRecord(after, custom);
      });
    },
  };
}
