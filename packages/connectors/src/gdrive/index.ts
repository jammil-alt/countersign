// "gdrive": Google Drive, files only (ARCHITECTURE §6.11, docs/plan.md §1.52). A person at the
// client signs in to their Google account from the portal; we ask Google for `drive.file` and
// nothing else, so we see only the files and folders Mezonas itself made. At sign-in the
// connection makes its own folder (`Mezonas`, or `Mezonas - <the client's chosen name>`) and keeps
// its id in `config`; `drive.file.upload` files a stored document under it by a path template such
// as `Bills/{yyyy}/{MM}`, once per external action, and `drive.file.list` lists our files there.
// File names and contents go to models only in tool results (invariant 9). Unchecked facts about
// Google: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type StoredFile,
  type ToolContext,
} from "../connector";
import { formEncode, globalFetch, type HttpResponseLike, parseUrl, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { sha256Bytes, toHex, utf8 } from "../runtime";
import {
  driveFileName,
  driveQueryLiteral,
  MAX_FILE_NAME_LENGTH,
  nameProblem,
  pathDate,
  resolvePathTemplate,
  templateProblems,
} from "./path";

export const GDRIVE_CONNECTOR_ID = "gdrive";
/** Tool ids keep Drive's own name (ARCHITECTURE §6.11): `drive.` is a shared namespace. */
export const GDRIVE_TOOLS = {
  upload: "drive.file.upload",
  list: "drive.file.list",
} as const;

export const GOOGLE_DRIVE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
/** Where resumable upload sessions must point: we never send a file anywhere else. */
const DRIVE_UPLOAD_ORIGIN = "https://www.googleapis.com";

/** The one scope: files this app made or the person opened with it. Not a restricted scope. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// DECISION: `drive.file` only (ARCHITECTURE §6.11), no `openid email`: the signed-in address comes
// from Drive's own `about.get` (user.emailAddress), which `drive.file` can read (NOTES.md).
export const GDRIVE_SCOPES: readonly string[] = [DRIVE_FILE_SCOPE];

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** The appProperties key that marks a file with the external action that uploaded it. */
export const DRIVE_ACTION_PROPERTY = "mezonasAction";
/** The appProperties key that marks the connection's own folder. */
export const DRIVE_ROOT_PROPERTY = "mezonasRoot";

const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,trashed";

export const GdriveCredentials = OAuthTokens.extend({ address: z.string().min(3) });
export type GdriveCredentials = z.infer<typeof GdriveCredentials>;

/** What `connection.config` holds: the folder the connection made, and whose Drive it is. */
export const GdriveConfig = z.looseObject({
  address: z.string(),
  folderId: z.string().min(1),
  folderName: z.string().min(1),
  folderUrl: z.string().nullable().optional(),
  scopes: z.array(z.string()).optional(),
});
export type GdriveConfig = z.infer<typeof GdriveConfig>;

const TokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const DriveFile = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.string().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  webViewLink: z.string().optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean().optional(),
});
type DriveFile = z.infer<typeof DriveFile>;

const FileList = z.looseObject({
  files: z.array(DriveFile).default([]),
  nextPageToken: z.string().optional(),
});

export class DriveApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 429 and 5xx: a later try may get through (the step's retry). */
    readonly retryable = status === 429 || status >= 500,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

/** A file of that name is already in the target folder, and the step said not to add another. */
export class DriveFileExistsError extends DriveApiError {
  constructor(name: string, path: string) {
    super(409, `"${name}" is already in ${path || "the Mezonas folder"} in Google Drive`, false);
    this.name = "DriveFileExistsError";
  }
}

/** The connection's own folder is gone (deleted or in the bin). */
export class DriveFolderMissingError extends DriveApiError {
  constructor() {
    super(404, "the Mezonas folder is no longer in Google Drive; connect Drive again", false);
    this.name = "DriveFolderMissingError";
  }
}

export class GdriveNotConfiguredError extends Error {
  constructor() {
    super(
      "Google Drive sign-in is not set up on this deployment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)",
    );
    this.name = "GdriveNotConfiguredError";
  }
}

/** fetch with a body that may be bytes (the file itself). */
export interface DriveRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}
export type DriveFetch = (url: string, init?: DriveRequestInit) => Promise<HttpResponseLike>;

export interface GdriveOptions {
  /** Google Cloud's OAuth client ("Mezonas web"), the one Gmail uses. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: DriveFetch;
}

// ── Inputs and outputs ──────────────────────────────────────────────────────────────────────────

const PathTemplate = z
  .string()
  .max(300)
  .superRefine((t, ctx) => {
    for (const p of templateProblems(t)) ctx.addIssue({ code: "custom", message: p });
  });

const FileNameInput = z
  .string()
  .trim()
  .min(1)
  .max(MAX_FILE_NAME_LENGTH)
  .superRefine((n, ctx) => {
    const p = nameProblem(n, MAX_FILE_NAME_LENGTH);
    if (p) ctx.addIssue({ code: "custom", message: p });
    if (n.includes("/")) ctx.addIssue({ code: "custom", message: "a file name can't have a /" });
  });

export const DriveUploadInput = z.object({
  /** A stored document of this client (upload, email or another tool). */
  documentId: z.uuid(),
  /**
   * Folders under the connection's folder, by template: `{yyyy}`, `{yy}`, `{MM}`, `{dd}`
   * from `date`. Empty: the connection's folder itself. Missing folders are made.
   */
  path: PathTemplate.default(""),
  /** The day the template is filled from (e.g. the invoice date); default today (UTC). */
  date: z.iso.date().optional(),
  /** The file's name in Drive; default the stored document's. */
  fileName: FileNameInput.optional(),
  /** When a file of that name is already there: refuse (default), or add this one beside it. */
  ifExists: z.enum(["fail", "keep_both"]).default("fail"),
});

export const DriveUploadOutput = z.object({
  fileId: z.string(),
  name: z.string(),
  /** The folders under the connection's folder, `/`-separated ("" for the folder itself). */
  path: z.string(),
  folderId: z.string(),
  webViewLink: z.string().nullable(),
  size: z.number().int().nonnegative(),
  /** True when this action had already filed it (a retried step): nothing new was uploaded. */
  alreadyDone: z.boolean(),
});
export type DriveUploadOutput = z.infer<typeof DriveUploadOutput>;

const ExistingFile = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable(),
  modifiedTime: z.string().nullable(),
});

/** What the approver sees and `external_action.before` keeps. */
export const DriveUploadBefore = z.object({
  folder: z.object({ id: z.string(), name: z.string() }),
  path: z.string(),
  fileName: z.string(),
  /** Whether a file of that name is already in the target folder. */
  exists: z.boolean(),
  existing: ExistingFile.nullable(),
  /** Whether the target folder is there yet (it is made when the file is filed). */
  folderExists: z.boolean(),
  document: z.object({
    id: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    size: z.number().int(),
  }),
});

export const DriveListInput = z.object({
  /** A folder under the connection's folder, by the same template as uploads. */
  path: PathTemplate.default(""),
  date: z.iso.date().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  pageToken: z.string().max(2000).optional(),
});

const ListedFile = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.boolean(),
  mimeType: z.string().nullable(),
  size: z.number().int().nullable(),
  createdTime: z.string().nullable(),
  modifiedTime: z.string().nullable(),
  webViewLink: z.string().nullable(),
});

export const DriveListOutput = z.object({
  path: z.string(),
  /** Null when the folder isn't there (nothing filed there yet). */
  folderId: z.string().nullable(),
  files: z.array(ListedFile),
  nextPageToken: z.string().nullable(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** `Mezonas`, or `Mezonas - <name>` with the client's chosen name, made safe. */
// DECISION: the chosen name comes in the callback's parameters as `folder_name` (the portal page
// may post it beside the provider's; the generic route passes every parameter through), so no
// route or state changes. Without one the folder is plain `Mezonas`. Names are cut to 80
// characters, and `/` and control characters become spaces.
export function driveFolderName(chosen: string | undefined): string {
  let name = "";
  for (const ch of chosen ?? "") {
    const c = ch.charCodeAt(0);
    name += ch === "/" || ch === "\\" || c < 0x20 || c === 0x7f ? " " : ch;
  }
  name = name.trim().slice(0, 80).trim();
  return name ? `Mezonas - ${name}` : "Mezonas";
}

/** The appProperties value for an action's upload: a hash of its key, short enough for Drive. */
// DECISION: Drive takes no idempotency key, so each upload carries `mezonasAction` = the first 40
// hex characters of sha256("gdrive:" + key) in its appProperties (key + value must stay within
// 124 bytes), and a run looks for it before uploading: a retried step finds the first file.
export async function driveActionTag(idempotencyKey: string): Promise<string> {
  return toHex(await sha256Bytes(utf8(`gdrive:${idempotencyKey}`))).slice(0, 40);
}

function readJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function googleMessage(json: unknown): string {
  const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" ? msg : "no reason given";
}

const sizeOf = (f: DriveFile): number | null => (f.size === undefined ? null : Number(f.size));

function configOf(ctx: ToolContext): GdriveConfig {
  const r = GdriveConfig.safeParse(ctx.connection.config);
  if (!r.success)
    throw new ReconnectRequiredError("the Drive connection has no folder; connect again");
  return r.data;
}

async function documentOf(ctx: ToolContext, documentId: string): Promise<StoredFile> {
  const docs = ctx.services?.documents;
  if (!docs) throw new DriveApiError(500, "documents are not available to this call", false);
  const file = await docs.read(documentId);
  if (!file) throw new DriveApiError(404, "that document is not this client's", false);
  return file;
}

// ── The connector ───────────────────────────────────────────────────────────────────────────────

export function createGdriveConnector(options: GdriveOptions = {}): Connector {
  const doFetch = (): DriveFetch => options.fetch ?? (globalFetch() as unknown as DriveFetch);
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new GdriveNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>): Promise<z.infer<typeof TokenAnswer>> {
    const res = await doFetch()(GOOGLE_DRIVE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const parsed = TokenAnswer.safeParse(readJson(await res.text()));
    if (!parsed.success) {
      throw new DriveApiError(res.status, "Google's token answer has an unexpected shape");
    }
    return parsed.data;
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const c = client();
      const answer = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: c.id,
        client_secret: c.secret,
      });
      if ("error" in answer) {
        throw new ReconnectRequiredError(`Google refused the refresh: ${answer.error}`);
      }
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  /** One Drive call with this token: JSON in and out. Throws on anything but 2xx (and 401). */
  type Call = (
    method: string,
    url: string,
    body?: { type: string; data: string | Uint8Array; headers?: Record<string, string> },
  ) => Promise<{ status: number; json: unknown; location: string | null }>;

  function callWith(token: string): Call {
    return async (method, url, body) => {
      const res = await doFetch()(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": body.type, ...(body.headers ?? {}) } : {}),
        },
        ...(body ? { body: body.data } : {}),
        redirect: "manual",
        signal: timeoutSignal(60_000),
      });
      const json = readJson(await res.text());
      if (res.status === 401) throw new ReconnectRequiredError("Google refused the access token");
      if (!res.ok) {
        throw new DriveApiError(
          res.status,
          `Google Drive refused the request (${res.status}): ${googleMessage(json)}`,
        );
      }
      return { status: res.status, json, location: res.headers.get("location") };
    };
  }

  /** A Drive call for a connection: refreshes before expiry, and once more after a 401. */
  function callFor(ctx: ConnectionContext): Call {
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    return async (method, url, body) => {
      try {
        return await callWith(await tokens.accessToken())(method, url, body);
      } catch (error) {
        if (!(error instanceof ReconnectRequiredError)) throw error;
        return callWith((await tokens.refresh()).accessToken)(method, url, body);
      }
    };
  }

  async function list(call: Call, q: string, pageSize = 10, pageToken?: string) {
    const query = formEncode({
      q,
      spaces: "drive",
      pageSize: String(pageSize),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: "folder,name",
      ...(pageToken ? { pageToken } : {}),
    });
    const { json } = await call("GET", `${DRIVE_API}/files?${query}`);
    const parsed = FileList.safeParse(json);
    if (!parsed.success)
      throw new DriveApiError(502, "Google Drive's file list has an unexpected shape");
    return parsed.data;
  }

  /** The child of `parentId` with this name (a folder, or not), not in the bin. */
  async function child(call: Call, parentId: string, name: string, folder: boolean) {
    const q = [
      `name = ${driveQueryLiteral(name)}`,
      `${driveQueryLiteral(parentId)} in parents`,
      `mimeType ${folder ? "=" : "!="} ${driveQueryLiteral(DRIVE_FOLDER_MIME)}`,
      "trashed = false",
    ].join(" and ");
    const { files } = await list(call, q, 10);
    return files[0] ?? null;
  }

  async function createFolder(
    call: Call,
    name: string,
    parentId: string,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile> {
    const { json } = await call(
      "POST",
      `${DRIVE_API}/files?${formEncode({ fields: FILE_FIELDS })}`,
      {
        type: "application/json; charset=UTF-8",
        data: JSON.stringify({
          name,
          mimeType: DRIVE_FOLDER_MIME,
          parents: [parentId],
          ...(appProperties ? { appProperties } : {}),
        }),
      },
    );
    const parsed = DriveFile.safeParse(json);
    if (!parsed.success)
      throw new DriveApiError(502, "Google Drive didn't say which folder it made");
    return parsed.data;
  }

  /** The connection's folder, checked: still there and not in the bin. */
  async function rootFolder(
    call: Call,
    config: GdriveConfig,
  ): Promise<{ id: string; name: string }> {
    try {
      const { json } = await call(
        "GET",
        `${DRIVE_API}/files/${encodeURIComponent(config.folderId)}?${formEncode({ fields: FILE_FIELDS })}`,
      );
      const f = DriveFile.safeParse(json);
      if (!f.success || f.data.trashed) throw new DriveFolderMissingError();
      return { id: f.data.id, name: f.data.name };
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404)
        throw new DriveFolderMissingError();
      throw error;
    }
  }

  /** Walks the folders under `rootId`; makes missing ones when `create`, else stops at null. */
  async function walk(
    call: Call,
    rootId: string,
    segments: string[],
    create: boolean,
  ): Promise<string | null> {
    let parent = rootId;
    for (const name of segments) {
      const found = await child(call, parent, name, true);
      if (found) {
        parent = found.id;
        continue;
      }
      if (!create) return null;
      parent = (await createFolder(call, name, parent)).id;
    }
    return parent;
  }

  function resolved(template: string, date: string | undefined, now: Date): string[] {
    const r = resolvePathTemplate(template, pathDate(date, now));
    if (!r.ok)
      throw new DriveApiError(400, `the path can't be used: ${r.problems.join("; ")}`, false);
    return r.segments;
  }

  /** Our earlier upload for this action, if any (a retried step). */
  async function uploadedFor(call: Call, tag: string): Promise<DriveFile | null> {
    const q = [
      `appProperties has { key=${driveQueryLiteral(DRIVE_ACTION_PROPERTY)} and value=${driveQueryLiteral(tag)} }`,
      "trashed = false",
    ].join(" and ");
    const { files } = await list(call, q, 10);
    return files[0] ?? null;
  }

  /** A resumable upload in one piece: works for every stored document's size (32 MB at most). */
  // DECISION: resumable rather than multipart (5 MB at most at Google): one code path for every
  // document. The session URL must be on www.googleapis.com, or nothing is sent to it.
  async function upload(
    call: Call,
    file: StoredFile,
    metadata: Record<string, unknown>,
  ): Promise<DriveFile> {
    const started = await call(
      "POST",
      `${DRIVE_UPLOAD_API}?${formEncode({ uploadType: "resumable", fields: FILE_FIELDS })}`,
      {
        type: "application/json; charset=UTF-8",
        data: JSON.stringify(metadata),
        headers: {
          "x-upload-content-type": file.mimeType,
          "x-upload-content-length": String(file.bytes.length),
        },
      },
    );
    const session = started.location ? parseUrl(started.location) : null;
    if (session?.origin !== DRIVE_UPLOAD_ORIGIN || session.protocol !== "https:") {
      throw new DriveApiError(502, "Google Drive gave no usable upload address", false);
    }
    const { json } = await call("PUT", session.href, { type: file.mimeType, data: file.bytes });
    const parsed = DriveFile.safeParse(json);
    if (!parsed.success) throw new DriveApiError(502, "Google Drive didn't say which file it made");
    return parsed.data;
  }

  return defineConnector({
    id: GDRIVE_CONNECTOR_ID,
    name: "Google Drive",
    description:
      "File documents in a Mezonas folder in your Google Drive. We see only what we file.",
    icon: "folder",
    auth: "oauth2",
    entities: [],
    // DECISION: tool ids keep Drive's name (ARCHITECTURE §6.11: `drive.file.upload`), so `drive`
    // is the connector's shared namespace; another drive provider could offer the same tools.
    sharedNamespaces: ["drive"],
    // v0.12 W2-A: record types for the matrix (docs/plan.md §1.44).
    permissionEntities: [{ id: "file", label: "Files", verbs: ["read", "create"] }],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        redirect_uri: req.redirectUri,
        response_type: "code",
        scope: GDRIVE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state: req.state,
      });
      return { redirectUrl: `${GOOGLE_DRIVE_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Google callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Google refused the sign-in: ${answer.error}`);
      const scopes = (answer.scope ?? "").split(" ").filter(Boolean);
      if (!scopes.includes(DRIVE_FILE_SCOPE)) {
        throw new SignInRefusedError(
          "Google didn't give us permission to file documents in your Drive. Connect again and allow it.",
        );
      }
      if (scopes.some((s) => s !== DRIVE_FILE_SCOPE)) {
        throw new SignInRefusedError(
          "Google gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Google gave no refresh token");
      const call = callWith(answer.access_token);
      const about = z
        .looseObject({ user: z.looseObject({ emailAddress: z.string().min(3) }) })
        .safeParse(
          (
            await call(
              "GET",
              `${DRIVE_API}/about?${formEncode({ fields: "user(emailAddress,displayName)" })}`,
            )
          ).json,
        );
      if (!about.success) throw new SignInRefusedError("Google didn't say which account signed in");
      const address = about.data.user.emailAddress.trim().toLowerCase();
      // DECISION: a reconnect finds the folder it made before (same name, marked as ours, at the top
      // of My Drive, not in the bin) instead of making a second one.
      const folderName = driveFolderName(params.folder_name);
      const rootQ = [
        `name = ${driveQueryLiteral(folderName)}`,
        `${driveQueryLiteral("root")} in parents`,
        `mimeType = ${driveQueryLiteral(DRIVE_FOLDER_MIME)}`,
        "trashed = false",
        `appProperties has { key=${driveQueryLiteral(DRIVE_ROOT_PROPERTY)} and value=${driveQueryLiteral("1")} }`,
      ].join(" and ");
      const folder =
        (await list(call, rootQ, 1)).files[0] ??
        (await createFolder(call, folderName, "root", { [DRIVE_ROOT_PROPERTY]: "1" }));
      const now = new Date();
      const credentials: GdriveCredentials = GdriveCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        scope: scopes.join(" "),
        address,
      });
      const config: GdriveConfig = {
        address,
        folderId: folder.id,
        folderName: folder.name,
        folderUrl: folder.webViewLink ?? null,
        scopes: ["drive.file"],
      };
      return {
        externalAccountId: address,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: refresher,
    // DECISION: no `revoke`. Drive shares Gmail's Google OAuth client, and Google's revoke ends
    // every scope the account granted that client, so revoking Drive's token could also end a Gmail
    // connection made by the same Google account. Disconnect drops only our tokens; the person can
    // remove Mezonas in their Google account. If the owner gives Drive its own OAuth client, the
    // revoke can be turned back on (docs/plan.md §1.52).

    tools: [
      defineReadTool({
        id: GDRIVE_TOOLS.list,
        entity: "file",
        description:
          "List the files Mezonas filed in the connection's Google Drive folder, or in a folder under it by path (e.g. Bills/{yyyy}/{MM}). Only our own files are visible.",
        summary: "Listed files in Google Drive",
        input: DriveListInput,
        output: DriveListOutput,
        async run(input, ctx) {
          const config = configOf(ctx);
          const call = callFor(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const root = await rootFolder(call, config);
          const folderId = await walk(call, root.id, segments, false);
          const path = segments.join("/");
          if (!folderId) return { path, folderId: null, files: [], nextPageToken: null };
          const q = [`${driveQueryLiteral(folderId)} in parents`, "trashed = false"].join(" and ");
          const page = await list(call, q, input.limit, input.pageToken);
          return {
            path,
            folderId,
            files: page.files.map((f) => ({
              id: f.id,
              name: f.name,
              folder: f.mimeType === DRIVE_FOLDER_MIME,
              mimeType: f.mimeType ?? null,
              size: sizeOf(f),
              createdTime: f.createdTime ?? null,
              modifiedTime: f.modifiedTime ?? null,
              webViewLink: f.webViewLink ?? null,
            })),
            nextPageToken: page.nextPageToken ?? null,
          };
        },
      }),

      defineWriteTool({
        id: GDRIVE_TOOLS.upload,
        entity: "file",
        description:
          "File a stored document in the client's Google Drive, in the Mezonas folder or a folder under it by path template ({yyyy}, {yy}, {MM}, {dd} from the date), e.g. Bills/{yyyy}/{MM}. Missing folders are made. Refuses when a file of that name is already there unless ifExists is keep_both.",
        verb: "create",
        summary: "Filed {{name}} in Google Drive",
        input: DriveUploadInput,
        output: DriveUploadOutput,
        beforeSchema: DriveUploadBefore,
        async before(input, ctx) {
          const config = configOf(ctx);
          const file = await documentOf(ctx, input.documentId);
          const call = callFor(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const fileName = input.fileName ?? driveFileName(file.filename);
          const root = await rootFolder(call, config);
          // Reads only: a missing folder is reported, not made.
          const folderId = await walk(call, root.id, segments, false);
          const existing = folderId ? await child(call, folderId, fileName, false) : null;
          return {
            folder: root,
            path: segments.join("/"),
            fileName,
            exists: existing !== null,
            existing: existing
              ? {
                  id: existing.id,
                  name: existing.name,
                  webViewLink: existing.webViewLink ?? null,
                  modifiedTime: existing.modifiedTime ?? null,
                }
              : null,
            folderExists: folderId !== null,
            document: {
              id: file.id,
              fileName: file.filename,
              mimeType: file.mimeType,
              size: file.bytes.length,
            },
          };
        },
        async run(input, ctx) {
          const config = configOf(ctx);
          const file = await documentOf(ctx, input.documentId);
          const call = callFor(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const path = segments.join("/");
          const fileName = input.fileName ?? driveFileName(file.filename);
          const tag = await driveActionTag(ctx.idempotencyKey);
          const done = (
            f: DriveFile,
            folderId: string,
            alreadyDone: boolean,
          ): DriveUploadOutput => ({
            fileId: f.id,
            name: f.name,
            path,
            folderId: f.parents?.[0] ?? folderId,
            webViewLink: f.webViewLink ?? null,
            size: sizeOf(f) ?? file.bytes.length,
            alreadyDone,
          });
          // Executed once: a retried step finds the file this action already filed.
          const earlier = await uploadedFor(call, tag);
          if (earlier) return done(earlier, earlier.parents?.[0] ?? "", true);
          const root = await rootFolder(call, config);
          const folderId = (await walk(call, root.id, segments, true)) as string;
          if (input.ifExists === "fail" && (await child(call, folderId, fileName, false))) {
            throw new DriveFileExistsError(fileName, path);
          }
          const made = await upload(call, file, {
            name: fileName,
            parents: [folderId],
            mimeType: file.mimeType,
            appProperties: { [DRIVE_ACTION_PROPERTY]: tag },
          });
          return done(made, folderId, false);
        },
      }),
    ],
  });
}
