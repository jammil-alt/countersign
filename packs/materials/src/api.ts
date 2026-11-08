// The pack's API surface (ARCHITECTURE §12.1: a pack exports its routes' handlers): its reports,
// as JSON and CSV, and its inbox review card, the match review. apps/api mounts them under the
// platform's generic pack routes (/api/reports/:pack/:report, /api/inbox/:id/pack-review) and
// does the sign-in, roles and client scope; these get one client's transaction or database.

import type { Db, Tx } from "@countersign/db";
import { z } from "zod";
import { decideLine } from "./catalog/match";
import { mergeItems } from "./catalog/merge";
import { backfillFromBills } from "./purchasing/backfill";
import { requestsCsv, requestsReport } from "./purchasing/report";
import { catalogCsv, catalogReport, priceWatch, priceWatchCsv, reviewLines } from "./reports";

export interface PackReportHandler {
  title: string;
  json(tx: Tx, tenantId: string, today: string): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string): Promise<string>;
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
  // P-5: purchase requests with their quotes and orders (docs/plan.md §1.67); no screen yet.
  requests: {
    title: "Purchase requests",
    json: async (tx, tenantId) => ({ ...(await requestsReport(tx, tenantId)) }),
    csv: async (tx, tenantId) => requestsCsv(await requestsReport(tx, tenantId)),
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
      decision: ReviewDecision;
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
      const p = MatchReviewPayload.parse(input.payload);
      if (!p.docLineIds.includes(input.decision.docLineId)) {
        throw new ReviewError("that line isn't part of this review");
      }
      if (input.decision.action === "skip") return;
      if (input.decision.action === "match" && !input.decision.catalogItemId) {
        throw new ReviewError("say which catalog item the line is");
      }
      await decideLine(db, {
        tenantId: input.tenantId,
        docLineId: input.decision.docLineId,
        userId: input.userId,
        decision: input.decision.action === "match" ? "matched" : "new_item",
        catalogItemId: input.decision.catalogItemId,
        testRun: input.testRun,
      });
    },
  },
};
