// The Purchasing area's Master items profile (docs/step-model-plan.md §7, §10d): what a line, a
// request's line or a bill's line is in the client's master list, run by core's Match engine.
// Hybrid: the vendors' names for the item and its key attributes first (exact), then a shortlist by
// name and meaning (embeddings) a model chooses from. Its never-the-same rule is the catalog's hard
// rule: a key attribute stated differently on both sides (invariant 7). It replaces Find master
// item candidates, Match descriptions to the catalog, Match a request's lines again and Check the
// model's answers (`materials.master_items.candidates`, `materials.catalog.match-text`,
// `materials.request.match-lines`, `materials.matches.check`), whose lookups it reuses.
//
// A person's answer is learned as the vendor's wording for the item (`learnAlias`), so the next line
// in those words is an exact hit; with no vendor there is nothing to learn it by.

import type {
  ProfileCandidate,
  ProfileMatcher,
  ProfileRecord,
  ProfileStore,
} from "@countersign/core";
import { steps } from "@countersign/core";
import { type Tx, vendor, withTenant } from "@countersign/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { anyVendorAlias, vendorCatalogHit } from "../purchasing/match-text";
import { catalogItem } from "../schema";
import { savedUnlessTest } from "../tools";
import { lineEmbeddingText } from "../vendor/pipeline";
import type { MatchContext } from "../vendor/profiles";
import { similarMasterItems } from "../vendor/store";
import { type ParsedLine, parseNormalized, RULE_CONFIDENCE, scorePair } from "./keys";
import { descriptionHash, normalize } from "./normalize";
import type { Attributes } from "./parsers";
import { type CatalogItemRow, findAlias, findCandidates, learnAlias, liveItem } from "./store";

export const MASTER_ITEMS_PROFILE: steps.MatchProfile = steps.MatchProfile.parse({
  id: "master-items",
  name: "Master items",
  area: "purchasing",
  record: "catalog_item",
  source: { kind: "table" },
  input: [
    { name: "description", type: "text", required: true, about: "The item as written" },
    {
      name: "vendorId",
      type: "record",
      record: "vendor",
      required: false,
      about: "The vendor whose words these are, when known",
    },
    { name: "sku", type: "text", required: false, about: "The vendor's SKU, when there is one" },
    { name: "unit", type: "text", required: false, about: "The unit asked or billed in" },
  ],
  keys: [
    { id: "vendor_name", name: "A vendor's SKU or name for it", field: "description" },
    { id: "attributes", name: "Key attributes", field: "description" },
  ],
  semantic: { text: ["description"] },
  types: ["exact", "semantic", "hybrid"],
  neverSame: [{ id: "key_attribute", words: "A key attribute stated differently on each side" }],
  learns: true,
});

/** Names less alike than this (trigram similarity) are no candidates. */
const NAME_FLOOR = 0.15;

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

const itemKeys = (item: Pick<CatalogItemRow, "category" | "attributes">) => ({
  category: item.category,
  attributes: item.attributes as Attributes,
});

/**
 * The catalog's hard rule for a line and an item: the key attribute they state differently (or
 * the line names another category), or null. Words the parsers can't place state nothing.
 */
export function masterNeverSame(
  parsed: Pick<ParsedLine, "category" | "attributes">,
  item: Pick<CatalogItemRow, "category" | "attributes">,
): string | null {
  if (parsed.category === "other") return null;
  return scorePair(parsed, itemKeys(item)).confidence <= RULE_CONFIDENCE.veto
    ? "key_attribute"
    : null;
}

/** The one item the rules say a line is by its key attributes (every one equal), or null. */
export function attributesHit<T extends Pick<CatalogItemRow, "category" | "attributes">>(
  parsed: Pick<ParsedLine, "category" | "attributes">,
  items: readonly T[],
): T[] {
  return items.filter((i) => scorePair(parsed, itemKeys(i)).confidence >= RULE_CONFIDENCE.exact);
}

function masterRecord(item: CatalogItemRow, sources: string[] = []): ProfileRecord {
  const values: Record<string, string> = { category: item.category, unit: item.standardUom };
  for (const [k, v] of Object.entries((item.attributes ?? {}) as Attributes)) {
    if (typeof v === "string" && v) values[k] = v;
  }
  return { id: item.id, label: item.canonicalName, values, sources: [item.id, ...sources] };
}

interface Reading {
  normalized: string;
  hash: string;
  parsed: ParsedLine;
}

async function abbreviationsOf(tx: Tx, tenantId: string, vendorId: string | null) {
  if (!vendorId) return {};
  const [row] = await tx
    .select({ ext: vendor.ext })
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, vendorId)))
    .limit(1);
  const a = (row?.ext as { abbreviations?: unknown } | undefined)?.abbreviations;
  return a && typeof a === "object" ? (a as Record<string, string>) : {};
}

/** The master items' store for one call. */
export function masterItemsStore(ctx: MatchContext): ProfileStore {
  const read = <T>(work: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, work);
  const readings = new Map<string, Reading>();
  const vendorOf = (item: Readonly<Record<string, unknown>>) => text(item.vendorId);
  // The line read once per call: normalized with the vendor's abbreviations, hashed, parsed.
  const reading = async (tx: Tx, item: Readonly<Record<string, unknown>>): Promise<Reading> => {
    const description = text(item.description) ?? "";
    const vendorId = vendorOf(item);
    const k = `${vendorId ?? ""}\u0000${description}`;
    const seen = readings.get(k);
    if (seen) return seen;
    const normalized = normalize(description, {
      abbreviations: await abbreviationsOf(tx, ctx.tenantId, vendorId),
    });
    const r = {
      normalized,
      hash: await descriptionHash(normalized),
      parsed: parseNormalized(normalized),
    };
    readings.set(k, r);
    return r;
  };
  return {
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const item = await read((tx) => liveItem(tx, ctx.tenantId, id));
      return item && item.id === id ? masterRecord(item) : null;
    },
    async byKey(key, item) {
      return read(async (tx) => {
        const r = await reading(tx, item);
        if (key.id === "vendor_name") {
          // A vendor item's SKU or exact name (§1.189), with the catalog's hard rules and the pack
          // size checked; two master items named is no hit.
          const hit = await vendorCatalogHit(
            tx,
            ctx.tenantId,
            {
              description: text(item.description) ?? "",
              vendorId: vendorOf(item),
              vendorSku: text(item.sku),
              unit: text(item.unit),
            },
            r.parsed,
          );
          return hit ? [masterRecord(hit.item, hit.vendorItem ? [hit.vendorItem.id] : [])] : [];
        }
        if (r.parsed.category === "other") return [];
        const found = await findCandidates(tx, ctx.tenantId, r.parsed);
        return attributesHit(
          r.parsed,
          found.map((c) => c.item),
        ).map((i) => masterRecord(i));
      });
    },
    async learned(item) {
      return read(async (tx) => {
        const r = await reading(tx, item);
        const vendorId = vendorOf(item);
        // DECISION: the learned name is the wording only (a SKU is the Vendor items profile's);
        // with no vendor, every vendor's wording for these words when they all name one item.
        const hit = vendorId
          ? (
              await findAlias(tx, ctx.tenantId, {
                vendorId,
                vendorSku: null,
                descriptionHash: r.hash,
              })
            )?.item
          : await anyVendorAlias(tx, ctx.tenantId, r.hash);
        return hit ? [masterRecord(hit)] : [];
      });
    },
    async shortlist(item, limit) {
      const r = await read((tx) => reading(tx, item));
      // The line's meaning, made between transactions; none without a model, or when the client's
      // compliance mode refuses the embedding vendor: the names still give a shortlist.
      // DECISION: a failed embedding is no failure of the match (as Sales' and the vendor search).
      let vector: number[] | null = null;
      if (ctx.llm) {
        try {
          const e = await ctx.llm.embed({
            texts: [lineEmbeddingText(text(item.description) ?? "", r.parsed)],
            label: "match:master-items",
          });
          vector = e.embeddings[0] ?? null;
        } catch {
          vector = null;
        }
      }
      return read(async (tx) => {
        const out = new Map<string, ProfileCandidate>();
        const add = (i: CatalogItemRow, similarity: number | null) => {
          const rules = scorePair(r.parsed, itemKeys(i)).confidence;
          const score = Math.max(rules, similarity ?? 0);
          const at = out.get(i.id);
          if (!at || at.score < score) out.set(i.id, { ...masterRecord(i), score });
        };
        for (const c of await findCandidates(tx, ctx.tenantId, r.parsed, { trigramLimit: limit })) {
          add(c.item, c.similarity);
        }
        // DECISION: names across every category too (a line the parsers place in none, or in the
        // wrong one, still finds its item), the closest first; the never-the-same rule still holds.
        const sim = sql<number>`similarity(${catalogItem.canonicalName}, ${r.normalized})`;
        const byName = await tx
          .select({ item: catalogItem, sim })
          .from(catalogItem)
          .where(
            and(
              eq(catalogItem.tenantId, ctx.tenantId),
              isNull(catalogItem.mergedIntoId),
              sql`${sim} > ${NAME_FLOOR}`,
            ),
          )
          .orderBy(desc(sim), asc(catalogItem.id))
          .limit(limit);
        for (const n of byName) add(n.item, Number(n.sim));
        if (vector) {
          for (const s of await similarMasterItems(tx, ctx.tenantId, vector, {
            category: r.parsed.category === "other" ? undefined : r.parsed.category,
            limit,
          })) {
            add(s.item, s.similarity);
          }
        }
        return [...out.values()]
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, limit);
      });
    },
    async neverSame(item, record) {
      return read(async (tx) => {
        const r = await reading(tx, item);
        const live = await liveItem(tx, ctx.tenantId, record.id);
        return live ? masterNeverSame(r.parsed, live) : null;
      });
    },
    async learn(item, recordId) {
      const vendorId = vendorOf(item);
      if (!vendorId || !text(item.description)) return false;
      const r = await read((tx) => reading(tx, item));
      return savedUnlessTest(ctx, async (tx) => {
        const live = await liveItem(tx, ctx.tenantId, recordId);
        if (!live) return false;
        await learnAlias(tx, ctx.tenantId, {
          vendorId,
          vendorSku: null,
          descriptionHash: r.hash,
          normalizedDescription: r.normalized,
          catalogItemId: live.id,
          source: "human",
        });
        return true;
      });
    },
  };
}

export const MASTER_ITEMS_MATCHER: ProfileMatcher<MatchContext> = {
  profile: MASTER_ITEMS_PROFILE,
  store: masterItemsStore,
};
