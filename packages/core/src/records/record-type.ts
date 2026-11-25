// Record types (docs/step-model-plan.md §10f, part 1): a kind of our own record (a vendor, a bank
// transaction, a master item), defined once, in code, by the area that owns it: its fields and
// keys, its links to other record types, and the operations it allows. Delete is always off. The
// database is still not a tool: steps reach records only through a record type's standard actions
// (Find, Get by id, Create, Update; ./actions.ts), each typed from this declaration, and every
// write runs the record type's rules wherever it comes from.
//
// Pure. Areas declare record types on their pack manifest (`recordTypes`), the platform its shared
// ones; apps/api registers each with its store.

import { z } from "zod";
import { AreaId } from "../schemas/tool";
import { type Field, Fields } from "../steps/schema";

/** A record type's id: `vendor`, `bank_transaction`, `master_item`. Unique across areas. */
export const RecordTypeId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _, starting with a letter");
export type RecordTypeId = z.infer<typeof RecordTypeId>;

/** What a record type allows. Delete is never one of them (invariant 8: delete is off). */
export const RECORD_OPS = ["get", "create", "update"] as const;
export type RecordOp = (typeof RECORD_OPS)[number];

/** A link from one record type to another: a field holding the other record's id. */
export const RecordLink = z.strictObject({
  /** What a Find follows (`vendor`): the linked record is read under this name. */
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),
  /** The record type it links to, in this area or another. */
  to: RecordTypeId,
  /** The field of this record type holding the linked record's id. */
  field: z.string().min(1).max(64),
});
export type RecordLink = z.infer<typeof RecordLink>;

/** Field names no record type may declare and no custom field may take. */
export const RESERVED_RECORD_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "sources",
  "custom",
  "ext",
  "tenantId",
]);

export const RecordType = z
  .strictObject({
    id: RecordTypeId,
    /** "Vendor". */
    name: z.string().min(1).max(60),
    /** "Vendors". */
    plural: z.string().min(1).max(60),
    /** The area that owns the records (`shared` for the shared business records). */
    area: AreaId,
    /** One line on what a record is. */
    about: z.string().min(1).max(200),
    /** Its built-in fields, as Find and Get give them; `id` is always there and not listed. */
    fields: Fields.min(1),
    /** The fields that pick out one record within a client (beside `id`). */
    keys: z.array(z.string().min(1)).max(5).default([]),
    links: z.array(RecordLink).max(10).default([]),
    /** Get is always on; Create and Update only where the area says. */
    operations: z
      .strictObject({
        create: z.boolean().default(false),
        update: z.boolean().default(false),
      })
      .prefault({}),
    /**
     * The built-in fields Create and Update may set. Everything else is the area's own to write
     * (its bespoke actions, its sync). Custom fields are always writable where Create or Update is on.
     */
    writable: z.array(z.string().min(1)).max(40).default([]),
    /** Whether the record keeps custom fields (it has an `ext` column). */
    customFields: z.boolean().default(true),
  })
  .superRefine((t, ctx) => {
    const names = new Set(t.fields.map((f) => f.name));
    t.fields.forEach((f, i) => {
      if (RESERVED_RECORD_FIELDS.has(f.name)) {
        ctx.addIssue({
          code: "custom",
          message: `${f.name} is a reserved name`,
          path: ["fields", i, "name"],
        });
      }
    });
    if (names.size !== t.fields.length) {
      ctx.addIssue({ code: "custom", message: "a field is declared twice", path: ["fields"] });
    }
    t.keys.forEach((k, i) => {
      if (!names.has(k)) {
        ctx.addIssue({ code: "custom", message: `key ${k} isn't a field`, path: ["keys", i] });
      }
    });
    t.writable.forEach((w, i) => {
      if (!names.has(w)) {
        ctx.addIssue({
          code: "custom",
          message: `writable ${w} isn't a field`,
          path: ["writable", i],
        });
      }
    });
    const linkNames = new Set<string>();
    t.links.forEach((l, i) => {
      const f = t.fields.find((x) => x.name === l.field);
      if (f?.type !== "record" || f.record !== l.to) {
        ctx.addIssue({
          code: "custom",
          message: `link ${l.name} reads ${l.field}, which isn't a field linking to ${l.to}`,
          path: ["links", i, "field"],
        });
      }
      if (linkNames.has(l.name) || names.has(l.name)) {
        ctx.addIssue({
          code: "custom",
          message: `link ${l.name} has the name of a field or another link`,
          path: ["links", i, "name"],
        });
      }
      linkNames.add(l.name);
    });
    if (
      (t.operations.create || t.operations.update) &&
      t.writable.length === 0 &&
      !t.customFields
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a record type that can be written names what can be written",
        path: ["writable"],
      });
    }
  });
export type RecordType = z.infer<typeof RecordType>;

/** Whether a record type allows an operation. */
export function recordTypeAllows(type: Pick<RecordType, "operations">, op: RecordOp): boolean {
  return op === "get" || type.operations[op];
}

/**
 * The record types declared across areas, checked together: ids unique, every link to a declared
 * record type. Returns the problems in plain words (empty: none).
 */
export function recordTypesProblems(types: readonly RecordType[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const t of types) {
    if (ids.has(t.id)) out.push(`two areas declare the record type ${t.id}`);
    ids.add(t.id);
  }
  for (const t of types) {
    for (const l of t.links) {
      if (!ids.has(l.to))
        out.push(`${t.id}'s link ${l.name} goes to ${l.to}, which isn't declared`);
    }
  }
  return out;
}

/** A record type's built-in fields with `id` first. */
export function recordFields(type: Pick<RecordType, "fields" | "name">): Field[] {
  return [
    { name: "id", type: "text", required: true, about: `The ${type.name.toLowerCase()}'s id` },
    ...type.fields,
  ];
}

/** One record as an area's store holds it: its id, its built-in fields' values, its `ext`. */
export interface StoredRecord {
  id: string;
  values: Record<string, unknown>;
  ext: Record<string, unknown>;
}

/**
 * How the platform reaches one record type's records (an area's code; apps/api registers it). Every
 * call is inside one client's transaction (`Tx`, opaque here), and every query also filters by
 * `tenantId` (invariant 1). The platform runs the record type's rules around `create` and `update`:
 * the custom fields' checks, the agent version, the evidence and the idempotency log.
 */
export interface RecordStore<Tx> {
  type: RecordType;
  /** Newest first, at most `limit`; `truncated` when there are more. */
  list(
    tx: Tx,
    tenantId: string,
    limit: number,
  ): Promise<{ rows: StoredRecord[]; truncated: boolean }>;
  /**
   * With `lock`, the rows are locked for this transaction (`for update`): a write reads its record
   * so, and writes its custom values whole, so two writes at once never lose each other's.
   */
  get(
    tx: Tx,
    tenantId: string,
    ids: readonly string[],
    options?: { lock?: boolean },
  ): Promise<StoredRecord[]>;
  /** Where the record type allows Create: inserts the built-in values and the custom ones. */
  create?(
    tx: Tx,
    tenantId: string,
    input: {
      values: Record<string, unknown>;
      custom: Record<string, unknown>;
      agentVersionId: string | null;
    },
  ): Promise<StoredRecord>;
  /** Where it allows Update: sets the given built-in values and the record's custom values whole. */
  update?(
    tx: Tx,
    tenantId: string,
    id: string,
    input: { values: Record<string, unknown>; custom: Record<string, unknown> },
  ): Promise<StoredRecord | null>;
  /** Whether any record in scope holds a value for a custom field (its type can't change then). */
  holdsCustom(tx: Tx, name: string): Promise<boolean>;
}
