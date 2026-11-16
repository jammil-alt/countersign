// "odoo": the client's own Odoo (Online, Odoo.sh or its own server), for CRM, sales, purchasing,
// invoicing and inventory. The client admin enters, in the vault, the Odoo address and database and
// the login and API key of an Odoo user made for us: encrypted with the client's own key,
// write-only, never shown, logged or given to a model (invariant 13). Calls go only to that
// address, https on a public host, and never follow a redirect.
//
// Reads (each with `sources`): search and get leads, contacts, quotations and sales orders,
// purchase orders, invoices and bills, products, stock on hand and transfers. Writes, each
// `external` behind approval with its before state and run once per external action: create and
// update leads, contacts, and draft orders, invoices and bills; confirm a quotation or a purchase
// order; post a draft invoice or bill; validate a receipt; log an internal note; schedule an
// activity. No delete tool, and delete stays off. Unchecked facts about Odoo: ./NOTES.md.

import { CurrencyCode, DecimalString, dec } from "@countersign/core";
import { z } from "zod";
import {
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type ToolContext,
} from "../connector";
import type { FetchLike } from "../http";
import {
  ODOO_CREDENTIAL_FIELDS,
  OdooApiError,
  OdooClient,
  refuse,
  type WriteNote,
  wireDecimal,
  writeAnswer,
} from "./client";
import {
  DEFAULT_FIELDS,
  FIXED_DOMAIN,
  type FieldMap,
  FieldName,
  FieldsAnswer,
  INVOICE_MOVE_TYPES,
  linkId,
  MANY2ONE,
  META_FIELDS,
  mapOdooRecord,
  ODOO_MODEL_ENTITY,
  OdooModel,
  OdooRecord,
  OdooValue,
  type OdooValueType,
  OdooWritableModel,
  odooDatetime,
  PROTECTED_FIELDS,
  plainText,
  QUERY_FIELDS,
  SETTABLE_TYPES,
} from "./records";

export {
  ODOO_CREDENTIAL_FIELDS,
  OdooAddressRefused,
  OdooApiError,
  OdooCredentials,
  OdooInvalidInputError,
  odooJson,
  odooOrigin,
} from "./client";
export {
  mapOdooRecord,
  mapOdooValue,
  ODOO_MODEL_ENTITY,
  OdooModel,
  OdooRecord,
  OdooWritableModel,
  odooDecimal,
} from "./records";

export const ODOO_CONNECTOR_ID = "odoo";
export const ODOO_TOOLS = {
  search: "odoo.record.search",
  get: "odoo.record.get",
  create: "odoo.record.create",
  update: "odoo.record.update",
  confirmOrder: "odoo.order.confirm",
  postInvoice: "odoo.invoice.post",
  validateReceipt: "odoo.receipt.validate",
  note: "odoo.note.create",
  activity: "odoo.activity.create",
} as const;

/** v0.12 W2-A: the record tools' entity is the one their `model` names (as HubSpot's). */
export const ODOO_MODEL_ENTITY_INPUT = { field: "model", values: ODOO_MODEL_ENTITY };
const WRITABLE_ENTITY_INPUT = {
  field: "model",
  values: Object.fromEntries(
    OdooWritableModel.options.map((m) => [m, ODOO_MODEL_ENTITY[m]]),
  ) as Record<OdooWritableModel, string>,
};

/** The orders a person confirms: a quotation becomes a sales order, an RFQ a purchase order. */
const OrderModel = z.enum(["sale.order", "purchase.order"]);
type OrderModel = z.infer<typeof OrderModel>;
const ORDER_ENTITY_INPUT = {
  field: "model",
  values: { "sale.order": "sale_order", "purchase.order": "purchase_order" },
};
/** The method that confirms each, and the states that mean it is already confirmed. */
const CONFIRM: Record<OrderModel, { method: string; open: string[]; done: string[] }> = {
  "sale.order": { method: "action_confirm", open: ["draft", "sent"], done: ["sale", "done"] },
  "purchase.order": {
    method: "button_confirm",
    open: ["draft", "sent", "to approve"],
    done: ["purchase", "done"],
  },
};

/** Where each model keeps its lines, and the line's quantity field. */
const LINES: Partial<Record<OdooWritableModel, { field: string; quantity: string }>> = {
  "sale.order": { field: "order_line", quantity: "product_uom_qty" },
  "purchase.order": { field: "order_line", quantity: "product_qty" },
  "account.move": { field: "invoice_line_ids", quantity: "quantity" },
};

/** A record made by us within this long that matches a create is this action's own earlier write. */
const TWIN_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

const RecordId = z.number().int().positive().max(2_147_483_647);
/** A field, or a path through links (`partner_id.country_id.code`), for search conditions. */
const FieldPath = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62}){0,2}$/,
    "a field's technical name, or a path like partner_id.name",
  );
const Scalar = z.union([z.string().max(65_536), z.number().int(), z.boolean(), z.null()]);
type Scalar = z.infer<typeof Scalar>;
const Values = z
  .record(FieldName, Scalar)
  .refine((v) => Object.keys(v).length > 0, "give at least one field")
  .refine((v) => Object.keys(v).length <= 60, "at most 60 fields");

const Condition = z.object({
  field: FieldPath,
  op: z.enum(["=", "!=", ">", ">=", "<", "<=", "ilike", "not ilike", "in", "not in"]),
  value: z.union([
    z.string().max(500),
    z.number().int(),
    z.boolean(),
    z.null(),
    z
      .array(z.union([z.string().max(200), z.number().int()]))
      .min(1)
      .max(100),
  ]),
});
type Condition = z.infer<typeof Condition>;

const Line = z.object({
  productId: RecordId,
  description: z.string().trim().min(1).max(2000).optional(),
  quantity: DecimalString,
  /** Odoo's price from the pricelist or vendor when left out. */
  unitPrice: DecimalString.optional(),
  /** Invoices and bills only: the taxes on the line (Odoo's default from the product otherwise). */
  taxIds: z.array(RecordId).max(10).optional(),
  /** Invoices and bills only: the income or expense account (the product's otherwise). */
  accountId: RecordId.optional(),
});
type Line = z.infer<typeof Line>;

const Order = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}( (asc|desc))?$/, "a field and asc or desc, e.g. write_date desc");

// ── The connector ───────────────────────────────────────────────────────────────────────────────

export interface OdooOptions {
  fetch?: FetchLike;
}

export function createOdooConnector(options: OdooOptions = {}): Connector {
  /** One client per tool call: it signs in once and keeps each model's fields for the call. */
  function session(ctx: ToolContext) {
    const c = new OdooClient(ctx, { fetch: options.fetch });
    const fieldCache = new Map<string, Promise<FieldMap>>();
    function fields(model: string): Promise<FieldMap> {
      let f = fieldCache.get(model);
      if (!f) {
        f = c
          .execute(model, "fields_get", [], { attributes: ["type", "string", "relation"] })
          .then((raw) => FieldsAnswer.parse(raw));
        fieldCache.set(model, f);
      }
      return f;
    }
    return { c, fields };
  }
  type Session = ReturnType<typeof session>;

  /** The fields to read: the model's defaults Odoo has, the extra ones asked, and the meta ones. */
  function readList(fields: FieldMap, model: OdooModel, extra: readonly string[] = []): string[] {
    const unknown = extra.filter((f) => !fields[f]);
    if (unknown.length > 0) {
      throw refuse(`${model} has no field ${unknown.join(", ")} in this Odoo`);
    }
    return [
      ...new Set([...DEFAULT_FIELDS[model], ...extra, ...META_FIELDS].filter((f) => fields[f])),
    ];
  }

  async function searchRead(
    s: Session,
    model: OdooModel,
    domain: unknown[],
    opts: { extra?: readonly string[]; limit: number; offset?: number; order?: string } = {
      limit: 20,
    },
    context: Record<string, unknown> = {},
  ): Promise<OdooRecord[]> {
    const fields = await s.fields(model);
    const raw = await s.c.execute(
      model,
      "search_read",
      [[...(FIXED_DOMAIN[model] ?? []), ...domain]],
      {
        fields: readList(fields, model, opts.extra),
        limit: opts.limit,
        ...(opts.offset ? { offset: opts.offset } : {}),
        order: opts.order ?? "id desc",
        ...(Object.keys(context).length > 0 ? { context } : {}),
      },
    );
    return z
      .array(z.unknown())
      .parse(raw)
      .map((r) => mapOdooRecord(model, r, fields));
  }

  /** One record by id (archived ones too), or null when there is none the user can see. */
  async function getRecord(
    s: Session,
    model: OdooModel,
    id: number,
    extra: readonly string[] = [],
  ): Promise<OdooRecord | null> {
    const [r] = await searchRead(
      s,
      model,
      [["id", "=", id]],
      { extra, limit: 1 },
      { active_test: false },
    );
    return r ?? null;
  }

  function notFound(model: string, id: number): OdooApiError {
    return new OdooApiError(
      404,
      "NOT_FOUND",
      `${model} ${id} isn't in this Odoo`,
      "not_found",
      false,
    );
  }

  /** A search condition on the wire: a decimal on a float or money field goes as a number. */
  function conditionTerm(fields: FieldMap, model: string, c: Condition): unknown[] {
    const top = c.field.split(".")[0] as string;
    const info = fields[top];
    if (!info) throw refuse(`${model} has no field ${top} in this Odoo`);
    const decimal = (info.type === "float" || info.type === "monetary") && !c.field.includes(".");
    const value =
      decimal && typeof c.value === "string" && DecimalString.safeParse(c.value).success
        ? wireDecimal(c.value)
        : c.value === null
          ? false
          : c.value;
    return [c.field, c.op, value];
  }

  /** `A or B or C` in Odoo's prefix notation. */
  function anyOf(terms: unknown[][]): unknown[] {
    return terms.length === 0 ? [] : [...Array(terms.length - 1).fill("|"), ...terms];
  }

  /** A value the agent gave → Odoo's wire value for the field, or a refusal. */
  function wireValue(model: string, field: string, info: FieldMap[string] | undefined, v: Scalar) {
    if (!info) throw refuse(`${model} has no field ${field} in this Odoo`);
    if (PROTECTED_FIELDS.has(field)) {
      throw refuse(`${field} isn't set this way: its own tool changes it, or Odoo does`);
    }
    if (!SETTABLE_TYPES.has(info.type)) {
      throw refuse(`${field} is a ${info.type} field, which these tools don't set`);
    }
    // Odoo clears a field of any type with `false`.
    if (v === null) return false;
    switch (info.type) {
      case "float":
      case "monetary": {
        const text = typeof v === "number" ? String(v) : v;
        if (typeof text !== "string" || !DecimalString.safeParse(text).success) {
          throw refuse(`${field} takes a decimal as text, e.g. "120.50"`);
        }
        return wireDecimal(text);
      }
      case "integer":
      case MANY2ONE:
        if (typeof v !== "number") throw refuse(`${field} takes a whole number (a record's id)`);
        return v;
      case "boolean":
        if (typeof v !== "boolean") throw refuse(`${field} takes true or false`);
        return v;
      default:
        if (typeof v !== "string") throw refuse(`${field} takes text`);
        return v;
    }
  }

  async function wireValues(s: Session, model: string, values: Record<string, Scalar>) {
    const fields = await s.fields(model);
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, wireValue(model, k, fields[k], v)]),
    );
  }

  /** Whether the record's value already is the one asked. */
  function sameValue(current: OdooValueType | undefined, wanted: Scalar): boolean {
    if (current === undefined) return false;
    if (wanted === null) return current === null || current === false;
    if (typeof wanted === "number" && current !== null && typeof current === "object") {
      return linkId(current) === wanted;
    }
    if (typeof current === "string" && DecimalString.safeParse(current).success) {
      const w = typeof wanted === "number" ? String(wanted) : wanted;
      return typeof w === "string" && DecimalString.safeParse(w).success && dec(current).eq(dec(w));
    }
    return current === wanted;
  }

  /** A before value written back by the update tool (R5 restore). */
  function restoreValue(v: OdooValueType): Scalar | undefined {
    if (Array.isArray(v)) return undefined;
    if (v !== null && typeof v === "object") return v.id;
    return v;
  }

  function lineCommands(model: OdooWritableModel, lines: readonly Line[]): unknown[] {
    const spec = LINES[model];
    if (!spec) throw refuse(`${model} has no lines`);
    return lines.map((l) => {
      if (model !== "account.move" && (l.taxIds || l.accountId)) {
        throw refuse("taxes and accounts are set on invoice and bill lines only");
      }
      return [
        0,
        0,
        {
          product_id: l.productId,
          [spec.quantity]: wireDecimal(l.quantity),
          ...(l.description ? { name: l.description } : {}),
          ...(l.unitPrice ? { price_unit: wireDecimal(l.unitPrice) } : {}),
          ...(l.taxIds ? { tax_ids: [[6, 0, l.taxIds]] } : {}),
          ...(l.accountId ? { account_id: l.accountId } : {}),
        },
      ];
    });
  }

  const sourcesOf = (records: readonly OdooRecord[]) => records.map((r) => `${r.model}:${r.id}`);

  // ── Create ──

  const CreateInput = z
    .object({
      model: OdooWritableModel,
      values: Values,
      /** Orders, invoices and bills: their lines (products, quantities, prices). */
      lines: z.array(Line).min(1).max(200).optional(),
      /** Invoices and bills: which kind. */
      moveType: z.enum(INVOICE_MOVE_TYPES).optional(),
    })
    .refine((v) => (v.model === "account.move") === (v.moveType !== undefined), {
      message: "give moveType for an invoice or bill (account.move), and only then",
    })
    .refine((v) => !v.lines || LINES[v.model] !== undefined, {
      message: "only orders, invoices and bills have lines",
    });
  type CreateInput = z.infer<typeof CreateInput>;

  /** What finds a record a create would repeat: the same email or name, or the same draft. */
  function twinDomain(input: CreateInput): unknown[] | null {
    const v = input.values;
    const has = (k: string) => v[k] !== undefined && v[k] !== null && v[k] !== "";
    switch (input.model) {
      case "res.partner":
        if (has("email")) return [["email", "=ilike", v.email]];
        return has("name") ? [["name", "=ilike", v.name]] : null;
      case "crm.lead":
        return has("name") ? [["name", "=", v.name]] : null;
      case "sale.order":
      case "purchase.order":
        return has("partner_id")
          ? [
              ["partner_id", "=", v.partner_id],
              ["state", "in", ["draft", "sent"]],
            ]
          : null;
      case "account.move":
        return has("partner_id")
          ? [
              ["partner_id", "=", v.partner_id],
              ["move_type", "=", input.moveType],
              ["state", "=", "draft"],
            ]
          : null;
    }
  }

  const NoteText = z.string().trim().min(1).max(10_000);

  return defineConnector({
    id: ODOO_CONNECTOR_ID,
    name: "Odoo",
    description:
      "Leads, contacts, orders, invoices, bills, products and stock in your Odoo. We sign in as an Odoo user you make for us, with an API key.",
    icon: "box",
    auth: "api_key",
    credentialFields: ODOO_CREDENTIAL_FIELDS.map((f) => ({ ...f })),
    entities: [
      "Lead",
      "Contact",
      "SaleOrder",
      "PurchaseOrder",
      "Invoice",
      "Product",
      "Stock",
      "Transfer",
      "Note",
      "Activity",
    ],
    permissionEntities: [
      { id: "lead", label: "Leads and opportunities", verbs: ["read", "create", "update"] },
      { id: "contact", label: "Contacts", verbs: ["read", "create", "update"] },
      {
        id: "sale_order",
        label: "Quotations and sales orders",
        verbs: ["read", "create", "update"],
      },
      { id: "purchase_order", label: "Purchase orders", verbs: ["read", "create", "update"] },
      { id: "invoice", label: "Invoices and bills", verbs: ["read", "create", "update"] },
      { id: "product", label: "Products", verbs: ["read"] },
      { id: "stock", label: "Stock on hand", verbs: ["read"] },
      { id: "transfer", label: "Receipts and deliveries", verbs: ["read", "update"] },
      { id: "note", label: "Notes", verbs: ["create"] },
      { id: "activity", label: "Activities", verbs: ["create"] },
    ],
    tools: [
      // ── Reads ──
      defineReadTool({
        id: ODOO_TOOLS.search,
        entityInput: ODOO_MODEL_ENTITY_INPUT,
        description:
          "Search Odoo records of one kind (crm.lead, res.partner, sale.order, purchase.order, account.move for invoices and bills, product.product, stock.quant for stock on hand, stock.picking for receipts and deliveries) by a word or by conditions on fields, a page at a time.",
        summary: "Found {{records.length}} of {{total}} {{model}}",
        input: z.object({
          model: OdooModel,
          /** Looked for in the kind's names, references and emails. */
          query: z.string().trim().min(2).max(200).optional(),
          /** All must hold. */
          conditions: z.array(Condition).max(10).optional(),
          /** Extra fields to return beside the defaults. */
          fields: z.array(FieldName).max(40).optional(),
          /** Archived records too. */
          includeArchived: z.boolean().default(false),
          order: Order.optional(),
          limit: z.number().int().min(1).max(100).default(20),
          offset: z.number().int().min(0).max(100_000).default(0),
        }),
        output: z.object({
          model: OdooModel,
          total: z.number().int(),
          records: z.array(OdooRecord),
          nextOffset: z.number().int().nullable(),
          sources: z.array(z.string()),
        }),
        async run(input, ctx) {
          const s = session(ctx);
          const fields = await s.fields(input.model);
          const terms = (input.conditions ?? []).map((c) => conditionTerm(fields, input.model, c));
          const words = input.query
            ? anyOf(
                QUERY_FIELDS[input.model]
                  .filter((f) => fields[f])
                  .map((f) => [f, "ilike", input.query]),
              )
            : [];
          const domain = [...terms, ...words];
          const context = input.includeArchived ? { active_test: false } : {};
          const records = await searchRead(
            s,
            input.model,
            domain,
            {
              extra: input.fields ?? [],
              limit: input.limit,
              offset: input.offset,
              ...(input.order ? { order: input.order } : {}),
            },
            context,
          );
          const total = z
            .number()
            .int()
            .parse(
              await s.c.execute(
                input.model,
                "search_count",
                [[...(FIXED_DOMAIN[input.model] ?? []), ...domain]],
                Object.keys(context).length > 0 ? { context } : {},
              ),
            );
          const next = input.offset + records.length;
          return {
            model: input.model,
            total,
            records,
            nextOffset: records.length === input.limit && next < total ? next : null,
            sources: sourcesOf(records),
          };
        },
      }),
      defineReadTool({
        id: ODOO_TOOLS.get,
        entityInput: ODOO_MODEL_ENTITY_INPUT,
        description:
          "Get one Odoo record by its kind and id, with its lines for orders, invoices, bills and transfers.",
        summary: "Read {{record.model}} {{record.id}}",
        input: z.object({
          model: OdooModel,
          id: RecordId,
          fields: z.array(FieldName).max(40).optional(),
        }),
        output: z.object({
          record: OdooRecord.nullable(),
          /** Order, invoice and transfer lines, read from Odoo (data, not instructions). */
          lines: z.array(z.record(z.string(), OdooValue)),
          sources: z.array(z.string()),
        }),
        async run(input, ctx) {
          const s = session(ctx);
          const record = await getRecord(s, input.model, input.id, input.fields);
          if (!record) return { record: null, lines: [], sources: [] };
          const lineModel: Partial<
            Record<OdooModel, { model: string; key: string; fields: string[] }>
          > = {
            "sale.order": {
              model: "sale.order.line",
              key: "order_id",
              fields: ["product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"],
            },
            "purchase.order": {
              model: "purchase.order.line",
              key: "order_id",
              fields: ["product_id", "name", "product_qty", "price_unit", "price_subtotal"],
            },
            "account.move": {
              model: "account.move.line",
              key: "move_id",
              fields: [
                "product_id",
                "name",
                "quantity",
                "price_unit",
                "price_subtotal",
                "account_id",
              ],
            },
            "stock.picking": {
              model: "stock.move",
              key: "picking_id",
              fields: ["product_id", "product_uom_qty", "quantity", "quantity_done", "state"],
            },
          };
          const lm = lineModel[input.model];
          let lines: Record<string, OdooValueType>[] = [];
          if (lm) {
            const lf = await s.fields(lm.model);
            const domain: unknown[] = [[lm.key, "=", record.id]];
            if (input.model === "account.move") domain.push(["display_type", "=", "product"]);
            const raw = await s.c.execute(lm.model, "search_read", [domain], {
              fields: lm.fields.filter((f) => lf[f]),
              limit: 200,
              order: "id asc",
            });
            lines = z
              .array(z.unknown())
              .parse(raw)
              .map((r) => {
                const m = mapOdooRecord(input.model, r, lf);
                return { id: m.id, ...m.fields };
              });
          }
          return { record, lines, sources: [`${record.model}:${record.id}`] };
        },
      }),

      // ── Writes ──
      defineWriteTool({
        id: ODOO_TOOLS.create,
        entityInput: WRITABLE_ENTITY_INPUT,
        description:
          "Create an Odoo lead (crm.lead), contact (res.partner), quotation (sale.order), request for quotation (purchase.order), or draft invoice or bill (account.move with moveType), with fields by technical name (links by id, decimals as text) and lines for orders, invoices and bills. Orders and invoices are made as drafts; confirming or posting is its own step.",
        verb: "create",
        // R5: no archive or cancel tool yet, and delete stays off.
        undo: { kind: "none" },
        summary: "Created {{model}} {{id}}",
        input: CreateInput,
        output: z.object({
          model: OdooWritableModel,
          id: z.number().int(),
          alreadyDone: z.boolean(),
        }),
        // What is there already: records like this one (same email or name, or a draft for the
        // same partner), so the approver sees a likely duplicate before it is made.
        beforeSchema: z.object({ existing: z.array(OdooRecord) }),
        async before(input, ctx) {
          const domain = twinDomain(input);
          if (!domain) return { existing: [] };
          const s = session(ctx);
          const lines = LINES[input.model];
          const fields = await s.fields(input.model);
          const extra = [...Object.keys(input.values), ...(lines ? [lines.field] : [])].filter(
            (f) => fields[f],
          );
          return {
            existing: await searchRead(s, input.model, domain, { extra, limit: 10 }),
          };
        },
        async run(input, ctx, before) {
          const s = session(ctx);
          const values = await wireValues(s, input.model, input.values);
          const uid = await s.c.uid();
          // DECISION: Odoo takes no idempotency key. A record of this kind that our Odoo user made
          // within the last day, with every given field already as asked (and as many lines), is
          // this action's own earlier write (a retry after a lost answer): reported done, not made
          // again.
          const since = odooDatetime(new Date(ctx.now().getTime() - TWIN_WINDOW_MS));
          const lineField = LINES[input.model]?.field;
          const twin = (before?.existing ?? []).find(
            (r) =>
              r.createdBy === uid &&
              r.createdAt !== null &&
              r.createdAt >= since &&
              Object.entries(input.values).every(([k, v]) => sameValue(r.fields[k], v)) &&
              (!lineField ||
                !input.lines ||
                (Array.isArray(r.fields[lineField]) &&
                  (r.fields[lineField] as number[]).length === input.lines.length)),
          );
          if (twin) return { model: input.model, id: twin.id, alreadyDone: true };
          if (
            input.model === "res.partner" &&
            input.values.email &&
            (before?.existing.length ?? 0) > 0
          ) {
            throw new OdooApiError(
              409,
              "CONFLICT",
              "a contact with this email already exists in Odoo: update it instead",
              "conflict",
              false,
            );
          }
          const vals: Record<string, unknown> = {
            ...values,
            ...(input.moveType ? { move_type: input.moveType } : {}),
            ...(input.lines && lineField
              ? { [lineField]: lineCommands(input.model, input.lines) }
              : {}),
          };
          const note: WriteNote = {
            title: `A ${input.model} record may have been created in Odoo`,
            details: { model: input.model },
          };
          ctx.logger.info("creating odoo record", { model: input.model });
          const out = writeAnswer(
            z.union([RecordId, z.array(RecordId).length(1)]),
            await s.c.execute(input.model, "create", [vals], {}, note),
            note,
          );
          return {
            model: input.model,
            id: Array.isArray(out) ? (out[0] as number) : out,
            alreadyDone: false,
          };
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.update,
        entityInput: WRITABLE_ENTITY_INPUT,
        description:
          "Change fields of an Odoo lead, contact, order, invoice or bill (technical names; links by id, decimals as text). Give the record's updatedAt as read to refuse the change if it changed since. States change only through their own tools.",
        verb: "update",
        // R5: the before state is written back with this tool, if the record hasn't changed since.
        undo: { kind: "restore" },
        summary: "Updated {{model}} {{id}}",
        input: z.object({
          model: OdooWritableModel,
          id: RecordId,
          values: Values,
          /** The record's `updatedAt` when the agent read it. */
          expectedUpdatedAt: z.string().max(40).optional(),
        }),
        output: z.object({
          model: OdooWritableModel,
          id: z.number().int(),
          updatedAt: z.string().nullable(),
          alreadyDone: z.boolean(),
        }),
        // What the change replaces: the record's current values of the fields it sets.
        beforeSchema: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          updatedAt: z.string().nullable(),
          values: z.record(z.string(), OdooValue),
        }),
        // R5: the fields it set go back to their values before, guarded by the record's
        // `updatedAt` now (the undo runs only when nobody changed it since our write).
        undoInput: ({ input, before, current }) => {
          if (!before || !current) return null;
          const values: Record<string, Scalar> = {};
          for (const k of Object.keys(input.values)) {
            const v = restoreValue(before.values[k] ?? null);
            if (v === undefined) return null;
            values[k] = v;
          }
          return {
            model: input.model,
            id: input.id,
            values,
            ...(current.updatedAt === null ? {} : { expectedUpdatedAt: current.updatedAt }),
          };
        },
        async before(input, ctx) {
          const s = session(ctx);
          const fields = await s.fields(input.model);
          const asked = Object.keys(input.values).filter((k) => fields[k]);
          const current = await getRecord(s, input.model, input.id, asked);
          if (!current) return null;
          return {
            id: current.id,
            name: current.name,
            updatedAt: current.updatedAt,
            values: Object.fromEntries(
              Object.keys(input.values).map((k) => [k, current.fields[k] ?? null]),
            ),
          };
        },
        async run(input, ctx, before) {
          if (!before) throw notFound(input.model, input.id);
          const s = session(ctx);
          const values = await wireValues(s, input.model, input.values);
          // Already as asked (a retry after a lost answer, or nothing to change): no write.
          if (Object.entries(input.values).every(([k, v]) => sameValue(before.values[k], v))) {
            return {
              model: input.model,
              id: before.id,
              updatedAt: before.updatedAt,
              alreadyDone: true,
            };
          }
          if (
            input.expectedUpdatedAt !== undefined &&
            before.updatedAt !== null &&
            before.updatedAt !== input.expectedUpdatedAt
          ) {
            throw new OdooApiError(
              409,
              "STALE",
              `${input.model} ${input.id} changed since it was read`,
              "conflict",
              false,
            );
          }
          const note: WriteNote = {
            title: `${input.model} ${input.id} may have been changed in Odoo`,
            details: { model: input.model, id: String(input.id) },
          };
          writeAnswer(
            z.literal(true),
            await s.c.execute(input.model, "write", [[input.id], values], {}, note),
            note,
          );
          const after = await getRecord(s, input.model, input.id);
          return {
            model: input.model,
            id: input.id,
            updatedAt: after?.updatedAt ?? null,
            alreadyDone: false,
          };
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.confirmOrder,
        entityInput: ORDER_ENTITY_INPUT,
        description:
          "Confirm an Odoo quotation (sale.order) into a sales order, or a request for quotation (purchase.order) into a purchase order. Give the total and currency as read: a different total in Odoo refuses it.",
        verb: "update",
        // R5: cancelling a confirmed order is a person's call in Odoo, not an undo.
        undo: { kind: "none" },
        summary: "Confirmed {{model}} {{name}}",
        amount: { path: "expectedTotal", currencyPath: "currency" },
        input: z.object({
          model: OrderModel,
          id: RecordId,
          expectedTotal: DecimalString,
          currency: CurrencyCode,
        }),
        output: z.object({
          model: OrderModel,
          id: z.number().int(),
          name: z.string().nullable(),
          state: z.string(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          state: z.string().nullable(),
          partner: z.string().nullable(),
          total: z.string().nullable(),
          currency: z.string().nullable(),
        }),
        async before(input, ctx) {
          const r = await getRecord(session(ctx), input.model, input.id);
          return r ? orderState(r) : null;
        },
        async run(input, ctx, before) {
          if (!before) throw notFound(input.model, input.id);
          const rule = CONFIRM[input.model];
          const done = (state: string, alreadyDone: boolean) => ({
            model: input.model,
            id: input.id,
            name: before.name,
            state,
            alreadyDone,
          });
          if (before.state && rule.done.includes(before.state)) return done(before.state, true);
          if (!before.state || !rule.open.includes(before.state)) {
            throw refuse(
              `${before.name ?? input.id} is ${before.state ?? "in no state"} in Odoo, so it can't be confirmed`,
            );
          }
          checkTotal(before, input);
          const s = session(ctx);
          const note: WriteNote = {
            title: `${before.name ?? `${input.model} ${input.id}`} may have been confirmed in Odoo`,
            details: { model: input.model, id: String(input.id) },
          };
          await s.c.execute(input.model, rule.method, [[input.id]], {}, note);
          const after = await getRecord(s, input.model, input.id);
          const state = after ? (orderState(after).state ?? "unknown") : "unknown";
          if (!rule.done.includes(state) && state !== "to approve") {
            throw new OdooApiError(
              200,
              "NOT_CONFIRMED",
              `Odoo didn't confirm ${before.name ?? input.id}: it is ${state}`,
              "refused",
              false,
            );
          }
          return done(state, false);
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.postInvoice,
        entity: "invoice",
        description:
          "Post a draft Odoo invoice or bill (account.move), which gives it its number and puts it in the books. Give the total and currency as read: a different total in Odoo refuses it.",
        verb: "update",
        // R5: resetting a posted entry to draft is a person's call in Odoo, not an undo.
        undo: { kind: "none" },
        summary: "Posted {{name}}",
        amount: { path: "expectedTotal", currencyPath: "currency" },
        input: z.object({ id: RecordId, expectedTotal: DecimalString, currency: CurrencyCode }),
        output: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          state: z.string(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          kind: z.string().nullable(),
          state: z.string().nullable(),
          partner: z.string().nullable(),
          total: z.string().nullable(),
          currency: z.string().nullable(),
        }),
        async before(input, ctx) {
          const r = await getRecord(session(ctx), "account.move", input.id);
          if (!r) return null;
          return {
            ...orderState(r),
            kind: typeof r.fields.move_type === "string" ? r.fields.move_type : null,
          };
        },
        async run(input, ctx, before) {
          if (!before) throw notFound("account.move", input.id);
          if (before.state === "posted") {
            return { id: input.id, name: before.name, state: "posted", alreadyDone: true };
          }
          if (before.state !== "draft") {
            throw refuse(
              `${before.name ?? input.id} is ${before.state ?? "in no state"} in Odoo, so it can't be posted`,
            );
          }
          checkTotal(before, input);
          const s = session(ctx);
          const note: WriteNote = {
            title: `Invoice or bill ${input.id} may have been posted in Odoo`,
            details: { id: String(input.id) },
          };
          await s.c.execute("account.move", "action_post", [[input.id]], {}, note);
          const after = await getRecord(s, "account.move", input.id);
          const state = after ? (orderState(after).state ?? "unknown") : "unknown";
          if (state !== "posted") {
            throw new OdooApiError(
              200,
              "NOT_POSTED",
              `Odoo didn't post ${input.id}: it is ${state}`,
              "refused",
              false,
            );
          }
          return { id: input.id, name: after?.name ?? before.name, state, alreadyDone: false };
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.validateReceipt,
        entity: "transfer",
        description:
          "Validate an Odoo receipt (an incoming stock.picking) with the quantities already set on it, which puts the goods in stock. A receipt Odoo wants a person to decide on (a backorder, quantities not set) is refused.",
        verb: "update",
        // R5: a validated receipt is returned in Odoo, by a person, not undone.
        undo: { kind: "none" },
        summary: "Validated {{name}}",
        input: z.object({ id: RecordId }),
        output: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          state: z.string(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({
          id: z.number().int(),
          name: z.string().nullable(),
          kind: z.string().nullable(),
          state: z.string().nullable(),
          partner: z.string().nullable(),
          origin: z.string().nullable(),
          moves: z.array(
            z.object({
              product: z.string().nullable(),
              demand: z.string().nullable(),
              quantity: z.string().nullable(),
            }),
          ),
        }),
        async before(input, ctx) {
          const s = session(ctx);
          const r = await getRecord(s, "stock.picking", input.id);
          if (!r) return null;
          const mf = await s.fields("stock.move");
          const qty = mf.quantity ? "quantity" : "quantity_done";
          const raw = await s.c.execute(
            "stock.move",
            "search_read",
            [[["picking_id", "=", input.id]]],
            {
              fields: ["product_id", "product_uom_qty", qty].filter((f) => mf[f]),
              limit: 200,
              order: "id asc",
            },
          );
          const moves = z
            .array(z.unknown())
            .parse(raw)
            .map((m) => mapOdooRecord("stock.picking", m, mf).fields)
            .map((f) => ({
              product: linkName(f.product_id),
              demand: typeof f.product_uom_qty === "string" ? f.product_uom_qty : null,
              quantity: typeof f[qty] === "string" ? (f[qty] as string) : null,
            }));
          const text = (v: OdooValueType | undefined) => (typeof v === "string" ? v : null);
          return {
            id: r.id,
            name: r.name,
            kind: text(r.fields.picking_type_code),
            state: text(r.fields.state),
            partner: linkName(r.fields.partner_id),
            origin: text(r.fields.origin),
            moves,
          };
        },
        async run(input, ctx, before) {
          if (!before) throw notFound("stock.picking", input.id);
          const done = (state: string, alreadyDone: boolean) => ({
            id: input.id,
            name: before.name,
            state,
            alreadyDone,
          });
          if (before.state === "done") return done("done", true);
          if (before.kind !== "incoming") {
            throw refuse(
              `${before.name ?? input.id} isn't a receipt: only receipts are validated here`,
            );
          }
          if (before.state === "cancel" || before.state === "draft") {
            throw refuse(
              `${before.name ?? input.id} is ${before.state} in Odoo, so it can't be validated`,
            );
          }
          const s = session(ctx);
          const note: WriteNote = {
            title: `Receipt ${before.name ?? input.id} may have been validated in Odoo`,
            details: { id: String(input.id) },
          };
          const answer = await s.c.execute(
            "stock.picking",
            "button_validate",
            [[input.id]],
            {},
            note,
          );
          const after = await getRecord(s, "stock.picking", input.id);
          const state = typeof after?.fields.state === "string" ? after.fields.state : "unknown";
          if (state === "done") return done(state, false);
          // Odoo answered with a wizard (a backorder or quantities to confirm): a person decides.
          const wizard =
            answer && typeof answer === "object" && "res_model" in answer
              ? String((answer as { res_model: unknown }).res_model)
              : null;
          throw new OdooApiError(
            200,
            "NEEDS_A_PERSON",
            wizard
              ? `Odoo wants a person to decide before ${before.name ?? input.id} is validated (${wizard}): open it in Odoo`
              : `Odoo didn't validate ${before.name ?? input.id}: it is ${state}`,
            "refused",
            false,
          );
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.note,
        entity: "note",
        description:
          "Log an internal note in the chatter of an Odoo lead, contact, order, invoice, bill or transfer. Internal: followers aren't sent it.",
        verb: "create",
        // R5: no delete, and delete stays off.
        undo: { kind: "none" },
        summary: "Logged a note on {{model}} {{recordId}}",
        input: z.object({ model: OdooModel, recordId: RecordId, text: NoteText }),
        output: z.object({
          model: OdooModel,
          recordId: z.number().int(),
          id: z.number().int(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({
          record: z.object({ model: OdooModel, id: z.number().int(), name: z.string().nullable() }),
        }),
        async before(input, ctx) {
          if (input.model === "stock.quant" || input.model === "product.product") {
            throw refuse(
              `notes go on leads, contacts, orders, invoices, bills and transfers, not ${input.model}`,
            );
          }
          const r = await getRecord(session(ctx), input.model, input.recordId);
          return r ? { record: { model: r.model, id: r.id, name: r.name } } : null;
        },
        async run(input, ctx, before) {
          if (!before) throw notFound(input.model, input.recordId);
          const s = session(ctx);
          const uid = await s.c.uid();
          const done = (id: number, alreadyDone: boolean) => ({
            model: input.model,
            recordId: input.recordId,
            id,
            alreadyDone,
          });
          // DECISION: the same note on the same record by our Odoo user within a day is this
          // action's own earlier write (Odoo takes no idempotency key): reported done, not logged
          // again.
          const since = odooDatetime(new Date(ctx.now().getTime() - TWIN_WINDOW_MS));
          const found = z
            .array(z.looseObject({ id: RecordId, body: z.union([z.string(), z.literal(false)]) }))
            .parse(
              await s.c.execute(
                "mail.message",
                "search_read",
                [
                  [
                    ["model", "=", input.model],
                    ["res_id", "=", input.recordId],
                    ["create_uid", "=", uid],
                    ["create_date", ">=", since],
                    ["message_type", "=", "comment"],
                  ],
                ],
                { fields: ["body"], limit: 50, order: "id desc" },
              ),
            );
          const want = input.text
            .replace(/[ \t]+/g, " ")
            .replace(/\s*\n\s*/g, "\n")
            .trim();
          const twin = found.find((m) => typeof m.body === "string" && plainText(m.body) === want);
          if (twin) return done(twin.id, true);
          const note: WriteNote = {
            title: `A note may have been logged on ${input.model} ${input.recordId} in Odoo`,
            details: { model: input.model, id: String(input.recordId) },
          };
          // UNCHECKED (NOTES.md): Odoo escapes a plain-text body over RPC from 17 on; older
          // versions sanitize it as HTML. Either way markup in the text doesn't run.
          const out = writeAnswer(
            z.union([RecordId, z.array(RecordId).length(1)]),
            await s.c.execute(
              input.model,
              "message_post",
              [[input.recordId]],
              { body: input.text, message_type: "comment", subtype_xmlid: "mail.mt_note" },
              note,
            ),
            note,
          );
          return done(Array.isArray(out) ? (out[0] as number) : out, false);
        },
      }),
      defineWriteTool({
        id: ODOO_TOOLS.activity,
        entity: "activity",
        description:
          "Schedule an activity (a to-do with a due date) on an Odoo lead, contact, order, invoice, bill or transfer, for our Odoo user or the user given.",
        verb: "create",
        // R5: no delete, and delete stays off.
        undo: { kind: "none" },
        summary: "Scheduled an activity on {{model}} {{recordId}}",
        input: z.object({
          model: OdooModel,
          recordId: RecordId,
          summary: z.string().trim().min(1).max(255),
          note: z.string().trim().max(10_000).optional(),
          dueDate: z.iso.date(),
          /** The Odoo user it is for; our user when left out. */
          userId: RecordId.optional(),
          /** An activity type's id (mail.activity.type); Odoo's default (a to-do) when left out. */
          activityTypeId: RecordId.optional(),
        }),
        output: z.object({ id: z.number().int(), alreadyDone: z.boolean() }),
        beforeSchema: z.object({
          record: z.object({ model: OdooModel, id: z.number().int(), name: z.string().nullable() }),
        }),
        async before(input, ctx) {
          if (input.model === "stock.quant" || input.model === "product.product") {
            throw refuse(
              `activities go on leads, contacts, orders, invoices, bills and transfers, not ${input.model}`,
            );
          }
          const r = await getRecord(session(ctx), input.model, input.recordId);
          return r ? { record: { model: r.model, id: r.id, name: r.name } } : null;
        },
        async run(input, ctx, before) {
          if (!before) throw notFound(input.model, input.recordId);
          const s = session(ctx);
          const uid = await s.c.uid();
          // As notes: the same activity on the same record by our user within a day is ours.
          const since = odooDatetime(new Date(ctx.now().getTime() - TWIN_WINDOW_MS));
          const twin = z.array(RecordId).parse(
            await s.c.execute(
              "mail.activity",
              "search",
              [
                [
                  ["res_model", "=", input.model],
                  ["res_id", "=", input.recordId],
                  ["summary", "=", input.summary],
                  ["date_deadline", "=", input.dueDate],
                  ["create_uid", "=", uid],
                  ["create_date", ">=", since],
                ],
              ],
              { limit: 1 },
            ),
          )[0];
          if (twin !== undefined) return { id: twin, alreadyDone: true };
          const modelId = z.array(RecordId).parse(
            await s.c.execute("ir.model", "search", [[["model", "=", input.model]]], {
              limit: 1,
            }),
          )[0];
          if (modelId === undefined) throw refuse(`this Odoo has no ${input.model}`);
          const note: WriteNote = {
            title: `An activity may have been scheduled on ${input.model} ${input.recordId} in Odoo`,
            details: { model: input.model, id: String(input.recordId) },
          };
          const out = writeAnswer(
            z.union([RecordId, z.array(RecordId).length(1)]),
            await s.c.execute(
              "mail.activity",
              "create",
              [
                {
                  res_model_id: modelId,
                  res_id: input.recordId,
                  summary: input.summary,
                  date_deadline: input.dueDate,
                  user_id: input.userId ?? uid,
                  ...(input.note ? { note: input.note } : {}),
                  ...(input.activityTypeId ? { activity_type_id: input.activityTypeId } : {}),
                },
              ],
              {},
              note,
            ),
            note,
          );
          return { id: Array.isArray(out) ? (out[0] as number) : out, alreadyDone: false };
        },
      }),
    ],
  });
}

function linkName(v: OdooValueType | undefined): string | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v.name : null;
}

/** What names an order or an invoice on its approval card, and its total. */
function orderState(r: OdooRecord) {
  const f = r.fields;
  return {
    id: r.id,
    name: typeof f.name === "string" ? f.name : r.name,
    state: typeof f.state === "string" ? f.state : null,
    partner: linkName(f.partner_id),
    total: typeof f.amount_total === "string" ? f.amount_total : null,
    currency: linkName(f.currency_id),
  };
}

/** Refuses a confirm or a post whose total or currency in Odoo isn't the one the person saw. */
function checkTotal(
  before: { name: string | null; total: string | null; currency: string | null },
  input: { id: number; expectedTotal: string; currency: string },
): void {
  if (before.total === null || !dec(before.total).eq(dec(input.expectedTotal))) {
    throw refuse(
      `${before.name ?? input.id} totals ${before.total ?? "nothing"} in Odoo, not ${input.expectedTotal}: read it again`,
    );
  }
  if (before.currency !== null && before.currency.toUpperCase() !== input.currency) {
    throw refuse(`${before.name ?? input.id} is in ${before.currency}, not ${input.currency}`);
  }
}
