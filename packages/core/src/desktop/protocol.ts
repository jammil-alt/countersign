// The Mezonas desktop app (docs/plan.md §1.151): what the platform and a client's computer say to
// each other. The computer never takes a connection in: it asks the API for its jobs, does each
// one inside the folders it was given, and answers with a result. Every decision (which tool,
// whether it is approved, whether it may write) stays in apps/api; the computer only does the
// file work and checks the folder rules again. Shared by apps/api, packages/connectors (the
// `desktop` connector builds the jobs) and apps/desktop (which runs them).

import { z } from "zod";
import { DevicePublicKey } from "../mobile/mobile";
import { parseXlsxRange, XLSX_MAX_ROW, type XlsxCell } from "./a1";
import {
  DESKTOP_MAX_FOLDERS,
  DESKTOP_MAX_PATH,
  DesktopPlatform,
  DesktopRelativePath,
  FolderAccess,
} from "./paths";

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────

/** Rows one read answers, columns one job reads or writes, cells one write sends. */
export const DESKTOP_MAX_READ_ROWS = 1000;
export const DESKTOP_MAX_COLUMNS = 100;
export const DESKTOP_MAX_WRITE_CELLS = 2000;
/** Characters in one cell, and in one text file a job reads or creates. */
export const DESKTOP_MAX_CELL_LENGTH = 32_767;
export const DESKTOP_MAX_TEXT_CHARS = 1_000_000;
/** Entries one listing answers. */
export const DESKTOP_MAX_LIST = 500;
/** How long a job waits to be picked up before it is given up on. */
export const DESKTOP_JOB_TTL_SEC = 120;
/** How far the computer's clock may be from ours, either way, on a signed request. */
export const DESKTOP_SIGNATURE_SKEW_SEC = 5 * 60;

// ── Requests the computer signs ─────────────────────────────────────────────────────────────────

/** Headers on every request from a paired computer. */
export const DESKTOP_DEVICE_HEADER = "x-mezonas-device";
export const DESKTOP_TIME_HEADER = "x-mezonas-time";
export const DESKTOP_SIGNATURE_HEADER = "x-mezonas-signature";

/**
 * The API's paths for the desktop app. Pairing and folders use the person's session (the client
 * admin, signed in through the phone app's handoff); jobs and files use the computer's own key.
 */
export const DESKTOP_PATHS = {
  /** POST (session, client admin): pair this computer. DELETE `/:id`: unpair it. */
  devices: "/api/desktop/devices",
  /** PUT (session, client admin): the folders this computer gives, replacing the list. */
  folders: (deviceId: string) => `/api/desktop/devices/${encodeURIComponent(deviceId)}/folders`,
  /** GET (device): wait up to `DESKTOP_POLL_SEC` for jobs. */
  jobs: "/api/desktop/jobs",
  /** POST (device): a job's result. */
  result: (jobId: string) => `/api/desktop/jobs/${encodeURIComponent(jobId)}/result`,
  /** POST (device): a file from a granted folder, for the documents capability. */
  files: "/api/desktop/files",
} as const;

/** How long one wait for jobs lasts before the computer asks again. */
export const DESKTOP_POLL_SEC = 25;

/**
 * What a computer signs on each request: fixed lines, so the same request always gives the same
 * bytes. The body's hash is in it, so a signature can't be moved to another body, and the time
 * bounds a replay to the skew window.
 */
export function desktopRequestText(input: {
  deviceId: string;
  method: string;
  path: string;
  bodySha256: string;
  at: string;
}): string {
  return [
    "mezonas-desktop:v1",
    input.deviceId,
    input.method.toUpperCase(),
    input.path,
    input.bodySha256,
    input.at,
  ].join("\n");
}

/** The public half of a computer's key: an EC P-256 JWK, as the phone's. */
export const DesktopPublicKey = DevicePublicKey;
export type DesktopPublicKey = DevicePublicKey;

// ── Pairing and folders ─────────────────────────────────────────────────────────────────────────

export const PairDesktopBody = z.object({
  name: z.string().trim().min(1).max(80),
  platform: DesktopPlatform,
  /** The app's version, so the back office can see which computers need an update. */
  appVersion: z.string().max(40),
  publicKey: DesktopPublicKey,
});
export type PairDesktopBody = z.infer<typeof PairDesktopBody>;

export const PairedDesktop = z.object({
  deviceId: z.string().uuid(),
  tenantId: z.string().uuid(),
  clientName: z.string(),
  connectionId: z.string().uuid(),
});
export type PairedDesktop = z.infer<typeof PairedDesktop>;

/** One folder this computer gives Mezonas. */
export const DesktopFolder = z.object({
  id: z.string().uuid(),
  /** The folder as this computer shows it (`C:\Users\ana\Documents\Accounting`). */
  path: z.string().min(1).max(DESKTOP_MAX_PATH),
  /** What people call it in the portal and in steps ("Accounting"). */
  label: z.string().trim().min(1).max(80),
  access: FolderAccess,
  /** New and changed files here go to Mezonas as documents. */
  ingest: z.boolean(),
});
export type DesktopFolder = z.infer<typeof DesktopFolder>;

export const DesktopFoldersBody = z.object({
  folders: z.array(DesktopFolder).max(DESKTOP_MAX_FOLDERS),
});

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────

const CellValue = z.union([
  z.string().max(DESKTOP_MAX_CELL_LENGTH),
  z.number(),
  z.boolean(),
  z.null(),
]);

const SheetName = z.string().min(1).max(31);

const FileRef = {
  folderId: z.string().uuid(),
  path: DesktopRelativePath,
};

/** A range a job may name: bounded columns, rows within Excel's grid. */
export const DesktopRange = z
  .string()
  .max(24)
  .superRefine((s, ctx) => {
    const r = parseXlsxRange(s);
    if (!r) {
      ctx.addIssue({ code: "custom", message: "not a range like A1:D20, A2:D or A:D" });
      return;
    }
    if (r.endCol - r.startCol + 1 > DESKTOP_MAX_COLUMNS) {
      ctx.addIssue({ code: "custom", message: `at most ${DESKTOP_MAX_COLUMNS} columns at once` });
    }
  });

const Grid = z
  .array(z.array(CellValue).min(1).max(DESKTOP_MAX_COLUMNS))
  .min(1)
  .max(DESKTOP_MAX_READ_ROWS)
  .refine(
    (rows) => rows.reduce((n, r) => n + r.length, 0) <= DESKTOP_MAX_WRITE_CELLS,
    `at most ${DESKTOP_MAX_WRITE_CELLS} cells at once`,
  );

/** The writes carry the external action's key: the computer does each one once. */
const IdempotencyKey = z.string().min(8).max(200);

export const DesktopJobRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("files.list"),
    folderId: z.string().uuid(),
    /** A folder inside the granted one; default its top. */
    path: DesktopRelativePath.optional(),
    /** 1: this folder's entries; up to 3 levels down. */
    depth: z.number().int().min(1).max(3).default(1),
    limit: z.number().int().min(1).max(DESKTOP_MAX_LIST).default(200),
  }),
  z.object({ kind: z.literal("file.read"), ...FileRef }),
  z.object({
    kind: z.literal("xlsx.read"),
    ...FileRef,
    sheet: SheetName.optional(),
    range: DesktopRange.optional(),
    /** The values underneath (default) or the formulas. */
    render: z.enum(["values", "formula"]).default("values"),
    limit: z.number().int().min(1).max(DESKTOP_MAX_READ_ROWS).default(200),
  }),
  z.object({
    kind: z.literal("xlsx.append"),
    ...FileRef,
    sheet: SheetName.optional(),
    rows: Grid,
    idempotencyKey: IdempotencyKey,
  }),
  z.object({
    kind: z.literal("xlsx.update"),
    ...FileRef,
    sheet: SheetName.optional(),
    /** Both rows given (`B2:C3`); `values` has exactly its shape. */
    range: DesktopRange,
    values: Grid,
    /** The cells as the approver saw them: refused if they differ now. */
    expect: z.array(z.array(CellValue)).nullable(),
    idempotencyKey: IdempotencyKey,
  }),
  z.object({
    kind: z.literal("file.create"),
    ...FileRef,
    /** Text for a .csv, .txt or .md file. Never overwrites: a file already there is refused. */
    text: z.string().max(DESKTOP_MAX_TEXT_CHARS),
    idempotencyKey: IdempotencyKey,
  }),
]);
export type DesktopJobRequest = z.infer<typeof DesktopJobRequest>;
export type DesktopJobKind = DesktopJobRequest["kind"];

/** The kinds that change a file: each runs only for an approved external action. */
export const DESKTOP_WRITE_KINDS: ReadonlySet<DesktopJobKind> = new Set([
  "xlsx.append",
  "xlsx.update",
  "file.create",
]);

export const DesktopJob = z.object({
  id: z.string().uuid(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  request: DesktopJobRequest,
});
export type DesktopJob = z.infer<typeof DesktopJob>;

export const DesktopJobsResponse = z.object({
  jobs: z.array(DesktopJob).max(20),
  /** The folders as the platform has them; the computer keeps to the stricter of both lists. */
  folders: z.array(DesktopFolder).max(DESKTOP_MAX_FOLDERS),
});
export type DesktopJobsResponse = z.infer<typeof DesktopJobsResponse>;

// ── Outputs ─────────────────────────────────────────────────────────────────────────────────────

export const DesktopListOutput = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["file", "folder"]),
      size: z.number().int().nonnegative().nullable(),
      modifiedAt: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export const DesktopReadOutput = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

export const DesktopXlsxReadOutput = z.object({
  path: z.string(),
  sheet: z.string(),
  sheets: z.array(z.string()),
  range: z.string(),
  values: z.array(z.array(CellValue)),
  truncated: z.boolean(),
  /** The last row with data on the sheet (0 when empty). */
  lastRow: z.number().int().min(0).max(XLSX_MAX_ROW),
});

export const DesktopXlsxAppendOutput = z.object({
  path: z.string(),
  sheet: z.string(),
  range: z.string(),
  firstRow: z.number().int().positive(),
  rows: z.number().int().positive(),
  alreadyDone: z.boolean(),
});

export const DesktopXlsxUpdateOutput = z.object({
  path: z.string(),
  sheet: z.string(),
  range: z.string(),
  updatedCells: z.number().int().nonnegative(),
  alreadyDone: z.boolean(),
});

export const DesktopCreateOutput = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  alreadyDone: z.boolean(),
});

/** Each kind's output, for the connector and the computer to check against. */
export const DESKTOP_OUTPUTS = {
  "files.list": DesktopListOutput,
  "file.read": DesktopReadOutput,
  "xlsx.read": DesktopXlsxReadOutput,
  "xlsx.append": DesktopXlsxAppendOutput,
  "xlsx.update": DesktopXlsxUpdateOutput,
  "file.create": DesktopCreateOutput,
} as const satisfies Record<DesktopJobKind, z.ZodType>;

export type DesktopOutput<K extends DesktopJobKind> = z.infer<(typeof DESKTOP_OUTPUTS)[K]>;

/** Why the computer didn't do a job. Fixed codes; the message is plain words for a person. */
export const DesktopJobErrorCode = z.enum([
  /** The folder isn't given, or the path leaves it (a link included). */
  "not_granted",
  /** The folder is given for reading only. */
  "read_only",
  "not_found",
  /** Someone has the workbook open: it must be closed before we write. */
  "file_open",
  /** The cells differ from what the approver saw. */
  "cells_changed",
  /** The change would replace a formula. */
  "formula_cell",
  /** Not a file type this job reads or writes. */
  "unsupported_file",
  "too_large",
  /** A file is already there (create never overwrites). */
  "exists",
  "invalid",
  /** The job's time ran out before the computer got to it. */
  "expired",
  "failed",
]);
export type DesktopJobErrorCode = z.infer<typeof DesktopJobErrorCode>;

export const DesktopJobResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), output: z.record(z.string(), z.unknown()) }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: DesktopJobErrorCode, message: z.string().max(500) }),
  }),
]);
export type DesktopJobResult = z.infer<typeof DesktopJobResult>;

// ── Files sent from a folder ────────────────────────────────────────────────────────────────────

/** What goes with each file the app sends (as JSON in the `meta` part of the upload). */
export const DesktopFileMeta = z.object({
  folderId: z.string().uuid(),
  path: DesktopRelativePath,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  modifiedAt: z.string().datetime(),
  contentType: z.string().max(120),
});
export type DesktopFileMeta = z.infer<typeof DesktopFileMeta>;

/** A grid padded to `rows` × `cols` with nulls (for comparing what a range holds). */
export function padXlsxGrid(grid: readonly XlsxCell[][], rows: number, cols: number): XlsxCell[][] {
  const out: XlsxCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = grid[r] ?? [];
    out.push(Array.from({ length: cols }, (_, c) => row[c] ?? null));
  }
  return out;
}

/** Whether a cell read back holds what was written ("" and null are both empty). */
export function sameXlsxCell(a: XlsxCell | undefined, b: XlsxCell | undefined): boolean {
  const empty = (v: XlsxCell | undefined) => v === null || v === undefined || v === "";
  if (empty(a) && empty(b)) return true;
  return a === b;
}
