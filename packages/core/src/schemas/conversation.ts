// v0.14 capture: WhatsApp passive capture (ARCHITECTURE §6.12, docs/plan.md §1.55). A conversation's
// capture setting, the client's default, which attachment types each setting takes, and how a
// downloaded file is checked against the type it was declared as. Pure: shared by the API, the
// capture job and the screens.

import { z } from "zod";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";

/** 20 MB: a conversation's default per-file limit. */
export const CAPTURE_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 32 MB: never above the documents capability's limit (the model's request limit). */
export const CAPTURE_MAX_BYTES_CAP = 32 * 1024 * 1024;

export const CAPTURE_ATTACHMENTS = ["off", "documents", "all"] as const;
export const CaptureAttachments = z.enum(CAPTURE_ATTACHMENTS);
export type CaptureAttachments = z.infer<typeof CaptureAttachments>;

export const ConversationCapture = z.strictObject({
  /** Keep the message text (false: the envelope only). */
  archive: z.boolean(),
  attachments: CaptureAttachments,
  /** Per file. */
  maxBytes: z.number().int().min(1).max(CAPTURE_MAX_BYTES_CAP),
  /** A client agent of this client started with the new documents (`inbound.message`). */
  agentId: z
    .string()
    .refine((v) => isUuid(v), "not an id")
    .optional(),
});
export type ConversationCapture = z.infer<typeof ConversationCapture>;

/** Today's behaviour: messages kept, attachments not downloaded. */
export const CAPTURE_DEFAULT: ConversationCapture = Object.freeze({
  archive: true,
  attachments: "off",
  maxBytes: CAPTURE_DEFAULT_MAX_BYTES,
}) as ConversationCapture;

/**
 * The client's default (`tenant.settings.messaging.capture`), else `CAPTURE_DEFAULT`. A stored value
 * that doesn't parse reads as the default.
 */
export function defaultCaptureOf(settings: unknown): ConversationCapture {
  const messaging = isPlainObject(settings) ? settings.messaging : undefined;
  const stored = isPlainObject(messaging) ? messaging.capture : undefined;
  const parsed = ConversationCapture.safeParse(stored);
  return parsed.success ? parsed.data : { ...CAPTURE_DEFAULT };
}

/**
 * The capture a new conversation starts with: the client's default; for someone who wasn't a
 * contact before this message, with attachments off whatever the default says.
 */
// DECISION (plan §1.55): a stranger's files are fetched only after a person turns it on.
export function initialCapture(
  clientDefault: ConversationCapture,
  knownContact: boolean,
): ConversationCapture {
  return knownContact ? { ...clientDefault } : { ...clientDefault, attachments: "off" };
}

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────

/** PDFs and images: what `documents` takes, and what the documents capability reads. */
const DOCUMENT_TYPES = new Map<string, { ext: string; magic: readonly number[][] }>([
  ["application/pdf", { ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }],
  ["image/png", { ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] }],
  ["image/jpeg", { ext: "jpg", magic: [[0xff, 0xd8, 0xff]] }],
  [
    "image/gif",
    {
      ext: "gif",
      magic: [
        [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
        [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
      ],
    },
  ],
  // RIFF....WEBP: checked as RIFF here; the WEBP tag at offset 8 is checked below.
  ["image/webp", { ext: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }],
]);

/** What `all` adds: voice notes, videos and common office files. Stored, not read. */
// DECISION (plan §1.55): a fixed list; anything else, or an executable type, is refused.
const OTHER_TYPES = new Map<string, string>([
  ["audio/ogg", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/amr", "amr"],
  ["video/mp4", "mp4"],
  ["video/3gpp", "3gp"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/csv", "csv"],
  ["text/plain", "txt"],
]);

/** A declared type in lower case without parameters (`image/jpeg; x=1` → `image/jpeg`). */
export function normalizeContentType(raw: string | null | undefined): string {
  const base = (raw ?? "").split(";")[0] ?? "";
  const t = base.trim().toLowerCase();
  return t === "image/jpg" ? "image/jpeg" : t;
}

/** `document` (PDF or image), `other` (on the `all` list) or null (never downloaded). */
export function attachmentKind(contentType: string): "document" | "other" | null {
  const t = normalizeContentType(contentType);
  if (DOCUMENT_TYPES.has(t)) return "document";
  if (OTHER_TYPES.has(t)) return "other";
  return null;
}

/** Whether a conversation's setting takes an attachment of this declared type. */
export function captureAllows(capture: Pick<ConversationCapture, "attachments">, type: string) {
  const kind = attachmentKind(type);
  if (capture.attachments === "off" || kind === null) return false;
  return capture.attachments === "all" || kind === "document";
}

/** The file extension stored for a type (`whatsapp-<sid>-<index>.<ext>`). */
export function extensionFor(contentType: string): string {
  const t = normalizeContentType(contentType);
  return DOCUMENT_TYPES.get(t)?.ext ?? OTHER_TYPES.get(t) ?? "bin";
}

/**
 * Whether the bytes start as their declared type does. PDFs and images are checked by their magic
 * bytes; the other types on the `all` list are taken as declared (they are stored, never read).
 */
export function bytesMatchType(bytes: Uint8Array, contentType: string): boolean {
  const t = normalizeContentType(contentType);
  const known = DOCUMENT_TYPES.get(t);
  if (!known) return OTHER_TYPES.has(t);
  const starts = known.magic.some((m) => m.every((b, i) => bytes[i] === b));
  if (!starts) return false;
  if (t === "image/webp") {
    // "WEBP" at offset 8.
    return bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return true;
}

// ── What is kept of a message's attachments ──────────────────────────────────────────────────────

/**
 * One attachment as the inbound raw record keeps it: its place, declared type and the provider's
 * media id (Twilio: ME…), never a link (plan §1.55).
 */
export const StoredMedia = z.object({
  index: z.number().int().min(0).max(9),
  contentType: z.string().max(200),
  mediaSid: z.string().nullable(),
});
export type StoredMedia = z.infer<typeof StoredMedia>;

export const MEDIA_OUTCOME_STATUSES = ["filed", "refused", "failed"] as const;
export const MediaOutcomeStatus = z.enum(MEDIA_OUTCOME_STATUSES);
export type MediaOutcomeStatus = z.infer<typeof MediaOutcomeStatus>;

export const MEDIA_REFUSALS = [
  "too_large",
  "type_not_allowed",
  "type_mismatch",
  "empty",
  "capture_off",
] as const;
export const MEDIA_FAILURES = ["gone", "unauthorized", "redirect_refused", "no_media_id"] as const;

/** The outcome of fetching one attachment (raw record `MessageMedia`, `<sid>:<index>`). */
export const MediaOutcome = z.object({
  status: MediaOutcomeStatus,
  reason: z.enum([...MEDIA_REFUSALS, ...MEDIA_FAILURES]).nullable(),
  documentId: z.string().nullable(),
  contentType: z.string(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
});
export type MediaOutcome = z.infer<typeof MediaOutcome>;

/** An attachment's state as tools and screens show it. */
export const ATTACHMENT_STATUSES = [
  "not_downloaded",
  "pending",
  "filed",
  "refused",
  "failed",
] as const;
export const AttachmentStatus = z.enum(ATTACHMENT_STATUSES);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

export const AttachmentView = z.object({
  index: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int().nullable(),
  status: AttachmentStatus,
  documentId: z.string().nullable(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;

/** Most tries per attachment, the first included (download now tries a failed one again). */
export const MEDIA_MAX_TRIES = 3;
