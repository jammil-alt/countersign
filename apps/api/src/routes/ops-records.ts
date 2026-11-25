// Back office: record types and custom fields (docs/step-model-plan.md §10f). The operator adds a
// field to a record type for one client or shared with every client, changes its words, and
// removes it (hidden, its data kept). A field's type changes only while no record holds a value
// for it. Operator only (invariant 11); every route through `mount`, which writes the audit row
// (invariant 14). A client's fields are read and written in that client's scope only.

import {
  type CustomFieldDef,
  type CustomFieldView,
  customFieldProblems,
  MAX_CUSTOM_FIELDS,
  routes,
} from "@countersign/core";
import { customField, narrowToTenant, type Tx } from "@countersign/db";
import { eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import {
  type CustomFieldRow,
  clientCustomFields,
  defOf,
  sharedCustomFields,
} from "../records/fields";
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

/** Whether any record holds a value for the field: in its client, or (shared) in any served. */
async function holdsData(
  tx: Tx,
  catalog: RecordCatalog,
  def: CustomFieldDef,
  clientId: string | null,
  served: readonly string[],
): Promise<boolean> {
  const store = catalog.store(def.recordType);
  if (!store) return false;
  // DECISION: a shared field's data is looked for in every client this operator serves; RLS keeps
  // the rest out of reach, so an operator who serves fewer clients may change a shared field's type
  // that another client's records use. Shared fields are few and an owner's change; noted under
  // Not done in the PR.
  for (const t of clientId ? [clientId] : served) {
    if (await narrowToTenant(tx, t, (one) => store.holdsCustom(one, def.name))) return true;
  }
  return false;
}

async function existingDefs(tx: Tx, clientId: string | null, recordType: string) {
  return clientId
    ? narrowToTenant(tx, clientId, (one) => clientCustomFields(one, clientId, recordType))
    : sharedCustomFields(tx, recordType);
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
      existing: await existingDefs(tx, clientId, body.recordType),
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
    const existing = await existingDefs(tx, row.tenantId, row.recordType);
    const problems = customFieldProblems({
      def: after,
      recordType: records.type(row.recordType),
      knownTypes: new Set(records.types.map((t) => t.id)),
      existing,
      before,
      holdsData: typeChanged
        ? await holdsData(tx, records, before, row.tenantId, ctx.tenantIds)
        : false,
    });
    // A field shown again counts toward the limit like a new one.
    if (before.hidden && !after.hidden) {
      const shown = existing.filter((d) => !d.hidden).length;
      if (shown >= MAX_CUSTOM_FIELDS)
        problems.push(`${row.recordType} has ${shown} custom fields, the most it can have`);
    }
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
