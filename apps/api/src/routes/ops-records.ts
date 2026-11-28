// Back office: record types and custom fields (docs/step-model-plan.md §10f). The operator adds a
// field to a record type for one client or shared with every client, changes its words, and
// removes it (hidden, its data kept). A client's field's type changes only while none of its
// records holds a value for it; a shared field's never does. A name is never both a client's and a
// shared field's. Operator only (invariant 11); every route through `mount`, which writes the audit row
// (invariant 14). A client's fields are read and written in that client's scope only.

import {
  type CustomFieldDef,
  type CustomFieldView,
  customFieldProblems,
  routes,
} from "@countersign/core";
import { customField, narrowToTenant, type Tx } from "@countersign/db";
import { eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { type CustomFieldRow, defOf } from "../records/fields";
import type { RecordCatalog } from "../records/registry";

function view(row: CustomFieldRow): CustomFieldView {
  const def = defOf(row);
  if (!def) throw new HttpError(500, "internal", `custom field ${row.id} doesn't read`);
  return {
    ...def,
    id: row.id,
    clientId: row.tenantId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether any of the client's records holds a value for its field. */
async function holdsData(
  tx: Tx,
  catalog: RecordCatalog,
  def: CustomFieldDef,
  clientId: string,
): Promise<boolean> {
  const store = catalog.store(def.recordType);
  if (!store) return false;
  return narrowToTenant(tx, clientId, (one) => store.holdsCustom(one, def.name));
}

/**
 * What a field's name and the cap are checked against (core's `customFieldProblems`): for a
 * client's field, its own and the shared ones on the record type; for a shared field, the shared
 * ones and the own fields of every client this operator serves (RLS shows those), the cap being the
 * most any of them would show. `except` leaves out the field being changed.
 */
async function around(
  tx: Tx,
  clientId: string | null,
  recordType: string,
  except?: string,
): Promise<{ others: CustomFieldDef[]; counted: number }> {
  const rows = await tx.select().from(customField).where(eq(customField.recordType, recordType));
  const defs = rows
    .filter((r) => r.id !== except)
    .map((r) => ({ row: r, def: defOf(r) }))
    .filter((x): x is { row: CustomFieldRow; def: CustomFieldDef } => x.def !== null);
  const shared = defs.filter((x) => x.row.tenantId === null);
  const shown = (xs: typeof defs) => xs.filter((x) => !x.def.hidden).length;
  if (clientId) {
    const own = defs.filter((x) => x.row.tenantId === clientId);
    return { others: [...own, ...shared].map((x) => x.def), counted: shown(own) + shown(shared) };
  }
  const perClient = new Map<string, typeof defs>();
  for (const x of defs) {
    if (x.row.tenantId)
      perClient.set(x.row.tenantId, [...(perClient.get(x.row.tenantId) ?? []), x]);
  }
  const most = Math.max(0, ...[...perClient.values()].map(shown));
  return { others: defs.map((x) => x.def), counted: shown(shared) + most };
}

export function opsRecordRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsRecordTypes, async (ctx) => {
    const { records } = ctx.services.platform;
    const client = ctx.query.client;
    if (client) ensureClient(ctx, client);
    const rows = await ctx.tx
      .select()
      .from(customField)
      .where(client ? eq(customField.tenantId, client) : isNull(customField.tenantId));
    const shared = client
      ? await ctx.tx.select().from(customField).where(isNull(customField.tenantId))
      : [];
    return {
      recordTypes: [...records.types],
      fields: [...shared, ...rows]
        .map((r) => {
          try {
            return view(r);
          } catch {
            return null;
          }
        })
        .filter((v): v is CustomFieldView => v !== null),
    };
  });

  mount(app, routes.opsCustomFieldCreate, async (ctx) => {
    const { body, tx, session } = ctx;
    const { records } = ctx.services.platform;
    const clientId = body.clientId ?? null;
    if (clientId) ensureClient(ctx, clientId);
    const def: CustomFieldDef = {
      recordType: body.recordType,
      name: body.name,
      label: body.label,
      type: body.type,
      spec: body.spec,
      required: body.required,
      about: body.about,
      scope: clientId ? "client" : "shared",
      hidden: false,
    };
    const problems = customFieldProblems({
      def,
      recordType: records.type(body.recordType),
      knownTypes: new Set(records.types.map((t) => t.id)),
      ...(await around(tx, clientId, body.recordType)),
    });
    if (problems.length > 0) throw new HttpError(422, "invalid_field", problems.join("; "));
    const [row] = await tx
      .insert(customField)
      .values({
        tenantId: clientId,
        recordType: def.recordType,
        name: def.name,
        label: def.label,
        type: def.type,
        spec: def.spec,
        required: def.required,
        about: def.about,
        createdBy: session.user.id,
      })
      .returning();
    if (!row) throw new HttpError(500, "internal", "the field wasn't saved");
    return { field: view(row) };
  });

  mount(app, routes.opsCustomFieldUpdate, async (ctx) => {
    const { body, tx, params } = ctx;
    const { records } = ctx.services.platform;
    const [row] = await tx.select().from(customField).where(eq(customField.id, params.id));
    if (!row) throw notFound("custom field");
    if (row.tenantId) ensureClient(ctx, row.tenantId);
    const before = defOf(row);
    if (!before) throw new HttpError(500, "internal", "the field doesn't read");
    const after: CustomFieldDef = {
      ...before,
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.about !== undefined ? { about: body.about } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.spec !== undefined ? { spec: body.spec } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
    };
    const typeChanged =
      after.type !== before.type || JSON.stringify(after.spec) !== JSON.stringify(before.spec);
    const problems = customFieldProblems({
      def: after,
      recordType: records.type(row.recordType),
      knownTypes: new Set(records.types.map((t) => t.id)),
      ...(await around(tx, row.tenantId, row.recordType, row.id)),
      before,
      // A shared field's type never changes (core says so); a client's only while it holds no data.
      holdsData:
        typeChanged && row.tenantId ? await holdsData(tx, records, before, row.tenantId) : false,
    });
    if (problems.length > 0) throw new HttpError(422, "invalid_field", problems.join("; "));
    const [updated] = await tx
      .update(customField)
      .set({
        label: after.label,
        about: after.about,
        required: after.required,
        type: after.type,
        spec: after.spec,
        hiddenAt: after.hidden ? (row.hiddenAt ?? new Date()) : null,
      })
      .where(eq(customField.id, row.id))
      .returning();
    if (!updated) throw notFound("custom field");
    return { field: view(updated) };
  });
}
