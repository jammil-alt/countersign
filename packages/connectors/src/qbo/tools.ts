// The qbo connector's tools (ARCHITECTURE §6.2, owner 2026-11-04): reads of bills, purchases,
// vendors, items and attachments, and the MVP writes, each an external action behind approval:
// itemize a bill's or purchase's lines (total unchanged), update its memo, update an item's
// purchase cost, attach a stored document. Every write reads the record with its SyncToken first
// (the before state), refuses a record that changed since the agent read it, runs once under QBO's
// request id, and recognises a write it already made.

import { CurrencyCode, DecimalString, dec, toNumeric } from "@countersign/core";
import { z } from "zod";
import {
  defineReadTool,
  defineWriteTool,
  type ToolContext,
  type ToolDefinition,
  type WriteContext,
} from "../connector";
import { QboApiError, type QboClient, QboStaleObjectError, qboLiteral, qboRequestId } from "./api";
import {
  QboAttachment,
  QboId,
  QboItem,
  QboTxn,
  type QboTxnEntity,
  QboVendor,
  SyncToken,
  toAttachment,
  toItem,
  toTxn,
  toVendor,
  wire,
} from "./records";

export const QBO_TOOLS = {
  purchaseQuery: "qbo.purchase.query",
  billQuery: "qbo.bill.query",
  vendorQuery: "qbo.vendor.query",
  itemQuery: "qbo.item.query",
  attachableList: "qbo.attachable.list",
  billUpdateLines: "qbo.bill.update_lines",
  purchaseUpdateLines: "qbo.purchase.update_lines",
  billUpdateMemo: "qbo.bill.update_memo",
  purchaseUpdateMemo: "qbo.purchase.update_memo",
  itemUpdatePurchaseCost: "qbo.item.update_purchase_cost",
  attachableUpload: "qbo.attachable.upload",
} as const;

/** A write refused because it would change the transaction's total (or its tax). */
export class QboTotalWouldChangeError extends QboApiError {
  constructor(message: string) {
    super(422, "TOTAL_WOULD_CHANGE", message, false);
    this.name = "QboTotalWouldChangeError";
  }
}

export type ClientFor = (ctx: ToolContext) => Promise<QboClient>;

const IsoDate = z.iso.date();
const Page = {
  start: z.number().int().min(1).max(100_000).default(1),
  limit: z.number().int().min(1).max(100).default(25),
};

function where(conds: string[]): string {
  return conds.length > 0 ? ` where ${conds.join(" and ")}` : "";
}

/** `limit + 1` rows are asked for, so `more` is known without a count query. */
async function page<T>(
  client: QboClient,
  entity: string,
  conds: string[],
  input: { start: number; limit: number },
  map: (row: unknown) => T,
  order = "Metadata.LastUpdatedTime desc",
): Promise<{ rows: T[]; more: boolean }> {
  const sql = `select * from ${entity}${where(conds)} orderby ${order} startposition ${input.start} maxresults ${input.limit + 1}`;
  const { rows } = await client.query(sql, entity);
  return { rows: rows.slice(0, input.limit).map(map), more: rows.length > input.limit };
}

function txnQueryTool(entity: QboTxnEntity, clientFor: ClientFor): ToolDefinition {
  const plural = entity === "Bill" ? "bills" : "purchases";
  return defineReadTool({
    id: entity === "Bill" ? QBO_TOOLS.billQuery : QBO_TOOLS.purchaseQuery,
    description:
      entity === "Bill"
        ? "Find bills in QuickBooks by id, vendor, number or date, with their lines and SyncToken."
        : "Find purchases (card charges, checks, cash) in QuickBooks by id, payee or date, with their lines and SyncToken.",
    summary: `Found {{${plural}.length}} ${plural}`,
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      vendorId: QboId.optional(),
      docNumber: z.string().min(1).max(21).optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      ...Page,
    }),
    output: z.object({ [plural]: z.array(QboTxn), more: z.boolean() }) as z.ZodType<
      Record<string, unknown>
    >,
    async run(input, ctx) {
      const conds: string[] = [];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      // UNCHECKED (NOTES.md): Purchase is filtered by EntityRef, Bill by VendorRef.
      if (input.vendorId) {
        conds.push(
          `${entity === "Bill" ? "VendorRef" : "EntityRef"} = ${qboLiteral(input.vendorId)}`,
        );
      }
      if (input.docNumber) conds.push(`DocNumber = ${qboLiteral(input.docNumber)}`);
      if (input.from) conds.push(`TxnDate >= ${qboLiteral(input.from)}`);
      if (input.to) conds.push(`TxnDate <= ${qboLiteral(input.to)}`);
      const client = await clientFor(ctx);
      const { rows, more } = await page(client, entity, conds, input, (r) => toTxn(entity, r));
      return { [plural]: rows, more };
    },
  });
}

// ── Itemizing lines ─────────────────────────────────────────────────────────────────────────────

const NewLine = z
  .object({
    /** An item line (the invoice's product), or … */
    itemId: QboId.optional(),
    /** … an account line. */
    accountId: QboId.optional(),
    description: z.string().max(4000).optional(),
    qty: DecimalString.optional(),
    unitPrice: DecimalString.optional(),
    amount: DecimalString,
  })
  .superRefine((l, ctx) => {
    if ((l.itemId === undefined) === (l.accountId === undefined)) {
      ctx.addIssue({ code: "custom", message: "give exactly one of itemId and accountId" });
      return;
    }
    if (dec(l.amount).isNegative()) {
      ctx.addIssue({ code: "custom", message: "a line's amount can't be negative" });
    }
    if (!dec(l.amount).equals(dec(l.amount).toDecimalPlaces(2))) {
      ctx.addIssue({ code: "custom", message: "a line's amount has at most 2 decimals" });
    }
    if (l.itemId !== undefined) {
      if (l.qty === undefined || l.unitPrice === undefined) {
        ctx.addIssue({ code: "custom", message: "an item line needs qty and unitPrice" });
        return;
      }
      // DECISION: an item line's amount must be qty × unit price rounded half up to cents, as
      // QuickBooks computes it; a mismatch is refused here rather than adjusted by QuickBooks.
      const product = dec(l.qty).times(dec(l.unitPrice)).toDecimalPlaces(2);
      if (!product.equals(dec(l.amount))) {
        ctx.addIssue({
          code: "custom",
          message: `amount ${l.amount} is not qty × unitPrice (${product.toFixed(2)})`,
        });
      }
    } else if (l.qty !== undefined || l.unitPrice !== undefined) {
      ctx.addIssue({ code: "custom", message: "an account line has no qty or unitPrice" });
    }
  });
type NewLine = z.infer<typeof NewLine>;

const UpdateLinesInput = z.object({
  id: QboId,
  /** The SyncToken the agent read: the write is refused if the record changed since. */
  syncToken: SyncToken,
  /** The total the agent read: it must still be the total, and stays the total. */
  expectedTotal: DecimalString,
  currency: CurrencyCode.optional(),
  /** The lines being replaced (usually the one account line), by their QBO line id. */
  replaceLineIds: z.array(QboId).min(1).max(100),
  /** What replaces them, in order (the invoice's item lines). */
  lines: z.array(NewLine).min(1).max(250),
});
type UpdateLinesInput = z.infer<typeof UpdateLinesInput>;

type RawLine = Record<string, unknown> & { Id?: unknown; DetailType?: unknown; Amount?: unknown };

function rawLines(raw: Record<string, unknown>): RawLine[] {
  return Array.isArray(raw.Line) ? (raw.Line as RawLine[]) : [];
}

function sum(values: string[]): string {
  return toNumeric(values.reduce((s, v) => s.plus(dec(v)), dec("0")));
}

/** Job, class, billable status and tax code of the line being replaced, carried onto new lines. */
// DECISION: new lines inherit the first replaced line's customer (job), class, billable status and
// tax code, so itemizing never moves a cost off a job or changes how it is billed.
function inherited(line: RawLine | undefined): Record<string, unknown> {
  const detail = (line?.AccountBasedExpenseLineDetail ?? line?.ItemBasedExpenseLineDetail) as
    | Record<string, unknown>
    | undefined;
  const out: Record<string, unknown> = {};
  for (const k of ["CustomerRef", "ClassRef", "BillableStatus", "TaxCodeRef"]) {
    if (detail?.[k] !== undefined) out[k] = detail[k];
  }
  return out;
}

function wireLine(l: NewLine, inherit: Record<string, unknown>): Record<string, unknown> {
  const base = {
    ...(l.description === undefined ? {} : { Description: l.description }),
    Amount: wire(l.amount),
  };
  if (l.itemId !== undefined) {
    return {
      ...base,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: {
        ...inherit,
        ItemRef: { value: l.itemId },
        Qty: wire(l.qty as string),
        UnitPrice: wire(l.unitPrice as string),
      },
    };
  }
  return {
    ...base,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ...inherit, AccountRef: { value: l.accountId } },
  };
}

/** Whether the record already has exactly the lines this change makes (it ran before). */
// DECISION: QBO may give new lines the ids of the lines they replaced, so a past write is known by
// its result: the record's last lines are exactly the new ones and its total is the one expected.
function alreadyItemized(current: QboTxn, input: UpdateLinesInput): boolean {
  const tail = current.lines.slice(-input.lines.length);
  if (tail.length !== input.lines.length) return false;
  return input.lines.every((want, i) => {
    const have = tail[i];
    if (!have) return false;
    const sameRef =
      want.itemId !== undefined
        ? have.item?.id === want.itemId
        : have.account?.id === want.accountId;
    return (
      sameRef &&
      dec(have.amount).equals(dec(want.amount)) &&
      (want.qty === undefined || (have.qty !== null && dec(have.qty).equals(dec(want.qty)))) &&
      (want.unitPrice === undefined ||
        (have.unitPrice !== null && dec(have.unitPrice).equals(dec(want.unitPrice))))
    );
  });
}

/** Purchase updates carry the payment fields along (NOTES.md: whether QBO needs them on sparse). */
function purchaseKeep(entity: QboTxnEntity, raw: Record<string, unknown>): Record<string, unknown> {
  if (entity !== "Purchase") return {};
  return {
    ...(raw.PaymentType === undefined ? {} : { PaymentType: raw.PaymentType }),
    ...(raw.AccountRef === undefined ? {} : { AccountRef: raw.AccountRef }),
  };
}

async function readTxn(
  client: QboClient,
  entity: QboTxnEntity,
  id: string,
): Promise<{ raw: Record<string, unknown>; txn: QboTxn } | null> {
  const raw = await client.read(entity, id);
  return raw ? { raw, txn: toTxn(entity, raw) } : null;
}

function notFound(entity: string, id: string): QboApiError {
  return new QboApiError(404, "NOT_FOUND", `${entity} ${id} is not in QuickBooks`, false);
}

/** The record changed since the agent read it, and not by this change. */
function stale(entity: string, id: string, read: string, now: string): QboStaleObjectError {
  return new QboStaleObjectError(
    `${entity} ${id} changed in QuickBooks since it was read (SyncToken ${read}, now ${now}); read it again`,
  );
}

/**
 * Why itemizing this record (as read, at the SyncToken the agent read) would be refused: the total
 * is not the one expected, the record has tax, a line to replace isn't there, or the new lines
 * don't add up to the lines they replace. Null when it may go ahead.
 */
function itemizeProblem(txn: QboTxn, input: UpdateLinesInput): QboApiError | null {
  const word = txn.entity === "Bill" ? "bill" : "purchase";
  if (!dec(txn.total).equals(dec(input.expectedTotal))) {
    return new QboTotalWouldChangeError(
      `the ${word}'s total is ${txn.total}, not the ${input.expectedTotal} expected`,
    );
  }
  if (txn.tax !== null && !dec(txn.tax).isZero()) {
    return new QboTotalWouldChangeError(
      `the ${word} has tax (${txn.tax}); itemizing could change it, so it is left to a person`,
    );
  }
  const replaced = txn.lines.filter((l) => l.id !== null && input.replaceLineIds.includes(l.id));
  const missing = input.replaceLineIds.filter((id) => !replaced.some((l) => l.id === id));
  if (missing.length > 0) {
    return new QboApiError(
      422,
      "LINE_NOT_FOUND",
      `the ${word} has no line ${missing.join(", ")}`,
      false,
    );
  }
  const oldSum = sum(replaced.map((l) => l.amount));
  const newSum = sum(input.lines.map((l) => l.amount));
  if (!dec(oldSum).equals(dec(newSum))) {
    return new QboTotalWouldChangeError(
      `the new lines add up to ${newSum} and the lines they replace to ${oldSum}: the total would change`,
    );
  }
  return null;
}

function updateLinesTool(entity: QboTxnEntity, clientFor: ClientFor): ToolDefinition {
  const word = entity === "Bill" ? "bill" : "purchase";
  return defineWriteTool({
    id: entity === "Bill" ? QBO_TOOLS.billUpdateLines : QBO_TOOLS.purchaseUpdateLines,
    description: `Itemize a QuickBooks ${word}: replace lines (usually its one account line) with the invoice's item lines. The total must stay the same, or the change is refused.`,
    verb: "update",
    summary: `Itemized the ${word} into {{lineCount}} lines; total unchanged at {{total}}`,
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    input: UpdateLinesInput,
    output: z.object({
      entity: z.string(),
      id: z.string(),
      syncToken: z.string(),
      total: DecimalString,
      lineCount: z.number().int(),
      alreadyDone: z.boolean(),
    }),
    beforeSchema: QboTxn,
    // DECISION: a change that would move the total is refused when it is proposed, before anyone
    // is asked to approve it, and checked again right before writing.
    async before(input, ctx) {
      const txn = (await readTxn(await clientFor(ctx), entity, input.id))?.txn ?? null;
      if (txn && txn.syncToken === input.syncToken) {
        const problem = itemizeProblem(txn, input);
        if (problem) throw problem;
      }
      return txn;
    },
    async run(input, ctx: WriteContext) {
      const client = await clientFor(ctx);
      const current = await readTxn(client, entity, input.id);
      if (!current) throw notFound(entity, input.id);
      const { raw, txn } = current;
      const done = (t: QboTxn, alreadyDone: boolean) => ({
        entity,
        id: t.id,
        syncToken: t.syncToken,
        total: t.total,
        lineCount: t.lines.length,
        alreadyDone,
      });
      if (txn.syncToken !== input.syncToken) {
        // A retry after QuickBooks took the change but the answer was lost: nothing more to do.
        if (alreadyItemized(txn, input) && dec(txn.total).equals(dec(input.expectedTotal))) {
          ctx.logger.info("lines already itemized", { entity, id: input.id });
          return done(txn, true);
        }
        throw stale(entity, input.id, input.syncToken, txn.syncToken);
      }
      const problem = itemizeProblem(txn, input);
      if (problem) throw problem;
      const lines = rawLines(raw);
      const replaced = lines.filter((l) => input.replaceLineIds.includes(String(l.Id)));
      const inherit = inherited(replaced[0]);
      const kept = lines.filter((l) => !input.replaceLineIds.includes(String(l.Id)));
      const body = {
        Id: txn.id,
        SyncToken: txn.syncToken,
        sparse: true,
        ...purchaseKeep(entity, raw),
        Line: [...kept, ...input.lines.map((l) => wireLine(l, inherit))],
      };
      ctx.logger.info("itemizing lines", { entity, id: txn.id, lines: input.lines.length });
      const answer = (await client.post(`/${entity.toLowerCase()}`, body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as Record<string, unknown>;
      const after = toTxn(entity, answer[entity]);
      if (!dec(after.total).equals(dec(txn.total))) {
        // The checks make this unexpected; if QuickBooks still moved the total, a person looks at
        // it with the before state the action was proposed with.
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks changed the ${word}'s total from ${txn.total} to ${after.total}; check it`,
          false,
        );
      }
      return done(after, false);
    },
  });
}

function updateMemoTool(entity: QboTxnEntity, clientFor: ClientFor): ToolDefinition {
  const word = entity === "Bill" ? "bill" : "purchase";
  return defineWriteTool({
    id: entity === "Bill" ? QBO_TOOLS.billUpdateMemo : QBO_TOOLS.purchaseUpdateMemo,
    description: `Set the memo of a QuickBooks ${word} (its private note). Nothing else changes.`,
    verb: "update",
    summary: `Updated the ${word}'s memo`,
    input: z.object({ id: QboId, syncToken: SyncToken, memo: z.string().max(4000) }),
    output: z.object({
      entity: z.string(),
      id: z.string(),
      syncToken: z.string(),
      memo: z.string().nullable(),
      alreadyDone: z.boolean(),
    }),
    beforeSchema: z.object({
      entity: z.string(),
      id: z.string(),
      syncToken: z.string(),
      memo: z.string().nullable(),
      total: DecimalString,
    }),
    async before(input, ctx) {
      const t = (await readTxn(await clientFor(ctx), entity, input.id))?.txn;
      return t ? { entity, id: t.id, syncToken: t.syncToken, memo: t.memo, total: t.total } : null;
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const current = await readTxn(client, entity, input.id);
      if (!current) throw notFound(entity, input.id);
      const { raw, txn } = current;
      if (txn.memo === input.memo) {
        return { entity, id: txn.id, syncToken: txn.syncToken, memo: txn.memo, alreadyDone: true };
      }
      if (txn.syncToken !== input.syncToken) {
        throw stale(entity, input.id, input.syncToken, txn.syncToken);
      }
      const answer = (await client.post(
        `/${entity.toLowerCase()}`,
        {
          Id: txn.id,
          SyncToken: txn.syncToken,
          sparse: true,
          ...purchaseKeep(entity, raw),
          PrivateNote: input.memo,
        },
        { requestid: await qboRequestId(ctx.idempotencyKey) },
      )) as Record<string, unknown>;
      const after = toTxn(entity, answer[entity]);
      if (!dec(after.total).equals(dec(txn.total))) {
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks changed the ${word}'s total from ${txn.total} to ${after.total}; check it`,
          false,
        );
      }
      return {
        entity,
        id: after.id,
        syncToken: after.syncToken,
        memo: after.memo,
        alreadyDone: false,
      };
    },
  });
}

function updatePurchaseCostTool(clientFor: ClientFor): ToolDefinition {
  const ItemBefore = z.object({
    id: z.string(),
    syncToken: z.string(),
    name: z.string(),
    purchaseCost: DecimalString.nullable(),
  });
  return defineWriteTool({
    id: QBO_TOOLS.itemUpdatePurchaseCost,
    description:
      "Set an item's purchase cost in QuickBooks (what new purchases of it default to). Nothing else changes.",
    verb: "update",
    summary: "Set {{name}}'s purchase cost to {{purchaseCost}}",
    amount: { path: "purchaseCost", currencyPath: "currency", currency: "USD" },
    input: z.object({
      id: QboId,
      syncToken: SyncToken,
      purchaseCost: DecimalString.refine((v) => !dec(v).isNegative(), "can't be negative"),
      currency: CurrencyCode.optional(),
    }),
    output: ItemBefore.extend({ alreadyDone: z.boolean() }),
    beforeSchema: ItemBefore,
    async before(input, ctx) {
      const raw = await (await clientFor(ctx)).read("Item", input.id);
      if (!raw) return null;
      const i = toItem(raw);
      return { id: i.id, syncToken: i.syncToken, name: i.name, purchaseCost: i.purchaseCost };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const raw = await client.read("Item", input.id);
      if (!raw) throw notFound("Item", input.id);
      const i = toItem(raw);
      if (i.purchaseCost !== null && dec(i.purchaseCost).equals(dec(input.purchaseCost))) {
        return { ...pick(i), alreadyDone: true };
      }
      if (i.syncToken !== input.syncToken)
        throw stale("Item", input.id, input.syncToken, i.syncToken);
      const answer = (await client.post(
        "/item",
        // UNCHECKED (NOTES.md): whether a sparse Item update needs Name (sent unchanged).
        {
          Id: i.id,
          SyncToken: i.syncToken,
          sparse: true,
          Name: i.name,
          PurchaseCost: wire(input.purchaseCost),
        },
        { requestid: await qboRequestId(ctx.idempotencyKey) },
      )) as Record<string, unknown>;
      return { ...pick(toItem(answer.Item)), alreadyDone: false };
    },
  });
}

function pick(i: QboItem) {
  return { id: i.id, syncToken: i.syncToken, name: i.name, purchaseCost: i.purchaseCost };
}

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────

const AttachTo = z.enum(["Bill", "Purchase", "VendorCredit"]);

async function attachmentsOf(
  client: QboClient,
  entity: string,
  id: string,
): Promise<QboAttachment[]> {
  const { rows } = await client.query(
    `select * from Attachable where AttachableRef.EntityRef.Type = ${qboLiteral(entity)} and AttachableRef.EntityRef.value = ${qboLiteral(id)} maxresults 100`,
    "Attachable",
  );
  return rows.map(toAttachment);
}

/** Content types QuickBooks takes as attachments that our documents can be. */
const ATTACHABLE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
]);

function uploadTool(clientFor: ClientFor): ToolDefinition {
  return defineWriteTool({
    id: QBO_TOOLS.attachableUpload,
    description:
      "Attach a stored document (the invoice) to a QuickBooks bill, purchase or vendor credit.",
    verb: "create",
    summary: "Attached {{fileName}} to the {{entity}} in QuickBooks",
    input: z.object({
      documentId: z.uuid(),
      entity: AttachTo,
      entityId: QboId,
      note: z.string().max(2000).optional(),
    }),
    output: z.object({
      attachableId: z.string(),
      fileName: z.string(),
      entity: z.string(),
      entityId: z.string(),
      alreadyDone: z.boolean(),
    }),
    beforeSchema: z.object({
      entity: z.string(),
      entityId: z.string(),
      attachments: z.array(QboAttachment),
    }),
    async before(input, ctx) {
      const client = await clientFor(ctx);
      return {
        entity: input.entity,
        entityId: input.entityId,
        attachments: await attachmentsOf(client, input.entity, input.entityId),
      };
    },
    async run(input, ctx) {
      const docs = ctx.services?.documents;
      if (!docs) throw new Error("documents are not available to this call");
      const file = await docs.read(input.documentId);
      if (!file)
        throw new QboApiError(404, "NOT_FOUND", "that document is not this client's", false);
      if (!ATTACHABLE_TYPES.has(file.mimeType)) {
        throw new QboApiError(
          415,
          "UNSUPPORTED_TYPE",
          `QuickBooks can't take a ${file.mimeType}`,
          false,
        );
      }
      const client = await clientFor(ctx);
      if (!(await client.read(input.entity, input.entityId))) {
        throw notFound(input.entity, input.entityId);
      }
      // DECISION: the same file name and size on the same record is the same attachment: a retry
      // after a lost answer, or the agent attaching what is already there, adds nothing.
      const existing = (await attachmentsOf(client, input.entity, input.entityId)).find(
        (a) => a.fileName === file.filename && a.size === file.bytes.length,
      );
      const out = (id: string, alreadyDone: boolean) => ({
        attachableId: id,
        fileName: file.filename,
        entity: input.entity,
        entityId: input.entityId,
        alreadyDone,
      });
      if (existing) return out(existing.id, true);
      const answer = (await client.upload({
        metadata: {
          AttachableRef: [
            { EntityRef: { type: input.entity, value: input.entityId }, IncludeOnSend: false },
          ],
          FileName: file.filename,
          ContentType: file.mimeType,
          ...(input.note ? { Note: input.note } : {}),
        },
        filename: file.filename,
        contentType: file.mimeType,
        bytes: file.bytes,
        requestId: await qboRequestId(ctx.idempotencyKey),
      })) as { AttachableResponse?: { Attachable?: unknown; Fault?: unknown }[] };
      const first = answer.AttachableResponse?.[0];
      if (!first?.Attachable) {
        throw new QboApiError(
          502,
          "UPLOAD_FAILED",
          "QuickBooks did not take the attachment",
          false,
        );
      }
      return out(toAttachment(first.Attachable).id, false);
    },
  });
}

// ── All tools ───────────────────────────────────────────────────────────────────────────────────

export function qboTools(clientFor: ClientFor): ToolDefinition[] {
  return [
    txnQueryTool("Purchase", clientFor),
    txnQueryTool("Bill", clientFor),
    defineReadTool({
      id: QBO_TOOLS.vendorQuery,
      description: "Find vendors in QuickBooks by name, or list them.",
      summary: "Found {{vendors.length}} vendors",
      input: z.object({
        ids: z.array(QboId).min(1).max(30).optional(),
        name: z.string().min(1).max(100).optional(),
        ...Page,
      }),
      output: z.object({ vendors: z.array(QboVendor), more: z.boolean() }),
      async run(input, ctx) {
        const conds: string[] = [];
        if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
        if (input.name) conds.push(`DisplayName like ${qboLiteral(`%${input.name}%`)}`);
        const { rows, more } = await page(
          await clientFor(ctx),
          "Vendor",
          conds,
          input,
          toVendor,
          "DisplayName",
        );
        return { vendors: rows, more };
      },
    }),
    defineReadTool({
      id: QBO_TOOLS.itemQuery,
      description:
        "Find products and services (items) in QuickBooks by name, with their purchase cost.",
      summary: "Found {{items.length}} items",
      input: z.object({
        ids: z.array(QboId).min(1).max(30).optional(),
        name: z.string().min(1).max(100).optional(),
        ...Page,
      }),
      output: z.object({ items: z.array(QboItem), more: z.boolean() }),
      async run(input, ctx) {
        const conds: string[] = [];
        if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
        if (input.name) conds.push(`Name like ${qboLiteral(`%${input.name}%`)}`);
        const { rows, more } = await page(
          await clientFor(ctx),
          "Item",
          conds,
          input,
          toItem,
          "Name",
        );
        return { items: rows, more };
      },
    }),
    defineReadTool({
      id: QBO_TOOLS.attachableList,
      description: "List the attachments on a QuickBooks bill, purchase or vendor credit.",
      summary: "Found {{attachments.length}} attachments",
      input: z.object({ entity: AttachTo, entityId: QboId }),
      output: z.object({ attachments: z.array(QboAttachment) }),
      async run(input, ctx) {
        return {
          attachments: await attachmentsOf(await clientFor(ctx), input.entity, input.entityId),
        };
      },
    }),
    updateLinesTool("Bill", clientFor),
    updateLinesTool("Purchase", clientFor),
    updateMemoTool("Bill", clientFor),
    updateMemoTool("Purchase", clientFor),
    updatePurchaseCostTool(clientFor),
    uploadTool(clientFor),
  ];
}
