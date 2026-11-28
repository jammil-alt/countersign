// Two of the Purchasing area's match profiles (docs/step-model-plan.md §7, §10d), run by core's
// Match engine (`@countersign/core`'s `matchWithProfile`):
//
//   Vendors       the client's vendors (the shared `vendor` table): accounting id, tax id, email
//                 domain, then name; hybrid allowed (names by trigram, a model choosing). Replaces
//                 Match the vendor (`materials.vendor.match`), whose lookups it reuses.
//   Vendor items  one vendor's catalog: a SKU match or nothing (owner, 2026-11-25). The vendor's
//                 past wording is not a key; a SKU this vendor printed before for the item, or a
//                 person taught, is a learned name. Replaces Look up by SKU
//                 (`materials.vendor_items.lookup`).
//
// Every read is one client's (invariant 1); a learned name is a Save to our records, which a test
// run rolls back (`savedUnlessTest`).

import {
  normalizeVendorName,
  type ProfileMatcher,
  type ProfileRecord,
  type ProfileStore,
  steps,
} from "@countersign/core";
import { type Tx, vendor, withTenant } from "@countersign/db";
import { and, asc, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import { parseNormalized } from "../catalog/keys";
import { normalize } from "../catalog/normalize";
import { identifyingSku, liveItem, skuContradicts, taughtCode } from "../catalog/store";
import { itemAlias } from "../schema";
import { type PackToolContext, savedUnlessTest } from "../tools";
import { cleanSku, type VendorItemRow, vendorItemById, vendorItemBySku } from "./store";

/** What a profile's store needs of a call: one client, its database and model, test or live. */
export type MatchContext = Pick<PackToolContext, "tenantId" | "db" | "llm" | "mode">;

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

// ── Vendors ──────────────────────────────────────────────────────────────────────────────────────

export const VENDORS_PROFILE: steps.MatchProfile = steps.MatchProfile.parse({
  id: "vendors",
  name: "Vendors",
  area: "shared",
  record: "vendor",
  source: { kind: "table" },
  input: [
    {
      name: "accountingId",
      type: "text",
      required: false,
      about: "The vendor's id in the client's accounting system",
    },
    { name: "taxId", type: "text", required: false, about: "The vendor's tax id (EIN, VAT)" },
    {
      name: "email",
      type: "text",
      required: false,
      about: "An email address the vendor sent from",
    },
    { name: "name", type: "text", required: false, about: "The vendor's name as written" },
  ],
  keys: [
    { id: "accounting_id", name: "Accounting id", field: "accountingId" },
    { id: "tax_id", name: "Tax id", field: "taxId" },
    { id: "email_domain", name: "Email domain", field: "email" },
    { id: "name", name: "Name", field: "name" },
  ],
  semantic: { text: ["name"] },
  types: ["exact", "semantic", "hybrid"],
  neverSame: [
    { id: "tax_id", words: "Two different tax ids" },
    { id: "accounting_id", words: "Two different ids in the accounting system" },
  ],
  learns: true,
});

const taxKey = (s: string | null | undefined) =>
  (s ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const domainOf = (email: string | null): string | null => {
  const at = (email ?? "").lastIndexOf("@");
  const d =
    at < 0
      ? ""
      : (email ?? "")
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return d || null;
};

type VendorRow = typeof vendor.$inferSelect;

function vendorRecord(v: VendorRow): ProfileRecord {
  const ext = (v.ext ?? {}) as { taxId?: unknown };
  const values: Record<string, string> = {};
  if (typeof ext.taxId === "string" && ext.taxId) values.taxId = ext.taxId;
  if (v.aliases.length > 0) values.otherNames = v.aliases.slice(0, 5).join(", ");
  return { id: v.id, label: v.name, values, sources: [v.id] };
}

/** The vendors' store for one call. */
export function vendorsStore(ctx: MatchContext): ProfileStore {
  const rows = new Map<string, VendorRow>();
  const read = <T>(work: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, work);
  const keep = (found: VendorRow[]) => {
    for (const v of found) rows.set(v.id, v);
    return found.map(vendorRecord);
  };
  const where = (...c: SQL[]) => and(eq(vendor.tenantId, ctx.tenantId), ...c);
  const row = async (id: string) =>
    rows.get(id) ??
    (await read(async (tx) => {
      const [v] = await tx
        .select()
        .from(vendor)
        .where(where(sql`${vendor.id} = ${id}`))
        .limit(1);
      if (v) rows.set(v.id, v);
      return v ?? null;
    }));
  return {
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const v = await row(id);
      return v ? vendorRecord(v) : null;
    },
    async byKey(key, item) {
      const value = text(item[key.field]);
      if (!value) return [];
      return keep(
        await read(async (tx) => {
          if (key.id === "accounting_id") {
            return tx
              .select()
              .from(vendor)
              .where(
                where(
                  sql`exists (select 1 from jsonb_each_text(${vendor.externalRefs}) e where e.value = ${value})`,
                ),
              )
              .limit(5);
          }
          if (key.id === "tax_id") {
            // A tax id shorter than five characters names nothing (as Match the vendor had it).
            if (taxKey(value).length < 5) return [];
            return tx
              .select()
              .from(vendor)
              .where(
                where(
                  sql`upper(regexp_replace(coalesce(${vendor.ext} ->> 'taxId', ''), '[^0-9A-Za-z]', '', 'g')) = ${taxKey(value)}`,
                ),
              )
              .limit(5);
          }
          if (key.id === "email_domain") {
            const domain = domainOf(value);
            if (!domain) return [];
            return tx
              .select()
              .from(vendor)
              .where(where(sql`${vendor.ext} -> 'domains' ? ${domain}`))
              .limit(5);
          }
          const name = normalizeVendorName(value);
          if (!name) return [];
          return tx
            .select()
            .from(vendor)
            .where(where(sql`${vendor.normalizedName} = ${name}`))
            .limit(5);
        }),
      );
    },
    async learned(item) {
      const name = normalizeVendorName(text(item.name) ?? "");
      if (!name) return [];
      return keep(
        await read((tx) =>
          tx
            .select()
            .from(vendor)
            .where(where(sql`${name} = any(${vendor.aliases})`))
            .limit(5),
        ),
      );
    },
    async shortlist(item, limit) {
      const name = normalizeVendorName(text(item.name) ?? "");
      if (!name) return [];
      const sim = sql<number>`similarity(${vendor.normalizedName}, ${name})`;
      const found = await read((tx) =>
        tx
          .select({ v: vendor, sim })
          .from(vendor)
          .where(where(sql`${vendor.normalizedName} % ${name}`))
          .orderBy(desc(sim), asc(vendor.id))
          .limit(limit),
      );
      for (const f of found) rows.set(f.v.id, f.v);
      return found.map((f) => ({ ...vendorRecord(f.v), score: Number(f.sim) }));
    },
    async neverSame(item, record) {
      const v = await row(record.id);
      if (!v) return null;
      const theirs = taxKey((v.ext as { taxId?: string } | null)?.taxId);
      const ours = taxKey(text(item.taxId));
      if (ours.length >= 5 && theirs.length >= 5 && ours !== theirs) return "tax_id";
      const accountingId = text(item.accountingId);
      const refs = Object.values((v.externalRefs ?? {}) as Record<string, unknown>).map(String);
      if (accountingId && refs.length > 0 && !refs.includes(accountingId)) return "accounting_id";
      return null;
    },
    async learn(item, recordId) {
      const name = normalizeVendorName(text(item.name) ?? "");
      if (!name) return false;
      return savedUnlessTest(ctx, async (tx) => {
        // A name that is another vendor's own is never taught to this one.
        const [own] = await tx
          .select({ id: vendor.id })
          .from(vendor)
          .where(where(sql`${vendor.normalizedName} = ${name}`, ne(vendor.id, recordId)))
          .limit(1);
        if (own) return false;
        // A person's answer moves the name: no other vendor keeps it.
        await tx
          .update(vendor)
          .set({ aliases: sql`array_remove(${vendor.aliases}, ${name})` })
          .where(where(sql`${name} = any(${vendor.aliases})`, ne(vendor.id, recordId)));
        const updated = await tx
          .update(vendor)
          .set({ aliases: sql`array_append(${vendor.aliases}, ${name})` })
          .where(
            where(
              sql`${vendor.id} = ${recordId}`,
              sql`${vendor.normalizedName} <> ${name}`,
              sql`not (${name} = any(${vendor.aliases}))`,
            ),
          )
          .returning({ id: vendor.id });
        return updated.length > 0;
      });
    },
  };
}

export const VENDORS_MATCHER: ProfileMatcher<MatchContext> = {
  profile: VENDORS_PROFILE,
  store: vendorsStore,
};

// ── Vendor items ─────────────────────────────────────────────────────────────────────────────────

export const VENDOR_ITEMS_PROFILE: steps.MatchProfile = steps.MatchProfile.parse({
  id: "vendor-items",
  name: "Vendor items",
  area: "purchasing",
  record: "vendor_item",
  source: { kind: "table" },
  input: [
    { name: "vendorId", type: "record", record: "vendor", required: true, about: "The vendor" },
    { name: "sku", type: "text", required: true, about: "The vendor's SKU for the item" },
    {
      name: "description",
      type: "text",
      required: false,
      about: "The line's words: never matched on, only checked against the item",
    },
  ],
  // An invoice's line as read (`docs.read-document`) names its SKU `vendorSku`.
  keys: [{ id: "sku", name: "SKU", field: "sku", also: ["vendorSku"] }],
  types: ["exact"],
  neverSame: [
    { id: "vendor", words: "Another vendor's item" },
    {
      id: "words",
      words: "The line's own words state a key attribute differently from the item's",
    },
  ],
  learns: true,
});

function vendorItemRecord(v: VendorItemRow, masterName?: string | null): ProfileRecord {
  const values: Record<string, string> = {};
  if (v.sku) values.sku = v.sku;
  if (masterName) values.masterItem = masterName;
  return { id: v.id, label: v.name, values, sources: [v.id, v.catalogItemId] };
}

/** The SKU a line's code is looked up by: a SKU that names one item, else none (`identifyingSku`). */
/**
 * The code a line names its item by: its `sku`, or, for a line as an invoice is read
 * (`docs.read-document`'s lines), its `vendorSku`.
 */
// Staging, 2026-11-28: a SKU match given an invoice's lines as they were read found nothing, since
// the reader hands the code on as `vendorSku`.
const rawSku = (item: Readonly<Record<string, unknown>>) =>
  cleanSku(text(item.sku) || text(item.vendorSku));

const skuOf = (item: Readonly<Record<string, unknown>>) => identifyingSku(rawSku(item));

/** The vendor items' store for one call. */
export function vendorItemsStore(ctx: MatchContext): ProfileStore {
  const read = <T>(work: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, work);
  const vendorOf = (item: Readonly<Record<string, unknown>>) => text(item.vendorId);
  return {
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const v = await read((tx) => vendorItemById(tx, ctx.tenantId, id));
      return v ? vendorItemRecord(v) : null;
    },
    async byKey(_key, item) {
      const vendorId = vendorOf(item);
      const sku = skuOf(item);
      if (!vendorId || !sku) return [];
      const v = await read((tx) => vendorItemBySku(tx, ctx.tenantId, vendorId, sku));
      return v ? [vendorItemRecord(v)] : [];
    },
    // DECISION: a learned name for a vendor item is a SKU only, never its wording (§7): a SKU this
    // vendor printed for the item before (kept when its line was registered), or a code a person
    // taught. An alias kept before the vendor catalog, naming no vendor item, names nothing here.
    async learned(item) {
      const vendorId = vendorOf(item);
      const raw = rawSku(item);
      if (!vendorId || !raw) return [];
      const sku = identifyingSku(raw);
      const taught = sku ? null : taughtCode(raw);
      if (!sku && !taught) return [];
      return read(async (tx) => {
        const hits = await tx
          .select({ vendorItemId: itemAlias.vendorItemId })
          .from(itemAlias)
          .where(
            and(
              eq(itemAlias.tenantId, ctx.tenantId),
              eq(itemAlias.vendorId, vendorId),
              eq(itemAlias.vendorSku, (sku ?? taught) as string),
              sql`${itemAlias.descriptionHash} is null`,
              ...(sku ? [] : [eq(itemAlias.source, "human")]),
            ),
          )
          .limit(5);
        const out: ProfileRecord[] = [];
        for (const h of hits) {
          if (!h.vendorItemId) continue;
          const v = await vendorItemById(tx, ctx.tenantId, h.vendorItemId);
          if (v) out.push({ ...vendorItemRecord(v), sources: [v.id, v.catalogItemId] });
        }
        return out;
      });
    },
    async neverSame(item, record) {
      return read(async (tx) => {
        const v = await vendorItemById(tx, ctx.tenantId, record.id);
        if (!v) return null;
        if (vendorOf(item) && v.vendorId !== vendorOf(item)) return "vendor";
        const words = text(item.description);
        if (!words) return null;
        const master = await liveItem(tx, ctx.tenantId, v.catalogItemId);
        if (!master) return null;
        // A SKU never outvotes the line's own words (audit 7.10, as Look up by SKU had it).
        const parsed = parseNormalized(normalize(words));
        return (await skuContradicts(tx, ctx.tenantId, parsed, master)) ? "words" : null;
      });
    },
    async learn(item, recordId) {
      const vendorId = vendorOf(item);
      const raw = rawSku(item);
      // A person's answer keeps a short code too, never a generic one (`taughtCode`).
      const sku = raw ? (identifyingSku(raw) ?? taughtCode(raw)) : null;
      if (!vendorId || !sku) return false;
      return savedUnlessTest(ctx, async (tx) => {
        const v = await vendorItemById(tx, ctx.tenantId, recordId);
        if (!v || v.vendorId !== vendorId) return false;
        await tx.execute(sql`
          insert into item_alias
            (tenant_id, vendor_id, vendor_sku, description_hash, normalized_description,
             catalog_item_id, source, vendor_item_id)
          values (${ctx.tenantId}, ${vendorId}, ${sku}, null, ${v.name.toLowerCase()},
                  ${v.catalogItemId}, 'human', ${v.id})
          on conflict (tenant_id, vendor_id, coalesce(vendor_sku, ''), coalesce(description_hash, ''))
          do update set vendor_item_id = excluded.vendor_item_id,
                        catalog_item_id = excluded.catalog_item_id,
                        source = 'human',
                        updated_at = now()`);
        return true;
      });
    },
  };
}

export const VENDOR_ITEMS_MATCHER: ProfileMatcher<MatchContext> = {
  profile: VENDOR_ITEMS_PROFILE,
  store: vendorItemsStore,
};
