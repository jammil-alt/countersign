// The signed copy of a deal's contract: the PDF's bytes in the body (`PUT
// /api/ops/deals/:id/terms/signed-copy`), which the JSON client does not send. Fails the same way
// (ApiError) and parses the answer with the contract.
import {
  buildPath,
  DEAL_SIGNED_COPY_MAX_BYTES,
  DEAL_SIGNED_COPY_TYPE,
  routes,
  SESSION_ACTIVITY_HEADER,
} from "@countersign/core";
import { ApiError } from "../../../api/client";
import { noteWrite } from "../../../api/store";

export async function uploadSignedCopy(
  dealId: string,
  file: File,
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<{ ok: true; bytes: number }> {
  const spec = routes.opsDealUploadSignedCopy;
  const path = `${buildPath(spec.path, { id: dealId })}?name=${encodeURIComponent(file.name.slice(0, 200))}`;
  const route = `${spec.method} ${spec.path}`;
  if (file.type && file.type !== DEAL_SIGNED_COPY_TYPE) {
    throw new ApiError({ status: 422, code: "not_pdf", message: "Choose a PDF.", route });
  }
  if (file.size > DEAL_SIGNED_COPY_MAX_BYTES) {
    throw new ApiError({
      status: 422,
      code: "too_large",
      message: "The signed copy is larger than 10 MB.",
      route,
    });
  }
  let res: Response;
  try {
    res = await doFetch(path, {
      method: "PUT",
      body: file,
      credentials: "same-origin",
      // Choosing the file is the person's own act (docs/plan.md §1.35).
      headers: {
        accept: "application/json",
        "content-type": DEAL_SIGNED_COPY_TYPE,
        [SESSION_ACTIVITY_HEADER]: "1",
      },
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
  noteWrite();
  return spec.response.parse(json);
}
