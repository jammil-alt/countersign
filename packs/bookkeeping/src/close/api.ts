// The Close pack's card and report (docs/plan.md §1.232). On the card a person sees the month's
// checklist and its journal entries; they waive a line with a reason (or take the waiver back), turn
// down an entry whose write isn't waiting, and sign the month off once every line is done or waived
// and every entry decided. The report is the client's closes and one month in full, for the portal
// and the back office: one client's, with no agent, prompt or cost (invariant 11).

import { type Tx, withTenant } from "@countersign/db";
import { z } from "zod";
import { asReview, type CardDecision, type PackReviewHandler } from "../pack";
import { type CloseDecision, closeList, closeView, decideClose } from "./store";

export const CLOSE_REVIEW = "close.signoff";

const Id = z.uuid();
const Payload = z.object({ periodId: Id });
const Decision = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("waive"),
    input: z.strictObject({ itemId: Id, note: z.string().trim().min(1).max(500) }),
  }),
  z.strictObject({ action: z.literal("unwaive"), input: z.strictObject({ itemId: Id }) }),
  z.strictObject({ action: z.literal("reject"), input: z.strictObject({ entryId: Id }) }),
  z.strictObject({
    action: z.literal("sign_off"),
    input: z.strictObject({ note: z.string().max(1000).nullable().optional() }),
  }),
]);

export const CLOSE_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  [CLOSE_REVIEW]: {
    async load(tx, tenantId, payload) {
      const p = Payload.parse(payload);
      return { close: await closeView(tx, tenantId, p.periodId) };
    },
    async decide(db, input) {
      if (input.testRun) return;
      await asReview(async () => {
        const p = Payload.parse(input.payload);
        const d = Decision.parse(input.decision as CardDecision) as CloseDecision;
        await withTenant(db, input.tenantId, (tx) =>
          decideClose(tx, { tenantId: input.tenantId, userId: input.userId }, p.periodId, d),
        );
      });
    },
  },
};

/** The report's query: one month by its id; the latest when absent. */
const Query = z.object({ periodId: Id.optional() });

/** A report as apps/api's generic report routes call it, with its query. */
export interface CloseReportHandler {
  title: string;
  query: z.ZodType;
  json(
    tx: Tx,
    tenantId: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string, query: Record<string, unknown>): Promise<string>;
  item(tx: Tx, tenantId: string, id: string): Promise<Record<string, unknown> | null>;
}

async function closeReport(tx: Tx, tenantId: string, query: Record<string, unknown>) {
  const q = Query.parse(query);
  const periods = await closeList(tx, tenantId);
  const id = q.periodId ?? periods[0]?.id ?? null;
  return { periods, close: id ? await closeView(tx, tenantId, id) : null };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // A cell starting with a formula character is quoted and prefixed, so a spreadsheet reads text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CLOSE_REPORTS: Readonly<Record<string, CloseReportHandler>> = {
  close: {
    title: "Month-end close",
    query: Query,
    json: async (tx, tenantId, _today, query) => closeReport(tx, tenantId, query),
    async csv(tx, tenantId, _today, query) {
      const r = await closeReport(tx, tenantId, query);
      const head = ["period_end", "line", "status", "amount", "count", "summary", "note"];
      const rows = (r.close?.items ?? []).map((i) =>
        [r.close?.period.periodEnd, i.title, i.status, i.amount, i.count, i.summary, i.note]
          .map(csvCell)
          .join(","),
      );
      const entries = (r.close?.entries ?? []).map((e) =>
        [r.close?.period.periodEnd, `Entry: ${e.memo}`, e.status, e.amount, 1, e.reason, e.qboId]
          .map(csvCell)
          .join(","),
      );
      return `${[head.join(","), ...rows, ...entries].join("\n")}\n`;
    },
    item: async (tx, tenantId, id) => {
      const parsed = Id.safeParse(id);
      if (!parsed.success) return null;
      const close = await closeView(tx, tenantId, parsed.data);
      return close ? { close } : null;
    },
  },
};
