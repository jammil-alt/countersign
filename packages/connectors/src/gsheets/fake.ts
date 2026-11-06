// A fake Google Sheets for tests (re-exported by @countersign/connectors/testing; never imported by
// the Worker): Google's token endpoint for a `drive.file` grant, Drive's `about` and file get, and
// the Sheets API calls the connector makes: spreadsheet get, values get and update (RAW only),
// batchUpdate (insertDimension, updateCells, createDeveloperMetadata; applied whole or not at
// all) and developer metadata search. Under `drive.file` a spreadsheet is visible only to the
// accounts it was picked by (or made by): anything else answers 404. Shaped like Google's answers
// as far as we know them (NOTES.md).

import { DRIVE_FILE_SCOPE, GOOGLE_DRIVE_TOKEN_URL } from "../gdrive/index";
import type { HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { type Cell, columnLetters, parseA1, qualifiedRange, splitQualifiedRange } from "./a1";
import { type SheetsFetch, SPREADSHEET_MIME } from "./index";

export const FAKE_GOOGLE_SHEETS = {
  clientId: "1234-mezonas.apps.googleusercontent.com",
  clientSecret: "GOCSPX-fake-secret",
} as const;

export interface FakeTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  /** Cells by row (0-based), as entered; rows past the end are empty. */
  rows: Cell[][];
}

export interface FakeMetadata {
  metadataId: number;
  key: string;
  value: string;
  sheetId: number;
  startIndex: number;
  endIndex: number;
}

export interface FakeSpreadsheet {
  id: string;
  name: string;
  tabs: FakeTab[];
  /** Accounts Google lets this app open it for (picked with the Picker, or made by the app). */
  grantedTo: Set<string>;
  trashed: boolean;
  metadata: FakeMetadata[];
}

interface Grant {
  address: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeGoogleSheets {
  fetch: SheetsFetch;
  /** Every request, in order. */
  requests: { url: string; method: string; body: string }[];
  spreadsheets: Map<string, FakeSpreadsheet>;
  issueCode(opts?: { address?: string; scopes?: string[] }): string;
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  expireAccessTokens(): void;
  /** A spreadsheet in someone's Drive, with tabs of rows; nobody granted it to us yet. */
  seed(name: string, tabs: Record<string, Cell[][]>, opts?: { id?: string }): FakeSpreadsheet;
  /** The person picks it with Google's Picker: Google grants `drive.file` access to it. */
  pick(id: string, address?: string): void;
  /** The next write (batchUpdate or values update) is applied, but its answer is lost (a 503). */
  loseNextWriteAnswer(): void;
  /** A tab's cells as they are now, trailing empties trimmed. */
  cells(id: string, title?: string): Cell[][];
  /** Sets a cell as a person would (row and column 1-based). */
  edit(id: string, title: string, row: number, col: number, value: Cell): void;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

const error = (status: number, message: string) =>
  respond(status, { error: { code: status, message, status: "ERROR" } });

const isEmpty = (v: Cell | undefined) => v === undefined || v === null || v === "";

/** Rows with trailing empty cells and trailing empty rows removed, as Google answers them. */
function trimmed(rows: Cell[][]): Cell[][] {
  const out = rows.map((r) => {
    let n = r.length;
    while (n > 0 && isEmpty(r[n - 1])) n--;
    return r.slice(0, n);
  });
  let n = out.length;
  while (n > 0 && (out[n - 1]?.length ?? 0) === 0) n--;
  return out.slice(0, n);
}

function rendered(v: Cell, render: string): Cell {
  if (render !== "FORMATTED_VALUE") return v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function cellFromData(d: unknown): Cell | "invalid" {
  if (d === null || typeof d !== "object") return "invalid";
  const uev = (d as { userEnteredValue?: Record<string, unknown> }).userEnteredValue;
  if (uev === undefined) return null;
  const keys = Object.keys(uev);
  if (keys.length !== 1) return "invalid";
  if (typeof uev.stringValue === "string") return uev.stringValue;
  if (typeof uev.numberValue === "number") return uev.numberValue;
  if (typeof uev.boolValue === "boolean") return uev.boolValue;
  if (typeof uev.formulaValue === "string") return uev.formulaValue;
  return "invalid";
}

export function fakeGoogleSheets(): FakeGoogleSheets {
  let n = 0;
  const requests: FakeGoogleSheets["requests"] = [];
  const spreadsheets = new Map<string, FakeSpreadsheet>();
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const accessTokens = new Map<string, { grant: Grant; live: boolean }>();
  let loseWrite = false;

  function issueTokens(grant: Grant, refreshToken: string | null) {
    const accessToken = `ya29.fake-sheets-access-${++n}`;
    accessTokens.set(accessToken, { grant, live: true });
    return {
      access_token: accessToken,
      expires_in: 3599,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  function token(form: Record<string, string>): HttpResponseLike {
    if (
      form.client_id !== FAKE_GOOGLE_SHEETS.clientId ||
      form.client_secret !== FAKE_GOOGLE_SHEETS.clientSecret
    ) {
      return respond(401, { error: "invalid_client" });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) return respond(400, { error: "invalid_grant" });
      codes.delete(form.code ?? "");
      const refreshToken = `1//fake-sheets-refresh-${++n}`;
      refreshTokens.set(refreshToken, grant);
      return respond(200, issueTokens(grant, refreshToken));
    }
    if (form.grant_type === "refresh_token") {
      const grant = refreshTokens.get(form.refresh_token ?? "");
      if (!grant || grant.revoked) {
        return respond(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      return respond(200, issueTokens(grant, null));
    }
    return respond(400, { error: "unsupported_grant_type" });
  }

  function authorized(init: HttpRequestInit | undefined): Grant | null {
    const auth = init?.headers?.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const at = accessTokens.get(auth.slice("Bearer ".length));
    if (!at?.live || at.grant.revoked) return null;
    return at.grant.scopes.includes(DRIVE_FILE_SCOPE) ? at.grant : null;
  }

  function query(url: string): Record<string, string> {
    const i = url.indexOf("?");
    return i < 0 ? {} : formDecode(url.slice(i + 1));
  }

  function visible(id: string, grant: Grant): FakeSpreadsheet | null {
    const s = spreadsheets.get(id);
    return s && !s.trashed && s.grantedTo.has(grant.address) ? s : null;
  }

  function tabNamed(s: FakeSpreadsheet, title: string): FakeTab | undefined {
    return s.tabs.find((t) => t.title === title);
  }

  /** A qualified range on a tab: the tab and the cells, rows 0-based [start, end). */
  function located(s: FakeSpreadsheet, raw: string) {
    const q = splitQualifiedRange(raw);
    if (!q) return null;
    const tab = tabNamed(s, q.title);
    const a1 = parseA1(q.cells);
    if (!tab || !a1.ok) return null;
    const used = trimmed(tab.rows).length;
    const r = a1.range;
    const startRow = (r.startRow ?? 1) - 1;
    const endRow = r.endRow ?? Math.max(used, startRow + 1);
    return { tab, startRow, endRow, startCol: r.startCol - 1, endCol: r.endCol, title: q.title };
  }

  function getValues(s: FakeSpreadsheet, raw: string, url: string): HttpResponseLike {
    const at = located(s, raw);
    if (!at) return error(400, `Unable to parse range: ${raw}`);
    const params = query(url);
    if (params.majorDimension !== "ROWS") return error(400, "majorDimension");
    const render = params.valueRenderOption ?? "FORMATTED_VALUE";
    const rows: Cell[][] = [];
    for (let r = at.startRow; r < Math.min(at.endRow, at.tab.rowCount); r++) {
      const row = at.tab.rows[r] ?? [];
      const cells: Cell[] = [];
      for (let c = at.startCol; c < at.endCol; c++) cells.push(row[c] ?? null);
      rows.push(cells);
    }
    const out = trimmed(rows).map((row) => row.map((v) => rendered(v, render)));
    const range = qualifiedRange(
      at.title,
      `${columnLetters(at.startCol + 1)}${at.startRow + 1}:${columnLetters(at.endCol)}${at.endRow}`,
    );
    return respond(200, { range, majorDimension: "ROWS", ...(out.length ? { values: out } : {}) });
  }

  function lostOr(body: unknown): HttpResponseLike {
    if (loseWrite) {
      loseWrite = false;
      return error(503, "The service is currently unavailable.");
    }
    return respond(200, body);
  }

  function putValues(s: FakeSpreadsheet, raw: string, url: string, body: string): HttpResponseLike {
    if (query(url).valueInputOption !== "RAW") return error(400, "only RAW is accepted here");
    const at = located(s, raw);
    if (!at) return error(400, `Unable to parse range: ${raw}`);
    const parsed = JSON.parse(body || "{}") as { values?: unknown[][] };
    const values = parsed.values ?? [];
    if (at.startRow + values.length > at.tab.rowCount) return error(400, "exceeds grid limits");
    let updated = 0;
    values.forEach((row, i) => {
      const target = at.tab.rows[at.startRow + i] ?? [];
      at.tab.rows[at.startRow + i] = target;
      row.forEach((v, j) => {
        if (v === null) return;
        target[at.startCol + j] = v as Cell;
        updated++;
      });
    });
    return lostOr({
      spreadsheetId: s.id,
      updatedRange: raw,
      updatedRows: values.length,
      updatedColumns: Math.max(0, ...values.map((r) => r.length)),
      updatedCells: updated,
    });
  }

  function batchUpdate(s: FakeSpreadsheet, body: string): HttpResponseLike {
    const parsed = JSON.parse(body || "{}") as { requests?: Record<string, unknown>[] };
    // Applied to copies, kept only if every request applies: Google's batch is atomic.
    const tabs = s.tabs.map((t) => ({ ...t, rows: t.rows.map((r) => [...r]) }));
    const metadata = s.metadata.map((m) => ({ ...m }));
    const tabById = (id: unknown) => tabs.find((t) => t.sheetId === id);
    for (const req of parsed.requests ?? []) {
      const kinds = Object.keys(req);
      if (kinds.length !== 1) return error(400, "one kind per request");
      const kind = kinds[0];
      if (kind === "insertDimension") {
        const r = req.insertDimension as {
          range: { sheetId: number; dimension: string; startIndex: number; endIndex: number };
        };
        const tab = tabById(r.range.sheetId);
        if (!tab || r.range.dimension !== "ROWS") return error(400, "insertDimension");
        const { startIndex, endIndex } = r.range;
        if (
          startIndex < 0 ||
          endIndex <= startIndex ||
          endIndex - startIndex > 1000 ||
          startIndex > tab.rowCount
        ) {
          return error(400, "Invalid insertDimension range");
        }
        const count = endIndex - startIndex;
        while (tab.rows.length < startIndex) tab.rows.push([]);
        tab.rows.splice(startIndex, 0, ...Array.from({ length: count }, () => [] as Cell[]));
        tab.rowCount += count;
        for (const m of metadata) {
          if (m.sheetId !== tab.sheetId) continue;
          if (m.startIndex >= startIndex) {
            m.startIndex += count;
            m.endIndex += count;
          }
        }
      } else if (kind === "updateCells") {
        const r = req.updateCells as {
          start: { sheetId: number; rowIndex: number; columnIndex: number };
          rows: { values?: unknown[] }[];
          fields: string;
        };
        const tab = tabById(r.start.sheetId);
        if (!tab || r.fields !== "userEnteredValue") return error(400, "updateCells");
        if (r.start.rowIndex + r.rows.length > tab.rowCount)
          return error(400, "exceeds grid limits");
        for (let i = 0; i < r.rows.length; i++) {
          const row = tab.rows[r.start.rowIndex + i] ?? [];
          tab.rows[r.start.rowIndex + i] = row;
          const cells = r.rows[i]?.values ?? [];
          for (let j = 0; j < cells.length; j++) {
            const v = cellFromData(cells[j]);
            if (v === "invalid") return error(400, "Invalid CellData");
            row[r.start.columnIndex + j] = v;
          }
        }
      } else if (kind === "createDeveloperMetadata") {
        const d = (req.createDeveloperMetadata as { developerMetadata: Record<string, unknown> })
          .developerMetadata as {
          metadataKey: string;
          metadataValue: string;
          visibility: string;
          location: { dimensionRange?: { sheetId: number; startIndex: number; endIndex: number } };
        };
        const dr = d.location.dimensionRange;
        if (!dr || !tabById(dr.sheetId) || d.visibility !== "PROJECT") {
          return error(400, "createDeveloperMetadata");
        }
        metadata.push({
          metadataId: ++n,
          key: d.metadataKey,
          value: d.metadataValue,
          sheetId: dr.sheetId,
          startIndex: dr.startIndex,
          endIndex: dr.endIndex,
        });
      } else {
        return error(400, `no fake for ${kind}`);
      }
    }
    s.tabs = tabs;
    s.metadata = metadata;
    return lostOr({ spreadsheetId: s.id, replies: (parsed.requests ?? []).map(() => ({})) });
  }

  function searchMetadata(s: FakeSpreadsheet, body: string): HttpResponseLike {
    const parsed = JSON.parse(body || "{}") as {
      dataFilters?: {
        developerMetadataLookup?: { metadataKey?: string; metadataValue?: string };
      }[];
    };
    const look = parsed.dataFilters?.[0]?.developerMetadataLookup;
    if (!look) return error(400, "dataFilters");
    const found = s.metadata.filter(
      (m) =>
        (look.metadataKey === undefined || m.key === look.metadataKey) &&
        (look.metadataValue === undefined || m.value === look.metadataValue),
    );
    if (found.length === 0) return respond(200, {});
    return respond(200, {
      matchedDeveloperMetadata: found.map((m) => ({
        developerMetadata: {
          metadataId: m.metadataId,
          metadataKey: m.key,
          metadataValue: m.value,
          location: {
            locationType: "ROW",
            dimensionRange: {
              sheetId: m.sheetId,
              dimension: "ROWS",
              startIndex: m.startIndex,
              endIndex: m.endIndex,
            },
          },
          visibility: "PROJECT",
        },
        dataFilters: parsed.dataFilters,
      })),
    });
  }

  function sheets(path: string, method: string, url: string, body: string, grant: Grant) {
    const rest = path.slice("/v4/spreadsheets/".length);
    const valuesAt = rest.indexOf("/values/");
    if (valuesAt > 0) {
      const s = visible(decodeURIComponent(rest.slice(0, valuesAt)), grant);
      if (!s) return error(404, "Requested entity was not found.");
      const raw = decodeURIComponent(rest.slice(valuesAt + "/values/".length));
      if (method === "GET") return getValues(s, raw, url);
      if (method === "PUT") return putValues(s, raw, url, body);
      return error(405, "method");
    }
    const search = "/developerMetadata:search";
    if (rest.endsWith(search) && method === "POST") {
      const s = visible(decodeURIComponent(rest.slice(0, -search.length)), grant);
      return s ? searchMetadata(s, body) : error(404, "Requested entity was not found.");
    }
    if (rest.endsWith(":batchUpdate") && method === "POST") {
      const s = visible(decodeURIComponent(rest.slice(0, -":batchUpdate".length)), grant);
      return s ? batchUpdate(s, body) : error(404, "Requested entity was not found.");
    }
    if (method === "GET") {
      const s = visible(decodeURIComponent(rest), grant);
      if (!s) return error(404, "Requested entity was not found.");
      return respond(200, {
        spreadsheetId: s.id,
        properties: { title: s.name },
        sheets: s.tabs.map((t) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            index: t.index,
            gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount },
          },
        })),
      });
    }
    return error(404, `no fake for ${method} ${url}`);
  }

  const fetch: SheetsFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ?? "";
    requests.push({ url, method, body });
    if (url === GOOGLE_DRIVE_TOKEN_URL && method === "POST") return token(formDecode(body));
    const u = parseUrl(url);
    if (!u) return error(404, `no fake for ${url}`);
    const grant = authorized(init);
    if (!grant) return error(401, "Request had invalid authentication credentials.");
    if (u.origin === "https://www.googleapis.com") {
      if (u.pathname === "/drive/v3/about" && method === "GET") {
        return respond(200, { user: { emailAddress: grant.address, displayName: "Pat Lee" } });
      }
      const prefix = "/drive/v3/files/";
      if (u.pathname.startsWith(prefix) && method === "GET") {
        const id = decodeURIComponent(u.pathname.slice(prefix.length));
        const s = spreadsheets.get(id);
        if (!s?.grantedTo.has(grant.address)) return error(404, `File not found: ${id}.`);
        return respond(200, {
          id: s.id,
          name: s.name,
          mimeType: SPREADSHEET_MIME,
          trashed: s.trashed,
          webViewLink: `https://docs.google.com/spreadsheets/d/${s.id}/edit`,
        });
      }
      return error(404, `no fake for ${method} ${url}`);
    }
    if (
      u.origin === "https://sheets.googleapis.com" &&
      u.pathname.startsWith("/v4/spreadsheets/")
    ) {
      return sheets(u.pathname, method, url, body, grant);
    }
    return error(404, `no fake for ${url}`);
  };

  function tab(id: string, title?: string): FakeTab {
    const s = spreadsheets.get(id);
    const t = title === undefined ? s?.tabs[0] : s?.tabs.find((x) => x.title === title);
    if (!t) throw new Error(`no tab ${title ?? "(first)"} in ${id}`);
    return t;
  }

  return {
    fetch,
    requests,
    spreadsheets,
    issueCode(opts = {}) {
      const code = `4/fake-sheets-code-${++n}`;
      codes.set(code, {
        address: opts.address ?? "pat.lee@gmail.test",
        scopes: opts.scopes ?? [DRIVE_FILE_SCOPE],
        revoked: false,
      });
      return code;
    },
    issued: () => ({
      accessTokens: [...accessTokens.keys()],
      refreshTokens: [...refreshTokens.keys()],
    }),
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.live = false;
    },
    seed(name, tabs, opts = {}) {
      const id = opts.id ?? `1FakeSheet${String(++n).padStart(12, "0")}`;
      const s: FakeSpreadsheet = {
        id,
        name,
        tabs: Object.entries(tabs).map(([title, rows], index) => ({
          sheetId: index === 0 ? 0 : 1000 + index,
          title,
          index,
          rowCount: Math.max(1000, rows.length),
          columnCount: 26,
          rows: rows.map((r) => [...r]),
        })),
        grantedTo: new Set(),
        trashed: false,
        metadata: [],
      };
      spreadsheets.set(id, s);
      return s;
    },
    pick(id, address = "pat.lee@gmail.test") {
      spreadsheets.get(id)?.grantedTo.add(address);
    },
    loseNextWriteAnswer() {
      loseWrite = true;
    },
    cells: (id, title) => trimmed(tab(id, title).rows),
    edit(id, title, row, col, value) {
      const t = tab(id, title);
      const r = t.rows[row - 1] ?? [];
      while (t.rows.length < row) t.rows.push([]);
      t.rows[row - 1] = r;
      r[col - 1] = value;
    },
  };
}
