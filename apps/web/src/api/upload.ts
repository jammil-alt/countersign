// `POST /api/uploads` sends multipart form data, which the JSON client does not: this sends the
// files and parses the answer with the same contract schema, failing the same way (ApiError). The
// back office's Sandbox upload (`POST /api/ops/clients/:id/uploads`) answers the same.
import { buildPath, routes, SESSION_ACTIVITY_HEADER, setupRoutes } from "@countersign/core";
import { ApiError, type ResponseOf } from "./client";
import { noteWrite } from "./store";

export type UploadResponse = ResponseOf<typeof routes.portalUploads>;

/** Where the Sandbox client's documents are uploaded from the back office. */
export function sandboxUploadPath(clientId: string): string {
  return buildPath(routes.opsSandboxUploads.path, { id: clientId });
}

export async function uploadFiles(
  files: readonly File[],
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
  path: string = routes.portalUploads.path,
): Promise<UploadResponse> {
  return postFiles(files, doFetch, path, routes.portalUploads.response);
}

export type SetupFilesResponse = ResponseOf<typeof setupRoutes.opsSetupItemFiles>;

/** G10: the back office sends a file item of a client agent's setup checklist for the client. */
export function sendSetupFiles(
  agentId: string,
  itemId: string,
  files: readonly File[],
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<SetupFilesResponse> {
  const path = buildPath(setupRoutes.opsSetupItemFiles.path, { id: agentId, itemId });
  return postFiles(files, doFetch, path, setupRoutes.opsSetupItemFiles.response);
}

async function postFiles<T>(
  files: readonly File[],
  doFetch: typeof fetch,
  path: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const route = `POST ${path}`;
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  let res: Response;
  try {
    res = await doFetch(path, {
      method: "POST",
      body: form,
      credentials: "same-origin",
      // Choosing files is the person's own act (docs/plan.md §1.35).
      headers: { accept: "application/json", [SESSION_ACTIVITY_HEADER]: "1" },
    });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      code: "network",
      message: "The API could not be reached.",
      route,
      cause,
    });
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON: reported below.
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError({
      status: res.status,
      code: err?.code ?? `http_${res.status}`,
      message: err?.message ?? `The upload failed (${res.status}).`,
      route,
      body: json,
    });
  }
  // The server took the files (2xx), whatever the answer looks like: stored answers (documents,
  // inbox) are stale from now.
  noteWrite();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      status: res.status,
      code: "invalid_response",
      message: "The response does not match the contract.",
      route,
      body: json,
    });
  }
  return parsed.data;
}

/**
 * §1.110: files for a message in the portal, kept quiet until the message is passed on
 * (`?for=chat`). What was kept as chips, and each refused file with the words to show.
 */
export async function attachToMessage(
  files: readonly File[],
  refusedWords?: (filename: string) => string,
  doFetch?: typeof fetch,
): Promise<{ files: { id: string; name: string; contentType: string }[]; refused: string[] }> {
  const out = await uploadFiles(files, doFetch, `${routes.portalUploads.path}?for=chat`);
  const kept = [];
  const refused = [];
  for (const r of out.results) {
    if (r.kind === "document" && r.document) {
      kept.push({ id: r.document.id, name: r.document.filename, contentType: r.document.mimeType });
    } else {
      refused.push(refusedWords ? refusedWords(r.filename) : `${r.filename}: ${r.error ?? ""}`);
    }
  }
  return { files: kept, refused };
}
