import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopFolder, DesktopJob, DesktopJobRequest } from "@countersign/core";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveFolders } from "./guard";
import { type JobDeps, runJob } from "./jobs";
import { ownerFileNames } from "./lock";
import { Store } from "./store";
import { costsWorkbook } from "./testing";
import { Workbook } from "./xlsx";

const BOOKS = "0192f7a0-0000-7000-8000-0000000000b1";
const SCANS = "0192f7a0-0000-7000-8000-0000000000b2";
const NOW = new Date("2026-11-17T10:00:00Z");

let root: string;
let outside: string;
let store: Store;
let open: Set<string>;
let deps: JobDeps;

const job = (request: Record<string, unknown>, expiresAt = "2026-11-17T10:02:00Z"): DesktopJob => ({
  id: "0192f7a0-0000-7000-8000-00000000j0b1",
  issuedAt: "2026-11-17T10:00:00Z",
  expiresAt,
  request: request as DesktopJobRequest,
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "mezonas-desktop-"));
  root = join(base, "Books");
  outside = join(base, "Private");
  await mkdir(join(root, "Reports"), { recursive: true });
  await mkdir(join(base, "Scans"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "Costs.xlsx"), costsWorkbook());
  await writeFile(join(root, "notes.csv"), "a,b\n1,2");
  await writeFile(join(root, ".hidden"), "x");
  await writeFile(join(outside, "secret.csv"), "no");
  const folders: DesktopFolder[] = [
    { id: BOOKS, path: root, label: "Books", access: "read_write", ingest: false },
    { id: SCANS, path: join(base, "Scans"), label: "Scans", access: "read", ingest: true },
  ];
  store = new Store(join(base, "app-data"), () => NOW);
  await store.load();
  open = new Set();
  deps = {
    folders: () => folders,
    platform: "mac",
    doneOutput: (k) => store.doneOutput(k),
    recordDone: (k, o) => store.recordDone(k, o),
    backup: (p, id) => store.backup(p, id),
    inUse: async (p) => open.has(p),
    now: () => NOW,
  };
});

describe("reading", () => {
  it("lists a folder without hidden files", async () => {
    const r = await runJob(job({ kind: "files.list", folderId: BOOKS, depth: 2 }), deps);
    expect(r.ok && r.output.entries).toEqual([
      expect.objectContaining({ path: "Costs.xlsx", kind: "file" }),
      expect.objectContaining({ path: "notes.csv", kind: "file" }),
      expect.objectContaining({ path: "Reports", kind: "folder" }),
    ]);
  });

  it("reads text and cells", async () => {
    const text = await runJob(job({ kind: "file.read", folderId: BOOKS, path: "notes.csv" }), deps);
    expect(text).toMatchObject({ ok: true, output: { text: "a,b\n1,2", truncated: false } });
    const cells = await runJob(
      job({ kind: "xlsx.read", folderId: BOOKS, path: "Costs.xlsx", range: "B2:C3" }),
      deps,
    );
    expect(cells).toMatchObject({
      ok: true,
      output: {
        sheet: "Costs",
        lastRow: 4,
        values: [
          ["Northside Lumber", 412.5],
          ["Hardwood Supply", 129.95],
        ],
      },
    });
  });

  it("refuses folders it doesn't give, paths out of them and links that leave them", async () => {
    await symlink(join(outside, "secret.csv"), join(root, "link.csv"));
    const cases: [Record<string, unknown>, string][] = [
      [
        { kind: "file.read", folderId: "0192f7a0-0000-7000-8000-0000000000ff", path: "a.csv" },
        "not_granted",
      ],
      [{ kind: "file.read", folderId: BOOKS, path: "../Private/secret.csv" }, "invalid"],
      [{ kind: "file.read", folderId: BOOKS, path: "link.csv" }, "not_granted"],
      [{ kind: "file.read", folderId: BOOKS, path: "missing.csv" }, "not_found"],
      [{ kind: "file.read", folderId: BOOKS, path: "Costs.xlsx" }, "unsupported_file"],
    ];
    for (const [request, code] of cases) {
      const r = await runJob(job(request), deps);
      expect(r.ok ? "ok" : r.error.code, JSON.stringify(request)).toBe(code);
    }
  });

  it("gives up a job that waited too long", async () => {
    const r = await runJob(
      job({ kind: "files.list", folderId: BOOKS }, "2026-11-17T09:59:00Z"),
      deps,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "expired" } });
  });
});

describe("writing", () => {
  const append = {
    kind: "xlsx.append",
    folderId: BOOKS,
    path: "Costs.xlsx",
    rows: [["Oct 7", "Acme", 99]],
    idempotencyKey: "run-1:step-1:0",
  };

  it("adds rows once, keeps a backup, and answers a retry with what it did", async () => {
    const first = await runJob(job(append), deps);
    expect(first).toMatchObject({ ok: true, output: { range: "A5:C5", firstRow: 5 } });
    const again = await runJob(job(append), deps);
    expect(again).toMatchObject({ ok: true, output: { range: "A5:C5", alreadyDone: true } });
    const sheet = Workbook.open(new Uint8Array(await readFile(join(root, "Costs.xlsx")))).sheet();
    expect(sheet.lastRow()).toBe(5);
    expect(await readdir(join(store["dir" as never] as string, "backups"))).toHaveLength(1);
    // No temporary file is left beside the workbook.
    expect((await readdir(root)).some((n) => n.includes("mezonas"))).toBe(false);
  });

  it("waits for an open workbook to be closed", async () => {
    open.add(join(root, "Costs.xlsx"));
    const r = await runJob(job(append), deps);
    expect(r).toMatchObject({ ok: false, error: { code: "file_open" } });
    expect(store.doneOutput(append.idempotencyKey)).toBeNull();
  });

  it("refuses writes to a folder given for reading", async () => {
    const r = await runJob(job({ ...append, folderId: SCANS }), deps);
    expect(r).toMatchObject({ ok: false, error: { code: "read_only" } });
  });

  it("updates cells only if they hold what the approver saw, never over a formula", async () => {
    const base = { kind: "xlsx.update", folderId: BOOKS, path: "Costs.xlsx" };
    const changed = await runJob(
      job({
        ...base,
        range: "C2:C2",
        values: [[450]],
        expect: [[400]],
        idempotencyKey: "run-1:k-1",
      }),
      deps,
    );
    expect(changed).toMatchObject({ ok: false, error: { code: "cells_changed" } });
    const formula = await runJob(
      job({ ...base, range: "C4:C4", values: [[1]], expect: null, idempotencyKey: "run-1:k-2" }),
      deps,
    );
    expect(formula).toMatchObject({ ok: false, error: { code: "formula_cell" } });
    const done = await runJob(
      job({
        ...base,
        range: "B2:C2",
        values: [[null, 450]],
        expect: [["Northside Lumber", 412.5]],
        idempotencyKey: "run-1:k-3",
      }),
      deps,
    );
    expect(done).toMatchObject({ ok: true, output: { updatedCells: 1, alreadyDone: false } });
    const sheet = Workbook.open(new Uint8Array(await readFile(join(root, "Costs.xlsx")))).sheet();
    expect(sheet.cell(2, 3).value).toBe(450);
    expect(sheet.cell(2, 2).value).toBe("Northside Lumber");
  });

  it("creates a new file in a new folder, never over one that is there", async () => {
    const create = {
      kind: "file.create",
      folderId: BOOKS,
      path: "Reports/2026/Week 46.csv",
      text: "a,b",
      idempotencyKey: "run-1:create",
    };
    expect(await runJob(job(create), deps)).toMatchObject({ ok: true, output: { size: 3 } });
    expect(await readFile(join(root, "Reports/2026/Week 46.csv"), "utf8")).toBe("a,b");
    const again = await runJob(job({ ...create, idempotencyKey: "run-1:other" }), deps);
    expect(again).toMatchObject({ ok: false, error: { code: "exists" } });
  });
});

describe("folders", () => {
  it("works only in folders on both lists, with the stricter access", () => {
    const mine: DesktopFolder[] = [
      { id: BOOKS, path: "/a", label: "Books", access: "read_write", ingest: true },
      { id: SCANS, path: "/b", label: "Scans", access: "read_write", ingest: true },
    ];
    expect(effectiveFolders(mine, null)).toEqual(mine);
    const theirs = [{ ...mine[0], access: "read" as const, ingest: false } as DesktopFolder];
    expect(effectiveFolders(mine, theirs)).toEqual([
      { id: BOOKS, path: "/a", label: "Books", access: "read", ingest: false },
    ]);
  });

  it("knows Office's owner files", () => {
    expect(ownerFileNames("Budget 2026.xlsx")).toContain("~$Budget 2026.xlsx");
    expect(ownerFileNames("Budget 2026.xlsx")).toContain("~$dget 2026.xlsx");
  });
});
