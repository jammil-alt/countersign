// Matching a free description to the client's catalog (ARCHITECTURE §12.3) when there is no
// document line: a request line as someone asked for it, or a QuickBooks bill line. Deterministic
// only: the vendor's alias (with no vendor, every vendor's description alias when they agree),
// then the vendor catalog (a vendor item's SKU or name, docs/plan.md §1.189), then the attribute
// rules over the candidates. A description the rules aren't sure of comes back
// with its candidates, never guessed. No model is called here, and nothing is written unless the
// caller asks for a new item to be created (the backfill).

import { type Tx, vendor } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { type ParsedLine, parseNormalized, RULE_CONFIDENCE, scorePair } from "../catalog/keys";
import { RULE_NEW_ITEM_CONFIDENCE } from "../catalog/match";
import { descriptionHash, normalize } from "../catalog/normalize";
import {
  type CatalogItemRow,
  type Creator,
  createItem,
  findAlias,
  findCandidates,
  identifyingSku,
  liveItem,
} from "../catalog/store";
import { itemAlias } from "../schema";
import { packFits, type VendorItemRow, vendorItemById, vendorItemsNamed } from "../vendor/store";

/** How many candidates an unsure description comes back with. */
export const TEXT_CANDIDATES = 5;

export interface TextCandidate {
  catalogItemId: string;
  name: string;
  standardUom: string;
  confidence: number;
  /** The key attribute the rules couldn't settle, when one did. */
  hinge: string | null;
}

export interface TextMatch {
  decision: "matched" | "new_item" | "unsure";
  item: CatalogItemRow | null;
  method: "alias" | "rules" | null;
  confidence: number;
  hinge: string | null;
  candidates: TextCandidate[];
  parsed: ParsedLine;
  normalized: string;
  hash: string;
  /**
   * The vendor item the description named: through the vendor catalog, when one vendor item
   * named it, or the one the vendor's alias names (§1.189); null otherwise.
   */
  vendorItem: VendorItemRow | null;
  /** Matched through the vendor catalog (a vendor item's SKU or name), not an alias or a rule. */
  viaCatalog: boolean;
}

async function vendorAbbreviations(
  tx: Tx,
  tenantId: string,
  vendorId: string,
): Promise<Record<string, string>> {
  const [row] = await tx
    .select({ ext: vendor.ext })
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, vendorId)))
    .limit(1);
  const abbreviations = (row?.ext as { abbreviations?: unknown } | undefined)?.abbreviations;
  return abbreviations && typeof abbreviations === "object"
    ? (abbreviations as Record<string, string>)
    : {};
}

/**
 * With no vendor, the description aliases every vendor has for this text. DECISION: they settle it
 * only when all of them name one live item; two vendors meaning different items is unsure.
 */
export async function anyVendorAlias(
  tx: Tx,
  tenantId: string,
  hash: string,
): Promise<CatalogItemRow | null> {
  const rows = await tx
    .select({ catalogItemId: itemAlias.catalogItemId })
    .from(itemAlias)
    .where(and(eq(itemAlias.tenantId, tenantId), eq(itemAlias.descriptionHash, hash)))
    .limit(20);
  const items = new Map<string, CatalogItemRow>();
  for (const r of rows) {
    const item = await liveItem(tx, tenantId, r.catalogItemId);
    if (item) items.set(item.id, item);
  }
  return items.size === 1 ? ([...items.values()][0] ?? null) : null;
}

const LEADING = new Set(["(", '"', "'", "#", ":", "."]);
const TRAILING = new Set([")", '"', "'", ".", ":"]);

/** A word without the punctuation around it, in one pass (a regex here is slow on long runs). */
function trimPunctuation(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && LEADING.has(raw[start] as string)) start++;
  while (end > start && TRAILING.has(raw[end - 1] as string)) end--;
  return raw.slice(start, end);
}

/** The codes in a description that could be SKUs: each word with a digit (`identifyingSku`). */
export function skuTokens(description: string): string[] {
  const out = new Set<string>();
  for (const raw of description.split(/[\s,;]+/)) {
    const word = trimPunctuation(raw);
    const sku = /\d/.test(word) ? identifyingSku(word) : null;
    if (sku) out.add(sku);
  }
  return [...out].slice(0, 20);
}

/**
 * What the vendor catalog says a description is (§1.189): the master item of the vendor items
 * whose SKU the description names, or whose name it is, when they all name one live item. The
 * hard rules veto: a description whose own words name another category or another value of a
 * key attribute is not that item, nor is a box, case or pail line of another size (`packFits`).
 */
// DECISION (§1.189): a SKU never outvotes the description's own words (as §1.144 for invoices);
// two vendor items naming two master items is unsure, never guessed.
export async function vendorCatalogHit(
  tx: Tx,
  tenantId: string,
  input: MatchTextInput,
  parsed: ParsedLine,
): Promise<{ item: CatalogItemRow; vendorItem: VendorItemRow | null } | null> {
  const given = identifyingSku(input.vendorSku);
  const skus = [...new Set([...(given ? [given] : []), ...skuTokens(input.description)])];
  const rows = await vendorItemsNamed(tx, tenantId, {
    vendorId: input.vendorId,
    skus,
    description: input.description,
  });
  const items = new Map<string, { item: CatalogItemRow; rows: VendorItemRow[] }>();
  for (const v of rows) {
    if (!packFits(v, input.unit, input.description)) continue;
    const item = await liveItem(tx, tenantId, v.catalogItemId);
    if (!item) continue;
    if (parsed.category !== "other") {
      const score = scorePair(parsed, {
        category: item.category,
        attributes: item.attributes as Record<string, string>,
      });
      if (score.confidence <= RULE_CONFIDENCE.veto) continue;
    }
    const hit = items.get(item.id) ?? { item, rows: [] };
    hit.rows.push(v);
    items.set(item.id, hit);
  }
  if (items.size !== 1) return null;
  const [hit] = [...items.values()];
  if (!hit) return null;
  return { item: hit.item, vendorItem: hit.rows.length === 1 ? (hit.rows[0] ?? null) : null };
}

export interface MatchTextInput {
  description: string;
  vendorId?: string | null | undefined;
  vendorSku?: string | null | undefined;
  /** The unit asked or billed in, when there is one: a box line is told from a case (§1.144). */
  unit?: string | null | undefined;
  /** Create the item when the rules say it is new and every key attribute is stated. */
  create?: Creator | null | undefined;
}

/** Matches one description, inside the caller's client-scoped transaction. */
export async function matchText(
  tx: Tx,
  tenantId: string,
  input: MatchTextInput,
): Promise<TextMatch> {
  const abbreviations = input.vendorId
    ? await vendorAbbreviations(tx, tenantId, input.vendorId)
    : {};
  const normalized = normalize(input.description, { abbreviations });
  const hash = await descriptionHash(normalized);
  const parsed = parseNormalized(normalized);
  const base = {
    parsed,
    normalized,
    hash,
    hinge: null,
    candidates: [],
    vendorItem: null,
    viaCatalog: false,
  };

  const alias = input.vendorId
    ? await findAlias(tx, tenantId, {
        vendorId: input.vendorId,
        vendorSku: input.vendorSku?.trim().toUpperCase() || null,
        descriptionHash: hash,
      })
    : null;
  const aliased = input.vendorId ? alias?.item : await anyVendorAlias(tx, tenantId, hash);
  if (aliased) {
    // DECISION (review of C2.2): the vendor item the vendor's alias names comes with the match,
    // so a bill line in the wording of the vendor's box is told from one in its standard unit
    // (the bill-price import neither prices it nor makes a vendor item from it, §1.189).
    const named = alias?.vendorItemId
      ? await vendorItemById(tx, tenantId, alias.vendorItemId)
      : null;
    const vendorItem =
      named &&
      named.vendorId === input.vendorId &&
      (await liveItem(tx, tenantId, named.catalogItemId))?.id === aliased.id
        ? named
        : null;
    return {
      ...base,
      decision: "matched",
      item: aliased,
      method: "alias",
      confidence: 1,
      vendorItem,
    };
  }
  // DECISION (§1.189): a vendor item is the vendor's own name for its item, so a match through
  // the vendor catalog is recorded as `alias` (no new match method, no migration); `vendorItem`
  // says which one.
  const listed = await vendorCatalogHit(tx, tenantId, input, parsed);
  if (listed) {
    return {
      ...base,
      decision: "matched",
      item: listed.item,
      method: "alias",
      confidence: 1,
      vendorItem: listed.vendorItem,
      viaCatalog: true,
    };
  }

  const found = await findCandidates(tx, tenantId, parsed);
  const scored = found.map((c) => ({
    item: c.item,
    score: scorePair(parsed, {
      category: c.item.category,
      attributes: c.item.attributes as Record<string, string>,
    }),
  }));
  const exact = scored.filter((s) => s.score.confidence >= RULE_CONFIDENCE.exact);
  const possible = scored
    .filter((s) => s.score.confidence > RULE_CONFIDENCE.veto)
    .sort((a, b) => b.score.confidence - a.score.confidence);
  const candidates: TextCandidate[] = possible.slice(0, TEXT_CANDIDATES).map((s) => ({
    catalogItemId: s.item.id,
    name: s.item.canonicalName,
    standardUom: s.item.standardUom,
    confidence: s.score.confidence,
    hinge: s.score.hinge,
  }));

  if (exact.length === 1 && exact[0]) {
    return {
      ...base,
      decision: "matched",
      item: exact[0].item,
      method: "rules",
      confidence: RULE_CONFIDENCE.exact,
    };
  }
  if (input.create && possible.length === 0 && parsed.complete && parsed.category !== "other") {
    const made = await createItem(tx, tenantId, parsed, input.create);
    return {
      ...base,
      decision: made.created ? "new_item" : "matched",
      item: made.item,
      method: "rules",
      confidence: RULE_NEW_ITEM_CONFIDENCE,
    };
  }
  return {
    ...base,
    decision: "unsure",
    item: null,
    method: null,
    confidence: Math.max(0, ...possible.map((s) => s.score.confidence)),
    hinge: parsed.missing[0] ?? candidates[0]?.hinge ?? null,
    candidates,
  };
}
