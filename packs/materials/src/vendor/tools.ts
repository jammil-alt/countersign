// The vendor catalog's tools (docs/plan.md §1.88). Reads (`none`) for each step of the matching
// pipeline and for the catalog's screens; Save to records (`internal`) for every change, so a skill
// never writes (the skill model, ARCHITECTURE §10.14). The tools that embed text call the model
// transport and say so (`usesModel`), and make each embedding between transactions.

import { type Db, vendor, withTenant } from "@countersign/db";
import { EMBED_BATCH_MAX, EMBEDDING_DIMENSIONS } from "@countersign/llm";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { catalogItem, VENDOR_ITEM_STATUSES, vendorItem } from "../schema";
import { Answer, Checked, LookedUp, Open } from "../split";
import { defineTool, type PackTool, type PackToolContext } from "../tools";
import {
  embeddedText,
  itemsToEmbed,
  lineText,
  lookupBySku,
  masterCandidates,
  matchVendor,
  newToVendorLines,
  registerLines,
  similarForOpenLines,
  VENDOR_METHODS,
  VendorMatchError,
  vendorAbbreviations,
  vendorItemText,
} from "./pipeline";
import {
  cleanSku,
  createVendorItem,
  discontinue,
  setPreferred,
  updateVendorItem,
  VendorItemError,
  vendorCatalog,
  vendorItemById,
  vendorItemBySku,
  vendorItemView,
  vendorsForItem,
} from "./store";

const Uuid = z.uuid();
const Decimal = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "a decimal string, e.g. 12.5000");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");

/** `min_name_similarity` from the step's parameters: 1 (exact names only) unless set lower. */
export function nameSimilarityFrom(settings: Readonly<Record<string, unknown>>): number {
  const v = Number(settings.min_name_similarity);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
}

/**
 * Embeds texts on the step's model transport, a batch at a time, between transactions. Without
 * a transport (none configured) it answers no vectors, and the searches fall back to names.
 */
// DECISION: no transport means no vectors, never a failure: the name search (trigrams) still
// offers candidates, and the model and the hard rules still decide.
export async function embedTexts(
  ctx: PackToolContext,
  texts: readonly string[],
  label: string,
): Promise<(number[] | null)[]> {
  if (texts.length === 0 || !ctx.llm) return texts.map(() => null);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_MAX) {
    const r = await ctx.llm.embed({ texts: texts.slice(i, i + EMBED_BATCH_MAX), label });
    out.push(...r.embeddings);
  }
  return out;
}

const VendorMatchOut = z.object({
  matched: z.boolean(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  method: z.enum(VENDOR_METHODS).nullable(),
  read: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    taxId: z.string().nullable(),
  }),
  candidates: z.array(z.object({ vendorId: z.string(), name: z.string(), similarity: z.number() })),
  sources: z.array(z.string()),
});

/** Step 1: Match vendor. */
export const vendorMatch = defineTool({
  id: "materials.vendor.match",
  description:
    "Finds the client's vendor for a document, or for a name, email or tax id: the vendor id given, the document's purchase, the tax id, the sender's email domain, then the vendor's name or one of its known names. Writes nothing.",
  sideEffect: "none",
  summary: "Vendor: {{vendorName}}",
  input: z
    .object({
      documentId: Uuid.optional(),
      vendorId: Uuid.optional(),
      name: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
      taxId: z.string().max(50).optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined && x !== ""), {
      message: "give a document, a vendor id, a name, an email or a tax id",
    }),
  output: VendorMatchOut,
  async run(input, ctx) {
    const m = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      matchVendor(tx, ctx.tenantId, input, nameSimilarityFrom(ctx.settings)),
    );
    return {
      ...m,
      sources: [
        ...(input.documentId ? [input.documentId] : []),
        ...(m.vendorId ? [m.vendorId] : []),
      ],
    };
  },
});

const KnownOut = z.object({
  lineNo: z.number().int(),
  docLineId: z.string(),
  vendorItemId: z.string().nullable(),
  catalogItemId: z.string(),
  via: z.enum(["sku", "sku_alias", "wording"]),
});

/** Step 2: Match by SKU (vendor). */
export const vendorItemsLookup = defineTool({
  id: "materials.vendor_items.lookup",
  description:
    "Looks up each line of a document's latest reading in this vendor's catalog: the vendor's item with the line's SKU, then a SKU or wording this vendor used before. A hit gives the master item; no other vendor is searched. Every other line comes back open. Writes nothing.",
  sideEffect: "none",
  summary: "{{known.length}} lines known to this vendor; {{openCount}} open",
  input: z.object({ documentId: Uuid, vendorId: Uuid }),
  output: z.object({
    documentId: z.string(),
    vendorId: z.string(),
    lines: z.array(LookedUp),
    known: z.array(KnownOut),
    openCount: z.number().int(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await withTenant(ctx.db, ctx.tenantId, (tx) => lookupBySku(tx, ctx.tenantId, input));
    return {
      ...r,
      sources: [
        input.documentId,
        ...r.known.flatMap((k) => [k.docLineId, ...(k.vendorItemId ? [k.vendorItemId] : [])]),
      ],
    };
  },
});

export const VendorOpen = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  category: Open.shape.category,
  attributes: z.record(z.string(), z.string()),
  missing: z.array(z.string()),
  candidates: z.array(
    z.object({
      vendorItemId: z.string(),
      catalogItemId: z.string(),
      name: z.string(),
      sku: z.string().nullable(),
      masterName: z.string(),
      attributes: z.record(z.string(), z.string()),
    }),
  ),
});

/** Step 3's read: this vendor's items closest to each open line. */
export const vendorItemsSimilar = defineTool({
  id: "materials.vendor_items.similar",
  usesModel:
    "embeds each open line's description to search this vendor's items by meaning (OpenAI embeddings)",
  description:
    "For each open line, this vendor's closest items (by meaning, then by name), one per master item, scored by the category's key attributes. One with every key attribute equal settles the line; none that could be it makes the line new to this vendor; the rest stay open for Semantic match. Writes nothing.",
  sideEffect: "none",
  summary: "{{openCount}} lines for the semantic match",
  input: z.object({
    vendorId: Uuid,
    lines: z.array(LookedUp).max(500),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  output: z.object({
    lines: z.array(LookedUp),
    open: z.array(VendorOpen),
    openCount: z.number().int(),
    settled: z.array(
      z.object({ lineNo: z.number().int(), decision: z.enum(["matched", "new_item"]) }),
    ),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const lines = input.lines as Parameters<typeof similarForOpenLines>[2]["lines"];
    const abbreviations = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      vendorAbbreviations(tx, ctx.tenantId, input.vendorId),
    );
    const open = lines.filter((l) => l.decision === "open");
    // Known lines are never embedded: only the open ones are searched by meaning.
    const vectors = await embedTexts(
      ctx,
      open.map((l) => lineText(l.description, abbreviations)),
      "materials.vendor_items.similar",
    );
    const r = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      similarForOpenLines(tx, ctx.tenantId, {
        vendorId: input.vendorId,
        lines,
        vectors,
        abbreviations,
        limit: input.limit,
      }),
    );
    return {
      ...r,
      sources: [input.vendorId, ...r.open.flatMap((o) => o.candidates.map((c) => c.vendorItemId))],
    };
  },
});

/** Step 4's read: the client's master items closest to each line new to its vendor. */
export const masterItemsCandidates = defineTool({
  id: "materials.master_items.candidates",
  usesModel:
    "embeds each line new to its vendor to search the client's master items by meaning (OpenAI embeddings)",
  description:
    "For each line Check matches found new to its vendor, the client's master items it could be: equal key attributes, close names, then close meaning, in its category. One equal item links it; none that could be it, with every required attribute stated, makes a new master item; the rest are for the Master item manager. Writes nothing.",
  sideEffect: "none",
  summary: "{{newCount}} lines new to this vendor; {{openCount}} for the master item manager",
  input: z.object({
    vendorId: Uuid,
    lines: z.array(Checked).max(500),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  output: z.object({
    lines: z.array(LookedUp),
    open: z.array(Open),
    openCount: z.number().int(),
    newCount: z.number().int(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const lines = input.lines as Parameters<typeof newToVendorLines>[2];
    const fresh = await withTenant(ctx.db, ctx.tenantId, async (tx) =>
      newToVendorLines(
        tx,
        ctx.tenantId,
        lines,
        await vendorAbbreviations(tx, ctx.tenantId, input.vendorId),
      ),
    );
    const vectors = await embedTexts(
      ctx,
      fresh.map((l) => l.text),
      "materials.master_items.candidates",
    );
    const r = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      masterCandidates(tx, ctx.tenantId, fresh, vectors, input.limit),
    );
    return {
      ...r,
      newCount: fresh.length,
      sources: r.lines.flatMap((l) => [l.docLineId, ...l.candidates.map((c) => c.catalogItemId)]),
    };
  },
});

const PersonAnswerIn = z.object({
  lineNo: z.number().int().positive(),
  catalogItemId: Uuid.nullable().optional(),
  newItem: z.boolean().optional(),
});

const RegisteredOut = z.object({
  lineNo: z.number().int(),
  docLineId: z.string(),
  decision: z.enum(["matched", "new_item", "unsure"]),
  catalogItemId: z.string().nullable(),
  vendorItemId: z.string().nullable(),
  createdItem: z.boolean(),
  createdVendorItem: z.boolean(),
  observationId: z.string().nullable(),
  recorded: z.boolean(),
  priceSkipped: z.string().nullable(),
});

const NeedsPersonOut = z.object({
  lineNo: z.number().int(),
  docLineId: z.string(),
  description: z.string(),
  sku: z.string().nullable(),
  reason: z.string(),
  candidates: z.array(
    z.object({ catalogItemId: z.string(), name: z.string(), vetoed: z.boolean() }),
  ),
});

/** Step 5 (and 6's answer): Save to records: register the items. */
export const vendorItemsRegister = defineTool({
  id: "materials.vendor_items.register",
  description:
    "Registers a document's decided lines: each line's match, the vendor's item (made when new), its SKU and wording, a new master item when the line is new everywhere, and the price, which becomes the vendor item's last price unless a newer one is kept. Lines nobody is sure of are listed for a person. Given a person's answers (each line's master item, or a new one) it registers them as theirs, so the vendor's wording is known next time. A line registered before is left as it is.",
  sideEffect: "internal",
  summary: "Registered {{registered}} lines; {{needsPersonCount}} for a person",
  input: z.object({
    documentId: Uuid,
    vendorId: Uuid,
    lines: z.array(Checked).max(500).optional(),
    resolved: z.array(Checked).max(500).optional(),
    hints: z
      .array(z.object({ lineNo: z.number().int(), vendorItemId: Uuid.nullable().optional() }))
      .max(500)
      .optional(),
    answers: z.array(PersonAnswerIn).max(500).optional(),
    decidedBy: Uuid.nullable().optional(),
  }),
  output: z.object({
    registered: z.number().int(),
    newMasterItems: z.number().int(),
    newVendorItems: z.number().int(),
    lines: z.array(RegisteredOut),
    needsPerson: z.array(NeedsPersonOut),
    needsPersonCount: z.number().int(),
    anyNeedsPerson: z.boolean(),
    catalogItemIds: z.array(z.string()),
    vendorItemIds: z.array(z.string()),
    testRun: z.boolean(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await registerLines(ctx.db, {
      tenantId: ctx.tenantId,
      agentVersionId: ctx.agentVersionId,
      documentId: input.documentId,
      vendorId: input.vendorId,
      lines: input.lines as never,
      resolved: input.resolved as never,
      vendorItemHints: input.hints,
      answers: input.answers,
      decidedBy: input.decidedBy,
      testRun: ctx.mode === "test",
    });
    return {
      ...r,
      registered: r.lines.filter((l) => l.recorded).length,
      newMasterItems: r.catalogItemIds.length,
      newVendorItems: r.vendorItemIds.length,
      needsPersonCount: r.needsPerson.length,
      anyNeedsPerson: r.needsPerson.length > 0,
      sources: [
        input.documentId,
        ...r.lines.flatMap((l) => [
          l.docLineId,
          ...(l.catalogItemId ? [l.catalogItemId] : []),
          ...(l.vendorItemId ? [l.vendorItemId] : []),
          ...(l.observationId ? [l.observationId] : []),
        ]),
      ],
    };
  },
});

const VendorItemOut = z.object({
  id: z.string(),
  vendorId: z.string(),
  catalogItemId: z.string(),
  catalogItemName: z.string().nullable(),
  category: z.string().nullable(),
  standardUom: z.string().nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  packSize: z.string().nullable(),
  vendorUom: z.string().nullable(),
  stdPerVendorUom: z.string().nullable(),
  minOrderQty: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  listPrice: z.string().nullable(),
  listPriceOn: z.string().nullable(),
  lastPrice: z.string().nullable(),
  lastPriceStd: z.string().nullable(),
  lastPriceOn: z.string().nullable(),
  lastPriceSource: z.string().nullable(),
  lastPriceSourceId: z.string().nullable(),
  currency: z.string(),
  preferred: z.boolean(),
  status: z.enum(VENDOR_ITEM_STATUSES),
});

/** One vendor's catalog. */
export const vendorItemsList = defineTool({
  id: "materials.vendor_items.list",
  description:
    "One vendor's catalog for this client: every item it sells, with its SKU, the vendor's name for it, pack and unit, the master item, the last price and its date, the list price, and whether it is preferred.",
  sideEffect: "none",
  summary: "{{items.length}} items from {{vendor.name}}",
  input: z.object({
    vendorId: Uuid,
    includeDiscontinued: z.boolean().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  output: z.object({
    vendor: z.object({ id: z.string(), name: z.string() }),
    items: z.array(VendorItemOut),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const [v] = await tx
        .select({ id: vendor.id, name: vendor.name })
        .from(vendor)
        .where(and(eq(vendor.id, input.vendorId), eq(vendor.tenantId, ctx.tenantId)))
        .limit(1);
      if (!v) throw new VendorItemError("not_found", `vendor ${input.vendorId} not found`);
      const items = await vendorCatalog(tx, ctx.tenantId, input.vendorId, input);
      return { vendor: v, items, sources: [v.id, ...items.map((i) => i.id)] };
    }),
});

/** Every vendor's version of one master item, side by side. */
export const vendorItemsForItem = defineTool({
  id: "materials.vendor_items.for_item",
  description:
    "Every vendor's version of one master item, side by side: each vendor's SKU, pack and unit, and its last price per the item's standard unit, the preferred vendor first, then the cheapest. A price with no conversion to the standard unit is listed last and never compared.",
  sideEffect: "none",
  summary: "{{vendors.length}} vendors sell {{item.name}}",
  input: z.object({ catalogItemId: Uuid, includeDiscontinued: z.boolean().optional() }),
  output: z.object({
    item: z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      standardUom: z.string(),
      attributes: z.record(z.string(), z.string()),
    }),
    vendors: z.array(VendorItemOut.extend({ vendorName: z.string() })),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      vendorsForItem(tx, ctx.tenantId, input.catalogItemId, input),
    );
    return { ...r, sources: [r.item.id, ...r.vendors.map((v) => v.id)] };
  },
});

/** Save to records: a vendor item, made or changed. */
export const vendorItemUpsert = defineTool({
  id: "materials.vendor_item.upsert",
  description:
    "Adds an item to a vendor's catalog, or changes one (by its id, or the vendor's SKU): the master item it is, the vendor's name and description, pack and unit with how many standard units one unit is, the minimum order, the lead time and the list price. Only the fields given change.",
  sideEffect: "internal",
  summary: "Saved {{item.name}} in the vendor's catalog",
  input: z.object({
    id: Uuid.optional(),
    vendorId: Uuid,
    catalogItemId: Uuid.optional(),
    sku: z.string().min(1).max(100).nullable().optional(),
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(2000).nullable().optional(),
    packSize: z.string().max(100).nullable().optional(),
    vendorUom: z.string().max(40).nullable().optional(),
    stdPerVendorUom: Decimal.nullable().optional(),
    minOrderQty: Decimal.nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
    listPrice: Decimal.nullable().optional(),
    listPriceOn: Day.nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  }),
  output: z.object({ item: VendorItemOut, created: z.boolean(), sources: z.array(z.string()) }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      if (input.listPrice && !input.listPriceOn) {
        throw new VendorItemError("bad_input", "a list price needs its date (listPriceOn)");
      }
      if (input.catalogItemId) {
        const [m] = await tx
          .select({ id: catalogItem.id, merged: catalogItem.mergedIntoId })
          .from(catalogItem)
          .where(
            and(eq(catalogItem.id, input.catalogItemId), eq(catalogItem.tenantId, ctx.tenantId)),
          )
          .limit(1);
        if (!m)
          throw new VendorItemError("not_found", `catalog item ${input.catalogItemId} not found`);
        if (m.merged)
          throw new VendorItemError("conflict", "that catalog item was merged into another");
      }
      const sku = input.sku === undefined ? undefined : cleanSku(input.sku);
      const existing = input.id
        ? await vendorItemById(tx, ctx.tenantId, input.id)
        : sku
          ? await vendorItemBySku(tx, ctx.tenantId, input.vendorId, sku)
          : null;
      if (input.id && !existing)
        throw new VendorItemError("not_found", `vendor item ${input.id} not found`);
      if (existing && existing.vendorId !== input.vendorId) {
        throw new VendorItemError("conflict", "that vendor item is another vendor's");
      }
      const { id: _id, vendorId: _vendorId, ...fields } = input;
      if (existing) {
        const item = await updateVendorItem(tx, ctx.tenantId, existing.id, { ...fields, sku });
        return { item: vendorItemView(item), created: false, sources: [item.id] };
      }
      if (!input.catalogItemId || !input.name) {
        throw new VendorItemError("bad_input", "a new vendor item needs its master item and name");
      }
      const made = await createVendorItem(
        tx,
        ctx.tenantId,
        {
          ...fields,
          vendorId: input.vendorId,
          catalogItemId: input.catalogItemId,
          name: input.name,
          sku,
        },
        { agentVersionId: ctx.agentVersionId },
      );
      return { item: vendorItemView(made.item), created: made.created, sources: [made.item.id] };
    }),
});

/** Save to records: the client's first choice for a master item. */
export const vendorItemSetPreferred = defineTool({
  id: "materials.vendor_item.set_preferred",
  description:
    "Marks a vendor item as the client's first choice for its master item; the item another vendor was preferred for loses it.",
  sideEffect: "internal",
  verb: "update",
  summary: "{{item.name}} is now preferred",
  input: z.object({ vendorItemId: Uuid }),
  output: z.object({
    item: VendorItemOut,
    cleared: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const r = await setPreferred(tx, ctx.tenantId, input.vendorItemId);
      return {
        item: vendorItemView(r.item),
        cleared: r.cleared,
        sources: [r.item.id, ...r.cleared],
      };
    }),
});

/** Save to records: the vendor no longer sells it. */
export const vendorItemDiscontinue = defineTool({
  id: "materials.vendor_item.discontinue",
  description:
    "Marks a vendor item discontinued (the vendor no longer sells it): it leaves the vendor's catalog and its semantic search, and stops being preferred. Its prices are kept.",
  sideEffect: "internal",
  verb: "update",
  summary: "{{item.name}} discontinued",
  input: z.object({ vendorItemId: Uuid }),
  output: z.object({ item: VendorItemOut, sources: z.array(z.string()) }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const item = await discontinue(tx, ctx.tenantId, input.vendorItemId);
      return { item: vendorItemView(item), sources: [item.id] };
    }),
});

/** Save to records: embeddings for master items and vendor items. */
export const embeddingsWrite = defineTool({
  id: "materials.embeddings.write",
  usesModel:
    "embeds master items' and vendor items' names for the search by meaning (OpenAI embeddings)",
  description:
    "Makes the embeddings the semantic searches use, for the master items and vendor items given (those just registered), or for up to `missing` items that have none yet. An item already embedded from the same text is left as it is.",
  sideEffect: "internal",
  verb: "update",
  summary: "Embedded {{embedded}} items",
  input: z.object({
    catalogItemIds: z.array(Uuid).max(500).optional(),
    vendorItemIds: z.array(Uuid).max(500).optional(),
    missing: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    embedded: z.number().int(),
    catalogItems: z.number().int(),
    vendorItems: z.number().int(),
    left: z.number().int(),
    testRun: z.boolean(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    return writeEmbeddings(ctx, input);
  },
});

/** The embedding write, between transactions: read what needs one, embed, write each back. */
export async function writeEmbeddings(
  ctx: PackToolContext,
  input: {
    catalogItemIds?: string[] | undefined;
    vendorItemIds?: string[] | undefined;
    missing?: number | undefined;
  },
) {
  const byIds = input.catalogItemIds !== undefined || input.vendorItemIds !== undefined;
  const limit = input.missing ?? 500;
  const todo = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    const masters =
      input.catalogItemIds?.length || !byIds
        ? await itemsToEmbed(tx, ctx.tenantId, byIds ? (input.catalogItemIds ?? []) : null, limit)
        : [];
    const rows =
      input.vendorItemIds?.length || !byIds
        ? await tx
            .select({
              id: vendorItem.id,
              name: vendorItem.name,
              description: vendorItem.description,
              ext: vendorItem.ext,
              has: sql<boolean>`${vendorItem.embedding} is not null`,
            })
            .from(vendorItem)
            .where(
              and(
                eq(vendorItem.tenantId, ctx.tenantId),
                byIds
                  ? inArray(vendorItem.id, input.vendorItemIds ?? [])
                  : isNull(vendorItem.embedding),
              ),
            )
            .limit(limit)
        : [];
    const vendors = rows
      .map((r) => ({ id: r.id, text: vendorItemText(r), has: r.has, was: embeddedText(r.ext) }))
      .filter((r) => !r.has || r.was !== r.text)
      .map(({ id, text }) => ({ id, text }));
    return { masters, vendors };
  });
  const total = todo.masters.length + todo.vendors.length;
  // DECISION: a test run makes no embeddings (they cost, and the items it registered were rolled
  // back); it says how many it would have made.
  if (ctx.mode === "test" || total === 0 || !ctx.llm) {
    return {
      embedded: 0,
      catalogItems: 0,
      vendorItems: 0,
      left: total,
      testRun: ctx.mode === "test",
      sources: [],
    };
  }
  const texts = [...todo.masters.map((m) => m.text), ...todo.vendors.map((v) => v.text)];
  const vectors = await embedTexts(ctx, texts, "materials.embeddings.write");
  await withTenant(ctx.db, ctx.tenantId, async (tx) => {
    for (const [i, m] of todo.masters.entries()) {
      const v = vectors[i];
      if (!v || v.length !== EMBEDDING_DIMENSIONS) continue;
      await tx
        .update(catalogItem)
        .set({
          embedding: v,
          ext: sql`${catalogItem.ext} || ${JSON.stringify({ embedding: { text: m.text } })}::jsonb`,
        })
        .where(and(eq(catalogItem.id, m.id), eq(catalogItem.tenantId, ctx.tenantId)));
    }
    for (const [j, r] of todo.vendors.entries()) {
      const v = vectors[todo.masters.length + j];
      if (!v || v.length !== EMBEDDING_DIMENSIONS) continue;
      await tx
        .update(vendorItem)
        .set({
          embedding: v,
          ext: sql`${vendorItem.ext} || ${JSON.stringify({ embedding: { text: r.text } })}::jsonb`,
        })
        .where(and(eq(vendorItem.id, r.id), eq(vendorItem.tenantId, ctx.tenantId)));
    }
  });
  return {
    embedded: total,
    catalogItems: todo.masters.length,
    vendorItems: todo.vendors.length,
    left: 0,
    testRun: false,
    sources: [...todo.masters.map((m) => m.id), ...todo.vendors.map((v) => v.id)],
  };
}

export const VENDOR_TOOLS: readonly PackTool[] = [
  vendorMatch,
  vendorItemsLookup,
  vendorItemsSimilar,
  masterItemsCandidates,
  vendorItemsRegister,
  vendorItemsList,
  vendorItemsForItem,
  vendorItemUpsert,
  vendorItemSetPreferred,
  vendorItemDiscontinue,
  embeddingsWrite,
];

/** The vendor-level answer Semantic match (vendor) gives: Check matches' shape and the item. */
export const VendorAnswer = Answer.extend({ vendorItemId: z.string().nullable().optional() });

export type { Db };
export { VendorItemError, VendorMatchError };
