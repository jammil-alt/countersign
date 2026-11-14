// The matching pipeline that goes with the vendor catalog (docs/plan.md §1.88), the data half:
//
//   1 Match vendor (deterministic): the document's vendor by id, its purchase, tax id, the sender's
//     email domain, a known name.
//   2 Match by SKU (deterministic, at the vendor level): this vendor's vendor items by SKU, then a
//     wording (or SKU) alias this vendor used. A hit gives the master item through its link; no
//     other vendor is searched.
//   3 Semantic match (at the vendor level): this vendor's items closest to each open line (its
//     embedding, then its name), scored by the category's key attributes; the rules settle what
//     they can (one equal item: matched; none that could be it: new to this vendor), the model the
//     rest (Semantic match (vendor), an AI skill), then Check matches (the hard rules veto).
//   4 Master item manager: for a line new to this vendor only, the client's master items closest
//     to it (equal key attributes, then names, then embeddings), scored the same way; the rules
//     settle what they can, the model (Master item manager, an AI skill) the rest: link or create.
//     Check matches again.
//   5 Register item (Save to records): the match, the vendor item, its aliases, the new master item
//     when there is one, and the price (the vendor item's last price, the newer date winning).
//   6 Anything unsure goes to a person; their answer is registered as a person's (an alias), so the
//     next document from that vendor is caught at step 2.
//
// No model is called here: the tools (./tools.ts) make embeddings between transactions and hand
// the vectors in. Every read and write is inside one client's transaction (invariant 1).

import { dec, normalizeVendorName, toNumeric } from "@countersign/core";
import {
  type Db,
  docExtraction,
  docLine,
  document,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type ParsedLine, parseLine, parseNormalized, withCompleteness } from "../catalog/keys";
import { descriptionHash, normalize } from "../catalog/normalize";
import type { Attributes } from "../catalog/parsers";
import {
  type CandidateItem,
  type CheckedLine,
  decideByRules,
  type LookedUpLine,
  type OpenLine,
  openLines,
  withModelReading,
} from "../catalog/split";
import {
  type CatalogItemRow,
  createItem,
  findCandidates,
  latestMatch,
  learnAlias,
  liveItem,
  recordMatch,
} from "../catalog/store";
import { materialsEventRegistry } from "../events";
import { convertLine, readUom, withoutPackaging } from "../pricing/uom";
import { type Category, catalogItem, priceObservation, vendorItem } from "../schema";
import { EMBEDDING_TEMPLATE, embeddingText, stripTerms } from "./embedding-text";
import {
  cleanSku,
  createVendorItem,
  priceForVendorItem,
  recordLastPrice,
  resolveVendorItem,
  similarMasterItems,
  similarVendorItems,
  updateVendorItem,
  type VendorItemRow,
  vendorAlias,
  vendorItemBySku,
} from "./store";

export class VendorMatchError extends Error {
  override name = "VendorMatchError";
  constructor(
    readonly code: "not_found" | "no_reading" | "bad_input",
    message: string,
  ) {
    super(message);
  }
}

// ── 1. Match vendor ──────────────────────────────────────────────────────────────────────────────

export const VENDOR_METHODS = [
  "id",
  "document",
  "tax_id",
  "email_domain",
  "name",
  "similar_name",
] as const;
export type VendorMethod = (typeof VENDOR_METHODS)[number];

/**
 * What Match vendor may match a document's vendor on, in the order it tries them (a vendor id
 * given is always taken). The agent's `match_on` parameter picks among them.
 */
export const VENDOR_IDENTIFIERS = ["document", "tax_id", "email_domain", "name"] as const;
export type VendorIdentifier = (typeof VENDOR_IDENTIFIERS)[number];

export interface VendorMatchInput {
  vendorId?: string | undefined;
  documentId?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
  taxId?: string | undefined;
}

export interface VendorMatch {
  matched: boolean;
  vendorId: string | null;
  vendorName: string | null;
  method: VendorMethod | null;
  /** What was read: the vendor's name and email as the document gave them. */
  read: { name: string | null; email: string | null; taxId: string | null };
  candidates: { vendorId: string; name: string; similarity: number }[];
}

const digits = (s: string | null | undefined) =>
  (s ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const domainOf = (email: string | null | undefined) => {
  const at = (email ?? "").lastIndexOf("@");
  return at < 0
    ? null
    : (email ?? "")
        .slice(at + 1)
        .trim()
        .toLowerCase() || null;
};

/**
 * Step 1: the client's vendor for a document or what it names. A name is matched exactly
 * (normalized, or one of the vendor's known names) unless `minNameSimilarity` is below 1, when the
 * one vendor whose name is that close is taken; two that close is a person's call. Only the
 * identifiers in `matchOn` are tried (all, by default); a vendor id given is always taken.
 */
export async function matchVendor(
  tx: Tx,
  tenantId: string,
  input: VendorMatchInput,
  minNameSimilarity = 1,
  matchOn: readonly VendorIdentifier[] = VENDOR_IDENTIFIERS,
): Promise<VendorMatch> {
  const on = (i: VendorIdentifier) => matchOn.includes(i);
  let name = input.name?.trim() || null;
  let email = input.email?.trim() || null;
  const taxId = input.taxId?.trim() || null;
  const found = (
    v: { id: string; name: string },
    method: VendorMethod,
    candidates: VendorMatch["candidates"] = [],
  ): VendorMatch => ({
    matched: true,
    vendorId: v.id,
    vendorName: v.name,
    method,
    read: { name, email, taxId },
    candidates,
  });
  const byId = async (id: string) =>
    (
      await tx
        .select({ id: vendor.id, name: vendor.name, ext: vendor.ext })
        .from(vendor)
        .where(and(eq(vendor.id, id), eq(vendor.tenantId, tenantId)))
        .limit(1)
    )[0] ?? null;

  if (input.vendorId) {
    const v = await byId(input.vendorId);
    if (!v) throw new VendorMatchError("not_found", `vendor ${input.vendorId} not found`);
    return found(v, "id");
  }
  if (input.documentId) {
    const [d] = await tx
      .select({ meta: document.meta, vendorId: transaction.vendorId })
      .from(document)
      .leftJoin(transaction, eq(transaction.id, document.transactionId))
      .where(and(eq(document.id, input.documentId), eq(document.tenantId, tenantId)))
      .limit(1);
    if (!d) throw new VendorMatchError("not_found", `document ${input.documentId} not found`);
    const [x] = await tx
      .select({ header: docExtraction.header })
      .from(docExtraction)
      .where(
        and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, input.documentId)),
      )
      .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
      .limit(1);
    const header = (x?.header ?? {}) as Record<string, unknown>;
    if (!name && typeof header.vendorName === "string") name = header.vendorName.trim() || null;
    const from = (d.meta as { email?: { from?: unknown } }).email?.from;
    if (!email && typeof from === "string") email = from;
    if (d.vendorId && on("document")) {
      const v = await byId(d.vendorId);
      if (v) return found(v, "document");
    }
  }
  if (on("tax_id") && taxId && digits(taxId).length >= 5) {
    const rows = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(
        and(
          eq(vendor.tenantId, tenantId),
          sql`upper(regexp_replace(coalesce(${vendor.ext} ->> 'taxId', ''), '[^0-9A-Za-z]', '', 'g')) = ${digits(taxId)}`,
        ),
      )
      .limit(2);
    if (rows.length === 1 && rows[0]) return found(rows[0], "tax_id");
  }
  const domain = domainOf(email);
  if (domain && on("email_domain")) {
    const rows = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.tenantId, tenantId), sql`${vendor.ext} -> 'domains' ? ${domain}`))
      .limit(2);
    if (rows.length === 1 && rows[0]) return found(rows[0], "email_domain");
  }
  const key = name && on("name") ? normalizeVendorName(name) : "";
  if (key) {
    const rows = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(
        and(
          eq(vendor.tenantId, tenantId),
          sql`(${vendor.normalizedName} = ${key} or ${key} = any(${vendor.aliases}))`,
        ),
      )
      .limit(2);
    if (rows.length === 1 && rows[0]) return found(rows[0], "name");
    const sim = sql<number>`similarity(${vendor.normalizedName}, ${key})`;
    const close = await tx
      .select({ id: vendor.id, name: vendor.name, sim })
      .from(vendor)
      .where(and(eq(vendor.tenantId, tenantId), sql`${vendor.normalizedName} % ${key}`))
      .orderBy(desc(sim), asc(vendor.id))
      .limit(3);
    const candidates = close.map((c) => ({
      vendorId: c.id,
      name: c.name,
      similarity: Number(c.sim),
    }));
    const above = candidates.filter((c) => c.similarity >= minNameSimilarity);
    if (minNameSimilarity < 1 && above.length === 1 && above[0]) {
      return found({ id: above[0].vendorId, name: above[0].name }, "similar_name", candidates);
    }
    return {
      matched: false,
      vendorId: null,
      vendorName: null,
      method: null,
      read: { name, email, taxId },
      candidates,
    };
  }
  return {
    matched: false,
    vendorId: null,
    vendorName: null,
    method: null,
    read: { name, email, taxId },
    candidates: [],
  };
}

// ── A document's lines ───────────────────────────────────────────────────────────────────────────

export interface DocLineRow {
  id: string;
  lineNo: number;
  sku: string | null;
  rawDescription: string;
  qty: string;
  uomRaw: string | null;
  unitPrice: string;
  extPrice: string;
  discount: string | null;
}

export interface LoadedDocument {
  documentId: string;
  extractionId: string;
  transactionId: string | null;
  /** The day its prices are for: the invoice's date, else the purchase's, else when it came. */
  observedOn: string;
  currency: string;
  lines: DocLineRow[];
}

const isoDay = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

export async function loadDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<LoadedDocument> {
  const [row] = await tx
    .select({
      extractionId: docExtraction.id,
      header: docExtraction.header,
      currency: docExtraction.currency,
      transactionId: document.transactionId,
      receivedAt: document.receivedAt,
      txnDate: transaction.txnDate,
    })
    .from(docExtraction)
    .innerJoin(document, eq(document.id, docExtraction.documentId))
    .leftJoin(transaction, eq(transaction.id, document.transactionId))
    .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, documentId)))
    .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
    .limit(1);
  if (!row) {
    throw new VendorMatchError(
      "no_reading",
      `document ${documentId} has no reading; read it first`,
    );
  }
  const lines = await tx
    .select({
      id: docLine.id,
      lineNo: docLine.lineNo,
      sku: docLine.vendorSku,
      rawDescription: docLine.rawDescription,
      qty: docLine.qty,
      uomRaw: docLine.uomRaw,
      unitPrice: docLine.unitPrice,
      extPrice: docLine.extPrice,
      discount: docLine.discount,
    })
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, row.extractionId)))
    .orderBy(asc(docLine.lineNo));
  const header = (row.header ?? {}) as Record<string, unknown>;
  return {
    documentId,
    extractionId: row.extractionId,
    transactionId: row.transactionId,
    observedOn:
      isoDay(header.invoiceDate) ??
      isoDay(row.txnDate) ??
      row.receivedAt.toISOString().slice(0, 10),
    currency: row.currency ?? "USD",
    lines,
  };
}

/** The vendor's learned abbreviations (`vendor.ext.abbreviations`). */
export async function vendorAbbreviations(
  tx: Tx,
  tenantId: string,
  vendorId: string,
): Promise<Record<string, string>> {
  const [v] = await tx
    .select({ ext: vendor.ext })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), eq(vendor.tenantId, tenantId)))
    .limit(1);
  if (!v) throw new VendorMatchError("not_found", `vendor ${vendorId} not found`);
  const a = (v.ext as { abbreviations?: unknown }).abbreviations;
  return a && typeof a === "object" ? (a as Record<string, string>) : {};
}

// ── 2. Match by SKU (vendor) ─────────────────────────────────────────────────────────────────────

export interface KnownLine {
  lineNo: number;
  docLineId: string;
  /** Null for an older alias with no vendor item yet: Register item makes one. */
  vendorItemId: string | null;
  catalogItemId: string;
  via: "sku" | "sku_alias" | "wording";
}

export interface SkuLookup {
  documentId: string;
  vendorId: string;
  lines: LookedUpLine[];
  known: KnownLine[];
  openCount: number;
}

/**
 * Step 2: each line of the document's latest reading against this vendor's catalog: its SKU's
 * vendor item, else a SKU or wording alias this vendor used. Every other line is open.
 */
export async function lookupBySku(
  tx: Tx,
  tenantId: string,
  input: { documentId: string; vendorId: string },
): Promise<SkuLookup> {
  const doc = await loadDocument(tx, tenantId, input.documentId);
  const abbreviations = await vendorAbbreviations(tx, tenantId, input.vendorId);
  const lines: LookedUpLine[] = [];
  const known: KnownLine[] = [];
  for (const l of doc.lines) {
    const normalized = normalize(l.rawDescription, { abbreviations });
    const parsed = parseNormalized(normalized);
    const sku = cleanSku(l.sku);
    const base = {
      docLineId: l.id,
      lineNo: l.lineNo,
      description: l.rawDescription,
      category: parsed.category,
      attributes: parsed.attributes,
      missing: parsed.missing,
      candidates: [],
    };
    const decided = async (
      catalogItemId: string,
      vendorItemId: string | null,
      via: KnownLine["via"],
    ) => {
      const item = await liveItem(tx, tenantId, catalogItemId);
      if (!item) return false;
      lines.push({
        ...base,
        decision: "matched",
        catalogItemId: item.id,
        catalogItemName: item.canonicalName,
        method: "alias",
        confidence: 1,
        hinge: null,
      });
      known.push({ lineNo: l.lineNo, docLineId: l.id, vendorItemId, catalogItemId: item.id, via });
      return true;
    };
    const bySku = sku ? await vendorItemBySku(tx, tenantId, input.vendorId, sku) : null;
    if (bySku && (await decided(bySku.catalogItemId, bySku.id, "sku"))) continue;
    const alias = await vendorAlias(tx, tenantId, {
      vendorId: input.vendorId,
      sku,
      descriptionHash: await descriptionHash(normalized),
    });
    if (
      alias &&
      (await decided(
        alias.catalogItemId,
        alias.item?.id ?? null,
        alias.via === "sku" ? "sku_alias" : "wording",
      ))
    ) {
      continue;
    }
    lines.push({
      ...base,
      decision: "open",
      catalogItemId: null,
      catalogItemName: null,
      method: null,
      confidence: 0,
      hinge: parsed.missing[0] ?? null,
    });
  }
  return {
    documentId: input.documentId,
    vendorId: input.vendorId,
    lines,
    known,
    openCount: lines.filter((l) => l.decision === "open").length,
  };
}

// ── 3. Semantic match (vendor): the candidates ───────────────────────────────────────────────────

/** An open line as Semantic match (vendor) reads it: this vendor's items it could be. */
export interface VendorOpenLine {
  lineNo: number;
  description: string;
  category: Category;
  attributes: Attributes;
  missing: string[];
  candidates: {
    vendorItemId: string;
    catalogItemId: string;
    /** As the vendor writes it. */
    name: string;
    sku: string | null;
    /** The master item's (vendor-neutral) name and attributes. */
    masterName: string;
    attributes: Attributes;
  }[];
}

/** How many of this vendor's items an open line is compared with. */
export const VENDOR_CANDIDATES = 5;

/**
 * The words a new master item made from a vendor's line may fall back on for its name (a category
 * with no generic name, `canonicalName`): the line's text without the vendor's SKU, pack count,
 * prices or terms. A master item is vendor-neutral (§1.88).
 */
// DECISION (review of vendor/web3, finding 4): a master item Register item makes keeps no pack
// size (`withoutPackaging`), no `ext.firstDescription` (the vendor's wording is the vendor item's
// name) and, where its name falls back on the line's words, none of the vendor's SKU or packaging.
export function neutralName(normalized: string, sku: string | null): string {
  let text = stripTerms(normalized);
  if (sku) {
    const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "gi"), " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || normalized;
}

/** The text an open line is searched by (names, trigrams) and parsed from: normalized. */
export function lineText(raw: string, abbreviations: Record<string, string> = {}): string {
  return normalize(raw, { abbreviations });
}

/**
 * The text an open line is embedded as, in the one template (./embedding-text.ts): its wording as
 * the vendor wrote it for the name, and the specs its category parser reads.
 */
// DECISION: a line is embedded in the same template as the items it is compared with (§1.88:
// like for like). Its name is the vendor's wording as written (what a vendor item's name is), it
// has no description, and its specs are the parsed category and attributes (the rules' reading,
// or Check matches' for a line new to its vendor).
export function lineEmbeddingText(
  raw: string,
  reading: { category: Category | string; attributes: Readonly<Record<string, unknown>> },
): string {
  return embeddingText({ name: raw, category: reading.category, attributes: reading.attributes });
}

/** An open line's embedding text, parsed with the vendor's abbreviations. */
export function openLineEmbeddingText(
  raw: string,
  abbreviations: Record<string, string> = {},
): string {
  return lineEmbeddingText(raw, parseNormalized(lineText(raw, abbreviations)));
}

export interface SimilarInput {
  vendorId: string;
  lines: readonly LookedUpLine[];
  /** One vector per open line, in order; null where none was made (no model configured). */
  vectors: readonly (readonly number[] | null)[];
  abbreviations: Record<string, string>;
  limit?: number | undefined;
}

export interface SimilarResult {
  lines: LookedUpLine[];
  open: VendorOpenLine[];
  openCount: number;
  /** Lines the rules settled here: one equal item of this vendor's, or new to this vendor. */
  settled: { lineNo: number; decision: "matched" | "new_item" }[];
}

/**
 * Step 3's read: for each open line, this vendor's closest active items (one per master item, by
 * embedding and name), scored by the key attributes. One candidate with every key attribute
 * equal settles it (matched, by the rules); none that could be it, with every required attribute
 * stated, makes it new to this vendor; anything else stays open for the model.
 */
export async function similarForOpenLines(
  tx: Tx,
  tenantId: string,
  input: SimilarInput,
): Promise<SimilarResult> {
  const open = input.lines.filter((l) => l.decision === "open");
  const vendorItems = new Map<string, Map<string, VendorItemRow>>();
  const out: LookedUpLine[] = [];
  const settled: SimilarResult["settled"] = [];
  for (const line of input.lines) {
    if (line.decision !== "open") {
      out.push(line);
      continue;
    }
    const vector = input.vectors[open.indexOf(line)] ?? null;
    const text = lineText(line.description, input.abbreviations);
    const parsed = parseNormalized(text);
    const found = await similarVendorItems(
      tx,
      tenantId,
      input.vendorId,
      { vector, text: text.toLowerCase() },
      input.limit ?? VENDOR_CANDIDATES,
    );
    const byMaster = new Map<string, VendorItemRow>();
    const items: CandidateItem[] = [];
    for (const f of found) {
      const master = await liveItem(tx, tenantId, f.item.catalogItemId);
      if (!master || byMaster.has(master.id)) continue;
      byMaster.set(master.id, f.item);
      items.push({
        catalogItemId: master.id,
        name: f.item.name,
        category: master.category,
        attributes: master.attributes as Attributes,
        standardUom: master.standardUom,
        similarity: f.similarity ?? f.nameSimilarity,
      });
    }
    vendorItems.set(line.docLineId, byMaster);
    const decided = decideByRules(line, parsed, items, input.limit ?? VENDOR_CANDIDATES);
    if (decided.decision !== "open")
      settled.push({ lineNo: line.lineNo, decision: decided.decision });
    out.push(decided);
  }
  const masters = new Map<string, CatalogItemRow>();
  const openOut: VendorOpenLine[] = [];
  for (const o of openLines(out, { withoutVetoed: true })) {
    const line = out.find((l) => l.lineNo === o.lineNo);
    const byMaster = line ? vendorItems.get(line.docLineId) : undefined;
    const candidates: VendorOpenLine["candidates"] = [];
    for (const c of o.candidates) {
      const vi = byMaster?.get(c.catalogItemId);
      if (!vi) continue;
      let master = masters.get(c.catalogItemId);
      if (!master) {
        master = (await liveItem(tx, tenantId, c.catalogItemId)) ?? undefined;
        if (master) masters.set(c.catalogItemId, master);
      }
      candidates.push({
        vendorItemId: vi.id,
        catalogItemId: c.catalogItemId,
        name: vi.name,
        sku: vi.sku,
        masterName: master?.canonicalName ?? c.name,
        attributes: c.attributes,
      });
    }
    openOut.push({ ...o, candidates });
  }
  return { lines: out, open: openOut, openCount: openOut.length, settled };
}

// ── 4. Master item manager: the candidates ──────────────────────────────────────────────────────

/** How many of the client's master items a line new to its vendor is compared with. */
export const MASTER_CANDIDATES = 5;

export interface NewToVendorLine {
  checked: CheckedLine;
  description: string;
  /** Normalized: what names are compared by. */
  text: string;
  /** What the line is embedded as (the one template). */
  embedText: string;
}

/** The lines Check matches found new to this vendor, with their text (from the document). */
export async function newToVendorLines(
  tx: Tx,
  tenantId: string,
  lines: readonly CheckedLine[],
  abbreviations: Record<string, string>,
): Promise<NewToVendorLine[]> {
  const fresh = lines.filter((l) => l.decision === "new_item");
  if (fresh.length === 0) return [];
  const rows = await tx
    .select({ id: docLine.id, raw: docLine.rawDescription })
    .from(docLine)
    .where(
      and(
        eq(docLine.tenantId, tenantId),
        inArray(
          docLine.id,
          fresh.map((l) => l.docLineId),
        ),
      ),
    );
  const raw = new Map(rows.map((r) => [r.id, r.raw]));
  return fresh.flatMap((checked) => {
    const description = raw.get(checked.docLineId);
    if (description === undefined) return [];
    return [
      {
        checked,
        description,
        text: lineText(description, abbreviations),
        embedText: lineEmbeddingText(description, checked),
      },
    ];
  });
}

export interface MasterCandidates {
  lines: LookedUpLine[];
  open: OpenLine[];
  openCount: number;
}

/**
 * Step 4's read: for each line new to its vendor, the client's live master items it could be:
 * equal key attributes, close names (trigrams), then close embeddings, in its category, scored by
 * the key attributes. One equal item links it (by the rules); none that could be it, with every
 * required attribute stated, makes a new master item; anything else is for the model.
 */
export async function masterCandidates(
  tx: Tx,
  tenantId: string,
  lines: readonly NewToVendorLine[],
  vectors: readonly (readonly number[] | null)[],
  limit = MASTER_CANDIDATES,
): Promise<MasterCandidates> {
  const out: LookedUpLine[] = [];
  for (const [i, l] of lines.entries()) {
    const parsed: ParsedLine = withCompleteness(
      l.text,
      l.checked.category,
      l.checked.attributes,
      "rules",
    );
    const items = new Map<string, CandidateItem>();
    for (const c of await findCandidates(tx, tenantId, parsed, { trigramLimit: limit })) {
      items.set(c.item.id, {
        catalogItemId: c.item.id,
        name: c.item.canonicalName,
        category: c.item.category,
        attributes: c.item.attributes as Attributes,
        standardUom: c.item.standardUom,
        similarity: c.similarity,
      });
    }
    const vector = vectors[i] ?? null;
    if (vector) {
      for (const s of await similarMasterItems(tx, tenantId, vector, {
        category: parsed.category,
        limit,
      })) {
        if (items.has(s.item.id)) continue;
        items.set(s.item.id, {
          catalogItemId: s.item.id,
          name: s.item.canonicalName,
          category: s.item.category,
          attributes: s.item.attributes as Attributes,
          standardUom: s.item.standardUom,
          similarity: s.similarity,
        });
      }
    }
    out.push(
      decideByRules(
        { docLineId: l.checked.docLineId, lineNo: l.checked.lineNo, description: l.description },
        parsed,
        [...items.values()],
        limit,
      ),
    );
  }
  const open = openLines(out, { withoutVetoed: true });
  return { lines: out, open, openCount: open.length };
}

// ── 5. Register item, and 6. a person's answer ──────────────────────────────────────────────────

export interface PersonAnswer {
  lineNo: number;
  /** The master item the person says it is; or `newItem` for a new one. */
  catalogItemId?: string | null | undefined;
  newItem?: boolean | undefined;
}

export interface RegisterInput {
  tenantId: string;
  agentVersionId: string;
  documentId: string;
  vendorId: string;
  /** Check matches at the vendor level (step 3). */
  lines?: readonly CheckedLine[] | undefined;
  /** Check matches after the master item manager (step 4), overriding `lines` by line number. */
  resolved?: readonly CheckedLine[] | undefined;
  /** Semantic match's answers: the vendor item it named for a line (a hint, checked here). */
  vendorItemHints?:
    | readonly { lineNo: number; vendorItemId?: string | null | undefined }[]
    | undefined;
  /** A person's answers (step 6), registered as theirs. */
  answers?: readonly PersonAnswer[] | undefined;
  decidedBy?: string | null | undefined;
  testRun: boolean;
}

export interface RegisteredLine {
  lineNo: number;
  docLineId: string;
  decision: "matched" | "new_item" | "unsure";
  catalogItemId: string | null;
  vendorItemId: string | null;
  createdItem: boolean;
  createdVendorItem: boolean;
  observationId: string | null;
  /** False when it was registered before (a retried step) and nothing was written now. */
  recorded: boolean;
  /** Why the line has no price recorded (no conversion rule, no quantity). */
  priceSkipped: string | null;
}

export interface NeedsPerson {
  lineNo: number;
  docLineId: string;
  description: string;
  sku: string | null;
  reason: string;
  candidates: { catalogItemId: string; name: string; vetoed: boolean }[];
}

export interface RegisterResult {
  lines: RegisteredLine[];
  needsPerson: NeedsPerson[];
  /** Master items and vendor items made now: Save to records: embeddings, next. */
  catalogItemIds: string[];
  vendorItemIds: string[];
  /** Vendor items moved to another master item now: their specs changed, so they embed again. */
  changedVendorItemIds: string[];
  testRun: boolean;
}

class RollBack extends Error {
  constructor(readonly result: RegisterResult) {
    super("test run: rolled back");
  }
}

interface Decision {
  decision: "matched" | "new_item" | "unsure";
  catalogItemId: string | null;
  confidence: number;
  method: "alias" | "rules" | "llm" | "human";
  hinge: string | null;
  vetoed: string | null;
  attributes: Attributes | null;
  candidates: CheckedLine["candidates"];
}

function fromChecked(l: CheckedLine): Decision {
  return {
    decision: l.decision,
    catalogItemId: l.catalogItemId,
    confidence: l.confidence,
    method: l.method === "recalled" ? "rules" : l.method,
    hinge: l.hingeAttribute,
    vetoed: l.vetoed,
    attributes: l.attributes,
    candidates: l.candidates,
  };
}

/**
 * Registers decided lines: the match (with the agent version, or the person), the master item (a
 * new one when the line is new everywhere), the vendor item, its SKU and wording aliases, and the
 * price, which becomes the vendor item's last price unless it already has a newer one. A line
 * registered before is left as it is. Unsure lines are listed for a person, never guessed. A test
 * run writes nothing: the work is rolled back and its result answered.
 */
// DECISION: a test run's Register item writes nothing (rolled back) and answers what it would
// have written; the ids it names are the rolled-back rows'.
export async function registerLines(db: Db, input: RegisterInput): Promise<RegisterResult> {
  try {
    return await withTenant(db, input.tenantId, async (tx) => {
      const result = await register(tx, input);
      if (input.testRun) throw new RollBack(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RollBack) return error.result;
    throw error;
  }
}

async function register(tx: Tx, input: RegisterInput): Promise<RegisterResult> {
  const registry = materialsEventRegistry();
  const { tenantId } = input;
  const doc = await loadDocument(tx, tenantId, input.documentId);
  const abbreviations = await vendorAbbreviations(tx, tenantId, input.vendorId);
  const human = input.answers !== undefined;
  if (human && !input.decidedBy) {
    throw new VendorMatchError("bad_input", "a person's answer names who gave it (decidedBy)");
  }
  const decisions = new Map<number, Decision>();
  for (const l of input.lines ?? []) decisions.set(l.lineNo, fromChecked(l));
  for (const l of input.resolved ?? []) decisions.set(l.lineNo, fromChecked(l));
  for (const a of input.answers ?? []) {
    if (!a.newItem && !a.catalogItemId) {
      throw new VendorMatchError("bad_input", `line ${a.lineNo}: say which item, or a new one`);
    }
    decisions.set(a.lineNo, {
      decision: a.newItem ? "new_item" : "matched",
      catalogItemId: a.newItem ? null : (a.catalogItemId ?? null),
      confidence: 1,
      method: "human",
      hinge: null,
      vetoed: null,
      attributes: null,
      candidates: [],
    });
  }
  const hints = new Map((input.vendorItemHints ?? []).map((h) => [h.lineNo, h.vendorItemId]));
  const by = human
    ? ({ userId: input.decidedBy as string } as const)
    : ({ agentVersionId: input.agentVersionId } as const);
  const result: RegisterResult = {
    lines: [],
    needsPerson: [],
    catalogItemIds: [],
    vendorItemIds: [],
    changedVendorItemIds: [],
    testRun: input.testRun,
  };
  for (const line of doc.lines) {
    const d = decisions.get(line.lineNo);
    if (!d) continue;
    const normalized = lineText(line.rawDescription, abbreviations);
    const sku = cleanSku(line.sku);
    const hash = await descriptionHash(normalized);
    const prior = await latestMatch(tx, tenantId, line.id);
    const base: RegisteredLine = {
      lineNo: line.lineNo,
      docLineId: line.id,
      decision: d.decision,
      catalogItemId: null,
      vendorItemId: null,
      createdItem: false,
      createdVendorItem: false,
      observationId: null,
      recorded: false,
      priceSkipped: null,
    };
    const askPerson = (reason: string, candidates = d.candidates) => {
      result.needsPerson.push({
        lineNo: line.lineNo,
        docLineId: line.id,
        description: line.rawDescription,
        sku,
        reason,
        candidates: candidates.map((c) => ({
          catalogItemId: c.catalogItemId,
          name: c.name,
          vetoed: c.vetoed,
        })),
      });
    };
    // A line decided before (a retried step, a re-run) is left as it is; a person's answer is
    // registered over an agent's unsure one.
    const priorItem =
      prior && prior.decision !== "unsure" && prior.catalogItemId
        ? await liveItem(tx, tenantId, prior.catalogItemId)
        : null;
    if (priorItem && !human) {
      const [obs] = await tx
        .select({ id: priceObservation.id, vendorItemId: priceObservation.vendorItemId })
        .from(priceObservation)
        .where(
          and(eq(priceObservation.tenantId, tenantId), eq(priceObservation.docLineId, line.id)),
        )
        .limit(1);
      result.lines.push({
        ...base,
        decision: prior?.decision ?? d.decision,
        catalogItemId: priorItem.id,
        vendorItemId: obs?.vendorItemId ?? null,
        observationId: obs?.id ?? null,
      });
      continue;
    }
    if (d.decision === "unsure") {
      if (!prior) {
        await recordMatch(tx, tenantId, {
          docLineId: line.id,
          catalogItemId: null,
          decision: "unsure",
          confidence: d.confidence,
          method: d.method,
          hingeAttribute: d.hinge,
          candidates: d.candidates,
          by,
        });
      }
      askPerson(d.vetoed ?? `not sure (${Math.round(d.confidence * 100)}% sure)`);
      result.lines.push(base);
      continue;
    }
    // The master item: the one decided, or a new one.
    let item: CatalogItemRow | null = null;
    let createdItem = false;
    let decision: "matched" | "new_item" = d.decision;
    if (d.decision === "matched") {
      item = d.catalogItemId ? await liveItem(tx, tenantId, d.catalogItemId) : null;
      if (!item) {
        throw new VendorMatchError("not_found", `catalog item ${d.catalogItemId} not found`);
      }
    } else {
      const rules = parseNormalized(normalized);
      const read = withModelReading(
        { description: normalized, category: rules.category, attributes: rules.attributes },
        d.attributes ?? undefined,
      );
      // A master item is vendor-neutral (§1.88): no pack size, no SKU, no vendor's wording kept.
      const made = await createItem(
        tx,
        tenantId,
        {
          ...read,
          attributes: withoutPackaging(read.attributes),
          normalized: neutralName(normalized, sku),
        },
        by,
        { vendorNeutral: true },
      );
      item = made.item;
      createdItem = made.created;
      // Another run made the same master item a moment ago: this line is that item.
      if (!made.created) decision = "matched";
      if (made.created) result.catalogItemIds.push(item.id);
    }
    const vendorUom = line.uomRaw?.trim()
      ? (readUom(line.uomRaw) ?? line.uomRaw.trim().toLowerCase())
      : item.standardUom;
    let vi = await resolveVendorItem(tx, tenantId, {
      vendorId: input.vendorId,
      catalogItemId: item.id,
      sku,
      vendorUom,
      hintId: hints.get(line.lineNo) ?? null,
    });
    if (vi && vi.catalogItemId !== item.id) {
      // A vendor item left on a master item merged into this one (before merges moved them):
      // it is this item, so it moves here without asking anyone.
      const merged = (await liveItem(tx, tenantId, vi.catalogItemId))?.id === item.id;
      // The vendor's SKU names another master item. A person may move it; an agent asks one.
      if (!human && !merged) {
        if (prior?.decision !== "unsure") {
          await recordMatch(tx, tenantId, {
            docLineId: line.id,
            catalogItemId: null,
            decision: "unsure",
            confidence: Math.min(d.confidence, 0.5),
            method: d.method,
            hingeAttribute: "sku",
            candidates: d.candidates,
            by,
          });
        }
        askPerson(`the vendor's SKU ${sku} is another item in the catalog`);
        result.lines.push({ ...base, decision: "unsure" });
        continue;
      }
      vi = await updateVendorItem(tx, tenantId, vi.id, { catalogItemId: item.id });
      result.changedVendorItemIds.push(vi.id);
    }
    // The vendor's unit and how many standard units it is (invariant 7: no rule, no std price):
    // the line's own words over the master item's specs, never the master item's pack size, else
    // the vendor item's own conversion for that unit (`convertLine`).
    const lineAttributes = parseLine(line.rawDescription).attributes;
    const conv = convertLine(line.uomRaw, item.standardUom, lineAttributes, item.attributes, vi);
    let createdVendorItem = false;
    if (!vi) {
      const pack = lineAttributes.pack_size;
      const made = await createVendorItem(
        tx,
        tenantId,
        {
          vendorId: input.vendorId,
          catalogItemId: item.id,
          sku,
          name: line.rawDescription,
          // The pack is the vendor's (vendor_item.pack_size), as the line states it.
          ...(pack ? { packSize: `${pack} per ${vendorUom}` } : {}),
          vendorUom,
          stdPerVendorUom: conv.ok ? toNumeric(conv.factor) : null,
        },
        by,
      );
      vi = made.item;
      createdVendorItem = made.created;
      if (made.created) result.vendorItemIds.push(vi.id);
    } else if (vi.stdPerVendorUom === null && conv.ok && (vi.vendorUom ?? "") === vendorUom) {
      vi = await updateVendorItem(tx, tenantId, vi.id, { stdPerVendorUom: toNumeric(conv.factor) });
    }
    const matchId = await recordMatch(tx, tenantId, {
      docLineId: line.id,
      catalogItemId: item.id,
      decision,
      confidence: d.confidence,
      method: d.method,
      hingeAttribute: d.hinge,
      candidates: d.candidates,
      by,
    });
    await learnAlias(tx, tenantId, {
      vendorId: input.vendorId,
      vendorSku: sku,
      descriptionHash: hash,
      normalizedDescription: normalized,
      catalogItemId: item.id,
      source: human ? "human" : "auto",
      vendorItemId: vi.id,
    });
    // The price: in the vendor's unit always; per standard unit only with a conversion.
    let observationId: string | null = null;
    let priceSkipped: string | null = null;
    const qty = dec(line.qty);
    const discounted = line.discount !== null && dec(line.discount).greaterThan(0);
    const unitRaw = qty.greaterThan(0)
      ? discounted
        ? dec(line.extPrice).dividedBy(qty)
        : dec(line.unitPrice)
      : null;
    if (!unitRaw) {
      priceSkipped = "no quantity";
    } else {
      const unitStd = conv.ok ? unitRaw.dividedBy(conv.factor) : null;
      if (conv.ok && unitStd) {
        const [row] = await tx
          .insert(priceObservation)
          .values({
            tenantId,
            catalogItemId: item.id,
            vendorId: input.vendorId,
            vendorItemId: vi.id,
            observedOn: doc.observedOn,
            unitPriceStd: toNumeric(unitStd),
            qtyStd: toNumeric(qty.times(conv.factor)),
            standardUom: item.standardUom,
            currency: doc.currency,
            docLineId: line.id,
            transactionId: doc.transactionId,
            agentVersionId: human ? null : input.agentVersionId || null,
            ext: {
              uomRaw: line.uomRaw,
              unitPriceRaw: toNumeric(unitRaw),
              factor: conv.factor.toString(),
              conversion: conv.rule,
              ...(conv.assumed ? { uomAssumed: true } : {}),
            },
          })
          .onConflictDoNothing()
          .returning({ id: priceObservation.id });
        if (row) {
          observationId = row.id;
          await emit(
            tx,
            {
              tenantId,
              type: "materials.price.observed",
              subjectId: row.id,
              payload: {
                observationId: row.id,
                catalogItemId: item.id,
                vendorId: input.vendorId,
                observedOn: doc.observedOn,
                unitPriceStd: toNumeric(unitStd),
                standardUom: item.standardUom,
              },
            },
            { registry, testRun: input.testRun },
          );
        } else {
          // Recorded before (by the price step): it now says which vendor item it was.
          const [existing] = await tx
            .update(priceObservation)
            .set({ vendorItemId: vi.id })
            .where(
              and(
                eq(priceObservation.tenantId, tenantId),
                eq(priceObservation.docLineId, line.id),
                isNull(priceObservation.vendorItemId),
              ),
            )
            .returning({ id: priceObservation.id });
          observationId = existing?.id ?? null;
        }
      } else {
        priceSkipped = conv.ok ? null : conv.reason;
      }
      // The last price is in the vendor item's own unit (a vendor item found by SKU may be priced
      // in another unit than this line's): reached from the line's unit or per standard unit,
      // else left as it was (invariant 7).
      const last = priceForVendorItem(vi, {
        price: toNumeric(unitRaw),
        unit: vendorUom,
        priceStd: unitStd ? toNumeric(unitStd) : null,
        standardUom: item.standardUom,
      });
      if (last) {
        await recordLastPrice(tx, tenantId, vi.id, {
          price: last.price,
          priceStd: last.priceStd,
          on: doc.observedOn,
          source: human ? "person" : "invoice",
          sourceId: line.id,
          currency: doc.currency,
        });
      }
    }
    await emit(
      tx,
      {
        tenantId,
        type: human ? "materials.match.decided" : "materials.line.matched",
        subjectId: line.id,
        payload: {
          docLineId: line.id,
          matchId,
          catalogItemId: item.id,
          decision,
          method: d.method,
          confidence: d.confidence.toFixed(3),
        },
      },
      { registry, testRun: input.testRun },
    );
    result.lines.push({
      ...base,
      decision,
      catalogItemId: item.id,
      vendorItemId: vi.id,
      createdItem,
      createdVendorItem,
      observationId,
      recorded: true,
      priceSkipped,
    });
  }
  return result;
}

// DECISION: an item is due for an embedding when it has none, when it was embedded under another
// template (or before the template was named), or, when its ids are given, when its text changed.
// A change of name, description or master item clears what a vendor item was embedded from
// (`updateVendorItem`), so `missing` finds it again; its old vector serves the searches meanwhile.
const dueSql = (embedding: unknown, ext: unknown) =>
  sql`(${embedding} is null or coalesce(${ext} -> 'embedding' ->> 'template', '') <> ${EMBEDDING_TEMPLATE})`;

/** Master items with no embedding yet, or whose text changed, among `ids` (or any, with none). */
export async function itemsToEmbed(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null,
  limit: number,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({
      id: catalogItem.id,
      name: catalogItem.canonicalName,
      category: catalogItem.category,
      attributes: catalogItem.attributes,
      ext: catalogItem.ext,
      has: sql<boolean>`${catalogItem.embedding} is not null`,
    })
    .from(catalogItem)
    .where(
      and(
        eq(catalogItem.tenantId, tenantId),
        isNull(catalogItem.mergedIntoId),
        ids ? inArray(catalogItem.id, [...ids]) : dueSql(catalogItem.embedding, catalogItem.ext),
      ),
    )
    .orderBy(asc(catalogItem.id))
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, text: masterText(r), has: r.has, was: embeddedText(r.ext) }))
    .filter((r) => !r.has || r.was !== r.text)
    .map(({ id, text }) => ({ id, text }));
}

/** Vendor items with no embedding yet, or whose text changed, among `ids` (or any, with none). */
export async function vendorItemsToEmbed(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | null,
  limit: number,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({
      id: vendorItem.id,
      name: vendorItem.name,
      description: vendorItem.description,
      ext: vendorItem.ext,
      has: sql<boolean>`${vendorItem.embedding} is not null`,
      category: catalogItem.category,
      attributes: catalogItem.attributes,
    })
    .from(vendorItem)
    .innerJoin(
      catalogItem,
      and(
        eq(catalogItem.id, vendorItem.catalogItemId),
        eq(catalogItem.tenantId, vendorItem.tenantId),
      ),
    )
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        ids ? inArray(vendorItem.id, [...ids]) : dueSql(vendorItem.embedding, vendorItem.ext),
      ),
    )
    .orderBy(asc(vendorItem.id))
    .limit(limit);
  return rows
    .map((r) => ({
      id: r.id,
      text: vendorItemText(r, r),
      has: r.has,
      was: embeddedText(r.ext),
    }))
    .filter((r) => !r.has || r.was !== r.text)
    .map(({ id, text }) => ({ id, text }));
}

/**
 * The text a master item is embedded as, in the one template: its vendor-neutral name, and its
 * category and attributes as the specs. A master item has no description of its own.
 */
export function masterText(m: {
  name: string;
  category: Category | string;
  attributes: Readonly<Record<string, unknown>> | null;
}): string {
  return embeddingText({ name: m.name, category: m.category, attributes: m.attributes });
}

/**
 * The text a vendor item is embedded as, in the one template: the vendor's name and description
 * as written, and the specs of its master item (the item it is).
 */
// DECISION: a vendor item's specs are its master item's category and attributes: a vendor item
// is exactly one master item (§1.88), whose attributes are the rules' reading, so its specs move
// with its master item and never depend on how one vendor abbreviates.
export function vendorItemText(
  v: { name: string; description: string | null },
  master: {
    category: Category | string;
    attributes: Readonly<Record<string, unknown>> | null;
  } | null,
): string {
  return embeddingText({
    name: v.name,
    description: v.description,
    category: master?.category ?? null,
    attributes: master?.attributes ?? null,
  });
}

/** What an item was last embedded from (`ext.embedding.text`). */
export function embeddedText(ext: unknown): string | null {
  const e = (ext as { embedding?: { text?: unknown } } | null)?.embedding?.text;
  return typeof e === "string" ? e : null;
}
