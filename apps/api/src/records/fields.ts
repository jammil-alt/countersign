// Custom field definitions as stored (`custom_field`, migration 0102), read and written for the
// back office and the records port (docs/step-model-plan.md §10f). A client's own fields are read
// in its scope; shared ones (no client) are the operator's catalogue, which a client's run reads as
// such (`readOperatorCatalogue`), never another client's rows.

import { CustomFieldDef } from "@countersign/core";
import { customField, readOperatorCatalogue, type Tx } from "@countersign/db";
import { and, asc, eq, isNull } from "drizzle-orm";

export type CustomFieldRow = typeof customField.$inferSelect;

/** A stored row as core's definition; a row that no longer parses is left out, never widened. */
export function defOf(row: CustomFieldRow): CustomFieldDef | null {
  const parsed = CustomFieldDef.safeParse({
    id: row.id,
    recordType: row.recordType,
    name: row.name,
    label: row.label,
    type: row.type,
    spec: row.spec,
    required: row.required,
    about: row.about,
    scope: row.tenantId ? "client" : "shared",
    hidden: row.hiddenAt !== null,
  });
  return parsed.success ? parsed.data : null;
}

const defs = (rows: CustomFieldRow[]) =>
  rows.map(defOf).filter((d): d is CustomFieldDef => d !== null);

/** The shared custom fields, read as the operator's catalogue from inside any transaction. */
export async function sharedCustomFields(tx: Tx, recordType?: string): Promise<CustomFieldDef[]> {
  return readOperatorCatalogue(tx, async (op) =>
    defs(
      await op
        .select()
        .from(customField)
        .where(
          and(
            isNull(customField.tenantId),
            recordType ? eq(customField.recordType, recordType) : undefined,
          ),
        )
        .orderBy(asc(customField.createdAt)),
    ),
  );
}

/** A client's own custom fields (hidden ones included), in its scope. */
export async function clientCustomFields(
  tx: Tx,
  tenantId: string,
  recordType?: string,
): Promise<CustomFieldDef[]> {
  return defs(
    await tx
      .select()
      .from(customField)
      .where(
        and(
          eq(customField.tenantId, tenantId),
          recordType ? eq(customField.recordType, recordType) : undefined,
        ),
      )
      .orderBy(asc(customField.createdAt)),
  );
}

/** Every definition a client's records of a type carry: its own, then the shared ones. */
export async function customFieldsFor(
  tx: Tx,
  tenantId: string,
  recordType?: string,
): Promise<CustomFieldDef[]> {
  return [
    ...(await clientCustomFields(tx, tenantId, recordType)),
    ...(await sharedCustomFields(tx, recordType)),
  ];
}
