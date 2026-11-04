import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { DocumentDetail, DocumentSummary } from "./documents";

// Record pages (docs/plan.md §1.16): what a source id (invariant 10) names, in both surfaces, and
// the back office's view of a client's documents. Alerts, step outputs and messages cite records by
// id; these routes say what each one is, its fields and where it came from. The portal reads only
// its own client's records; the back office one served client's at a time.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** The kinds of record a source id can name. An extraction's page is its document's. */
export const RECORD_KINDS = ["transaction", "raw_record", "document", "vendor"] as const;
export const RecordKind = z.enum(RECORD_KINDS);
export type RecordKind = z.infer<typeof RecordKind>;

const TransactionBrief = z.object({
  id: z.string(),
  txnKind: z.string(),
  txnDate: z.string().nullable(),
  total: z.string(),
  currency: z.string(),
});

export const TransactionRecord = z.object({
  kind: z.literal("transaction"),
  id: z.string(),
  /** purchase, bill or vendor_credit. */
  txnKind: z.string(),
  /** The connector it came from (`upload`, `qbo`, …) and its id there. */
  connector: z.string(),
  externalId: z.string(),
  vendor: z.object({ id: z.string(), name: z.string() }).nullable(),
  txnDate: z.string().nullable(),
  total: z.string(),
  currency: z.string(),
  purchaserRef: z.string().nullable(),
  paymentType: z.string().nullable(),
  memo: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  lines: z.array(
    z.object({
      lineNo: z.number(),
      detailType: z.string(),
      accountRef: z.string().nullable(),
      itemRef: z.string().nullable(),
      description: z.string().nullable(),
      qty: z.string().nullable(),
      unitPrice: z.string().nullable(),
      amount: z.string(),
    }),
  ),
  /** Documents linked to it (the invoice or receipt behind it). */
  documents: z.array(z.object({ id: z.string(), filename: z.string(), status: z.string() })),
  /** The raw record it was made from. */
  rawRecordId: z.string().nullable(),
});

export const RawRecordView = z.object({
  kind: z.literal("raw_record"),
  id: z.string(),
  connector: z.string(),
  /** What the tool calls it: `Purchase` (a CSV row), `delivery` (a webhook), a QBO entity. */
  entityType: z.string(),
  externalId: z.string(),
  externalVersion: z.string().nullable(),
  syncedAt: z.string(),
  isDeleted: z.boolean(),
  /** As it arrived from the client's tool or file. */
  payload: z.unknown(),
  /** Transactions made from it. */
  transactions: z.array(TransactionBrief),
});

export const DocumentRecord = z.object({
  kind: z.literal("document"),
  /** The id asked for: the document's, or one of its extractions'. */
  id: z.string(),
  documentId: z.string(),
  filename: z.string(),
  status: z.string(),
  source: z.string(),
  receivedAt: z.string(),
});

export const VendorRecord = z.object({
  kind: z.literal("vendor"),
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  createdAt: z.string(),
  /** Its most recent transactions, newest first. */
  transactions: z.array(TransactionBrief),
});

export const RecordView = z.discriminatedUnion("kind", [
  TransactionRecord,
  RawRecordView,
  DocumentRecord,
  VendorRecord,
]);
export type RecordView = z.infer<typeof RecordView>;

/** How many of a vendor's transactions its page lists. */
export const VENDOR_RECENT_TRANSACTIONS = 20;

export const recordRoutes = {
  portalRecord: defineRoute({
    method: "GET",
    path: "/api/records/:id",
    auth: "session",
    roles: CLIENT,
    summary: "One of your records, by the id a run or message cites: its kind, fields and source",
    params: z.object({ id: Id }),
    response: z.object({ record: RecordView }),
  }),
  opsClientRecord: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/records/:recordId",
    auth: "session",
    roles: OPS,
    summary: "A client's record, by the id a run or message cites: its kind, fields and source",
    params: z.object({ id: Id, recordId: Id }),
    response: z.object({ record: RecordView }),
  }),
  opsClientDocuments: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/documents",
    auth: "session",
    roles: OPS,
    summary: "A client's documents, newest first: uploaded, forwarded and from its tools",
    params: z.object({ id: Id }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: z.object({ documents: z.array(DocumentSummary) }),
  }),
  opsClientDocument: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/documents/:documentId",
    auth: "session",
    roles: OPS,
    summary: "A client's document: a 5-minute link to the file and its latest extraction",
    params: z.object({ id: Id, documentId: Id }),
    response: DocumentDetail,
  }),
} as const;
