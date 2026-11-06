// Where a client's data exports live (docs/plan.md §1.36): under the client's own prefix in object
// storage, so the retention sweep deletes them with the rest of its files 30 days after it is
// retired. Each export is a folder: `export.json` (its status, which the back office lists), the
// finished ZIP, and `parts/` (the pages and README written by the job, removed once the ZIP is
// whole). No table: the export's status is the manifest, and its start and end are in the audit
// log and the client's change log.

import type { ObjectStore } from "@countersign/connectors";
import { EXPORT_STATUSES } from "@countersign/core";
import { z } from "zod";

export const EXPORT_MANIFEST = "export.json";

export function exportsPrefix(tenantId: string): string {
  return `tenants/${tenantId.toLowerCase()}/exports/`;
}

export function exportFolder(tenantId: string, exportId: string): string {
  return `${exportsPrefix(tenantId)}${exportId}/`;
}

export const ExportManifest = z.object({
  v: z.literal(1),
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(EXPORT_STATUSES),
  requestedAt: z.string(),
  requestedBy: z.object({ id: z.string(), email: z.string().nullable() }).nullable(),
  reason: z.string(),
  finishedAt: z.string().nullable(),
  files: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** The ZIP's name when saved, e.g. `mezonas-export-acme-2026-11-06.zip`. */
  filename: z.string(),
  /** The ZIP's storage key, once ready. */
  key: z.string().nullable(),
  error: z.string().nullable(),
});
export type ExportManifest = z.infer<typeof ExportManifest>;

const encoder = new TextEncoder();

export async function writeManifest(objects: ObjectStore, m: ExportManifest): Promise<void> {
  await objects.put(
    `${exportFolder(m.tenantId, m.id)}${EXPORT_MANIFEST}`,
    encoder.encode(JSON.stringify(ExportManifest.parse(m))),
    { contentType: "application/json" },
  );
}

export async function readManifest(
  objects: ObjectStore,
  tenantId: string,
  exportId: string,
): Promise<ExportManifest | null> {
  const o = await objects.get(`${exportFolder(tenantId, exportId)}${EXPORT_MANIFEST}`);
  if (!o) return null;
  const parsed = ExportManifest.safeParse(JSON.parse(new TextDecoder().decode(o.bytes)));
  return parsed.success && parsed.data.tenantId === tenantId ? parsed.data : null;
}

/** Every export of a client, newest first. */
export async function listManifests(
  objects: ObjectStore,
  tenantId: string,
): Promise<ExportManifest[]> {
  const prefix = exportsPrefix(tenantId);
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const o of page.objects) {
      const rest = o.key.slice(prefix.length);
      const [id, file] = rest.split("/");
      if (id && file === EXPORT_MANIFEST) ids.add(id);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  const out: ExportManifest[] = [];
  for (const id of ids) {
    const m = await readManifest(objects, tenantId, id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** Deletes every object under `prefix` (an export's parts). */
export async function deletePrefix(objects: ObjectStore, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const o of page.objects) {
      await objects.delete(o.key);
      n++;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return n;
}

/** How long a running export holds off the retention sweep before it counts as abandoned. */
export const RUNNING_EXPORT_HOLD_MS = 24 * 60 * 60 * 1000;

/** Whether an export of this client is being built now (the retention sweep waits for it). */
export async function exportRunning(
  objects: ObjectStore,
  tenantId: string,
  now: Date,
): Promise<boolean> {
  const all = await listManifests(objects, tenantId);
  return all.some(
    (m) =>
      m.status === "running" &&
      now.getTime() - Date.parse(m.requestedAt) < RUNNING_EXPORT_HOLD_MS,
  );
}

/**
 * Object storage the export job writes its ZIP into. `putStream` writes an object of a known size
 * from pieces, without holding it whole: R2 through a FixedLengthStream in the Worker, memory in
 * tests.
 */
export interface ExportStorage {
  objects: ObjectStore;
  putStream(
    key: string,
    size: number,
    pieces: AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void>;
}

/** For tests: the pieces gathered and written to the object store at once. */
export function bufferedExportStorage(objects: ObjectStore): ExportStorage {
  return {
    objects,
    async putStream(key, size, pieces, contentType) {
      const parts: Uint8Array[] = [];
      let n = 0;
      for await (const p of pieces) {
        parts.push(p);
        n += p.length;
      }
      if (n !== size) throw new Error(`${key}: wrote ${n} bytes, planned ${size}`);
      const out = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      await objects.put(key, out, { contentType });
    },
  };
}
