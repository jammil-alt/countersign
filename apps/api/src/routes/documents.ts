// Documents, uploads and email forwarding in the portal (ARCHITECTURE §6.3, §6.5, §7, §14), the
// connector list, and the Worker-signed file links. Uploads and forwarding go through the client's
// built-in upload connection. A new document is read in the background when a model key is
// configured (DECISION below); otherwise it waits for an agent's `docs.extract`.

import { documentForTool, rollupPlatformDaily, utcDay } from "@countersign/agents";
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
import {
  connectorShown,
  type ExtractedHeader,
  parseCoveredProcessors,
  routes,
} from "@countersign/core";
import {
  docExtraction,
  document,
  narrowToTenant,
  run,
  stepRun,
  type Tx,
  tenant,
  toolCall,
  transaction,
  withTenant,
} from "@countersign/db";
import {
  DocumentError,
  type DocumentRow,
  duplicateOfMeta,
  extractDocument,
  getDocument,
  linkToTransaction,
  storeDocument,
} from "@countersign/documents";
import { createLlmClient } from "@countersign/llm";
import { collectEmitted, EmittedEvents, type EventRow, emit } from "@countersign/senses";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { guardModels, profileReader } from "../compliance/policy";
import {
  type AppContext,
  type AppEnv,
  contentDisposition,
  type HandlerCtx,
  HttpError,
  mount,
  notFound,
  type Services,
} from "../http";
import { reportHandled } from "../observability/report";
import { dispatchAfterCommit, dispatchEvents } from "../runs/dispatch";
import { signerFor, verifyFileToken } from "../storage";
import { sandboxClient } from "./ops-clients";

/** At most this many files in one upload request. */
export const MAX_UPLOAD_FILES = 20;
const SIGNED_TTL_MS = 300_000;

type ExtractionRow = typeof docExtraction.$inferSelect;

function isCsv(file: File): boolean {
  const t = file.type.toLowerCase();
  return t === "text/csv" || t === "application/csv" || file.name.toLowerCase().endsWith(".csv");
}

/** What a document is matched to, as the documents lists show it (DocumentSummary.match). */
export interface DocumentMatch {
  transactionId: string;
  kind: string;
  number: string | null;
  by: "link" | "run";
}

export function documentSummary(
  d: DocumentRow,
  x: ExtractionRow | null,
  match: DocumentMatch | null = null,
) {
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
    match,
    duplicateOf: duplicateOfMeta(d.meta),
  };
}

/** The tool that matches an invoice to its bill in a run (the Bill clerk's `docs.match-bill`). */
const MATCH_BILL_TOOL = "docs.match_bill";

/** The tool's document number of a transaction (`ext.<connector>.docNumber`), when it has one. */
function txnNumber(t: { connector: string; ext: unknown }): string | null {
  const own = (t.ext as Record<string, unknown> | null)?.[t.connector] as
    | { docNumber?: unknown }
    | undefined;
  return typeof own?.docNumber === "string" && own.docNumber.trim() ? own.docNumber : null;
}

/**
 * What each document is matched to: the transaction it is linked to, else the bill a live run's
 * `docs.match_bill` last matched it to. Before, the lists read only the link and called every
 * linked record "a purchase": a bill showed as a Purchase, and a copy whose link was taken (the
 * bill already had a document) read "Not yet" while its run said "matched".
 */
// DECISION: the run's match is read from its tool call (the tool only reads, ARCHITECTURE §7), so
// the lists agree with the run without the run writing a link; test runs don't count.
export async function documentMatches(
  tx: Tx,
  tenantId: string,
  docs: readonly Pick<DocumentRow, "id" | "transactionId" | "meta">[],
): Promise<Map<string, DocumentMatch>> {
  const out = new Map<string, DocumentMatch>();
  if (docs.length === 0) return out;
  const unlinked = docs
    .filter((d) => !d.transactionId && !duplicateOfMeta(d.meta))
    .map((d) => d.id);
  const found = unlinked.length
    ? await tx
        .select({
          documentId: sql<string>`${toolCall.input}->>'documentId'`,
          transactionId: sql<string | null>`${toolCall.output}->'bill'->>'transactionId'`,
        })
        .from(toolCall)
        .innerJoin(
          stepRun,
          and(eq(stepRun.id, toolCall.stepRunId), eq(stepRun.tenantId, toolCall.tenantId)),
        )
        .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
        .where(
          and(
            eq(toolCall.tenantId, tenantId),
            eq(toolCall.tool, MATCH_BILL_TOOL),
            eq(toolCall.status, "succeeded"),
            eq(run.mode, "live"),
            sql`${toolCall.output}->>'status' = 'matched'`,
            inArray(sql`${toolCall.input}->>'documentId'`, unlinked),
          ),
        )
        .orderBy(desc(toolCall.createdAt), desc(toolCall.id))
    : [];
  const byRun = new Map<string, string>();
  for (const f of found) {
    if (f.transactionId && !byRun.has(f.documentId)) byRun.set(f.documentId, f.transactionId);
  }
  const txnIds = [
    ...new Set([
      ...docs.flatMap((d) => (d.transactionId ? [d.transactionId] : [])),
      ...byRun.values(),
    ]),
  ];
  const txns = txnIds.length
    ? await tx
        .select({
          id: transaction.id,
          kind: transaction.kind,
          connector: transaction.connector,
          ext: transaction.ext,
        })
        .from(transaction)
        .where(and(eq(transaction.tenantId, tenantId), inArray(transaction.id, txnIds)))
    : [];
  const byId = new Map(txns.map((t) => [t.id, t]));
  for (const d of docs) {
    const linked = d.transactionId ? byId.get(d.transactionId) : undefined;
    const ran = byRun.get(d.id);
    const t = linked ?? (ran ? byId.get(ran) : undefined);
    if (!t) continue;
    out.set(d.id, {
      transactionId: t.id,
      kind: t.kind,
      number: txnNumber(t),
      by: linked ? "link" : "run",
    });
  }
  return out;
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
  const inner = services.deps.extractionTransport(services.env);
  if (!inner || documentIds.length === 0) return;
  // A client in HIPAA mode: only a model whose provider has a signed BAA reads its documents.
  const transport = guardModels(
    inner,
    tenantId,
    profileReader(services.db),
    parseCoveredProcessors(services.env.BAA_PROCESSORS),
  );
  const content = new ContentStore(services.deps.objects(services.env));
  // DECISION: a background read keeps no `model_call` row: the table names a run and step (both
  // NOT NULL, with foreign keys), and this read has neither. Its tokens and cost are on its
  // `doc_extraction` row and in `usage_platform_daily` (docs/plan.md §1.43); a read inside a run
  // (`docs.extract`) is recorded as its step's model call.
  const llm = createLlmClient({ transport });
  // v0.12 W1-H: each document's events (read, failed, linked) are dispatched as soon as its
  // transactions commit, so a run triggered by `document.extracted` starts at once (§8).
  const dispatch = { db: services.db, instances: services.deps.instances(services.env) };
  for (const documentId of documentIds) {
    const collect = new EmittedEvents();
    try {
      const read = await extractDocument(
        { db: services.db, content, llm },
        { tenantId, documentId, collect },
      );
      // A duplicate (the same invoice again) starts nothing and links to nothing: its original
      // holds the link.
      await withTenant(services.db, tenantId, async (tx) => {
        collectEmitted(tx, collect);
        if (!read.duplicateOf) await linkToTransaction(tx, tenantId, documentId);
      });
    } catch (error) {
      reportHandled("extracting a document failed", error, { kind: "extraction" });
    } finally {
      await dispatchAfterCommit(dispatch, tenantId, collect);
    }
  }
  // v0.12 W1-H: the reading is the client's usage (ARCHITECTURE §13), rolled up now; the hourly
  // sweep covers a rollup that fails.
  try {
    await withTenant(services.db, tenantId, (tx) =>
      rollupPlatformDaily(tx, { tenantId, day: utcDay(new Date()) }),
    );
  } catch (error) {
    reportHandled("rolling up reading usage failed", error, { kind: "extraction" });
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

/**
 * A document as both surfaces show it: what was printed, the checks on it and a fresh 5-minute
 * link. Model names and costs stay out (invariant 11). `tenantId` is the one client asked about.
 */
export async function documentDetail(
  ctx: { c: AppContext; tx: Tx; services: Services },
  tenantId: string,
  documentId: string,
) {
  const { c, tx, services } = ctx;
  const view = await getDocument(tx, tenantId, documentId);
  if (!view) throw notFound("document");
  const origin = new URL(c.req.url).origin;
  const signer = signerFor(services.env, origin, () => view.document.filename);
  const tool = await documentForTool(view, signer);
  const x = view.extraction;
  const header = (x?.header ?? {}) as Partial<ExtractedHeader>;
  // Only what was printed and the checks on it: model names and costs stay out of the portal.
  const meta = view.document.meta as { email?: Record<string, unknown> };
  const matches = await documentMatches(tx, tenantId, [view.document]);
  return {
    document: {
      ...documentSummary(view.document, x, matches.get(view.document.id) ?? null),
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
}

/** A client's recent documents, newest first, each with its latest extraction's header. */
export async function recentDocuments(tx: Tx, tenantId: string, limit: number) {
  const docs = await tx
    .select()
    .from(document)
    .where(eq(document.tenantId, tenantId))
    .orderBy(desc(document.receivedAt))
    .limit(limit);
  const [latest, matches] = await Promise.all([
    latestExtractions(
      tx,
      tenantId,
      docs.map((d) => d.id),
    ),
    documentMatches(tx, tenantId, docs),
  ]);
  return docs.map((d) => documentSummary(d, latest.get(d.id) ?? null, matches.get(d.id) ?? null));
}

/**
 * An upload into one client (multipart, field `files`), through its built-in upload connection:
 * the portal's for its client, the back office's for the Sandbox. A file already stored (the same
 * sha256) comes back as it is, `created` false: not read again, no event.
 */
async function receiveUploads(
  ctx: Pick<HandlerCtx<typeof routes.portalUploads>, "c" | "tx" | "session" | "services" | "defer">,
  tenantId: string,
) {
  const { c, tx, session, services, defer } = ctx;
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
}

export function documentRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalUploads, async (ctx) => receiveUploads(ctx, ctx.tenantIds[0] as string));

  // DECISION: the operator uploads documents only to the Sandbox client, which has no client
  // people to do it (docs/plan.md §1.16), with the portal's upload as it is; in a real client the
  // client uploads or forwards (403 `not_sandbox` here). It acts with withTenant's scope.
  mount(app, routes.opsSandboxUploads, async (ctx) => {
    const t = await sandboxClient(
      ctx,
      ctx.params.id,
      "only the Sandbox client's documents are uploaded from the back office",
    );
    return narrowToTenant(ctx.tx, t.id, (tx) => receiveUploads({ ...ctx, tx }, t.id));
  });

  mount(app, routes.portalDocuments, async ({ tx, tenantIds, query }) => ({
    documents: await recentDocuments(tx, tenantIds[0] as string, query.limit ?? 50),
  }));

  mount(app, routes.portalDocument, async ({ c, tx, tenantIds, params, services }) =>
    documentDetail({ c, tx, services }, tenantIds[0] as string, params.id),
  );

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

  // Test-only connectors (the testkit) are never offered to a real client (core's connectorShown);
  // the portal never acts in the Sandbox, which has no client people.
  mount(app, routes.connectors, async ({ services }) => ({
    connectors: services.platform.connectors
      .manifests()
      .filter((m) => connectorShown(m, { sandbox: false }))
      .map((m) => ({
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
    const headers = (contentType: string) => ({
      "content-type": contentType,
      // An export (a ZIP) is saved, a document opens in the browser's viewer.
      "content-disposition": contentDisposition(
        payload.f || "document",
        contentType === "application/zip" ? "attachment" : "inline",
      ),
      "cache-control": "private, max-age=0, no-store",
      "x-content-type-options": "nosniff",
    });
    // DECISION: with the R2 binding, the bytes stream through (a client export can be gigabytes);
    // tests, with no binding, read the object store whole.
    const bucket = services.env.ARTIFACTS as R2Bucket | undefined;
    if (bucket) {
      const object = await bucket.get(payload.k);
      if (!object) return c.json({ error: { code: "not_found", message: "file not found" } }, 404);
      return new Response(object.body, {
        headers: headers(object.httpMetadata?.contentType ?? "application/octet-stream"),
      });
    }
    const object = await services.deps.objects(services.env).get(payload.k);
    if (!object) return c.json({ error: { code: "not_found", message: "file not found" } }, 404);
    return new Response(object.bytes, { headers: headers(object.info.contentType) });
  });
}

export { contentDisposition };
