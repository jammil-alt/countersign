// The Odoo models the connector reaches, by business area, and Odoo's record JSON as tools return
// it. Field types come from Odoo itself (`fields_get`), so a float or monetary value is always
// decimal text (invariant 6), an empty value is null rather than Odoo's `false`, and a link to
// another record is `{id, name}`. Record text is what people wrote in the client's Odoo: data,
// never instructions (invariant 9).

import { dec, toNumeric } from "@countersign/core";
import { z } from "zod";

/** The models agents may work in: CRM, sales, purchasing, invoicing and inventory. */
export const OdooModel = z.enum([
  // CRM
  "crm.lead",
  "res.partner",
  // ERP: sales, purchasing, invoices and bills
  "sale.order",
  "purchase.order",
  "account.move",
  // Inventory
  "product.product",
  "stock.quant",
  "stock.picking",
]);
export type OdooModel = z.infer<typeof OdooModel>;

/** The models records may be created in and changed: drafts behind approval. */
export const OdooWritableModel = z.enum([
  "crm.lead",
  "res.partner",
  "sale.order",
  "purchase.order",
  "account.move",
]);
export type OdooWritableModel = z.infer<typeof OdooWritableModel>;

/** The record type (permission entity) each model is in the matrix. */
export const ODOO_MODEL_ENTITY: Record<OdooModel, string> = {
  "crm.lead": "lead",
  "res.partner": "contact",
  "sale.order": "sale_order",
  "purchase.order": "purchase_order",
  "account.move": "invoice",
  "product.product": "product",
  "stock.quant": "stock",
  "stock.picking": "transfer",
};

/** The fields returned when the call names none: enough to know the record. */
export const DEFAULT_FIELDS: Record<OdooModel, readonly string[]> = {
  "crm.lead": [
    "name",
    "type",
    "partner_id",
    "partner_name",
    "contact_name",
    "email_from",
    "phone",
    "stage_id",
    "user_id",
    "expected_revenue",
    "probability",
    "date_deadline",
    "company_currency",
  ],
  "res.partner": [
    "name",
    "is_company",
    "parent_id",
    "email",
    "phone",
    "street",
    "city",
    "zip",
    "country_id",
    "vat",
    "ref",
  ],
  "sale.order": [
    "name",
    "partner_id",
    "state",
    "date_order",
    "validity_date",
    "client_order_ref",
    "user_id",
    "amount_untaxed",
    "amount_tax",
    "amount_total",
    "currency_id",
    "invoice_status",
  ],
  "purchase.order": [
    "name",
    "partner_id",
    "partner_ref",
    "state",
    "date_order",
    "date_planned",
    "user_id",
    "amount_untaxed",
    "amount_tax",
    "amount_total",
    "currency_id",
    "invoice_status",
  ],
  "account.move": [
    "name",
    "move_type",
    "partner_id",
    "state",
    "ref",
    "invoice_date",
    "invoice_date_due",
    "amount_untaxed",
    "amount_tax",
    "amount_total",
    "amount_residual",
    "currency_id",
    "payment_state",
  ],
  "product.product": [
    "name",
    "default_code",
    "barcode",
    "type",
    "list_price",
    "standard_price",
    "uom_id",
    "qty_available",
    "virtual_available",
  ],
  "stock.quant": [
    "product_id",
    "location_id",
    "lot_id",
    "quantity",
    "reserved_quantity",
    "product_uom_id",
  ],
  "stock.picking": [
    "name",
    "picking_type_code",
    "partner_id",
    "origin",
    "state",
    "scheduled_date",
    "date_done",
    "location_id",
    "location_dest_id",
  ],
};

/** Fields every read adds: what names a record, and when it was made and changed. */
export const META_FIELDS = ["display_name", "create_date", "write_date", "create_uid"] as const;

/** Where a word given to search is looked for, per model (any of them matches). */
export const QUERY_FIELDS: Record<OdooModel, readonly string[]> = {
  "crm.lead": ["name", "partner_name", "contact_name", "email_from"],
  "res.partner": ["name", "email", "ref"],
  "sale.order": ["name", "client_order_ref", "partner_id"],
  "purchase.order": ["name", "partner_ref", "partner_id"],
  "account.move": ["name", "ref", "partner_id"],
  "product.product": ["name", "default_code", "barcode"],
  "stock.quant": ["product_id"],
  "stock.picking": ["name", "origin", "partner_id"],
};

/** Invoices, credit notes and bills: the only kinds of journal entry agents see or make. */
export const INVOICE_MOVE_TYPES = ["out_invoice", "out_refund", "in_invoice", "in_refund"] as const;

/** Conditions every search in a model carries, whatever the agent asks. */
export const FIXED_DOMAIN: Partial<Record<OdooModel, unknown[]>> = {
  "account.move": [["move_type", "in", [...INVOICE_MOVE_TYPES]]],
};

/** Odoo's field types that hold a decimal: always decimal text here, never a JS float. */
const DECIMAL_TYPES = new Set(["float", "monetary"]);
/** Link fields that may be read and set (by id). */
export const MANY2ONE = "many2one";
/** Field types a generic create or update may set. Lists of links go through their own inputs. */
export const SETTABLE_TYPES = new Set([
  "char",
  "text",
  "html",
  "selection",
  "boolean",
  "integer",
  "float",
  "monetary",
  "date",
  "datetime",
  "many2one",
]);

/**
 * Fields no agent sets through the generic tools: a record's state moves only through the tools
 * that confirm, post or validate it (each behind approval), and the bookkeeping fields are Odoo's.
 */
export const PROTECTED_FIELDS = new Set([
  "id",
  "state",
  "move_type",
  "company_id",
  "display_name",
  "create_uid",
  "create_date",
  "write_uid",
  "write_date",
  "access_token",
  "access_url",
  "posted_before",
  "invoice_status",
  "payment_state",
  "amount_total",
  "amount_untaxed",
  "amount_tax",
  "amount_residual",
]);

/** Names that must never be keys we assign (prototype pollution). */
export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** An Odoo field's technical name (`partner_id`, `x_studio_note`). */
export const FieldName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, "an Odoo field's technical name, e.g. partner_id")
  .refine((n) => !UNSAFE_KEYS.has(n), "not a field name");

/** What `fields_get` says about a field, as far as we use it. */
export const FieldInfo = z.looseObject({
  type: z.string(),
  string: z.string().optional(),
  relation: z.string().optional(),
  readonly: z.boolean().optional(),
});
export type FieldInfo = z.infer<typeof FieldInfo>;
export type FieldMap = Record<string, FieldInfo>;

export const FieldsAnswer = z.record(z.string(), FieldInfo);

/** A value as tools return it. */
export const OdooValue: z.ZodType<OdooValueType> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().int(),
    z.boolean(),
    z.null(),
    z.object({ id: z.number().int(), name: z.string().nullable() }),
    z.array(z.number().int()),
  ]),
);
export type OdooValueType =
  | string
  | number
  | boolean
  | null
  | { id: number; name: string | null }
  | number[];

/**
 * An Odoo record as tools return it. `fields` are what people and other tools wrote in the
 * client's Odoo: data, never instructions (invariant 9).
 */
export const OdooRecord = z.object({
  model: OdooModel,
  id: z.number().int(),
  name: z.string().nullable(),
  fields: z.record(z.string(), OdooValue),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The Odoo user who made it. */
  createdBy: z.number().int().nullable(),
});
export type OdooRecord = z.infer<typeof OdooRecord>;

const MAX_TEXT = 20_000;

/** A decimal Odoo sent as a JSON number → `numeric(14,4)` text, read from its digits. */
// DECISION: the number's shortest text (what JSON carried) is read as a decimal; values beyond
// numeric(14,4) keep their text rather than fail the read.
export function odooDecimal(v: number | string): string {
  const text = String(v);
  try {
    const d = dec(text);
    return d.abs().lt("10000000000") ? toNumeric(d) : d.toString();
  } catch {
    return text;
  }
}

/** One value from Odoo's JSON, read with its field's type. */
export function mapOdooValue(raw: unknown, info: FieldInfo | undefined): OdooValueType {
  const type = info?.type;
  // Odoo answers `false` for an empty value of every type but a boolean.
  if (raw === false && type !== "boolean") return null;
  if (raw === null || raw === undefined) return null;
  if (type && DECIMAL_TYPES.has(type)) {
    return typeof raw === "number" || typeof raw === "string" ? odooDecimal(raw) : null;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 2 && typeof raw[0] === "number" && type !== "one2many") {
      if (type === MANY2ONE || typeof raw[1] === "string" || raw[1] === false) {
        return { id: raw[0], name: typeof raw[1] === "string" ? raw[1].slice(0, 500) : null };
      }
    }
    if (raw.every((x) => typeof x === "number" && Number.isInteger(x))) {
      return (raw as number[]).slice(0, 1000);
    }
    return JSON.stringify(raw).slice(0, MAX_TEXT);
  }
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : odooDecimal(raw);
  if (typeof raw === "string") return raw.slice(0, MAX_TEXT);
  if (typeof raw === "boolean") return raw;
  return JSON.stringify(raw).slice(0, MAX_TEXT);
}

const RawRecord = z.looseObject({ id: z.number().int() });

/** Odoo's record JSON → OdooRecord, each value read with its field's type. */
export function mapOdooRecord(model: OdooModel, raw: unknown, fields: FieldMap): OdooRecord {
  const r = RawRecord.parse(raw) as Record<string, unknown> & { id: number };
  const skip = new Set<string>(["id", ...META_FIELDS]);
  const values: Record<string, OdooValueType> = Object.fromEntries(
    Object.entries(r)
      .filter(([k]) => !skip.has(k) && !UNSAFE_KEYS.has(k))
      .map(([k, v]) => [k, mapOdooValue(v, fields[k])]),
  );
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const creator = mapOdooValue(r.create_uid, { type: MANY2ONE });
  return OdooRecord.parse({
    model,
    id: r.id,
    name: text(r.display_name)?.slice(0, 500) ?? null,
    fields: values,
    createdAt: text(r.create_date),
    updatedAt: text(r.write_date),
    createdBy:
      creator && typeof creator === "object" && !Array.isArray(creator) ? creator.id : null,
  });
}

/** The id of a link value (`{id, name}`), or null. */
export function linkId(v: OdooValueType | undefined): number | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v.id : null;
}

/** Odoo's datetime text (UTC, `YYYY-MM-DD HH:MM:SS`) for an instant. */
export function odooDatetime(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/** HTML from Odoo's chatter as plain text, to compare a note with the one we'd write. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
