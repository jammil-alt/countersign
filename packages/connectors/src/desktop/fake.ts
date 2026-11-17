// A fake paired computer for tests: folders of text files and workbooks held in memory, answering
// jobs as the desktop app does (apps/desktop/src/main/jobs.ts): writes once per idempotency key,
// open workbooks refused, cells compared with what the approver saw, formulas never replaced.

import {
  type DesktopJobErrorCode,
  type DesktopJobRequest,
  type DesktopJobResult,
  formatXlsxRange,
  padXlsxGrid,
  parseXlsxRange,
  sameXlsxCell,
  type XlsxCell,
} from "@countersign/core";
import { type DesktopServices, DesktopUnavailableError } from "./index";

type FakeFile =
  | { kind: "text"; text: string }
  | { kind: "xlsx"; sheets: { name: string; cells: XlsxCell[][] }[] };

export interface FakeDesktop extends DesktopServices {
  /** Every job the computer was sent, in order. */
  readonly jobs: DesktopJobRequest[];
  put(folderId: string, path: string, file: FakeFile): void;
  get(folderId: string, path: string): FakeFile | undefined;
  /** A workbook someone has open in Excel. */
  open: Set<string>;
  /** The computer is off: jobs aren't picked up. */
  offline: boolean;
  /** Folder ids the computer itself doesn't give (its own list is stricter than ours). */
  revoked: Set<string>;
}

function fail(code: DesktopJobErrorCode, message: string): DesktopJobResult {
  return { ok: false, error: { code, message } };
}

const lastRowOf = (cells: XlsxCell[][]) => {
  for (let r = cells.length; r > 0; r--) {
    if ((cells[r - 1] ?? []).some((v) => v !== null && v !== "")) return r;
  }
  return 0;
};

export function fakeDesktop(name = "Front office PC"): FakeDesktop {
  const files = new Map<string, FakeFile>();
  const done = new Map<string, Record<string, unknown>>();
  const key = (folderId: string, path: string) => `${folderId}:${path.toLowerCase()}`;

  const fake: FakeDesktop = {
    jobs: [],
    open: new Set(),
    offline: false,
    revoked: new Set(),
    put(folderId, path, file) {
      files.set(key(folderId, path), file);
    },
    get(folderId, path) {
      return files.get(key(folderId, path));
    },

    async run(_connectionId, request) {
      if (fake.offline) throw new DesktopUnavailableError(name);
      fake.jobs.push(request);
      if (fake.revoked.has(request.folderId)) {
        return fail("not_granted", "This computer no longer gives that folder to Mezonas.");
      }
      if ("idempotencyKey" in request) {
        const prior = done.get(request.idempotencyKey);
        if (prior) return { ok: true, output: { ...prior, alreadyDone: true } };
      }
      const k = "path" in request && request.path ? key(request.folderId, request.path) : "";
      const file = files.get(k);
      switch (request.kind) {
        case "files.list": {
          const prefix = `${request.folderId}:${request.path ? `${request.path.toLowerCase()}/` : ""}`;
          const entries = [...files.keys()]
            .filter((p) => p.startsWith(prefix))
            .map((p) => ({
              path: p.slice(request.folderId.length + 1),
              kind: "file" as const,
              size: null,
              modifiedAt: null,
            }));
          return { ok: true, output: { entries, truncated: false } };
        }
        case "file.read":
          if (!file) return fail("not_found", "There's no such file.");
          if (file.kind !== "text") return fail("unsupported_file", "Not a text file.");
          return {
            ok: true,
            output: {
              path: request.path,
              size: file.text.length,
              modifiedAt: "2026-11-17T10:00:00.000Z",
              text: file.text,
              truncated: false,
            },
          };
        case "file.create": {
          if (file) return fail("exists", "A file with that name is already there.");
          files.set(k, { kind: "text", text: request.text });
          const output = { path: request.path, size: request.text.length, alreadyDone: false };
          done.set(request.idempotencyKey, output);
          return { ok: true, output };
        }
        default:
          break;
      }
      if (!file) return fail("not_found", "There's no such workbook.");
      if (file.kind !== "xlsx") return fail("unsupported_file", "Not a workbook.");
      const sheet = request.sheet
        ? file.sheets.find((s) => s.name.toLowerCase() === request.sheet?.toLowerCase())
        : file.sheets[0];
      if (!sheet) return fail("not_found", "There's no such worksheet.");
      const lastRow = lastRowOf(sheet.cells);
      if (request.kind === "xlsx.read") {
        const r = request.range ? parseXlsxRange(request.range) : null;
        const range = r ?? { startCol: 1, startRow: 1, endCol: 10, endRow: null };
        const end = Math.min(range.endRow ?? lastRow, lastRow);
        const count = Math.max(0, Math.min(end - range.startRow + 1, request.limit));
        const values = Array.from({ length: count }, (_, i) =>
          Array.from(
            { length: range.endCol - range.startCol + 1 },
            (_, j) => sheet.cells[range.startRow - 1 + i]?.[range.startCol - 1 + j] ?? null,
          ),
        );
        return {
          ok: true,
          output: {
            path: request.path,
            sheet: sheet.name,
            sheets: file.sheets.map((s) => s.name),
            range: formatXlsxRange({ ...range, endRow: range.startRow + Math.max(count, 1) - 1 }),
            values,
            truncated: end - range.startRow + 1 > request.limit,
            lastRow,
          },
        };
      }
      if (fake.open.has(request.path)) {
        return fail("file_open", `${request.path} is open. Close it and we'll try again.`);
      }
      if (request.kind === "xlsx.append") {
        const firstRow = lastRow + 1;
        request.rows.forEach((row, i) => {
          sheet.cells[firstRow - 1 + i] = [...row];
        });
        const width = Math.max(...request.rows.map((r) => r.length));
        const output = {
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
        done.set(request.idempotencyKey, output);
        return { ok: true, output };
      }
      // xlsx.update
      const r = parseXlsxRange(request.range);
      if (!r || r.endRow === null) return fail("invalid", "Give both rows of the range.");
      const rows = r.endRow - r.startRow + 1;
      const cols = r.endCol - r.startCol + 1;
      const now = padXlsxGrid(
        Array.from({ length: rows }, (_, i) =>
          Array.from(
            { length: cols },
            (_, j) => sheet.cells[r.startRow - 1 + i]?.[r.startCol - 1 + j] ?? null,
          ),
        ),
        rows,
        cols,
      );
      const holds = request.values.every((row, i) =>
        row.every((v, j) => sameXlsxCell(now[i]?.[j], v)),
      );
      const output = { path: request.path, sheet: sheet.name, range: request.range };
      if (holds) return { ok: true, output: { ...output, updatedCells: 0, alreadyDone: true } };
      if (now.some((row) => row.some((v) => typeof v === "string" && v.startsWith("=")))) {
        return fail("formula_cell", "One of those cells holds a formula; we never replace one.");
      }
      if (
        request.expect &&
        !request.expect.every((row, i) => row.every((v, j) => sameXlsxCell(now[i]?.[j], v)))
      ) {
        return fail("cells_changed", "The cells changed since this change was proposed.");
      }
      request.values.forEach((row, i) => {
        const target = sheet.cells[r.startRow - 1 + i] ?? [];
        row.forEach((v, j) => {
          target[r.startCol - 1 + j] = v;
        });
        sheet.cells[r.startRow - 1 + i] = target;
      });
      const result = { ...output, updatedCells: rows * cols, alreadyDone: false };
      done.set(request.idempotencyKey, result);
      return { ok: true, output: result };
    },
  };
  return fake;
}
