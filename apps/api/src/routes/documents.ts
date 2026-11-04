// Documents, uploads and email forwarding in the portal (ARCHITECTURE §6.3, §6.5, §7, §14), the
// connector list, and the Worker-signed file links. Uploads and forwarding go through the client's
// built-in upload connection. A new document is read in the background when a model key is
// configured (DECISION below); otherwise it waits for an agent's `docs.extract`.

import { documentForTool } from "@countersign/agents";
import {
  ContentStore,
  documentMimeType,
  ensureUploadConnection,
  forwardingAddress,
  forwardingOf,
  forwardingStatsOf,
  importPurchasesCsv,
  isDocumentType,
  newForwardingSecret,
  normalizeSender,
  PurchasesCsvError,
  type UploadConnectionRow,
  updateForwarding,
} from "@countersign/connectors";
import { type ExtractedHeader, routes } from "@countersign/core";
import { docExtraction, document, type Tx, tenant, withTenant } from "@countersign/db";
import {
  DocumentError,
  type DocumentRow,
  extractDocument,
  getDocument,
  linkToTransaction,
  storeDocument,
} from "@countersign/documents";
import { createLlmClient } from "@countersign/llm";
import { type EventRow, emit } from "@countersign/senses";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound, type Services } from "../http";
import { dispatchEvents } from "../runs/dispatch";
import { signerFor, verifyFileToken } from "../storage";

/** At most this many files in one upload request. */
export const MAX_UPLOAD_FILES = 20;
const SIGNED_TTL_MS = 300_000;

type ExtractionRow = typeof docExtraction.$inferSelect;

function isCsv(file: File): boolean {
  const t = file.type.toLowerCase();
  return t === "text/csv" || t === "application/csv" || file.name.toLowerCase().endsWith(".csv");
}

export function documentSummary(d: DocumentRow, x: ExtractionRow | null) {
  const header = (x?.header ?? null) as Partial<ExtractedHeader> | null;
  return {
    id: d.id,
    source: d.source,
    filename: d.filename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    status: d.status,
    pageCount: d.pageCount,
    transactionId: d.transactionId,
    receivedAt: d.receivedAt.toISOString(),
    vendorName: header?.vendorName ?? null,
    invoiceNumber: header?.invoiceNumber ?? null,
    total: x?.total ?? null,
  };
}

async function latestExtractions(tx: Tx, tenantId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, ExtractionRow>();
  const rows = await tx
    .select()
    .from(docExtraction)
    .where(and(eq(docExtraction.tenantId, tenantId), inArray(docExtraction.documentId, ids)))
    .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id));
  const out = new Map<string, ExtractionRow>();
  for (const r of rows) if (!out.has(r.documentId)) out.set(r.documentId, r);
  return out;
}

function contentOf(services: Services): ContentStore {
  return new ContentStore(services.deps.objects(services.env));
}

/**
 * Reads new documents and links them, after the response. Each extraction is its own work: a
 * failure leaves that document `failed` and goes on. Events it emits are dispatched by the cron.
 */
// DECISION: an uploaded or forwarded document is extracted at once (ARCHITECTURE §6.3: unlinked
// documents still extract) when the deployment has a model key, with no agent version
// (doc_extraction.agent_version_id null), then linked by vendor + total + date. Agents re-extract
// through `docs.extract` when they need their own reading.
export async function extractInBackground(
  services: Pick<Services, "db" | "env" | "deps">,
  tenantId: string,
  documentIds: readonly string[],
): Promise<void> {
  const transport = services.deps.extractionTransport(services.env);
  if (!transport || documentIds.length === 0) return;
  const content = new ContentStore(services.deps.objects(services.env));
  const llm = createLlmClient({ transport });
  for (const documentId of documentIds) {
    try {
      await extractDocument({ db: services.db, content, llm }, { tenantId, documentId });
      await withTenant(services.db, tenantId, (tx) => linkToTransaction(tx, tenantId, documentId));
    } catch (error) {
      console.error(`extracting document ${documentId} failed`, error);
    }
  }
}

async function forwardingView(
  tx: Tx,
  services: Services,
  tenantId: string,
  row: UploadConnectionRow,
  actorId: string | null,
) {
  const domain = services.env.EMAIL_FORWARDING_DOMAIN?.trim().toLowerCase();
  let conn = row;
  // DECISION: a client's forwarding address is made the first time its portal asks for it (once
  // the deployment has a forwarding domain), so every client gets one without an extra step.
  if (domain && !forwardingOf(conn).address) {
    const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
    const address = forwardingAddress({
      tenantId,
      clientName: t?.name ?? "client",
      secret: newForwardingSecret(),
      domain,
    });
    conn = await updateForwarding(tx, conn, { address }, actorId);
  }
  const f = forwardingOf(conn);
  const s = forwardingStatsOf(conn);
  return {
    available: Boolean(domain),
    // An address on another domain (the domain changed) is not shown.
    address: domain && f.address?.endsWith(`@${domain}`) ? f.address : null,
    allowedSenders: f.allowedSenders,
    accepted: s.accepted,
    dropped: s.dropped,
    lastReceivedAt: s.lastReceivedAt,
    lastDroppedAt: s.lastDroppedAt,
    lastDropReason: s.lastDropReason,
  };
}

export function documentRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalUploads, async ({ c, tx, tenantIds, session, services, defer }) => {
    const tenantId = tenantIds[0] as string;
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new HttpError(400, "invalid_request", "send the files as multipart/form-data");
    }
    const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (files.length === 0) throw new HttpError(400, "invalid_request", "no files in `files`");
    if (files.length > MAX_UPLOAD_FILES) {
      throw new HttpError(400, "invalid_request", `at most ${MAX_UPLOAD_FILES} files at once`);
    }
    const content = contentOf(services);
    const conn = await ensureUploadConnection(tx, tenantId);
    const events: EventRow[] = [];
    const extract: string[] = [];
    const results = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const base = {
        filename: file.name,
        document: null,
        created: false,
        purchases: null,
        error: null,
      };
      if (isCsv(file)) {
        try {
          const r = await importPurchasesCsv(tx, {
            tenantId,
            connectionId: conn.id,
            filename: file.name,
            bytes,
          });
          for (const t of r.created) {
            const row = await emit(tx, {
              tenantId,
              type: "transaction.created",
              subjectId: t.id,
              payload: {
                transactionId: t.id,
                source: t.connector,
                vendorId: t.vendorId,
                total: { amount: t.total, currency: t.currency },
                txnDate: t.txnDate,
              },
            });
            if (row) events.push(row);
          }
          results.push({
            ...base,
            kind: "purchases" as const,
            created: r.created.length > 0,
            purchases: {
              rows: r.rows,
              created: r.created.length,
              duplicates: r.duplicates,
              errors: r.errors,
            },
          });
        } catch (error) {
          if (!(error instanceof PurchasesCsvError)) throw error;
          results.push({ ...base, kind: "refused" as const, error: error.message });
        }
        continue;
      }
      const mimeType = documentMimeType(file.type, file.name);
      if (!isDocumentType(mimeType)) {
        results.push({
          ...base,
          kind: "refused" as const,
          error: "Upload PDFs, images (PNG, JPEG, GIF, WebP) or a CSV of purchases.",
        });
        continue;
      }
      try {
        const stored = await storeDocument(tx, content, {
          tenantId,
          source: "upload",
          connectionId: conn.id,
          bytes,
          filename: file.name,
          mimeType,
          meta: { uploadedBy: session.user.id },
        });
        if (stored.event) events.push(stored.event);
        if (stored.created) extract.push(stored.document.id);
        results.push({
          ...base,
          kind: "document" as const,
          document: documentSummary(stored.document, null),
          created: stored.created,
        });
      } catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        results.push({ ...base, kind: "refused" as const, error: error.message });
      }
    }
    if (events.length > 0) {
      defer(() => dispatchEvents({ db: services.db, instances: services.instances }, events));
    }
    if (extract.length > 0) defer(() => extractInBackground(services, tenantId, extract));
    return { results };
  });

  mount(app, routes.portalDocuments, async ({ tx, tenantIds, query }) => {
    const tenantId = tenantIds[0] as string;
    const docs = await tx
      .select()
      .from(document)
      .where(eq(document.tenantId, tenantId))
      .orderBy(desc(document.receivedAt))
      .limit(query.limit ?? 50);
    const latest = await latestExtractions(
      tx,
      tenantId,
      docs.map((d) => d.id),
    );
    return { documents: docs.map((d) => documentSummary(d, latest.get(d.id) ?? null)) };
  });

  mount(app, routes.portalDocument, async ({ c, tx, tenantIds, params, services }) => {
    const tenantId = tenantIds[0] as string;
    const view = await getDocument(tx, tenantId, params.id);
    if (!view) throw notFound("document");
    const origin = new URL(c.req.url).origin;
    const signer = signerFor(services.env, origin, () => view.document.filename);
    const tool = await documentForTool(view, signer);
    const x = view.extraction;
    const header = (x?.header ?? {}) as Partial<ExtractedHeader>;
    // Only what was printed and the checks on it: model names and costs stay out of the portal.
    const meta = view.document.meta as { email?: Record<string, unknown> };
    return {
      document: {
        ...documentSummary(view.document, x),
        meta: meta.email
          ? { email: { from: meta.email.from, subject: meta.email.subject, date: meta.email.date } }
          : {},
      },
      url: tool.url as string,
      urlExpiresAt: new Date(Date.now() + SIGNED_TTL_MS).toISOString(),
      extraction: x && {
        id: x.id,
        createdAt: x.createdAt.toISOString(),
        vendorName: header.vendorName ?? "",
        invoiceNumber: header.invoiceNumber ?? "",
        invoiceDate: header.invoiceDate ?? "",
        dueDate: header.dueDate ?? null,
        poNumber: header.poNumber ?? null,
        currency: x.currency,
        subtotal: x.subtotal,
        freight: x.freight,
        surcharges: x.surcharges,
        tax: x.tax,
        total: x.total,
        linesSum: x.linesSum,
        totalsMatch: x.totalsMatch,
        problems: x.problems,
        lines: (tool.extraction?.lines ?? []).map((l) => ({ ...l })),
      },
    };
  });

  mount(app, routes.portalForwarding, async ({ tx, tenantIds, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const conn = await ensureUploadConnection(tx, tenantId);
    return { forwarding: await forwardingView(tx, services, tenantId, conn, session.user.id) };
  });

  mount(app, routes.portalForwardingSenders, async ({ tx, tenantIds, session, services, body }) => {
    const tenantId = tenantIds[0] as string;
    const bad = body.allowed.filter((s) => normalizeSender(s) === null);
    if (bad.length > 0) {
      throw new HttpError(
        422,
        "invalid_sender",
        `not an email address or domain: ${bad.join(", ")}`,
        {
          invalid: bad,
        },
      );
    }
    const allowed = [...new Set(body.allowed.map((s) => normalizeSender(s) as string))];
    let conn = await ensureUploadConnection(tx, tenantId);
    if (JSON.stringify(forwardingOf(conn).allowedSenders) !== JSON.stringify(allowed)) {
      conn = await updateForwarding(tx, conn, { allowedSenders: allowed }, session.user.id);
    }
    return { forwarding: await forwardingView(tx, services, tenantId, conn, session.user.id) };
  });

  mount(app, routes.connectors, async ({ services }) => ({
    connectors: services.platform.connectors.manifests().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      icon: m.icon,
      auth: m.auth,
      entities: m.entities,
      tools: m.tools.map((t) => ({
        id: t.id,
        description: t.description,
        verb: t.verb,
        sideEffect: t.sideEffect,
      })),
    })),
  }));

  // The Worker's own signed link (storage.ts). Public: the signature is the authority, and it names
  // one object for 5 minutes.
  app.get(routes.documentFile.path, async (c) => {
    const services = c.get("req").services();
    const payload = await verifyFileToken(services.env, c.req.param("token") ?? "");
    if (!payload)
      return c.json({ error: { code: "not_found", message: "link expired or invalid" } }, 404);
    const object = await services.deps.objects(services.env).get(payload.k);
    if (!object) return c.json({ error: { code: "not_found", message: "file not found" } }, 404);
    const filename = (payload.f || "document").replace(/["\\\r\n]/g, "_");
    return new Response(object.bytes, {
      headers: {
        "content-type": object.info.contentType,
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, max-age=0, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
