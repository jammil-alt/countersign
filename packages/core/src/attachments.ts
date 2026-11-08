// P-3: attachments both ways (docs/plan.md §1.65). What an outbound email or message may carry: up
// to five of the client's own stored documents, PDFs and images only, named by id in the step's
// input (never invented by a model). The connector reads each one for the client of the call, from
// object storage, for that one send; its name and type come from the document record. Each
// provider's size limit is the connector's own (its NOTES.md). Pure: shared by the API, the
// connectors and the screens.

import { z } from "zod";
import type { ReachChannel } from "./reach/rules";

/** At most this many attachments on one email or message. */
export const OUTBOUND_ATTACHMENTS_MAX = 5;

/** The types an outbound attachment may be: what the documents capability keeps and reads. */
export const SENDABLE_TYPES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export function isSendableType(mimeType: string): boolean {
  return SENDABLE_TYPES.includes(mimeType.trim().toLowerCase());
}

/** One attachment as a send tool takes it: a stored document of this client, by id. */
export const OutboundAttachment = z.strictObject({ documentId: z.uuid() });
export type OutboundAttachment = z.infer<typeof OutboundAttachment>;

export const OutboundAttachments = z
  .array(OutboundAttachment)
  .max(OUTBOUND_ATTACHMENTS_MAX)
  .refine((list) => new Set(list.map((a) => a.documentId)).size === list.length, {
    message: "each document at most once",
  });

/** An attachment as the approval card, the before state and the send's record show it. */
export const AttachmentSummary = z.object({
  documentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;

/**
 * How many attachments one message on a channel can carry: an email up to five, a text (MMS) up
 * to five, a WhatsApp message one (it goes as the file, with the text as its caption), a call none.
 */
// DECISION (plan §1.65): a channel that can't carry a reach-out's attachments is left out of its
// plan with the reason ("can't carry the attachments"), never sent without them, so nobody gets a
// message that names a file they didn't receive.
export const CHANNEL_ATTACHMENTS_MAX: Readonly<Record<ReachChannel, number>> = {
  email: OUTBOUND_ATTACHMENTS_MAX,
  sms: OUTBOUND_ATTACHMENTS_MAX,
  whatsapp: 1,
  voice: 0,
};

/** "invoice.pdf (120 KB), photo.jpg (1.2 MB)": for cards and thread lines. */
export function describeAttachments(
  list: readonly Pick<AttachmentSummary, "filename" | "sizeBytes">[],
) {
  return list.map((a) => `${a.filename} (${formatBytes(a.sizeBytes)})`).join(", ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Replies ──────────────────────────────────────────────────────────────────────────────────────

/** An attachment of a reply that wasn't kept, and why: counted on the reply, never dropped silently. */
export const ReplyAttachmentRefusal = z.object({
  contentType: z.string().max(200),
  reason: z.string().max(40),
});
export type ReplyAttachmentRefusal = z.infer<typeof ReplyAttachmentRefusal>;

/** At most this many documents are kept from one reply (an email may carry more). */
export const REPLY_DOCUMENTS_MAX = 10;
