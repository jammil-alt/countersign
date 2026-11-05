// The documents capability behind the `docs.*` tools (DocumentsPort), over packages/documents.
// Reads and links run in one client-scoped transaction each; extraction holds none across the
// model call (packages/documents' extractDocument). A test run's extraction and links emit no
// events.

import type { ContentStore, UrlSigner } from "@countersign/connectors";
import { Decimal } from "@countersign/core";
import { type Db, withTenant } from "@countersign/db";
import {
  type DocumentView,
  extractDocument,
  findSupport,
  getDocument,
  matchBill,
} from "@countersign/documents";
import { createLlmClient, type LlmCallRecord, type LlmTransport } from "@countersign/llm";
import type { DocumentForTool, DocumentsPort } from "../tools/types";

export interface DbDocumentsOptions {
  content: ContentStore;
  /** The model transport extraction uses (the run's: live, or replay in tests). */
  transport: LlmTransport;
  /** Signs 5-minute links to originals; without one, `url` is null. */
  signer?: UrlSigner | null;
}

/** A document view as tools and the API show it, with a signed link to the file. */
export async function documentForTool(
  view: DocumentView,
  signer: UrlSigner | null | undefined,
): Promise<DocumentForTool> {
  const d = view.document;
  const x = view.extraction;
  return {
    id: d.id,
    source: d.source,
    filename: d.filename,
    mimeType: d.mimeType,
    status: d.status,
    pageCount: d.pageCount,
    transactionId: d.transactionId,
    receivedAt: d.receivedAt.toISOString(),
    url: signer ? await signer.signedGetUrl(d.storageKey) : null,
    extraction: x && {
      id: x.id,
      model: x.model,
      header: x.header,
      subtotal: x.subtotal,
      freight: x.freight,
      surcharges: x.surcharges,
      tax: x.tax,
      total: x.total,
      totalsMatch: x.totalsMatch,
      problems: x.problems,
      lines: x.lines.map((l) => ({
        lineNo: l.lineNo,
        vendorSku: l.vendorSku,
        description: l.rawDescription,
        qty: l.qty,
        uom: l.uomRaw,
        unitPrice: l.unitPrice,
        extPrice: l.extPrice,
        page: l.page,
      })),
    },
  };
}

function usageOf(record: LlmCallRecord) {
  const tokensIn =
    record.usage.inputTokens + record.usage.cacheWriteTokens + record.usage.cacheReadTokens;
  return {
    costUsd: new Decimal(record.costUsd ?? "0").toFixed(6),
    tokensIn,
    tokensOut: record.usage.outputTokens,
  };
}

export function dbDocumentsPort(db: Db, options: DbDocumentsOptions): DocumentsPort {
  return {
    async get(tenantId, documentId) {
      const view = await withTenant(db, tenantId, (tx) => getDocument(tx, tenantId, documentId));
      return view ? documentForTool(view, options.signer) : null;
    },

    async extract(tenantId, input) {
      const r = await extractDocument(
        { db, content: options.content, llm: createLlmClient({ transport: options.transport }) },
        {
          tenantId,
          documentId: input.documentId,
          agentVersionId: input.agentVersionId,
          testRun: input.testRun,
          onCall: async (record) => {
            await input.recordUsage?.(usageOf(record));
          },
        },
      );
      return {
        documentId: r.documentId,
        extractionId: r.extractionId,
        status: r.status,
        totalsMatch: r.totalsMatch,
        problems: r.problems,
        lineCount: r.lineCount,
        vendorName: r.extraction.header.vendorName,
        invoiceNumber: r.extraction.header.invoiceNumber,
        invoiceDate: r.extraction.header.invoiceDate,
        total: r.extraction.total,
        inboxItemId: r.inboxItemId,
      };
    },

    findSupport(tenantId, input) {
      return withTenant(db, tenantId, (tx) =>
        findSupport(tx, tenantId, input.transactionId, { testRun: input.testRun }),
      );
    },

    matchBill(tenantId, input) {
      return withTenant(db, tenantId, (tx) => matchBill(tx, tenantId, input));
    },
  };
}
