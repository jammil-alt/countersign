import { z } from "zod";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import { defineRoute } from "./contract";
import { DocumentDetail, DocumentSummary } from "./documents";

// Record pages (docs/plan.md §1.16): what a source id (invariant 10) names, in both surfaces, and
// the back office's view of a client's documents and records. Alerts, step outputs and messages cite
// records by id; these routes say what each one is, its fields and where it came from. The portal
// reads only its own client's records; the back office one served client's at a time, and lists
// them (the portal has no list).

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

/**
 * `config.accountName`, which a connector may set at sign-in (QuickBooks: the company's name): what
 * a person knows the connection by. Null when the connector set none.
 */
export function connectionAccountName(config: unknown): string | null {
  const v = isPlainObject(config) ? config.accountName : undefined;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

// The back office's Records page: what a client's connections brought in, by kind. Transactions
// and vendors are the shared records sync maps into; items are the tool's own (QuickBooks keeps
// them as raw records), so an item row's id is its latest raw record's.

export const RECORD_LIST_KINDS = ["transactions", "vendors", "items"] as const;
export const RecordListKind = z.enum(RECORD_LIST_KINDS);
export type RecordListKind = z.infer<typeof RecordListKind>;

/** Rows per page when the request names no limit. */
export const RECORD_LIST_PAGE = 50;

/** A connection records came through. */
export const RecordSource = z.object({
  id: z.string(),
  connector: z.string(),
  /** The connector's name (`QuickBooks Online`). */
  connectorName: z.string(),
  /** The company name the connector set (connectionAccountName), else null. */
  accountName: z.string().nullable(),
  /** The account's id in the tool: a QuickBooks realm id. */
  externalAccountId: z.string().nullable(),
  status: z.string(),
  lastSyncAt: z.string().nullable(),
});
export type RecordSource = z.infer<typeof RecordSource>;

export const RecordListTransaction = z.object({
  id: z.string(),
  /** purchase, bill or vendor_credit. */
  txnKind: z.string(),
  txnDate: z.string().nullable(),
  vendor: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** The tool's document number (a bill's number), when it has one. */
  docNumber: z.string().nullable(),
  memo: z.string().nullable(),
  total: z.string(),
  currency: z.string(),
  lines: z.number().int(),
  /** Documents linked to it. */
  attachments: z.number().int(),
  /** When its latest version arrived (its creation, for one made without a raw record). */
  syncedAt: z.string(),
  /** The connection it came through, by id (`sources`); null when none is known. */
  sourceId: z.string().nullable(),
  /** Deleted in the tool it came from; kept because documents and runs point at it. */
  deleted: z.boolean(),
});
export type RecordListTransaction = z.infer<typeof RecordListTransaction>;

export const RecordListVendor = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /** Its transactions, all time. */
  transactions: z.number().int(),
  /** Its id in the tool it was synced from, when it was. */
  externalId: z.string().nullable(),
  sourceId: z.string().nullable(),
  /** When its latest version arrived from a tool; null for a vendor made here (from an upload). */
  syncedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type RecordListVendor = z.infer<typeof RecordListVendor>;

export const RecordListItem = z.object({
  /** Its latest raw record's id (the record page shows it as it arrived). */
  id: z.string(),
  externalId: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  /** The tool's item type (`Inventory`, `NonInventory`, `Service`). */
  type: z.string().nullable(),
  description: z.string().nullable(),
  /** What the client pays for it, as the tool has it (no currency: the company's own). */
  purchaseCost: z.string().nullable(),
  active: z.boolean(),
  deleted: z.boolean(),
  sourceId: z.string(),
  syncedAt: z.string(),
});
export type RecordListItem = z.infer<typeof RecordListItem>;

export const RecordListPage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transactions"), rows: z.array(RecordListTransaction) }),
  z.object({ kind: z.literal("vendors"), rows: z.array(RecordListVendor) }),
  z.object({ kind: z.literal("items"), rows: z.array(RecordListItem) }),
]);

export const RecordList = z.object({
  /** Each kind's count, for the source asked for (all when none); the search doesn't change them. */
  counts: z.object({
    transactions: z.number().int(),
    vendors: z.number().int(),
    items: z.number().int(),
  }),
  /** The latest sync among the sources counted. */
  lastSyncAt: z.string().nullable(),
  /** The client's connections that brought records in, for the source filter and the rows. */
  sources: z.array(RecordSource),
  /** Rows of the asked kind matching the search and source. */
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  page: RecordListPage,
});
export type RecordList = z.infer<typeof RecordList>;

/** The portal's records list (v0.12 W1-H): the back office's query without the source filter. */
export const PortalRecordListQuery = z.object({
  kind: RecordListKind.optional(),
  /** Matches a doc number, memo, vendor or name, or an amount. */
  q: z.string().trim().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const recordRoutes = {
  // v0.12 W1-H: the portal's records list (docs/plan.md §1.43).
  portalRecords: defineRoute({
    method: "GET",
    path: "/api/records",
    auth: "session",
    roles: CLIENT,
    summary:
      "Your records, newest first: the transactions, vendors and items your tools brought in, with counts and a search",
    query: PortalRecordListQuery,
    response: RecordList,
  }),
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
  opsClientRecords: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/records",
    auth: "session",
    roles: OPS,
    summary:
      "What a client's connections brought in, newest first: transactions, vendors or items, with counts, a search and a source filter",
    params: z.object({ id: Id }),
    query: z.object({
      kind: RecordListKind.optional(),
      /** Matches a doc number, memo, vendor or name, or an amount. */
      q: z.string().trim().max(200).optional(),
      /** A connection id. */
      source: Id.optional(),
      offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
    response: RecordList,
  }),
  opsClientDocuments: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/documents",
    auth: "session",
    roles: OPS,
    summary: "A client's documents, newest first: uploaded, forwarded and from its tools",
    params: z.object({ id: Id }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: z.object({
      documents: z.array(DocumentSummary),
      /** The Sandbox client: the operator uploads its documents from the back office. */
      sandbox: z.boolean(),
    }),
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
