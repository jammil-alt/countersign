// Matching a free description to the client's catalog (ARCHITECTURE §12.3) when there is no
// document line: a request line as someone asked for it, or a QuickBooks bill line. Deterministic
// only: the vendor's alias (with no vendor, every vendor's description alias when they agree),
// then the attribute rules over the candidates. A description the rules aren't sure of comes back
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
  liveItem,
} from "../catalog/store";
import { itemAlias } from "../schema";

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
async function anyVendorAlias(
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

export interface MatchTextInput {
  description: string;
  vendorId?: string | null | undefined;
  vendorSku?: string | null | undefined;
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
  const base = { parsed, normalized, hash, hinge: null, candidates: [] };

  const aliased = input.vendorId
    ? (
        await findAlias(tx, tenantId, {
          vendorId: input.vendorId,
          vendorSku: input.vendorSku?.trim().toUpperCase() || null,
          descriptionHash: hash,
        })
      )?.item
    : await anyVendorAlias(tx, tenantId, hash);
  if (aliased) {
    return { ...base, decision: "matched", item: aliased, method: "alias", confidence: 1 };
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
