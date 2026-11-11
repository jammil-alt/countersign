// The pack's API surface (ARCHITECTURE §12.1: a pack exports its routes' handlers): its reports,
// as JSON and CSV, and its inbox review card, the match review. apps/api mounts them under the
// platform's generic pack routes (/api/reports/:pack/:report, /api/inbox/:id/pack-review) and
// does the sign-in, roles and client scope; these get one client's transaction or database.

import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { decideLine } from "./catalog/match";
import { mergeItems } from "./catalog/merge";
import { backfillFromBills } from "./purchasing/backfill";
import { requestsCsv, requestsReport } from "./purchasing/report";
// P-9
import {
  decideRequestLine,
  decideVendorChoice,
  REQUEST_LINES_REVIEW,
  requestLinesView,
  requestPage,
  VENDOR_CHOICE_REVIEW,
  vendorChoiceView,
} from "./purchasing/reviews";
import { catalogCsv, catalogReport, priceWatch, priceWatchCsv, reviewLines } from "./reports";
import { vendorItem } from "./schema";
import {
  discontinue,
  setPreferred,
  VendorItemError,
  vendorCatalog,
  vendorItemView,
  vendorsForItem,
} from "./vendor/store";

export interface PackReportHandler {
  title: string;
  json(tx: Tx, tenantId: string, today: string): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string): Promise<string>;
  /** P-9: one row in full (e.g. one purchase request); null when it isn't this client's. */
  item?(
    tx: Tx,
    tenantId: string,
    id: string,
    today: string,
  ): Promise<Record<string, unknown> | null>;
}

export const MATERIALS_REPORTS: Readonly<Record<string, PackReportHandler>> = {
  prices: {
    title: "Price watch",
    json: async (tx, tenantId, today) => ({ ...(await priceWatch(tx, tenantId, { today })) }),
    csv: async (tx, tenantId, today) => priceWatchCsv(await priceWatch(tx, tenantId, { today })),
  },
  catalog: {
    title: "Catalog",
    json: async (tx, tenantId) => ({ ...(await catalogReport(tx, tenantId)) }),
    csv: async (tx, tenantId) => catalogCsv(await catalogReport(tx, tenantId)),
  },
  // §1.88: the vendor catalog, back office only (apps/api lets the portal read only the reports
  // its screens name). The list is every vendor with its items; an item is one vendor's catalog.
  "vendor-catalog": {
    title: "Vendor catalog",
    json: async (tx, tenantId) => ({ vendors: await vendorCatalogIndex(tx, tenantId) }),
    csv: async (tx, tenantId) => vendorCatalogCsv(await vendorCatalogIndex(tx, tenantId)),
    item: async (tx, tenantId, vendorId) => {
      const [v] = await tx
        .select({ id: vendor.id, name: vendor.name })
        .from(vendor)
        .where(and(eq(vendor.id, vendorId), eq(vendor.tenantId, tenantId)))
        .limit(1);
      if (!v) return null;
      return {
        vendor: v,
        items: await vendorCatalog(tx, tenantId, vendorId, { includeDiscontinued: true }),
      };
    },
  },
  // §1.88: a master item's vendors side by side, in its standard unit (an item: the master item).
  "master-vendors": {
    title: "Master item vendors",
    json: async (tx, tenantId) => ({ vendors: await vendorCatalogIndex(tx, tenantId) }),
    csv: async (tx, tenantId) => vendorCatalogCsv(await vendorCatalogIndex(tx, tenantId)),
    item: async (tx, tenantId, catalogItemId) => {
      try {
        return {
          ...(await vendorsForItem(tx, tenantId, catalogItemId, { includeDiscontinued: true })),
        };
      } catch (error) {
        if (error instanceof VendorItemError && error.code === "not_found") return null;
        throw error;
      }
    },
  },
  // P-5: purchase requests with their quotes and orders (docs/plan.md §1.67); no screen yet.
  requests: {
    title: "Purchase requests",
    json: async (tx, tenantId) => ({ ...(await requestsReport(tx, tenantId)) }),
    csv: async (tx, tenantId) => requestsCsv(await requestsReport(tx, tenantId)),
    // P-9: one request's page (docs/plan.md §1.71).
    item: async (tx, tenantId, id, today) => {
      const page = await requestPage(tx, tenantId, id, today);
      return page ? { request: page } : null;
    },
  },
};

/** A back-office action on one client's pack data (a person's, never an agent's). */
export interface PackActionHandler {
  input: z.ZodType;
  run(
    db: Db,
    ctx: { tenantId: string; userId: string; input: unknown },
  ): Promise<Record<string, unknown>>;
}

// P-9: at most this many pages of 500 bills in one import (20,000 bills); more: run it again.
export const IMPORT_PAGES_MAX = 40;

/**
 * Every synced QuickBooks bill dated in the range into catalog items and prices, page after page
 * (`next`), at most IMPORT_PAGES_MAX pages. Safe to run again: a bill line is priced once. A
 * person's action, so the items and prices are theirs.
 */
export async function importBillPrices(
  db: Db,
  who: { tenantId: string; userId: string },
  input: { from: string; to: string },
  pageSize = 500,
): Promise<Record<string, unknown>> {
  const totals = {
    bills: 0,
    recorded: 0,
    alreadyRecorded: 0,
    matched: 0,
    newItems: 0,
    needsReview: 0,
    skipped: 0,
    accountLines: 0,
  };
  let after: string | undefined;
  let pages = 0;
  let more = false;
  do {
    const r = await backfillFromBills(
      db,
      // No agent version: the import is the person's (backfill attributes it to userId).
      {
        tenantId: who.tenantId,
        agentVersionId: "",
        userId: who.userId,
        runId: null,
        testRun: false,
      },
      { from: input.from, to: input.to, limit: pageSize, ...(after ? { after } : {}) },
    );
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
    pages++;
    after = r.next ?? undefined;
    more = r.next !== null;
  } while (more && pages < IMPORT_PAGES_MAX);
  return { ...totals, from: input.from, to: input.to, pages, more };
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");

export const MATERIALS_ACTIONS: Readonly<Record<string, PackActionHandler>> = {
  // The back office's catalog merge (ARCHITECTURE §12.2 "plus catalog merge"): mergeItems
  // refuses different categories or units (invariant 7) and moves aliases and price history.
  "merge-items": {
    input: z.strictObject({ fromId: z.uuid(), intoId: z.uuid() }),
    async run(db, ctx) {
      const input = ctx.input as { fromId: string; intoId: string };
      return {
        ...(await mergeItems(db, { tenantId: ctx.tenantId, userId: ctx.userId, ...input })),
      };
    },
  },
  // §1.88: the vendor catalog's back-office changes: the client's first choice for a master
  // item, and an item the vendor no longer sells. A person's, so the audit row names them.
  "vendor-item-preferred": {
    input: z.strictObject({ vendorItemId: z.uuid() }),
    run: (db, ctx) =>
      vendorRefusal(() =>
        withTenant(db, ctx.tenantId, async (tx) => {
          const r = await setPreferred(
            tx,
            ctx.tenantId,
            (ctx.input as { vendorItemId: string }).vendorItemId,
          );
          return { item: vendorItemView(r.item), cleared: r.cleared };
        }),
      ),
  },
  "vendor-item-discontinue": {
    input: z.strictObject({ vendorItemId: z.uuid() }),
    run: (db, ctx) =>
      vendorRefusal(() =>
        withTenant(db, ctx.tenantId, async (tx) => ({
          item: vendorItemView(
            await discontinue(
              tx,
              ctx.tenantId,
              (ctx.input as { vendorItemId: string }).vendorItemId,
            ),
          ),
        })),
      ),
  },
  // P-9: "Import bill prices" in the back office (docs/plan.md §1.71).
  "import-bill-prices": {
    input: z
      .strictObject({ from: Day, to: Day })
      .refine((v) => v.from <= v.to, { message: "`from` is after `to`" }),
    run: (db, ctx) =>
      importBillPrices(db, { tenantId: ctx.tenantId, userId: ctx.userId }, ctx.input as never),
  },
};

export interface ReviewDecision {
  docLineId: string;
  action: "match" | "new_item" | "skip";
  catalogItemId?: string | undefined;
}

/** P-9: another card's decision, checked by its own handler. */
export interface CardDecision {
  action: string;
  input: Record<string, unknown>;
}

export interface PackReviewHandler {
  load(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  decide(
    db: Db,
    input: {
      tenantId: string;
      userId: string;
      payload: Record<string, unknown>;
      decision: ReviewDecision | CardDecision;
      testRun: boolean;
    },
  ): Promise<void>;
}

export class ReviewError extends Error {
  override name = "ReviewError";
}

const MatchReviewPayload = z.object({
  documentId: z.string().optional(),
  docLineIds: z.array(z.string()).max(500),
});

/**
 * The match review (ARCHITECTURE §12.2 "Match review in the Inbox"): the lines Pia wasn't sure of,
 * with the candidates she weighed. A person's Match or New item is a human decision
 * (`decideLine`), which teaches the vendor's alias so the line never needs review again.
 */
// DECISION: Skip records nothing: the line stays unsure and gets no price; the card counts it as
// done for this review, and the item's resolution lists the lines skipped.
export const MATERIALS_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  "materials.match": {
    async load(tx, tenantId, payload) {
      const p = MatchReviewPayload.parse(payload);
      return {
        documentId: p.documentId ?? null,
        lines: await reviewLines(tx, tenantId, p.docLineIds),
      };
    },
    async decide(db, input) {
      if (!("docLineId" in input.decision)) throw new ReviewError("decide a line of the review");
      const decision = input.decision;
      const p = MatchReviewPayload.parse(input.payload);
      if (!p.docLineIds.includes(decision.docLineId)) {
        throw new ReviewError("that line isn't part of this review");
      }
      if (decision.action === "skip") return;
      if (decision.action === "match" && !decision.catalogItemId) {
        throw new ReviewError("say which catalog item the line is");
      }
      await decideLine(db, {
        tenantId: input.tenantId,
        docLineId: decision.docLineId,
        userId: input.userId,
        decision: decision.action === "match" ? "matched" : "new_item",
        catalogItemId: decision.catalogItemId,
        testRun: input.testRun,
      });
    },
  },
  // P-9: the request's unsure lines, and the choice of vendor (docs/plan.md §1.71).
  [REQUEST_LINES_REVIEW]: {
    load: (tx, tenantId, payload) => requestLinesView(tx, tenantId, payload),
    decide: (db, input) => reviewError(() => decideRequestLine(db, input)),
  },
  [VENDOR_CHOICE_REVIEW]: {
    load: (tx, tenantId, payload) => vendorChoiceView(tx, tenantId, payload),
    decide: (db, input) => reviewError(() => decideVendorChoice(db, input)),
  },
};

/** A refusal the route answers as 422 (its `PackRefusal`), from the vendor catalog's errors. */
class PackRefusal extends Error {
  override name = "PackRefusal";
}

async function vendorRefusal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof VendorItemError) throw new PackRefusal(error.message);
    throw error;
  }
}

/** Every vendor with items in the client's vendor catalog: counts and the last price's date. */
export async function vendorCatalogIndex(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({
      vendorId: vendor.id,
      name: vendor.name,
      items: sql<number>`count(*) filter (where ${vendorItem.status} = 'active')::int`,
      discontinued: sql<number>`count(*) filter (where ${vendorItem.status} = 'discontinued')::int`,
      preferred: sql<number>`count(*) filter (where ${vendorItem.preferred})::int`,
      lastPriceOn: sql<string | null>`max(${vendorItem.lastPriceOn})::text`,
    })
    .from(vendorItem)
    .innerJoin(
      vendor,
      and(eq(vendor.id, vendorItem.vendorId), eq(vendor.tenantId, vendorItem.tenantId)),
    )
    .where(eq(vendorItem.tenantId, tenantId))
    .groupBy(vendor.id, vendor.name)
    .orderBy(asc(vendor.name));
  return rows.map((r) => ({
    ...r,
    items: Number(r.items),
    discontinued: Number(r.discontinued),
    preferred: Number(r.preferred),
  }));
}

function vendorCatalogCsv(rows: Awaited<ReturnType<typeof vendorCatalogIndex>>): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    "vendor,items,discontinued,preferred,last_price_on",
    ...rows.map((r) =>
      [r.name, r.items, r.discontinued, r.preferred, r.lastPriceOn].map(cell).join(","),
    ),
  ].join("\n");
}

/** The pack's refusals and bad input as the card's 422. */
async function reviewError(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReviewError(error.issues.map((i) => i.message).join("; "));
    }
    if (error instanceof Error && error.name === "PurchasingError") {
      throw new ReviewError(error.message);
    }
    throw error;
  }
}
