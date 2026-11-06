// A fake Google Drive for tests (re-exported by @countersign/connectors/testing; never imported by
// the Worker): Google's token and revoke endpoints for a `drive.file` grant, Drive's `about`, file
// list with the `q` clauses the connector writes (anything else is a 400, so a malformed query
// fails the test), folder create, file get, and resumable uploads. Under `drive.file` the app sees
// only what it made: files seeded as someone else's never appear. Shaped like Google's answers as
// far as we know them (NOTES.md).

import type { HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { fromUtf8 } from "../runtime";
import type { DriveFetch, DriveRequestInit } from "./index";
import {
  DRIVE_FILE_SCOPE,
  DRIVE_FOLDER_MIME,
  DRIVE_UPLOAD_API,
  GOOGLE_DRIVE_REVOKE_URL,
  GOOGLE_DRIVE_TOKEN_URL,
} from "./index";

export const FAKE_GOOGLE_DRIVE = {
  clientId: "1234-mezonas.apps.googleusercontent.com",
  clientSecret: "GOCSPX-fake-secret",
} as const;

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  trashed: boolean;
  /** Made by Mezonas (visible under `drive.file`), or someone else's. */
  byApp: boolean;
  bytes: Uint8Array | null;
  createdTime: string;
}

interface Grant {
  address: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeGoogleDrive {
  fetch: DriveFetch;
  /** Every request, in order (bodies as text, or their length when bytes). */
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  files: Map<string, FakeDriveFile>;
  issueCode(opts?: { address?: string; scopes?: string[] }): string;
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  /** The next upload's file is made, but its answer is lost (a 503), as in a dropped connection. */
  loseNextUploadAnswer(): void;
  /** The next resumable session answers this Location instead of Google's. */
  nextUploadLocation(location: string): void;
  /** A file someone else made, which `drive.file` can't see. */
  seedForeignFile(name: string, parentId: string): FakeDriveFile;
  /** The file's path of folder names from My Drive, e.g. `Mezonas - Acme/Bills/2026/11/a.pdf`. */
  pathOf(id: string): string;
  /** Files (not folders) made by the app, with their paths. */
  uploaded(): (FakeDriveFile & { path: string })[];
  revoked(): string[];
}

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}

const error = (status: number, message: string) =>
  respond(status, { error: { code: status, message, errors: [{ message }] } });

// ── The `q` language, as far as the connector writes it ─────────────────────────────────────────

type Clause =
  | { kind: "name"; value: string }
  | { kind: "mime"; op: "=" | "!="; value: string }
  | { kind: "parent"; value: string }
  | { kind: "trashed"; value: boolean }
  | { kind: "prop"; key: string; value: string };

/** Reads `'…'` at `start` (with `\'` and `\\`); null when there isn't one. */
function literal(s: string, start: number): { value: string; end: number } | null {
  if (s[start] !== "'") return null;
  let value = "";
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next !== "\\" && next !== "'") return null;
      value += next;
      i += 1;
      continue;
    }
    if (ch === "'") return { value, end: i + 1 };
    value += ch;
  }
  return null;
}

/** Splits on ` and ` outside quotes and braces. */
function clauses(q: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (depth === 0 && q.startsWith(" and ", i)) {
      out.push(q.slice(start, i).trim());
      start = i + 5;
      i += 4;
    }
  }
  out.push(q.slice(start).trim());
  return out;
}

function parseClause(c: string): Clause | null {
  if (c === "trashed = false") return { kind: "trashed", value: false };
  if (c === "trashed = true") return { kind: "trashed", value: true };
  if (c.startsWith("name = ")) {
    const l = literal(c, 7);
    return l && l.end === c.length ? { kind: "name", value: l.value } : null;
  }
  for (const op of ["=", "!="] as const) {
    const head = `mimeType ${op} `;
    if (c.startsWith(head)) {
      const l = literal(c, head.length);
      return l && l.end === c.length ? { kind: "mime", op, value: l.value } : null;
    }
  }
  if (c.endsWith(" in parents")) {
    const l = literal(c, 0);
    return l && l.end === c.length - " in parents".length
      ? { kind: "parent", value: l.value }
      : null;
  }
  const head = "appProperties has { key=";
  if (c.startsWith(head)) {
    const k = literal(c, head.length);
    if (!k || !c.startsWith(" and value=", k.end)) return null;
    const v = literal(c, k.end + " and value=".length);
    return v && c.slice(v.end) === " }" ? { kind: "prop", key: k.value, value: v.value } : null;
  }
  return null;
}

function matches(f: FakeDriveFile, all: Clause[]): boolean {
  return all.every((c) => {
    switch (c.kind) {
      case "name":
        return f.name === c.value;
      case "mime":
        return c.op === "=" ? f.mimeType === c.value : f.mimeType !== c.value;
      case "parent":
        return f.parents.includes(c.value);
      case "trashed":
        return f.trashed === c.value;
      case "prop":
        return f.appProperties[c.key] === c.value;
    }
    return false;
  });
}

// ── The fake ────────────────────────────────────────────────────────────────────────────────────

const FIELDS_OUT = (f: FakeDriveFile) => ({
  kind: "drive#file",
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents,
  trashed: f.trashed,
  createdTime: f.createdTime,
  modifiedTime: f.createdTime,
  webViewLink:
    f.mimeType === DRIVE_FOLDER_MIME
      ? `https://drive.google.com/drive/folders/${f.id}`
      : `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
  ...(f.bytes ? { size: String(f.bytes.length) } : {}),
  ...(Object.keys(f.appProperties).length ? { appProperties: f.appProperties } : {}),
});

export function fakeGoogleDrive(): FakeGoogleDrive {
  let n = 0;
  const requests: FakeGoogleDrive["requests"] = [];
  const files = new Map<string, FakeDriveFile>();
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const accessTokens = new Map<string, { grant: Grant; live: boolean }>();
  const sessions = new Map<string, { metadata: Record<string, unknown>; grant: Grant }>();
  const revokedTokens: string[] = [];
  let loseAnswer = false;
  let location: string | null = null;
  const now = () => new Date(Date.UTC(2026, 10, 6, 12, 0, n)).toISOString();

  function issueTokens(grant: Grant, refreshToken: string | null) {
    const accessToken = `ya29.fake-drive-access-${++n}`;
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
      form.client_id !== FAKE_GOOGLE_DRIVE.clientId ||
      form.client_secret !== FAKE_GOOGLE_DRIVE.clientSecret
    ) {
      return respond(401, { error: "invalid_client" });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) return respond(400, { error: "invalid_grant" });
      codes.delete(form.code ?? "");
      const refreshToken = `1//fake-drive-refresh-${++n}`;
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

  function authorized(init: DriveRequestInit | undefined): Grant | null {
    const auth = init?.headers?.authorization ?? "";
    const at = accessTokens.get(auth.slice("Bearer ".length));
    if (!auth.startsWith("Bearer ") || !at?.live || at.grant.revoked) return null;
    return at.grant.scopes.includes(DRIVE_FILE_SCOPE) ? at.grant : null;
  }

  function make(input: {
    name: string;
    mimeType: string;
    parents: string[];
    appProperties?: Record<string, string>;
    byApp?: boolean;
    bytes?: Uint8Array | null;
  }): FakeDriveFile {
    const f: FakeDriveFile = {
      id: `1Fake${String(++n).padStart(6, "0")}`,
      name: input.name,
      mimeType: input.mimeType,
      parents: input.parents,
      appProperties: input.appProperties ?? {},
      trashed: false,
      byApp: input.byApp ?? true,
      bytes: input.bytes ?? null,
      createdTime: now(),
    };
    files.set(f.id, f);
    return f;
  }

  function query(url: string): Record<string, string> {
    const i = url.indexOf("?");
    return i < 0 ? {} : formDecode(url.slice(i + 1));
  }

  function filesList(url: string): HttpResponseLike {
    const params = query(url);
    const parsed = clauses(params.q ?? "").map(parseClause);
    if (!params.q || parsed.some((c) => c === null)) return error(400, "Invalid Value");
    if (params.spaces !== "drive") return error(400, "spaces must be drive");
    const visible = [...files.values()].filter((f) => f.byApp && matches(f, parsed as Clause[]));
    visible.sort((a, b) => {
      const fa = a.mimeType === DRIVE_FOLDER_MIME ? 0 : 1;
      const fb = b.mimeType === DRIVE_FOLDER_MIME ? 0 : 1;
      return fa - fb || a.name.localeCompare(b.name);
    });
    const size = Math.min(Number(params.pageSize ?? "100"), 1000);
    const offset = Number(params.pageToken ?? "0");
    const page = visible.slice(offset, offset + size);
    return respond(200, {
      kind: "drive#fileList",
      files: page.map(FIELDS_OUT),
      ...(offset + size < visible.length ? { nextPageToken: String(offset + size) } : {}),
    });
  }

  function create(init: DriveRequestInit | undefined): HttpResponseLike {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      name?: string;
      mimeType?: string;
      parents?: string[];
      appProperties?: Record<string, string>;
    };
    if (body.mimeType !== DRIVE_FOLDER_MIME) return error(400, "only folders are made here");
    const parent = body.parents?.[0] ?? "root";
    if (parent !== "root" && !files.get(parent)?.byApp)
      return error(404, `File not found: ${parent}.`);
    const f = make({
      name: body.name ?? "Untitled",
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parent],
      ...(body.appProperties ? { appProperties: body.appProperties } : {}),
    });
    return respond(200, FIELDS_OUT(f));
  }

  function startUpload(init: DriveRequestInit | undefined, grant: Grant): HttpResponseLike {
    const metadata = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const parent = (metadata.parents as string[] | undefined)?.[0] ?? "root";
    if (parent !== "root" && !files.get(parent)?.byApp)
      return error(404, `File not found: ${parent}.`);
    const id = `fake-upload-${++n}`;
    sessions.set(id, { metadata, grant });
    const loc = location ?? `${DRIVE_UPLOAD_API}?uploadType=resumable&upload_id=${id}`;
    location = null;
    return respond(200, undefined, { location: loc });
  }

  function finishUpload(url: string, init: DriveRequestInit | undefined): HttpResponseLike {
    const id = query(url).upload_id ?? "";
    const s = sessions.get(id);
    if (!s) return error(404, "No such upload session");
    sessions.delete(id);
    const bytes = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    const m = s.metadata as {
      name?: string;
      mimeType?: string;
      parents?: string[];
      appProperties?: Record<string, string>;
    };
    const f = make({
      name: m.name ?? "Untitled",
      mimeType: m.mimeType ?? init?.headers?.["content-type"] ?? "application/octet-stream",
      parents: [m.parents?.[0] ?? "root"],
      ...(m.appProperties ? { appProperties: m.appProperties } : {}),
      bytes,
    });
    if (loseAnswer) {
      loseAnswer = false;
      return error(503, "Backend Error");
    }
    return respond(200, FIELDS_OUT(f));
  }

  const fetch: DriveFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      init?.body instanceof Uint8Array ? `<${init.body.length} bytes>` : (init?.body ?? "");
    requests.push({ url, method, headers: { ...(init?.headers ?? {}) }, body });
    if (url === GOOGLE_DRIVE_TOKEN_URL && method === "POST") return token(formDecode(body));
    if (url === GOOGLE_DRIVE_REVOKE_URL && method === "POST") {
      const t = formDecode(body).token ?? "";
      const grant = refreshTokens.get(t) ?? accessTokens.get(t)?.grant;
      if (!grant || grant.revoked) return respond(400, { error: "invalid_token" });
      grant.revoked = true;
      revokedTokens.push(t);
      return respond(200, {});
    }
    const u = parseUrl(url);
    if (u?.origin !== "https://www.googleapis.com") return error(404, `no fake for ${url}`);
    const grant = authorized(init);
    if (!grant) return error(401, "Request had invalid authentication credentials.");
    const path = u.pathname;
    if (path === "/drive/v3/about" && method === "GET") {
      return respond(200, { user: { emailAddress: grant.address, displayName: "Pat Lee" } });
    }
    if (path === "/drive/v3/files" && method === "GET") return filesList(url);
    if (path === "/drive/v3/files" && method === "POST") return create(init);
    if (path.startsWith("/drive/v3/files/") && method === "GET") {
      const f = files.get(decodeURIComponent(path.slice("/drive/v3/files/".length)));
      if (!f?.byApp) return error(404, "File not found.");
      return respond(200, FIELDS_OUT(f));
    }
    if (path === "/upload/drive/v3/files" && method === "POST") {
      if (query(url).uploadType !== "resumable") return error(400, "uploadType");
      return startUpload(init, grant);
    }
    if (path === "/upload/drive/v3/files" && method === "PUT") return finishUpload(url, init);
    return error(404, `no fake for ${method} ${url}`);
  };

  function pathOf(id: string): string {
    const names: string[] = [];
    let cur = files.get(id);
    while (cur) {
      names.unshift(cur.name);
      cur = files.get(cur.parents[0] ?? "");
    }
    return names.join("/");
  }

  return {
    fetch,
    requests,
    files,
    issueCode(opts = {}) {
      const code = `4/fake-drive-code-${++n}`;
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
    expireRefreshTokens() {
      for (const g of refreshTokens.values()) g.revoked = true;
    },
    loseNextUploadAnswer() {
      loseAnswer = true;
    },
    nextUploadLocation(loc) {
      location = loc;
    },
    seedForeignFile(name, parentId) {
      return make({ name, mimeType: "application/pdf", parents: [parentId], byApp: false });
    },
    pathOf,
    uploaded: () =>
      [...files.values()]
        .filter((f) => f.byApp && f.mimeType !== DRIVE_FOLDER_MIME)
        .map((f) => ({ ...f, path: pathOf(f.id) })),
    revoked: () => [...revokedTokens],
  };
}

/** The uploaded bytes as text (tests upload small text files). */
export function fakeDriveText(f: FakeDriveFile): string {
  return f.bytes ? fromUtf8(f.bytes) : "";
}
