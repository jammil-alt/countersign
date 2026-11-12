// "onedrive": OneDrive, files only (docs/plan.md §1.97). A person at the client signs in to their
// Microsoft account from the portal; we ask Microsoft for `Files.ReadWrite.AppFolder` and nothing
// else, so Microsoft lets us see only our own app folder (`Apps/<our app's name>` in their
// OneDrive) and nothing they keep elsewhere: the match for Google Drive's `drive.file`. It offers
// the same tools as Google Drive (`drive.file.upload`, `drive.file.list`, the shared `drive`
// namespace, the same shapes), so a workflow files a document by month in whichever drive the
// agent is bound to. Uploads go once per external action: Graph takes no idempotency key, so the
// attempt is recorded first, the file goes to an exact name with `conflictBehavior=fail`, and a
// retry looks for that name before anything is sent again. File names reach models only in tool
// results (invariant 9). Unchecked facts about Microsoft: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { WriteAttemptServices } from "../attempts";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type StoredFile,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import {
  DriveApiError,
  DriveFileExistsError,
  DriveFolderMissingError,
  DriveListInput,
  DriveListOutput,
  DriveUploadBefore,
  DriveUploadInput,
  DriveUploadOutput,
} from "../gdrive/index";
import { driveFileName, MAX_FILE_NAME_LENGTH, pathDate, resolvePathTemplate } from "../gdrive/path";
import { formDecode, formEncode, parseUrl } from "../http";
import {
  type GraphCall,
  MicrosoftApiError,
  type MicrosoftAppOptions,
  microsoftSignIn,
} from "../microsoft/identity";
import { ReconnectRequiredError } from "../oauth/tokens";

export const ONEDRIVE_CONNECTOR_ID = "onedrive";
/** The same tool ids as Google Drive, in the shared `drive` namespace. */
export const ONEDRIVE_TOOLS = {
  upload: "drive.file.upload",
  list: "drive.file.list",
} as const;

/** The one Graph scope: our own app folder in the person's OneDrive. */
// DECISION: `Files.ReadWrite.AppFolder` only (owner, 2026-11-12: the strict option), so Microsoft
// itself keeps us out of everything but `Apps/<app name>`. Microsoft marks the delegated scope as
// preview and its docs list it for personal accounts; whether it works for OneDrive for Business is
// the first thing to check (NOTES.md). If it doesn't, the fallback is `Files.ReadWrite` with our
// own folder check, which is the owner's call.
export const ONEDRIVE_GRAPH_SCOPE = "Files.ReadWrite.AppFolder";

/** Attempts under one key that OneDrive refused before we stop trying. */
const MAX_ATTEMPTS = 5;
/** Names tried for `keep_both` before we give up: `name.pdf`, `name (2).pdf`, … */
const MAX_KEEP_BOTH = 50;

const ITEM_SELECT =
  "id,name,size,file,folder,webUrl,createdDateTime,lastModifiedDateTime,parentReference";

const DriveItem = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  size: z.number().int().nonnegative().optional(),
  webUrl: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  file: z.looseObject({ mimeType: z.string().optional() }).optional(),
  folder: z.looseObject({}).optional(),
  parentReference: z.looseObject({ id: z.string().optional() }).optional(),
});
type DriveItem = z.infer<typeof DriveItem>;

const Children = z.looseObject({
  value: z.array(DriveItem).default([]),
  "@odata.nextLink": z.string().optional(),
});

/** What `connection.config` holds: the app folder, and whose OneDrive it is. */
export const OnedriveConfig = z.looseObject({
  address: z.string(),
  folderId: z.string().min(1),
  folderName: z.string().min(1),
  folderUrl: z.string().nullable().optional(),
  scopes: z.array(z.string()).optional(),
});
export type OnedriveConfig = z.infer<typeof OnedriveConfig>;

export interface OnedriveOptions extends MicrosoftAppOptions {}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = new Set(['"', "*", ":", "<", ">", "?", "/", "\\", "|"]);

/**
 * A folder or file name OneDrive accepts: its forbidden characters (`" * : < > ? / \ |`) and
 * control characters become `-`, and leading or trailing spaces and trailing dots go.
 */
// DECISION: the shared `drive.*` inputs are Google Drive's, which allow more characters than
// OneDrive, so the same workflow works on both: OneDrive's names are made safe rather than refused
// ("INV: 1042.pdf" is filed as "INV- 1042.pdf"). The before state shows the name as it will be.
export function onedriveName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += FORBIDDEN.has(ch) || c < 0x20 || c === 0x7f ? "-" : ch;
  }
  out = out.trim();
  while (out.endsWith(".")) out = out.slice(0, -1).trimEnd();
  return out || "document";
}

/** `name.pdf` → `name (n).pdf`, for `keep_both`. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext}`.slice(-MAX_FILE_NAME_LENGTH);
}

/** A path under an item: each name encoded on its own (`/` between). */
function itemPath(names: readonly string[]): string {
  return names.map((n) => encodeURIComponent(n)).join("/");
}

function configOf(ctx: ToolContext): OnedriveConfig {
  const r = OnedriveConfig.safeParse(ctx.connection.config);
  if (!r.success) {
    throw new ReconnectRequiredError("the OneDrive connection has no folder; connect again");
  }
  return r.data;
}

async function documentOf(ctx: ToolContext, documentId: string): Promise<StoredFile> {
  const docs = ctx.services?.documents;
  if (!docs) throw new DriveApiError(500, "documents are not available to this call", false);
  const file = await docs.read(documentId);
  if (!file) throw new DriveApiError(404, "that document is not this client's", false);
  return file;
}

function attemptServices(ctx: ToolContext): WriteAttemptServices {
  const s = ctx.services?.attempts;
  if (!s) throw new Error("OneDrive uploads need the platform's record of attempts");
  return s;
}

function resolved(template: string, date: string | undefined, now: Date): string[] {
  const r = resolvePathTemplate(template, pathDate(date, now));
  if (!r.ok) {
    throw new DriveApiError(400, `the path can't be used: ${r.problems.join("; ")}`, false);
  }
  return r.segments.map(onedriveName);
}

/** A Graph refusal in the shared drive error, so the same workflow reads the same failures. */
function asDriveError(error: unknown): unknown {
  if (error instanceof MicrosoftApiError) {
    return new DriveApiError(error.status, error.message, error.retryable);
  }
  return error;
}

/** The `$skiptoken` of Graph's next page, which `drive.file.list` hands back as its page token. */
// DECISION: the page token is only Graph's `$skiptoken`, never a URL from the input: the next page
// is asked for under the same folder, so a token can't point a call anywhere else.
export function skipTokenOf(nextLink: string | undefined): string | null {
  if (!nextLink) return null;
  const q = nextLink.indexOf("?");
  if (q < 0 || !parseUrl(nextLink)) return null;
  return formDecode(nextLink.slice(q + 1)).$skiptoken ?? null;
}

// ── The connector ───────────────────────────────────────────────────────────────────────────────

export function createOnedriveConnector(options: OnedriveOptions = {}): Connector {
  const signIn = microsoftSignIn(options, {
    provider: "OneDrive",
    envNames: "ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET",
    graphScopes: [ONEDRIVE_GRAPH_SCOPE],
    missingMessage:
      "Microsoft didn't give us permission to file documents in your OneDrive. Connect again and allow it.",
  });

  const call = (ctx: ConnectionContext): GraphCall => {
    const graph = signIn.graph(ctx);
    return async (method, path, body, opts) => {
      try {
        return await graph(method, path, body, opts);
      } catch (error) {
        throw asDriveError(error);
      }
    };
  };

  function itemOf(json: unknown, what: string): DriveItem {
    const parsed = DriveItem.safeParse(json);
    if (!parsed.success) throw new DriveApiError(502, `OneDrive didn't say ${what}`);
    return parsed.data;
  }

  /** The connection's app folder, checked: still there. */
  async function rootFolder(graph: GraphCall, config: OnedriveConfig) {
    const res = await graph(
      "GET",
      `/me/drive/items/${encodeURIComponent(config.folderId)}?${formEncode({ $select: ITEM_SELECT })}`,
      undefined,
      { accept: [404] },
    );
    if (res.status === 404) throw new DriveFolderMissingError();
    const item = itemOf(res.json, "which folder is ours");
    if (!item.folder) throw new DriveFolderMissingError();
    return { id: item.id, name: item.name };
  }

  /** The child of `parentId` with this name, or null. */
  async function child(graph: GraphCall, parentId: string, name: string) {
    const res = await graph(
      "GET",
      `/me/drive/items/${encodeURIComponent(parentId)}:/${itemPath([name])}?${formEncode({ $select: ITEM_SELECT })}`,
      undefined,
      { accept: [404] },
    );
    return res.status === 404 ? null : itemOf(res.json, "what is in the folder");
  }

  async function createFolder(graph: GraphCall, parentId: string, name: string) {
    const res = await graph(
      "POST",
      `/me/drive/items/${encodeURIComponent(parentId)}/children`,
      { json: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" } },
      { accept: [409] },
    );
    // Made at the same moment by another run: use that one.
    if (res.status === 409) {
      const found = await child(graph, parentId, name);
      if (found?.folder) return found;
      throw new DriveApiError(409, `"${name}" is a file in OneDrive, not a folder`, false);
    }
    return itemOf(res.json, "which folder it made");
  }

  /** Walks the folders under `rootId`; makes missing ones when `create`, else stops at null. */
  async function walk(graph: GraphCall, rootId: string, segments: string[], create: boolean) {
    let parent = rootId;
    for (const name of segments) {
      const found = await child(graph, parent, name);
      if (found?.folder) {
        parent = found.id;
        continue;
      }
      if (found)
        throw new DriveApiError(409, `"${name}" is a file in OneDrive, not a folder`, false);
      if (!create) return null;
      parent = (await createFolder(graph, parent, name)).id;
    }
    return parent;
  }

  /** The name a new file gets: the asked-for one, or for keep_both the first free numbered one. */
  async function freeName(
    graph: GraphCall,
    folderId: string,
    name: string,
    ifExists: "fail" | "keep_both",
    path: string,
  ): Promise<string> {
    for (let n = 1; n <= MAX_KEEP_BOTH; n++) {
      const candidate = numberedName(name, n);
      if (!(await child(graph, folderId, candidate))) return candidate;
      if (ifExists === "fail") throw new DriveFileExistsError(candidate, path);
    }
    throw new DriveApiError(
      409,
      `there are already ${MAX_KEEP_BOTH} files named like "${name}"`,
      false,
    );
  }

  const output = (
    item: DriveItem,
    path: string,
    folderId: string,
    size: number,
    alreadyDone: boolean,
  ): DriveUploadOutput => ({
    fileId: item.id,
    name: item.name,
    path,
    folderId: item.parentReference?.id ?? folderId,
    webViewLink: item.webUrl ?? null,
    size: item.size ?? size,
    alreadyDone,
  });

  return defineConnector({
    id: ONEDRIVE_CONNECTOR_ID,
    name: "OneDrive",
    description:
      "File documents in a Mezonas folder in your OneDrive. We can't see anything else in it.",
    icon: "folder",
    auth: "oauth2",
    entities: [],
    // The same tools as Google Drive (§1.97): a workflow names `drive.file.upload` and the agent's
    // binding decides which drive answers.
    sharedNamespaces: ["drive"],
    permissionEntities: [{ id: "file", label: "Files", verbs: ["read", "create"] }],
    isConfigured: () => signIn.configured,

    async authorize(req) {
      return { redirectUrl: signIn.authorizeUrl(req) };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Microsoft callback has no code");
      const { credentials, account, accessToken } = await signIn.exchange(code, req.redirectUri);
      // DECISION: the connection's folder is the app folder itself (`Apps/<app name>`, made by
      // OneDrive on the first call); Microsoft names it after the Entra app, so the owner names the
      // app "Mezonas". No per-client name as Google Drive has: the app folder can't be renamed by us.
      const res = await signIn.graphWith(accessToken)(
        "GET",
        `/me/drive/special/approot?${formEncode({ $select: ITEM_SELECT })}`,
      );
      const folder = itemOf(res.json, "which folder is ours");
      const config: OnedriveConfig = {
        address: account.address,
        folderId: folder.id,
        folderName: folder.name,
        folderUrl: folder.webUrl ?? null,
        scopes: [ONEDRIVE_GRAPH_SCOPE],
      };
      return {
        externalAccountId: account.address,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: signIn.refresher,
    // DECISION: no `revoke`, as Outlook: Microsoft has no endpoint that revokes one app's delegated
    // grant; disconnect drops our tokens and the person removes the app in their account.

    tools: [
      defineReadTool({
        id: ONEDRIVE_TOOLS.list,
        entity: "file",
        description:
          "List the files in the connection's Mezonas folder in OneDrive, or in a folder under it by path (e.g. Bills/{yyyy}/{MM}). Only that folder is visible.",
        summary: "Listed files in OneDrive",
        input: DriveListInput,
        output: DriveListOutput,
        async run(input, ctx) {
          const config = configOf(ctx);
          const graph = call(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const root = await rootFolder(graph, config);
          const folderId = await walk(graph, root.id, segments, false);
          const path = segments.join("/");
          if (!folderId) return { path, folderId: null, files: [], nextPageToken: null };
          const query = formEncode({
            $select: ITEM_SELECT,
            $top: String(input.limit),
            ...(input.pageToken ? { $skiptoken: input.pageToken } : {}),
          });
          const res = await graph(
            "GET",
            `/me/drive/items/${encodeURIComponent(folderId)}/children?${query}`,
          );
          const page = Children.safeParse(res.json);
          if (!page.success)
            throw new DriveApiError(502, "OneDrive's file list has an unexpected shape");
          return {
            path,
            folderId,
            files: page.data.value.map((f) => ({
              id: f.id,
              name: f.name,
              folder: Boolean(f.folder),
              mimeType: f.file?.mimeType ?? null,
              size: f.folder ? null : (f.size ?? null),
              createdTime: f.createdDateTime ?? null,
              modifiedTime: f.lastModifiedDateTime ?? null,
              webViewLink: f.webUrl ?? null,
            })),
            nextPageToken: skipTokenOf(page.data["@odata.nextLink"]),
          };
        },
      }),

      defineWriteTool({
        id: ONEDRIVE_TOOLS.upload,
        entity: "file",
        description:
          "File a stored document in the client's OneDrive, in the Mezonas folder or a folder under it by path template ({yyyy}, {yy}, {MM}, {dd} from the date), e.g. Bills/{yyyy}/{MM}. Missing folders are made. Refuses when a file of that name is already there unless ifExists is keep_both.",
        verb: "create",
        // R5: no void or archive tool, and delete stays off.
        undo: { kind: "none" },
        summary: "Filed {{name}} in OneDrive",
        input: DriveUploadInput,
        output: DriveUploadOutput,
        beforeSchema: DriveUploadBefore,
        async before(input, ctx) {
          const config = configOf(ctx);
          const file = await documentOf(ctx, input.documentId);
          const graph = call(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const fileName = onedriveName(input.fileName ?? driveFileName(file.filename));
          const root = await rootFolder(graph, config);
          // Reads only: a missing folder is reported, not made.
          const folderId = await walk(graph, root.id, segments, false);
          const existing = folderId ? await child(graph, folderId, fileName) : null;
          return {
            folder: root,
            path: segments.join("/"),
            fileName,
            exists: existing !== null,
            existing: existing
              ? {
                  id: existing.id,
                  name: existing.name,
                  webViewLink: existing.webUrl ?? null,
                  modifiedTime: existing.lastModifiedDateTime ?? null,
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
          const attempts = attemptServices(ctx);
          const key = ctx.idempotencyKey;
          // A re-run after the upload was recorded returns it, before any call.
          const state = await attempts.stateFor(key);
          if (state.done) return { ...DriveUploadOutput.parse(state.done), alreadyDone: true };
          const config = configOf(ctx);
          const file = await documentOf(ctx, input.documentId);
          const graph = call(ctx);
          const segments = resolved(input.path, input.date, ctx.now());
          const path = segments.join("/");
          const root = await rootFolder(graph, config);

          // DECISION: Graph takes no idempotency key, but we can read our own folder: an attempt
          // started with no answer is checked by the exact name it recorded. The file there with
          // the document's size is ours (done); no file means the upload never landed (a simple
          // upload is all or nothing) and it may go again; anything else is for a person to check.
          if (state.started > state.refused && state.last) {
            const d = state.last.details;
            const earlierFolder = typeof d.folderId === "string" ? d.folderId : null;
            const earlierName = typeof d.name === "string" ? d.name : null;
            const found =
              earlierFolder && earlierName ? await child(graph, earlierFolder, earlierName) : null;
            if (found && !found.folder && found.size === file.bytes.length) {
              const out = output(found, path, earlierFolder as string, file.bytes.length, true);
              await attempts.done({ idempotencyKey: key, output: out, at: ctx.now() });
              return out;
            }
            if (found) {
              throw new UnconfirmedWriteError(
                `${earlierName} may have been filed in OneDrive`,
                `we started it at ${state.last.startedAt.toISOString()} and a file of that name is there now, but not the same size`,
                { channel: "onedrive", ...d, startedAt: state.last.startedAt.toISOString() },
              );
            }
          }
          if (state.started >= MAX_ATTEMPTS) {
            throw new DriveApiError(
              409,
              `OneDrive refused this file ${state.started} times; we stopped trying`,
              false,
            );
          }

          const folderId = (await walk(graph, root.id, segments, true)) as string;
          const wanted = onedriveName(input.fileName ?? driveFileName(file.filename));
          const name = await freeName(graph, folderId, wanted, input.ifExists, path);
          const attempt = state.started + 1;
          const details: JsonObject = { folderId, path, name, size: file.bytes.length, attempt };
          const claimed = await attempts.start({
            idempotencyKey: key,
            attempt,
            details,
            at: ctx.now(),
          });
          if (!claimed) {
            throw new UnconfirmedWriteError(
              `${name} may have been filed in OneDrive`,
              "another run of this action started filing it at the same time",
              { channel: "onedrive", ...details },
            );
          }
          // A network failure or timeout throws here with the attempt open: checked on retry.
          let res: Awaited<ReturnType<GraphCall>>;
          try {
            res = await graph(
              "PUT",
              `/me/drive/items/${encodeURIComponent(folderId)}:/${itemPath([name])}:/content?${formEncode({ "@microsoft.graph.conflictBehavior": "fail" })}`,
              { bytes: file.bytes, type: file.mimeType },
              { accept: [409], timeoutMs: 120_000 },
            );
          } catch (error) {
            // OneDrive answered and stored nothing: the next try is a new attempt.
            if (error instanceof DriveApiError && error.status < 500 && error.status !== 429) {
              await attempts.refused({
                idempotencyKey: key,
                attempt,
                reason: String(error.status),
                at: ctx.now(),
              });
            }
            throw error;
          }
          if (res.status === 409) {
            await attempts.refused({ idempotencyKey: key, attempt, reason: "409", at: ctx.now() });
            throw new DriveFileExistsError(name, path);
          }
          const made = itemOf(res.json, "which file it made");
          const out = output(made, path, folderId, file.bytes.length, false);
          await attempts.done({ idempotencyKey: key, output: out, at: ctx.now() });
          return out;
        },
      }),
    ],
  });
}
