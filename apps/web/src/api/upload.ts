// `POST /api/uploads` sends multipart form data, which the JSON client does not: this sends the
// files and parses the answer with the same contract schema, failing the same way (ApiError). The
// back office's Sandbox upload (`POST /api/ops/clients/:id/uploads`) answers the same.
import { buildPath, routes, SESSION_ACTIVITY_HEADER } from "@countersign/core";
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
  const parsed = routes.portalUploads.response.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      status: res.status,
      code: "invalid_response",
      message: "The response does not match the contract.",
      route,
      body: json,
    });
  }
  // An upload is a write: stored answers (documents, inbox) are stale from now.
  noteWrite();
  return parsed.data;
}
