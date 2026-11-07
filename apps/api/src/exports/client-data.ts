// The client data export job (docs/plan.md §1.36): every table in ./tables.ts as CSV, the original
// documents and a README, in one ZIP under the client's prefix. Each page of a table and each
// batch of documents is its own durable step, so a big client's export resumes where it stopped;
// the last step streams the pieces into one ZIP of known size. Everything it reads is read inside
// withTenant(the client), and every query also filters by the client (invariant 1).

import { type Db, document, tenant, withTenant } from "@countersign/db";
import { and, eq, gt } from "drizzle-orm";
import { auditAlone } from "../audit";
import { CSV_BOM, CSV_TYPE, csvLine, documentPath } from "./csv";
import {
  deletePrefix,
  type ExportManifest,
  type ExportStorage,
  exportFolder,
  readManifest,
  writeManifest,
} from "./store";
import { EXPORT_TABLES, type ExportTable } from "./tables";
import { crc32, planZip, type ZipEntry } from "./zip";

/** Rows per page of a table: one durable step each. */
export const EXPORT_PAGE_ROWS = 5000;
/** Documents per step, and the bytes one step reads at most before it hands on. */
const DOCUMENT_BATCH = 200;
const DOCUMENT_BATCH_BYTES = 256 * 1024 * 1024;

export interface ExportParams {
  tenantId: string;
  exportId: string;
}

export interface ExportJobDeps {
  db: Db;
  storage: ExportStorage;
  now(): Date;
  /** Rows per page; default EXPORT_PAGE_ROWS (tests use a few, to page). */
  pageRows?: number;
}

/** A Workflow's `step.do`: a named, durable step whose JSON result is replayed on resume. */
export interface ExportStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** One file of the ZIP and the stored pieces it is made of, in order. */
interface Piece extends ZipEntry {
  keys: string[];
}

interface PageResult {
  key: string;
  size: number;
  crc: number;
  rows: number;
  next: string | null;
}

interface DocumentBatch {
  files: Piece[];
  missing: { id: string; filename: string }[];
  next: string | null;
}

interface Begun {
  clientName: string;
  startedAt: string;
  filename: string;
}

const encoder = new TextEncoder();

const partsPrefix = (p: ExportParams) => `${exportFolder(p.tenantId, p.exportId)}parts/`;

/** `mezonas-export-acme-millwork-2026-11-06.zip` */
export function exportFilename(clientName: string, at: Date): string {
  const slug =
    clientName
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 40) || "client";
  return `mezonas-export-${slug}-${at.toISOString().slice(0, 10)}.zip`;
}

async function manifestOf(deps: ExportJobDeps, p: ExportParams): Promise<ExportManifest> {
  const m = await readManifest(deps.storage.objects, p.tenantId, p.exportId);
  if (!m) throw new Error(`export ${p.exportId} has no manifest`);
  return m;
}

async function begin(deps: ExportJobDeps, p: ExportParams): Promise<Begun> {
  const m = await manifestOf(deps, p);
  const [client] = await withTenant(deps.db, p.tenantId, (tx) =>
    tx.select().from(tenant).where(eq(tenant.id, p.tenantId)),
  );
  if (!client) throw new Error("no such client");
  const purge = (client.settings as { purge?: { files_deleted_at?: unknown } }).purge;
  if (purge?.files_deleted_at) throw new Error("this client's files have been deleted");
  return { clientName: client.name, startedAt: m.requestedAt, filename: m.filename };
}

async function writeTablePage(
  deps: ExportJobDeps,
  p: ExportParams,
  table: ExportTable,
  cursor: string | null,
  pageNo: number,
  crcSoFar: number,
): Promise<PageResult> {
  const page = await withTenant(deps.db, p.tenantId, (tx) =>
    table.page(tx, p.tenantId, cursor, deps.pageRows ?? EXPORT_PAGE_ROWS),
  );
  const text =
    (pageNo === 0 ? CSV_BOM + csvLine(table.header) : "") + page.rows.map(csvLine).join("");
  const bytes = encoder.encode(text);
  const key = `${partsPrefix(p)}${table.file}.${String(pageNo).padStart(6, "0")}`;
  await deps.storage.objects.put(key, bytes, { contentType: CSV_TYPE });
  return {
    key,
    size: bytes.length,
    crc: crc32(bytes, crcSoFar),
    rows: page.rows.length,
    next: page.next,
  };
}

async function readDocuments(
  deps: ExportJobDeps,
  p: ExportParams,
  cursor: string | null,
): Promise<DocumentBatch> {
  const docs = await withTenant(deps.db, p.tenantId, (tx) =>
    tx
      .select({
        id: document.id,
        filename: document.filename,
        storageKey: document.storageKey,
      })
      .from(document)
      .where(and(eq(document.tenantId, p.tenantId), cursor ? gt(document.id, cursor) : undefined))
      .orderBy(document.id)
      .limit(DOCUMENT_BATCH + 1),
  );
  const own = `tenants/${p.tenantId.toLowerCase()}/`;
  const files: Piece[] = [];
  const missing: { id: string; filename: string }[] = [];
  let read = 0;
  let last: string | null = null;
  let stopped = false;
  for (const d of docs.slice(0, DOCUMENT_BATCH)) {
    if (read >= DOCUMENT_BATCH_BYTES) {
      stopped = true;
      break;
    }
    last = d.id;
    // A stored file is the client's only if it sits under the client's own prefix.
    const object = d.storageKey.startsWith(own)
      ? await deps.storage.objects.get(d.storageKey)
      : null;
    if (!object) {
      missing.push({ id: d.id, filename: d.filename });
      continue;
    }
    read += object.bytes.length;
    files.push({
      name: documentPath(d),
      size: object.bytes.length,
      crc: crc32(object.bytes),
      keys: [d.storageKey],
    });
  }
  const more = stopped || docs.length > DOCUMENT_BATCH;
  return { files, missing, next: more ? last : null };
}

async function writeReadme(
  deps: ExportJobDeps,
  p: ExportParams,
  begun: Begun,
  rows: Map<string, number>,
  documents: number,
  missing: { id: string; filename: string }[],
): Promise<Piece> {
  const text = readmeText(begun, p.exportId, rows, documents, missing);
  const bytes = encoder.encode(text);
  const key = `${partsPrefix(p)}README.txt`;
  await deps.storage.objects.put(key, bytes, { contentType: "text/plain; charset=utf-8" });
  return { name: "README.txt", size: bytes.length, crc: crc32(bytes), keys: [key] };
}

export function readmeText(
  begun: Pick<Begun, "clientName" | "startedAt">,
  exportId: string,
  rows: Map<string, number>,
  documents: number,
  missing: { id: string; filename: string }[],
): string {
  const lines: string[] = [
    `Mezonas data export for ${begun.clientName}`,
    "",
    `Asked for ${begun.startedAt}. Export ${exportId}.`,
    "",
    "This is your data as we hold it: your records as CSV files, one per kind of record, and your",
    "original documents in the documents folder. Open the CSV files in a spreadsheet or load them",
    "into a database. Each file's first row names its columns.",
    "",
    "How to read the files",
    "- Times are in UTC, written as 2026-11-06T14:05:00.000Z. Dates are year-month-day.",
    "- Money is a decimal number with its currency in the next column, e.g. 1250.0000 and USD.",
    "- Ids join the files: transaction_lines.csv's transaction_id is an id in transactions.csv,",
    "  and documents.csv's file column is the document's path in this export.",
    "- Some cells hold JSON, such as the record before and after a change in external_actions.csv.",
    "- A cell that starts with an apostrophe had one added, so a spreadsheet shows it as text.",
    "",
    "The files",
  ];
  for (const t of EXPORT_TABLES) {
    lines.push(`- ${t.file} (${rows.get(t.file) ?? 0} rows): ${t.about}`);
  }
  lines.push(`- documents/ (${documents} files): your original documents.`);
  if (missing.length > 0) {
    lines.push(
      "",
      `${missing.length} documents are listed in documents.csv but their file was not found:`,
    );
    for (const m of missing.slice(0, 200)) lines.push(`- ${m.filename} (${m.id})`);
    if (missing.length > 200) lines.push(`- and ${missing.length - 200} more`);
  }
  lines.push(
    "",
    "What is not in this export",
    "- Logins, passwords, keys and tokens for your tools. We never show these to anyone.",
    "- How we built your agents: their settings, instructions and prompts are our work.",
    "- Our costs, our own notes, and test runs we made while building your agents.",
    "- Your audit log, which a client admin can download from the portal.",
    "",
    "Questions: write to the person who looks after your account at Mezonas.",
    "",
  );
  return lines.join("\r\n");
}

async function assemble(
  deps: ExportJobDeps,
  p: ExportParams,
  begun: Begun,
  pieces: Piece[],
): Promise<{ key: string; size: number; files: number }> {
  const plan = planZip(pieces, new Date(begun.startedAt));
  const objects = deps.storage.objects;
  async function* stream(): AsyncGenerator<Uint8Array> {
    for (const [i, piece] of pieces.entries()) {
      yield plan.headers[i] as Uint8Array;
      let n = 0;
      for (const key of piece.keys) {
        const object = await objects.get(key);
        if (!object) throw new Error(`${piece.name}: ${key} is gone`);
        n += object.bytes.length;
        yield object.bytes;
      }
      if (n !== piece.size) throw new Error(`${piece.name}: ${n} bytes, planned ${piece.size}`);
    }
    yield plan.trailer;
  }
  const key = `${exportFolder(p.tenantId, p.exportId)}${begun.filename}`;
  await deps.storage.putStream(key, plan.size, stream(), "application/zip");
  return { key, size: plan.size, files: pieces.length };
}

async function finish(
  deps: ExportJobDeps,
  p: ExportParams,
  zip: { key: string; size: number; files: number },
): Promise<void> {
  const m = await manifestOf(deps, p);
  await writeManifest(deps.storage.objects, {
    ...m,
    status: "ready",
    finishedAt: deps.now().toISOString(),
    files: zip.files,
    sizeBytes: zip.size,
    key: zip.key,
    error: null,
  });
  await deletePrefix(deps.storage.objects, partsPrefix(p));
  await auditAlone(deps.db, null, {
    tenantId: p.tenantId,
    actorKind: "system",
    action: "export.client_data.ready",
    outcome: "ok",
    target: { export: p.exportId, files: String(zip.files), bytes: String(zip.size) },
  });
}

async function fail(deps: ExportJobDeps, p: ExportParams, reason: string): Promise<void> {
  const m = await readManifest(deps.storage.objects, p.tenantId, p.exportId);
  if (m) {
    await writeManifest(deps.storage.objects, {
      ...m,
      status: "failed",
      finishedAt: deps.now().toISOString(),
      error: reason.slice(0, 500),
    });
  }
  await deletePrefix(deps.storage.objects, partsPrefix(p));
  await auditAlone(deps.db, null, {
    tenantId: p.tenantId,
    actorKind: "system",
    action: "export.client_data.failed",
    outcome: "error",
    target: { export: p.exportId },
  });
}

/** Runs one client data export, step by step. */
export async function runClientExport(
  deps: ExportJobDeps,
  p: ExportParams,
  step: ExportStep,
): Promise<{ key: string; size: number; files: number }> {
  try {
    const begun = await step.do("begin", () => begin(deps, p));
    const pieces: Piece[] = [];
    const rows = new Map<string, number>();
    for (const table of EXPORT_TABLES) {
      const piece: Piece = { name: table.file, size: 0, crc: 0, keys: [] };
      let cursor: string | null = null;
      let pageNo = 0;
      let count = 0;
      do {
        const crcSoFar = piece.crc;
        const at: string | null = cursor;
        const n = pageNo;
        const page: PageResult = await step.do(`${table.file} page ${n}`, () =>
          writeTablePage(deps, p, table, at, n, crcSoFar),
        );
        piece.keys.push(page.key);
        piece.size += page.size;
        piece.crc = page.crc;
        count += page.rows;
        cursor = page.next;
        pageNo++;
      } while (cursor !== null);
      rows.set(table.file, count);
      pieces.push(piece);
    }
    const files: Piece[] = [];
    const missing: { id: string; filename: string }[] = [];
    let cursor: string | null = null;
    let batch = 0;
    do {
      const at: string | null = cursor;
      const r: DocumentBatch = await step.do(`documents ${batch}`, () =>
        readDocuments(deps, p, at),
      );
      files.push(...r.files);
      missing.push(...r.missing);
      cursor = r.next;
      batch++;
    } while (cursor !== null);
    const readme = await step.do("readme", () =>
      writeReadme(deps, p, begun, rows, files.length, missing),
    );
    const zip = await step.do("zip", () => assemble(deps, p, begun, [readme, ...pieces, ...files]));
    await step.do("finish", () => finish(deps, p, zip));
    return zip;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await step.do("failed", () => fail(deps, p, reason));
    throw error;
  }
}
