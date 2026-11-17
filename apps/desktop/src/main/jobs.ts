// Doing one job on this computer (docs/plan.md §1.151). The platform decided the job (which tool,
// approved or not); this checks it again against this computer's own folders and the disk, does
// it, and answers. Writes happen once per idempotency key: a retried job answers what was done.
// A workbook is written only while closed, from a fresh read, after a backup, as a temporary
// file renamed over it, so Excel never sees half a file.

import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DESKTOP_MAX_COLUMNS,
  DESKTOP_MAX_FILE_BYTES,
  DESKTOP_MAX_TEXT_CHARS,
  DESKTOP_TEXT_TYPES,
  DESKTOP_WRITE_KINDS,
  type DesktopFolder,
  type DesktopJob,
  type DesktopJobErrorCode,
  type DesktopJobRequest,
  type DesktopJobResult,
  type DesktopPlatform,
  extensionOf,
  formatXlsxRange,
  DesktopJobRequest as JobRequestSchema,
  padXlsxGrid,
  parseXlsxRange,
  sameXlsxCell,
  type XlsxCell,
} from "@countersign/core";
import { GuardProblem, resolveInFolder } from "./guard";
import { workbookInUse } from "./lock";
import { Workbook, XlsxProblem } from "./xlsx";

export interface JobDeps {
  /** The folders this computer works in now (effectiveFolders). */
  folders(): readonly DesktopFolder[];
  platform: DesktopPlatform;
  /** What a write with this key answered, if it was done. */
  doneOutput(key: string): Record<string, unknown> | null;
  recordDone(key: string, output: Record<string, unknown>): Promise<void>;
  backup(path: string, jobId: string): Promise<string>;
  inUse?(path: string): Promise<boolean>;
  now(): Date;
}

class JobProblem extends Error {
  constructor(
    readonly code: DesktopJobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const fail = (code: DesktopJobErrorCode, message: string): DesktopJobResult => ({
  ok: false,
  error: { code, message: message.slice(0, 500) },
});

/** Runs one job and answers; never throws. */
export async function runJob(job: DesktopJob, deps: JobDeps): Promise<DesktopJobResult> {
  if (Date.parse(job.expiresAt) < deps.now().getTime()) {
    return fail("expired", "This job waited too long for the computer and was given up.");
  }
  // Checked again here: the job came over the network (invariant 5).
  const parsed = JobRequestSchema.safeParse(job.request);
  if (!parsed.success) return fail("invalid", "The job wasn't in a shape this app understands.");
  const request = parsed.data;
  try {
    if ("idempotencyKey" in request) {
      const prior = deps.doneOutput(request.idempotencyKey);
      if (prior) return { ok: true, output: { ...prior, alreadyDone: true } };
    }
    const folder = deps.folders().find((f) => f.id === request.folderId);
    if (!folder) {
      throw new JobProblem("not_granted", "This computer doesn't give that folder to Mezonas.");
    }
    if (DESKTOP_WRITE_KINDS.has(request.kind) && folder.access !== "read_write") {
      throw new JobProblem(
        "read_only",
        `${folder.label} is given for reading only. Allow changes in the Mezonas app first.`,
      );
    }
    const output = await perform(request, folder, job.id, deps);
    if ("idempotencyKey" in request) await deps.recordDone(request.idempotencyKey, output);
    return { ok: true, output };
  } catch (e) {
    if (e instanceof JobProblem || e instanceof GuardProblem || e instanceof XlsxProblem) {
      return fail(e.code, e.message);
    }
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      return fail(
        "file_open",
        "The file is in use or this app can't change it. Close it and try again.",
      );
    }
    // DECISION: a failure we didn't foresee answers a fixed message: no stack, no path beyond the
    // job's own, nothing from the file.
    return fail("failed", "Something went wrong on this computer; nothing was changed.");
  }
}

async function sizeChecked(path: string): Promise<{ size: number; mtime: Date }> {
  const s = await stat(path);
  if (!s.isFile()) throw new JobProblem("not_found", `${basename(path)} isn't a file.`);
  if (s.size > DESKTOP_MAX_FILE_BYTES) {
    throw new JobProblem("too_large", `${basename(path)} is larger than 25 MB.`);
  }
  return { size: s.size, mtime: s.mtime };
}

async function perform(
  request: DesktopJobRequest,
  folder: DesktopFolder,
  jobId: string,
  deps: JobDeps,
): Promise<Record<string, unknown>> {
  const platform = deps.platform;
  switch (request.kind) {
    case "files.list":
      return list(folder, request.path, request.depth, request.limit, platform);

    case "file.read": {
      if (!DESKTOP_TEXT_TYPES.has(extensionOf(request.path))) {
        throw new JobProblem("unsupported_file", "Only .csv, .txt and .md files are read as text.");
      }
      const abs = await resolveInFolder(folder, request.path, { platform, mode: "existing" });
      const { size, mtime } = await sizeChecked(abs);
      const text = await readFile(abs, "utf8");
      return {
        path: request.path,
        size,
        modifiedAt: mtime.toISOString(),
        text: text.slice(0, DESKTOP_MAX_TEXT_CHARS),
        truncated: text.length > DESKTOP_MAX_TEXT_CHARS,
      };
    }

    case "xlsx.read": {
      const { wb } = await openWorkbook(folder, request.path, platform);
      const sheet = wb.sheet(request.sheet);
      const lastRow = sheet.lastRow();
      const range = request.range
        ? parseXlsxRange(request.range)
        : {
            startCol: 1,
            startRow: 1,
            endCol: Math.min(Math.max(sheet.lastCol(), 1), DESKTOP_MAX_COLUMNS),
            endRow: null,
          };
      if (!range) throw new JobProblem("invalid", "That range can't be read.");
      const read = sheet.read(range, request.render, request.limit);
      return {
        path: request.path,
        sheet: sheet.name,
        sheets: wb.sheetNames(),
        range: read.range,
        values: read.values,
        truncated: read.truncated,
        lastRow,
      };
    }

    case "xlsx.append": {
      const { abs, wb, mtime } = await openForWrite(folder, request.path, deps);
      const sheet = wb.sheet(request.sheet);
      const firstRow = sheet.lastRow() + 1;
      const width = Math.max(...request.rows.map((r) => r.length));
      if (firstRow + request.rows.length - 1 > 1_048_576) {
        throw new JobProblem("invalid", "The worksheet has no room for these rows.");
      }
      sheet.write(firstRow, 1, request.rows, { inheritStyle: true });
      await saveWorkbook(abs, wb, mtime, jobId, deps);
      return {
        path: request.path,
        sheet: sheet.name,
        range: formatXlsxRange({
          startCol: 1,
          endCol: width,
          startRow: firstRow,
          endRow: firstRow + request.rows.length - 1,
        }),
        firstRow,
        rows: request.rows.length,
        alreadyDone: false,
      };
    }

    case "xlsx.update": {
      const r = parseXlsxRange(request.range);
      if (!r || r.endRow === null) throw new JobProblem("invalid", "Give both rows of the range.");
      const rows = r.endRow - r.startRow + 1;
      const cols = r.endCol - r.startCol + 1;
      if (request.values.length !== rows || request.values.some((v) => v.length !== cols)) {
        throw new JobProblem("invalid", "The values don't fit the range.");
      }
      const { abs, wb, mtime } = await openForWrite(folder, request.path, deps);
      const sheet = wb.sheet(request.sheet);
      const now = padXlsxGrid(sheet.read(r, "formula", rows).values, rows, cols);
      const base = { path: request.path, sheet: sheet.name, range: request.range };
      const writes = (fn: (v: XlsxCell, i: number, j: number) => boolean) =>
        request.values.every((row, i) => row.every((v, j) => v === null || fn(v, i, j)));
      // A retry whose answer was lost: the cells already hold what we were to write.
      if (writes((v, i, j) => sameXlsxCell(now[i]?.[j], v))) {
        return { ...base, updatedCells: 0, alreadyDone: true };
      }
      if (!writes((_, i, j) => sheet.cell(r.startRow + i, r.startCol + j).formula === null)) {
        throw new JobProblem(
          "formula_cell",
          "One of those cells holds a formula. We never replace a formula; change it in Excel.",
        );
      }
      const expect = request.expect;
      if (
        expect !== null &&
        !now.every((row, i) => row.every((v, j) => sameXlsxCell(expect[i]?.[j] ?? null, v)))
      ) {
        throw new JobProblem(
          "cells_changed",
          "The cells changed since this change was proposed. Nothing was written.",
        );
      }
      const updated = sheet.write(r.startRow, r.startCol, request.values, { inheritStyle: false });
      await saveWorkbook(abs, wb, mtime, jobId, deps);
      return { ...base, updatedCells: updated, alreadyDone: false };
    }

    case "file.create": {
      if (!DESKTOP_TEXT_TYPES.has(extensionOf(request.path))) {
        throw new JobProblem("unsupported_file", "Only .csv, .txt and .md files can be created.");
      }
      const abs = await resolveInFolder(folder, request.path, { platform, mode: "new" });
      try {
        // `wx`: never over a file that is there, even one made a moment ago.
        await writeFile(abs, request.text, { encoding: "utf8", flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          throw new JobProblem("exists", `There's already a file called ${request.path}.`);
        }
        throw e;
      }
      return { path: request.path, size: Buffer.byteLength(request.text), alreadyDone: false };
    }
  }
}

async function list(
  folder: DesktopFolder,
  relative: string | undefined,
  depth: number,
  limit: number,
  platform: DesktopPlatform,
): Promise<Record<string, unknown>> {
  const top = await resolveInFolder(folder, relative, { platform, mode: "existing" });
  const entries: {
    path: string;
    kind: "file" | "folder";
    size: number | null;
    modifiedAt: string | null;
  }[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string, level: number) => {
    const names = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const d of names) {
      // Hidden files, Office's lock files and links are never listed.
      if (d.name.startsWith(".") || d.name.startsWith("~$") || d.isSymbolicLink()) continue;
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const path = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        entries.push({ path, kind: "folder", size: null, modifiedAt: null });
        if (level < depth) await walk(join(dir, d.name), path, level + 1);
      } else if (d.isFile()) {
        const s = await stat(join(dir, d.name));
        entries.push({ path, kind: "file", size: s.size, modifiedAt: s.mtime.toISOString() });
      }
    }
  };
  await walk(top, relative ?? "", 1);
  return { entries, truncated };
}

async function openWorkbook(
  folder: DesktopFolder,
  relative: string,
  platform: DesktopPlatform,
): Promise<{ abs: string; wb: Workbook; mtime: Date }> {
  if (extensionOf(relative) !== "xlsx") {
    throw new JobProblem("unsupported_file", "Only .xlsx workbooks are read and changed.");
  }
  const abs = await resolveInFolder(folder, relative, { platform, mode: "existing" });
  const { mtime } = await sizeChecked(abs);
  const wb = Workbook.open(new Uint8Array(await readFile(abs)));
  return { abs, wb, mtime };
}

async function openForWrite(
  folder: DesktopFolder,
  relative: string,
  deps: JobDeps,
): Promise<{ abs: string; wb: Workbook; mtime: Date }> {
  const abs = await resolveInFolder(folder, relative, {
    platform: deps.platform,
    mode: "existing",
  });
  const inUse = deps.inUse ?? ((p: string) => workbookInUse(p));
  if (await inUse(abs)) {
    throw new JobProblem(
      "file_open",
      `${basename(relative)} is open. Close it and we'll make the change.`,
    );
  }
  return openWorkbook(folder, relative, deps.platform);
}

/**
 * Saves a changed workbook: a backup of what was there, a temporary file beside it, then a rename
 * over it, but only if the workbook wasn't opened or saved by someone since we read it.
 */
async function saveWorkbook(
  abs: string,
  wb: Workbook,
  readAt: Date,
  jobId: string,
  deps: JobDeps,
): Promise<void> {
  const bytes = wb.save();
  const tmp = join(dirname(abs), `.~mezonas-${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const inUse = deps.inUse ?? ((p: string) => workbookInUse(p));
    const now = await stat(abs);
    if (now.mtime.getTime() !== readAt.getTime()) {
      throw new JobProblem(
        "cells_changed",
        "The workbook was saved by someone just now. Nothing was written.",
      );
    }
    if (await inUse(abs)) {
      throw new JobProblem(
        "file_open",
        `${basename(abs)} was opened just now. Close it and we'll try again.`,
      );
    }
    await deps.backup(abs, jobId);
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
