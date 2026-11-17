// Sending new and changed files from folders set to "send new files to Mezonas" (docs/plan.md
// §1.151). Each goes to POST /api/desktop/files, signed by this computer, and becomes a document
// in the client's documents, where workflows pick it up (an invoice in Accounting/Inbox starts the
// invoice review). Only documents and office files go (core's DESKTOP_FILE_TYPES), at most 25 MB,
// never hidden files or Office's lock files, and a file whose contents didn't change isn't sent
// again.
// DECISION: only files added or changed after the folder was given are sent: giving a folder of
// ten years of invoices doesn't send ten years of invoices. Sending what is already there is a
// person's choice for later (docs/open.md).

import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  DESKTOP_MAX_FILE_BYTES,
  DESKTOP_PATHS,
  type DesktopFileMeta,
  type DesktopFolder,
  desktopFileType,
  relativePathProblem,
} from "@countersign/core";
import type { Api } from "./api";

export interface IngestDeps {
  api: Api;
  /** When each folder was given: files older than that aren't sent. */
  since(folderId: string): Date | null;
  /** The sha256 last sent for a file, by `folderId:path`. */
  sent(key: string): string | null;
  recordSent(key: string, sha256: string): Promise<void>;
  log(kind: "sent" | "error", text: string): Promise<void>;
  /** How long a file's size must hold still before it is sent (a copy in progress). */
  settleMs?: number;
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A file's path in its folder, `/`-separated; null when it can't be named in a job. */
export function relativeIn(folderPath: string, file: string): string | null {
  const rel = relative(folderPath, file).split(sep).join("/");
  if (rel.startsWith("..") || relativePathProblem(rel) !== null) return null;
  return rel;
}

/** A multipart body (meta as JSON, then the file) and its content type, as bytes to sign. */
export async function uploadBody(
  meta: DesktopFileMeta,
  name: string,
  bytes: Uint8Array,
): Promise<{ body: Uint8Array; contentType: string }> {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: meta.contentType }), name);
  const req = new Request("https://local.invalid/", { method: "POST", body: form });
  return {
    body: new Uint8Array(await req.arrayBuffer()),
    contentType: req.headers.get("content-type") ?? "multipart/form-data",
  };
}

export class Ingest {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private folders: DesktopFolder[] = [];

  constructor(private readonly deps: IngestDeps) {}

  /** Watches the folders set to send files; stops watching the rest. */
  async use(folders: readonly DesktopFolder[]): Promise<void> {
    this.folders = folders.filter((f) => f.ingest);
    for (const [id, w] of this.watchers) {
      if (!this.folders.some((f) => f.id === id)) {
        w.close();
        this.watchers.delete(id);
      }
    }
    for (const folder of this.folders) {
      if (this.watchers.has(folder.id)) continue;
      try {
        const w = watch(folder.path, { recursive: true }, (_event, name) => {
          if (name) this.queue(folder, join(folder.path, name.toString()));
        });
        w.on("error", () => {
          w.close();
          this.watchers.delete(folder.id);
        });
        this.watchers.set(folder.id, w);
      } catch {
        await this.deps.log("error", `We can't watch ${folder.label}; is it still there?`);
      }
      // Files that changed while the app was closed.
      void this.scan(folder);
    }
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private queue(folder: DesktopFolder, file: string): void {
    const key = `${folder.id}:${file}`;
    const had = this.pending.get(key);
    if (had) clearTimeout(had);
    // Changes come in bursts while a file is saved or copied: wait for them to stop.
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.consider(folder, file);
      }, 2000),
    );
  }

  async scan(folder: DesktopFolder): Promise<void> {
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.name.startsWith(".") || d.name.startsWith("~$")) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) await walk(p, depth + 1);
        else if (d.isFile()) await this.consider(folder, p);
      }
    };
    await walk(folder.path, 0);
  }

  /** Sends one file if it should go; never throws. */
  async consider(folder: DesktopFolder, file: string): Promise<"sent" | "skipped" | "failed"> {
    const rel = relativeIn(folder.path, file);
    if (!rel) return "skipped";
    const contentType = desktopFileType(rel);
    if (!contentType) return "skipped";
    try {
      const first = await stat(file);
      if (!first.isFile() || first.size === 0) return "skipped";
      const since = this.deps.since(folder.id);
      if (since && first.mtime < since) return "skipped";
      if (first.size > DESKTOP_MAX_FILE_BYTES) {
        await this.deps.log(
          "error",
          `${rel} in ${folder.label} is larger than 25 MB; it wasn't sent.`,
        );
        return "skipped";
      }
      await (this.deps.sleep ?? defaultSleep)(this.deps.settleMs ?? 1000);
      const second = await stat(file);
      if (second.size !== first.size || second.mtimeMs !== first.mtimeMs) return "skipped";
      const bytes = new Uint8Array(await readFile(file));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `${folder.id}:${rel}`;
      if (this.deps.sent(key) === sha256) return "skipped";
      const meta: DesktopFileMeta = {
        folderId: folder.id,
        path: rel,
        size: bytes.length,
        sha256,
        modifiedAt: second.mtime.toISOString(),
        contentType,
      };
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      const { body, contentType: type } = await uploadBody(meta, name, bytes);
      const res = await this.deps.api.asDevice("POST", DESKTOP_PATHS.files, body, type);
      if (!res.ok) {
        // 404: this API has no desktop routes yet. The file is tried again when it next changes
        // or the app starts.
        if (res.status !== 404)
          await this.deps.log("error", `${rel} wasn't sent (Mezonas answered ${res.status}).`);
        return "failed";
      }
      await this.deps.recordSent(key, sha256);
      await this.deps.log("sent", `Sent ${rel} from ${folder.label}`);
      return "sent";
    } catch {
      return "failed";
    }
  }
}
