// A fake Excel for tests (to be re-exported by @countersign/connectors/testing; never imported by
// the Worker): the shared fake Microsoft sign-in (../microsoft/fake.ts) for Excel's own app, and
// the Graph calls the connector makes: a drive item get, a search of the person's own drive, a
// workbook's worksheets, a worksheet's used range, and a range's get and PATCH. A file is visible
// at `/me/drive/items/<id>` only to the account whose OneDrive holds it; files shared with that
// account turn up in search with `remoteItem`. A PATCH reads `values` as Excel does typed input
// (text starting with `=`, `+`, `-` or `@` becomes a formula, numeric and ISO-date text become
// numbers, a leading `'` keeps the rest as text), so tests show what our escaping prevents.
// Shaped like Microsoft's answers as far as we know them (NOTES.md).

import { type Cell, columnLetters, isNumericText, parseA1, qualifiedRange } from "../gsheets/a1";
import type { FetchLike, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import {
  type FakeMicrosoftApp,
  type FakeMicrosoftIdentity,
  fakeMicrosoftIdentity,
  graphErrorResponse,
  jsonResponse,
  unauthorized,
} from "../microsoft/fake";
import { GRAPH_API } from "../microsoft/identity";
import { EXCEL_XLSX_MIME } from "./cells";

/** Excel's own Entra app in tests (not Outlook's: each Microsoft connector has its own). */
export const FAKE_EXCEL_APP: FakeMicrosoftApp = {
  clientId: "6f1c0d2e-0000-4000-8000-0000000e7ce1",
  clientSecret: "fake~excel~app~secret",
};

export const FAKE_EXCEL_ACCOUNT = "pat.lee@shop.example";

/** A formula in a fake cell, and the value Excel shows for it. */
export interface FakeFormula {
  formula: string;
  value: string | number | boolean;
}
/** What a cell holds: text, a number, true/false, a formula, or nothing. */
export type FakeCell = Cell | FakeFormula;

export interface FakeWorksheet {
  id: string;
  name: string;
  position: number;
  visibility: "Visible" | "Hidden" | "VeryHidden";
  /** Cells by row (0-based); rows past the end are empty. */
  rows: FakeCell[][];
}

export interface FakeDriveItem {
  id: string;
  name: string;
  mimeType: string;
  /** The account whose OneDrive holds it. */
  owner: string;
  /** Accounts it is shared with: they see it in search, with `remoteItem`. */
  sharedWith: Set<string>;
  folder: string;
  worksheets: FakeWorksheet[];
}

export interface FakeExcel {
  fetch: FetchLike;
  /** Every request, in order. */
  requests: { url: string; method: string; body: string }[];
  identity: FakeMicrosoftIdentity;
  items: Map<string, FakeDriveItem>;
  issueCode: FakeMicrosoftIdentity["issueCode"];
  issued: FakeMicrosoftIdentity["issued"];
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  /** A workbook in someone's OneDrive (default the test account's), with worksheets of rows. */
  seed(
    name: string,
    sheets: Record<string, FakeCell[][]>,
    opts?: { id?: string; owner?: string; mimeType?: string; folder?: string },
  ): FakeDriveItem;
  share(id: string, address: string): void;
  /** The next PATCH is applied, but its answer is lost (a 504). */
  loseNextWriteAnswer(): void;
  /** The next PATCH is turned down with this status and code, and nothing is written. */
  refuseNextWrite(status: number, code: string): void;
  /** A worksheet's cells as they are now, trailing empties trimmed. */
  cells(id: string, sheet?: string): FakeCell[][];
  /** Sets a cell as a person would (row and column 1-based). */
  edit(id: string, sheet: string, row: number, col: number, value: FakeCell): void;
}

const isFormula = (v: FakeCell | undefined): v is FakeFormula =>
  typeof v === "object" && v !== null;

const isEmpty = (v: FakeCell | undefined) => v === undefined || v === null || v === "";

/** Rows with trailing empty cells and rows removed. */
function trimmed(rows: FakeCell[][]): FakeCell[][] {
  const out = rows.map((r) => {
    let n = r.length;
    while (n > 0 && isEmpty(r[n - 1])) n--;
    return r.slice(0, n);
  });
  let n = out.length;
  while (n > 0 && (out[n - 1]?.length ?? 0) === 0) n--;
  return out.slice(0, n);
}

const digit = (s: string, i: number) => s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57;

/** `2026-10-07` → Excel's date serial (days since 1899-12-30); null when it isn't one. */
function isoDateSerial(s: string): number | null {
  if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return null;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!digit(s, i)) return null;
  const t = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** A value from `values` as Excel takes typed input; "invalid" for anything that isn't a cell. */
function typedInput(v: unknown): FakeCell | "invalid" {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "string") return "invalid";
  if (v === "") return null;
  if (v.startsWith("'")) return v.slice(1);
  if (isNumericText(v)) return Number(v);
  const first = v.charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@") {
    return { formula: first === "=" ? v : `=${v}`, value: 0 };
  }
  if (v.toUpperCase() === "TRUE") return true;
  if (v.toUpperCase() === "FALSE") return false;
  return isoDateSerial(v) ?? v;
}

const shownOf = (c: FakeCell | undefined) =>
  c === undefined || c === null ? "" : isFormula(c) ? c.value : c;
const formulaOf = (c: FakeCell | undefined) =>
  c === undefined || c === null ? "" : isFormula(c) ? c.formula : c;
function textOf(c: FakeCell | undefined): string {
  const v = shownOf(c);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

export function fakeExcel(app: FakeMicrosoftApp = FAKE_EXCEL_APP): FakeExcel {
  const identity = fakeMicrosoftIdentity(["Files.ReadWrite"], app);
  const requests: FakeExcel["requests"] = [];
  const items = new Map<string, FakeDriveItem>();
  let n = 0;
  let loseWrite = false;
  let refuseWrite: { status: number; code: string } | null = null;

  function driveItemJson(item: FakeDriveItem, address: string) {
    return {
      id: item.id,
      name: item.name,
      webUrl: `https://onedrive.live.com/edit.aspx?resid=${encodeURIComponent(item.id)}`,
      lastModifiedDateTime: "2026-11-01T10:00:00Z",
      file: { mimeType: item.mimeType },
      parentReference: { driveId: `drive-${item.owner}`, path: `/drive/root:${item.folder}` },
      ...(item.owner === address
        ? {}
        : { remoteItem: { id: item.id, parentReference: { driveId: `drive-${item.owner}` } } }),
    };
  }

  function sheetCell(ws: FakeWorksheet, r: number, c: number): FakeCell | undefined {
    return ws.rows[r]?.[c];
  }

  /** The cells of `range(address='…')` (both rows given), 0-based [start, end). */
  function located(raw: string) {
    const a1 = parseA1(raw);
    if (!a1.ok || a1.range.startRow === null || a1.range.endRow === null) return null;
    const r = a1.range;
    return {
      startRow: (r.startRow as number) - 1,
      endRow: r.endRow as number,
      startCol: r.startCol - 1,
      endCol: r.endCol,
      a1: raw,
    };
  }

  function rangeJson(
    ws: FakeWorksheet,
    at: { startRow: number; endRow: number; startCol: number; endCol: number },
    select: string | undefined,
  ) {
    const grid = (f: (c: FakeCell | undefined) => unknown) => {
      const out: unknown[][] = [];
      for (let r = at.startRow; r < at.endRow; r++) {
        const row: unknown[] = [];
        for (let c = at.startCol; c < at.endCol; c++) row.push(f(sheetCell(ws, r, c)));
        out.push(row);
      }
      return out;
    };
    const cells = `${columnLetters(at.startCol + 1)}${at.startRow + 1}:${columnLetters(at.endCol)}${at.endRow}`;
    const all: Record<string, unknown> = {
      address: ws.name.includes(" ") ? qualifiedRange(ws.name, cells) : `${ws.name}!${cells}`,
      rowIndex: at.startRow,
      columnIndex: at.startCol,
      rowCount: at.endRow - at.startRow,
      columnCount: at.endCol - at.startCol,
      cellCount: (at.endRow - at.startRow) * (at.endCol - at.startCol),
      values: grid(shownOf),
      text: grid(textOf),
      formulas: grid(formulaOf),
    };
    if (!select) return all;
    const keep = new Set(select.split(","));
    return Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k)));
  }

  function usedRange(ws: FakeWorksheet, select: string | undefined) {
    let lastRow = -1;
    let lastCol = -1;
    let firstRow = Number.POSITIVE_INFINITY;
    let firstCol = Number.POSITIVE_INFINITY;
    ws.rows.forEach((row, r) => {
      row.forEach((v, c) => {
        if (isEmpty(v)) return;
        lastRow = Math.max(lastRow, r);
        lastCol = Math.max(lastCol, c);
        firstRow = Math.min(firstRow, r);
        firstCol = Math.min(firstCol, c);
      });
    });
    // A blank worksheet answers its top-left cell.
    if (lastRow < 0)
      return rangeJson(ws, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 }, select);
    return rangeJson(
      ws,
      { startRow: firstRow, endRow: lastRow + 1, startCol: firstCol, endCol: lastCol + 1 },
      select,
    );
  }

  function patch(ws: FakeWorksheet, at: NonNullable<ReturnType<typeof located>>, body: string) {
    if (refuseWrite) {
      const r = refuseWrite;
      refuseWrite = null;
      return graphErrorResponse(r.status, r.code, "The request was turned down.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return graphErrorResponse(400, "invalidRequest", "Malformed JSON.");
    }
    const keys = Object.keys(parsed as object);
    // We only ever send `values`: never formulas, number formats or anything else.
    if (keys.length !== 1 || keys[0] !== "values") {
      return graphErrorResponse(400, "invalidArgument", `the fake takes values only (${keys})`);
    }
    const values = (parsed as { values: unknown }).values;
    const rows = at.endRow - at.startRow;
    const cols = at.endCol - at.startCol;
    if (
      !Array.isArray(values) ||
      values.length !== rows ||
      values.some((r) => !Array.isArray(r) || r.length !== cols)
    ) {
      return graphErrorResponse(
        400,
        "invalidArgument",
        "The number of rows or columns in the input array doesn't match the size or dimensions of the range.",
      );
    }
    const typed: (FakeCell | "skip")[][] = [];
    for (const row of values as unknown[][]) {
      const out: (FakeCell | "skip")[] = [];
      for (const v of row) {
        if (v === null) {
          out.push("skip");
          continue;
        }
        const t = typedInput(v);
        if (t === "invalid") return graphErrorResponse(400, "invalidArgument", "Bad cell value.");
        out.push(t);
      }
      typed.push(out);
    }
    typed.forEach((row, i) => {
      const r = at.startRow + i;
      while (ws.rows.length <= r) ws.rows.push([]);
      const target = ws.rows[r] as FakeCell[];
      row.forEach((v, j) => {
        if (v === "skip") return;
        target[at.startCol + j] = v;
      });
    });
    if (loseWrite) {
      loseWrite = false;
      return graphErrorResponse(504, "gatewayTimeout", "The operation has timed out.");
    }
    return jsonResponse(200, rangeJson(ws, at, "address,rowCount,columnCount,cellCount"));
  }

  function workbook(
    item: FakeDriveItem,
    rest: string[],
    method: string,
    query: Record<string, string>,
    body: string,
  ): HttpResponseLike {
    if (item.mimeType !== EXCEL_XLSX_MIME) {
      return graphErrorResponse(400, "unsupportedWorkbook", "This workbook isn't supported.");
    }
    if (rest[0] !== "worksheets") return graphErrorResponse(404, "notFound", "no fake for that");
    if (rest.length === 1 && method === "GET") {
      return jsonResponse(200, {
        value: item.worksheets.map((w) => ({
          id: w.id,
          name: w.name,
          position: w.position,
          visibility: w.visibility,
        })),
      });
    }
    const key = decodeURIComponent(rest[1] ?? "");
    const ws = item.worksheets.find((w) => w.id === key || w.name === key);
    if (!ws)
      return graphErrorResponse(404, "itemNotFound", "The requested resource doesn't exist.");
    const what = rest[2] ?? "";
    const select = query.$select;
    if (what === "usedRange(valuesOnly=true)" && method === "GET") {
      return jsonResponse(200, usedRange(ws, select));
    }
    const prefix = "range(address='";
    if (what.startsWith(prefix) && what.endsWith("')")) {
      const at = located(decodeURIComponent(what.slice(prefix.length, -2)));
      if (!at) return graphErrorResponse(400, "invalidArgument", "The argument is invalid.");
      if (method === "GET") return jsonResponse(200, rangeJson(ws, at, select));
      if (method === "PATCH") return patch(ws, at, body);
    }
    return graphErrorResponse(404, "notFound", `no fake for ${method} ${what}`);
  }

  function search(text: string, address: string, query: Record<string, string>) {
    const words = text.toLowerCase();
    const found = [...items.values()].filter(
      (i) =>
        (i.owner === address || i.sharedWith.has(address)) && i.name.toLowerCase().includes(words),
    );
    const top = Number(query.$top ?? "200");
    return jsonResponse(200, {
      value: found.slice(0, top).map((i) => ({
        ...driveItemJson(i, address),
        searchResult: { onClickTelemetryUrl: "https://bing.example/x" },
      })),
    });
  }

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, body });
    const token = identity.handle(url, init);
    if (token) return token;
    if (!url.startsWith(`${GRAPH_API}/`))
      return graphErrorResponse(404, "notFound", `no fake for ${url}`);
    const grant = identity.grantFor(init?.headers);
    if (!grant) return unauthorized();
    if (!identity.hasScope(grant, "Files.ReadWrite")) {
      return graphErrorResponse(403, "accessDenied", "Access denied.");
    }
    const q = url.indexOf("?");
    const path = url.slice(GRAPH_API.length, q < 0 ? undefined : q);
    const query = q < 0 ? {} : formDecode(url.slice(q + 1));
    const searchPrefix = "/me/drive/root/search(q='";
    if (path.startsWith(searchPrefix) && path.endsWith("')") && method === "GET") {
      const text = decodeURIComponent(path.slice(searchPrefix.length, -2)).split("''").join("'");
      return search(text, grant.address, query);
    }
    const itemsPrefix = "/me/drive/items/";
    if (!path.startsWith(itemsPrefix))
      return graphErrorResponse(404, "notFound", `no fake for ${path}`);
    const [rawId = "", ...rest] = path.slice(itemsPrefix.length).split("/");
    const item = items.get(decodeURIComponent(rawId));
    // Only the signed-in account's own OneDrive: anyone else's file is not found here.
    if (!item || item.owner !== grant.address) {
      return graphErrorResponse(404, "itemNotFound", "The resource could not be found.");
    }
    if (rest.length === 0 && method === "GET") {
      return jsonResponse(200, driveItemJson(item, grant.address));
    }
    if (rest[0] === "workbook") return workbook(item, rest.slice(1), method, query, body);
    return graphErrorResponse(404, "notFound", `no fake for ${method} ${path}`);
  };

  function sheetOf(id: string, name?: string): FakeWorksheet {
    const item = items.get(id);
    const ws =
      name === undefined ? item?.worksheets[0] : item?.worksheets.find((w) => w.name === name);
    if (!ws) throw new Error(`no worksheet ${name ?? "(first)"} in ${id}`);
    return ws;
  }

  return {
    fetch,
    requests,
    identity,
    items,
    issueCode: identity.issueCode,
    issued: identity.issued,
    expireAccessTokens: identity.expireAccessTokens,
    expireRefreshTokens: identity.expireRefreshTokens,
    seed(name, sheets, opts = {}) {
      const id = opts.id ?? `D4648F06C91D9D3D!${100 + ++n}`;
      const item: FakeDriveItem = {
        id,
        name,
        mimeType: opts.mimeType ?? EXCEL_XLSX_MIME,
        owner: opts.owner ?? FAKE_EXCEL_ACCOUNT,
        sharedWith: new Set(),
        folder: opts.folder ?? "",
        worksheets: Object.entries(sheets).map(([sheet, rows], position) => ({
          id: `{00000000-0001-0000-0000-00000000000${position}}`,
          name: sheet,
          position,
          visibility: "Visible",
          rows: rows.map((r) => [...r]),
        })),
      };
      items.set(id, item);
      return item;
    },
    share(id, address) {
      items.get(id)?.sharedWith.add(address);
    },
    loseNextWriteAnswer() {
      loseWrite = true;
    },
    refuseNextWrite(status, code) {
      refuseWrite = { status, code };
    },
    cells: (id, sheet) => trimmed(sheetOf(id, sheet).rows),
    edit(id, sheet, row, col, value) {
      const ws = sheetOf(id, sheet);
      while (ws.rows.length < row) ws.rows.push([]);
      const r = ws.rows[row - 1] as FakeCell[];
      r[col - 1] = value;
    },
  };
}
