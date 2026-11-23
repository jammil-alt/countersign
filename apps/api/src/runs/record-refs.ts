// How a run's kept rows (`run_subject`, docs/plan.md §1.188) are matched to one of a client's
// records: by our id, or by the client's tool and its id there. One matcher for the record page's
// Runs panel (R3, §1.200), the runs list's `about` filter and the counts search shows (R2, §1.193),
// so a record finds the same runs wherever it is asked about (overnight S3.2). Every query names
// the clients asked about as well as relying on RLS (invariant 1).

import { isUuid, type RunSubjectKind, subjectKindOfEntity } from "@countersign/core";
import {
  contact,
  organization,
  rawRecord,
  receivable,
  runSubject,
  type Tx,
  transaction,
  vendor,
} from "@countersign/db";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";

/**
 * A record as the client's tool knows it: its client, the kinds a run may have kept it as, the
 * tool and its id.
 */
export interface ToolRef {
  tenantId: string;
  kinds: readonly RunSubjectKind[];
  connector: string;
  externalId: string;
}

/** `{ qbo: "56" }` as tool refs of these kinds. */
function refsOf(tenantId: string, kinds: readonly RunSubjectKind[], refs: unknown): ToolRef[] {
  if (refs === null || typeof refs !== "object" || Array.isArray(refs)) return [];
  return Object.entries(refs as Record<string, unknown>).flatMap(([connector, id]) =>
    typeof id === "string" && id !== "" ? [{ tenantId, kinds, connector, externalId: id }] : [],
  );
}

/**
 * A tool's id in each form a run may have kept it: QuickBooks' transactions are ours as
 * `Bill:149` (the entity and its id, as sync stores them), but a write keeps what QuickBooks
 * returned, `149`.
 */
// DECISION: a transaction id `Entity:id` also matches its bare `id`, and a raw record's bare id
// its `Entity:id`; the kind (`transaction`) and the tool still have to match, so a vendor 149 is
// never bill 149 (overnight S3.1).
function idForms(externalId: string, entityType?: string): string[] {
  const forms = new Set([externalId]);
  const bare = /^[A-Za-z]+:(.+)$/.exec(externalId)?.[1];
  if (bare) forms.add(bare);
  else if (entityType) forms.add(`${entityType}:${externalId}`);
  return [...forms];
}

function toolIdRefs(
  kinds: readonly RunSubjectKind[],
  ref: { tenantId: string; connector: string; externalId: string },
  entityType?: string,
): ToolRef[] {
  return idForms(ref.externalId, entityType).map((externalId) => ({
    tenantId: ref.tenantId,
    kinds,
    connector: ref.connector,
    externalId,
  }));
}

/**
 * How the client's tools know the record with this id, if one of these clients' tables holds it:
 * a run's change to a client's tool keeps the tool's id for the thing it wrote, not ours (§1.188).
 */
// DECISION: a change is matched to a record by its tool, its id there and a kind the record can
// be kept as, so a QuickBooks vendor 56 is never a bill 56. A document, a message and a pack's own
// record are matched by our id alone (docs/plan.md §1.200).
export async function toolRefs(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
): Promise<ToolRef[]> {
  if (tenantIds.length === 0) return [];
  const clients = [...tenantIds];
  const [txn] = await tx
    .select({
      tenantId: transaction.tenantId,
      connector: transaction.connector,
      externalId: transaction.externalId,
    })
    .from(transaction)
    .where(and(inArray(transaction.tenantId, clients), eq(transaction.id, id)));
  if (txn) return toolIdRefs(["transaction"], txn);
  const [rec] = await tx
    .select({
      tenantId: receivable.tenantId,
      connector: receivable.connector,
      externalId: receivable.externalId,
    })
    .from(receivable)
    .where(and(inArray(receivable.tenantId, clients), eq(receivable.id, id)));
  if (rec) return toolIdRefs(["transaction"], rec);
  const [raw] = await tx
    .select({
      tenantId: rawRecord.tenantId,
      connector: rawRecord.connector,
      externalId: rawRecord.externalId,
      entityType: rawRecord.entityType,
    })
    .from(rawRecord)
    .where(and(inArray(rawRecord.tenantId, clients), eq(rawRecord.id, id)));
  if (raw) return toolIdRefs([subjectKindOfEntity(raw.entityType)], raw, raw.entityType);
  const [v] = await tx
    .select({ tenantId: vendor.tenantId, refs: vendor.externalRefs })
    .from(vendor)
    .where(and(inArray(vendor.tenantId, clients), eq(vendor.id, id)));
  if (v) return refsOf(v.tenantId, ["vendor", "organization"], v.refs);
  const [o] = await tx
    .select({ tenantId: organization.tenantId, refs: organization.externalRefs })
    .from(organization)
    .where(and(inArray(organization.tenantId, clients), eq(organization.id, id)));
  if (o) return refsOf(o.tenantId, ["customer", "vendor", "organization"], o.refs);
  const [c] = await tx
    .select({ tenantId: contact.tenantId, refs: contact.externalRefs })
    .from(contact)
    .where(and(inArray(contact.tenantId, clients), eq(contact.id, id)));
  if (c) return refsOf(c.tenantId, ["person"], c.refs);
  return [];
}

/**
 * A kept row about this record: by our id, or, in the record's own client, by the client's tool
 * and its id there.
 */
export function aboutRecord(id: string, refs: readonly ToolRef[]): SQL {
  return or(
    eq(runSubject.recordId, id),
    ...refs.map(
      (r) =>
        and(
          eq(runSubject.tenantId, r.tenantId),
          inArray(runSubject.kind, [...r.kinds]),
          eq(runSubject.connector, r.connector),
          eq(runSubject.externalId, r.externalId),
        ) as SQL,
    ),
  ) as SQL;
}

/** Each record id's tool refs, in the clients asked about (lower-case ids). */
export type RecordRefs = ReadonlyMap<string, readonly ToolRef[]>;

/** The tool refs of each of these record ids. */
export async function recordRefs(
  tx: Tx,
  tenantIds: readonly string[],
  ids: readonly string[],
): Promise<RecordRefs> {
  const out = new Map<string, ToolRef[]>();
  for (const raw of new Set(ids.filter((i) => isUuid(i)).map((i) => i.toLowerCase()))) {
    out.set(raw, await toolRefs(tx, tenantIds, raw));
  }
  return out;
}
