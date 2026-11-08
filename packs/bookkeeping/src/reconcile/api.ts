// R-1 (docs/plan.md §1.80): the reconciliation card and report. On the card a person sees the two
// numbers, what matched, what is left with its label and the model's proposals; they accept or
// reject a proposal, match or unmatch items, relabel, add what one side is missing, and sign off
// once nothing is unexplained. A test run's card changes nothing.

import { type Tx, withTenant } from "@countersign/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  asReview,
  type CardDecision,
  type PackReportHandler,
  type PackReviewHandler,
} from "../pack";
import { RECONCILIATION_LABELS, RECONCILIATION_SIDES, reconciliation } from "../schema";
import { decideReconciliation, type PersonDecision, reconciliationView } from "./store";

export const RECONCILIATION_REVIEW = "bookkeeping.reconciliation";

const Id = z.uuid();
const Payload = z.object({ reconciliationId: Id });
const Decision = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), input: z.strictObject({ matchId: Id }) }),
  z.strictObject({ action: z.literal("reject"), input: z.strictObject({ matchId: Id }) }),
  z.strictObject({
    action: z.literal("match"),
    input: z.strictObject({
      aItemIds: z.array(Id).min(1).max(50),
      bItemIds: z.array(Id).min(1).max(50),
      reason: z.string().max(500).nullable().optional(),
    }),
  }),
  z.strictObject({ action: z.literal("unmatch"), input: z.strictObject({ matchId: Id }) }),
  z.strictObject({
    action: z.literal("label"),
    input: z.strictObject({ itemId: Id, label: z.enum(RECONCILIATION_LABELS).nullable() }),
  }),
  z.strictObject({
    action: z.literal("add-item"),
    input: z.strictObject({
      side: z.enum(RECONCILIATION_SIDES),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd")
        .nullable()
        .optional(),
      effect: z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/, "an amount, like -12.50"),
      description: z.string().min(1).max(500),
    }),
  }),
  z.strictObject({
    action: z.literal("sign-off"),
    input: z.strictObject({ note: z.string().max(500).nullable().optional() }),
  }),
]);

export const RECONCILE_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  [RECONCILIATION_REVIEW]: {
    async load(tx, tenantId, payload) {
      const p = Payload.parse(payload);
      return { reconciliation: await reconciliationView(tx, tenantId, p.reconciliationId) };
    },
    async decide(db, input) {
      if (input.testRun) return;
      await asReview(async () => {
        const p = Payload.parse(input.payload);
        const d = Decision.parse(input.decision as CardDecision) as PersonDecision;
        await withTenant(db, input.tenantId, (tx) =>
          decideReconciliation(
            tx,
            { tenantId: input.tenantId, userId: input.userId },
            p.reconciliationId,
            d,
          ),
        );
      });
    },
  },
};

const REPORT_ROWS = 200;

async function reconciliationsReport(tx: Tx, tenantId: string) {
  const rows = await tx
    .select()
    .from(reconciliation)
    .where(and(eq(reconciliation.tenantId, tenantId), ne(reconciliation.status, "superseded")))
    .orderBy(desc(reconciliation.asOf), desc(reconciliation.createdAt))
    .limit(REPORT_ROWS);
  return {
    reconciliations: rows.map((r) => ({
      id: r.id,
      asOf: r.asOf,
      periodStart: r.periodStart,
      aLabel: r.aLabel,
      bLabel: r.bLabel,
      aClosing: r.aClosing,
      bClosing: r.bClosing,
      difference: r.difference,
      residual: r.residual,
      currency: r.currency,
      outcome: r.outcome,
      status: r.status,
      signedOffAt: r.signedOffAt?.toISOString() ?? null,
    })),
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // A cell starting with a formula character is quoted and prefixed, so a spreadsheet reads text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const RECONCILE_REPORTS: Readonly<Record<string, PackReportHandler>> = {
  reconciliations: {
    title: "Reconciliations",
    json: async (tx, tenantId) => ({ ...(await reconciliationsReport(tx, tenantId)) }),
    async csv(tx, tenantId) {
      const r = await reconciliationsReport(tx, tenantId);
      const head = [
        "as_of",
        "side_a",
        "balance_a",
        "side_b",
        "balance_b",
        "difference",
        "unexplained",
        "currency",
        "outcome",
        "status",
      ];
      const lines = r.reconciliations.map((x) =>
        [
          x.asOf,
          x.aLabel,
          x.aClosing,
          x.bLabel,
          x.bClosing,
          x.difference,
          x.residual,
          x.currency,
          x.outcome,
          x.status,
        ]
          .map(csvCell)
          .join(","),
      );
      return `${[head.join(","), ...lines].join("\n")}\n`;
    },
    item: async (tx, tenantId, id) => {
      try {
        return { reconciliation: await reconciliationView(tx, tenantId, id) };
      } catch {
        return null;
      }
    },
  },
};
