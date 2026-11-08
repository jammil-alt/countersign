// P-3: attachments both ways (docs/plan.md §1.65). The documents a send tool carries: each one is a
// stored document of the call's own client, read through `ctx.services.documents` (which answers
// null for an id of another client), for that one send. Its name and type come from the document
// record, never from the input. PDFs and images only; at most five; the total within the provider's
// limit. Approval cards and before states get the names and sizes (`describeOutbound`); the send
// gets the bytes (`loadOutbound`) or a five-minute link (`linkOutbound`) for a provider that fetches
// the file itself.

import {
  type AttachmentSummary,
  bytesMatchType,
  describeAttachments,
  formatBytes,
  isSendableType,
  OUTBOUND_ATTACHMENTS_MAX,
  type OutboundAttachment,
} from "@countersign/core";
import type { DocumentFacts, StoredFile, ToolContext } from "./connector";

export type AttachmentRefusal =
  | "not_available"
  | "not_found"
  | "type_not_allowed"
  | "type_mismatch"
  | "too_many"
  | "too_large";

/** A send refused because of its attachments: nothing was sent. */
export class AttachmentRefusedError extends Error {
  constructor(
    readonly code: AttachmentRefusal,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentRefusedError";
  }
}

/** What one provider takes in one message. */
export interface AttachmentLimits {
  /** Shown in refusals: "Gmail", "Twilio (MMS)". */
  provider: string;
  maxCount: number;
  /** The attachments' total, in bytes as stored (before any encoding). */
  maxTotalBytes: number;
}

export interface LoadedAttachment extends AttachmentSummary {
  bytes: Uint8Array;
}

function documents(ctx: ToolContext) {
  const docs = ctx.services?.documents;
  if (!docs) {
    throw new AttachmentRefusedError("not_available", "documents can't be attached to this send");
  }
  return docs;
}

function checkCount(list: readonly OutboundAttachment[], limits: AttachmentLimits) {
  const max = Math.min(limits.maxCount, OUTBOUND_ATTACHMENTS_MAX);
  if (list.length > max) {
    throw new AttachmentRefusedError(
      "too_many",
      max === 0
        ? `${limits.provider} can't carry attachments`
        : `${limits.provider} carries at most ${max} attachment${max === 1 ? "" : "s"} in one message`,
    );
  }
}

function checkFacts(facts: DocumentFacts | null, documentId: string): AttachmentSummary {
  // DECISION: an unknown id and another client's id get the same answer (no hint that it exists).
  if (!facts) {
    throw new AttachmentRefusedError("not_found", `document ${documentId} is not this client's`);
  }
  if (!isSendableType(facts.mimeType)) {
    throw new AttachmentRefusedError(
      "type_not_allowed",
      `${facts.filename} is not a PDF or an image, so it can't be attached`,
    );
  }
  return {
    documentId: facts.id,
    filename: facts.filename,
    mimeType: facts.mimeType.toLowerCase(),
    sizeBytes: facts.sizeBytes,
  };
}

function checkTotal(list: readonly AttachmentSummary[], limits: AttachmentLimits) {
  const total = list.reduce((n, a) => n + a.sizeBytes, 0);
  if (total > limits.maxTotalBytes) {
    throw new AttachmentRefusedError(
      "too_large",
      `the attachments come to ${formatBytes(total)}; ${limits.provider} takes at most ${formatBytes(limits.maxTotalBytes)} in one message`,
    );
  }
}

const factsOf = (file: StoredFile): DocumentFacts => ({
  id: file.id,
  filename: file.filename,
  mimeType: file.mimeType,
  sizeBytes: file.bytes.length,
});

/** Names, types and sizes, checked, without reading the files when the platform can say. */
export async function describeOutbound(
  ctx: ToolContext,
  list: readonly OutboundAttachment[] | undefined,
  limits: AttachmentLimits,
): Promise<AttachmentSummary[]> {
  if (!list?.length) return [];
  checkCount(list, limits);
  const docs = documents(ctx);
  const out: AttachmentSummary[] = [];
  for (const a of list) {
    const facts = docs.describe
      ? await docs.describe(a.documentId)
      : await docs.read(a.documentId).then((f) => (f ? factsOf(f) : null));
    out.push(checkFacts(facts, a.documentId));
  }
  checkTotal(out, limits);
  return out;
}

/** The files themselves, read from storage for this send, checked as `describeOutbound`. */
export async function loadOutbound(
  ctx: ToolContext,
  list: readonly OutboundAttachment[] | undefined,
  limits: AttachmentLimits,
): Promise<LoadedAttachment[]> {
  if (!list?.length) return [];
  checkCount(list, limits);
  const docs = documents(ctx);
  const out: LoadedAttachment[] = [];
  for (const a of list) {
    const file = await docs.read(a.documentId);
    const summary = checkFacts(file ? factsOf(file) : null, a.documentId);
    const bytes = (file as StoredFile).bytes;
    // The bytes must be what the record says (a PDF starts %PDF-, a PNG with its signature).
    if (!bytesMatchType(bytes, summary.mimeType)) {
      throw new AttachmentRefusedError(
        "type_mismatch",
        `${summary.filename} isn't the ${summary.mimeType} its record says`,
      );
    }
    out.push({ ...summary, bytes });
  }
  checkTotal(out, limits);
  return out;
}

/** Five-minute links to the files, for providers that fetch them (Twilio, Meta). */
export async function linkOutbound(
  ctx: ToolContext,
  list: readonly OutboundAttachment[] | undefined,
  limits: AttachmentLimits,
): Promise<(AttachmentSummary & { url: string })[]> {
  const described = await describeOutbound(ctx, list, limits);
  if (described.length === 0) return [];
  const docs = documents(ctx);
  if (!docs.signedUrl) {
    throw new AttachmentRefusedError("not_available", "files can't be linked from this send");
  }
  const out: (AttachmentSummary & { url: string })[] = [];
  for (const a of described) {
    const url = await docs.signedUrl(a.documentId);
    if (!url) throw new AttachmentRefusedError("not_found", `${a.filename} can't be read now`);
    out.push({ ...a, url });
  }
  return out;
}

/** The attachments as a thread line or a record names them (no ids of anything but documents). */
export function attachmentLine(list: readonly AttachmentSummary[]): string {
  return list.length ? `Attached: ${describeAttachments(list)}` : "";
}

/** For outputs and records: the summary without the bytes or the link. */
export function summaries(list: readonly AttachmentSummary[]): AttachmentSummary[] {
  return list.map(({ documentId, filename, mimeType, sizeBytes }) => ({
    documentId,
    filename,
    mimeType,
    sizeBytes,
  }));
}
