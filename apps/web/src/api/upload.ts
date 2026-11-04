// `POST /api/uploads` sends multipart form data, which the JSON client does not: this sends the
// files and parses the answer with the same contract schema, failing the same way (ApiError).
import { routes } from "@countersign/core";
import { ApiError, type ResponseOf } from "./client";

export type UploadResponse = ResponseOf<typeof routes.portalUploads>;

export async function uploadFiles(
  files: readonly File[],
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<UploadResponse> {
  const route = `POST ${routes.portalUploads.path}`;
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  let res: Response;
  try {
    res = await doFetch(routes.portalUploads.path, {
      method: "POST",
      body: form,
      credentials: "same-origin",
      headers: { accept: "application/json" },
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
  return parsed.data;
}
