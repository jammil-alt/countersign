// v0.14 W4-A: what Meta's WhatsApp webhook carries (docs/plan.md §1.57), as plain records. Lenient
// about fields we don't use (Meta adds them without warning), strict about the ones we act on: the
// receiving number's id (which client), the message id (`wamid`, once), the sender's WhatsApp id,
// the text, and each attachment's media id and declared type (never a link: the media is fetched
// later from Graph by id). Status callbacks become status records. Caps bound the work per delivery.
//
// Groups: Meta's groups API is unverified here (NOTES.md). A message with a `group_id` is read
// defensively (a safe id or nothing); the caller keeps it only where the client turned groups on.

import { normalizeContentType, type StoredMedia } from "@countersign/core";
import { z } from "zod";
import { e164OfWaId, isGraphId, isWamid } from "./graph";

/** Most messages, statuses and entries read from one delivery; the rest are left (Meta batches). */
const MAX_ITEMS = 100;
const MAX_TEXT = 4096;

const Media = z.looseObject({ id: z.unknown().optional(), mime_type: z.unknown().optional() });

const Message = z.looseObject({
  id: z.unknown().optional(),
  from: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  type: z.unknown().optional(),
  text: z.looseObject({ body: z.unknown().optional() }).optional(),
  image: Media.extend({ caption: z.unknown().optional() }).optional(),
  document: Media.extend({ caption: z.unknown().optional() }).optional(),
  video: Media.extend({ caption: z.unknown().optional() }).optional(),
  audio: Media.optional(),
  button: z.looseObject({ text: z.unknown().optional() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.unknown().optional() }).optional(),
      list_reply: z.looseObject({ title: z.unknown().optional() }).optional(),
    })
    .optional(),
  // UNVERIFIED (NOTES.md): where Meta's groups API names the group on a message.
  group_id: z.unknown().optional(),
});

const Status = z.looseObject({
  id: z.unknown().optional(),
  status: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  recipient_id: z.unknown().optional(),
  biz_opaque_callback_data: z.unknown().optional(),
  errors: z.array(z.looseObject({ code: z.unknown().optional() })).optional(),
});

const Value = z.looseObject({
  messaging_product: z.unknown().optional(),
  metadata: z.looseObject({
    phone_number_id: z.unknown().optional(),
    display_phone_number: z.unknown().optional(),
  }),
  contacts: z
    .array(
      z.looseObject({
        wa_id: z.unknown().optional(),
        profile: z.looseObject({ name: z.unknown().optional() }),
      }),
    )
    .optional(),
  messages: z.array(Message).optional(),
  statuses: z.array(Status).optional(),
});

const Payload = z.looseObject({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.looseObject({
      id: z.unknown().optional(),
      changes: z
        .array(z.looseObject({ field: z.unknown().optional(), value: z.unknown().optional() }))
        .default([]),
    }),
  ),
});

/** One inbound message as the platform keeps it. Its text is the sender's: data, never instructions. */
export interface MetaInbound {
  /** The client's number it came to: which client (and connection) it belongs to. */
  phoneNumberId: string;
  wamid: string;
  /** The sender, E.164. */
  from: string;
  profileName: string | null;
  sentAt: Date | null;
  type: string;
  text: string;
  /** At most one attachment (index 0): declared type and Meta's media id, never a link. */
  media: StoredMedia[];
  /** The group it was sent in, when Meta names one (unverified shape), else null. */
  groupId: string | null;
}

export interface MetaStatus {
  phoneNumberId: string;
  wamid: string;
  status: string;
  /** The recipient, E.164, when Meta names one. */
  to: string | null;
  errorCode: string | null;
  /** Our own data sent with the message (`biz_opaque_callback_data`): the send's key. */
  opaque: string | null;
  at: Date | null;
}

export interface MetaWebhook {
  messages: MetaInbound[];
  statuses: MetaStatus[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;

function dateOf(ts: unknown): Date | null {
  if (typeof ts !== "string" || ts.length === 0 || ts.length > 12) return null;
  const n = Number(ts);
  return Number.isInteger(n) && n > 0 ? new Date(n * 1000) : null;
}

/** A status word as Meta sends it (`sent`, `delivered`, `read`, `failed`), checked without a regex. */
function statusWord(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 2 || v.length > 20) return null;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (!((c >= 0x61 && c <= 0x7a) || c === 0x5f)) return null;
  }
  return v;
}

/** A group's id as far as we can tell: letters, digits, `.`, `_`, `-`, `@`, at most 200. */
function groupIdOf(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 1 || v.length > 200) return null;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2e ||
      c === 0x5f ||
      c === 0x2d ||
      c === 0x40;
    if (!ok) return null;
  }
  return v;
}

// DECISION: stickers are not attachments (an image/webp sticker would be filed as a document);
// reactions, locations, contacts and system messages keep no text and no media.
function textAndMedia(m: z.infer<typeof Message>): { text: string; media: StoredMedia[] } {
  const type = typeof m.type === "string" ? m.type : "";
  if (type === "text") return { text: str(m.text?.body, MAX_TEXT) ?? "", media: [] };
  if (type === "button") return { text: str(m.button?.text, MAX_TEXT) ?? "", media: [] };
  if (type === "interactive") {
    const t = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    return { text: str(t, MAX_TEXT) ?? "", media: [] };
  }
  const media =
    type === "image"
      ? m.image
      : type === "document"
        ? m.document
        : type === "video"
          ? m.video
          : type === "audio"
            ? m.audio
            : undefined;
  if (!media) return { text: "", media: [] };
  const caption = "caption" in media ? str(media.caption, MAX_TEXT) : null;
  const id = isGraphId(media.id) ? media.id : null;
  const contentType = normalizeContentType(str(media.mime_type, 200)).slice(0, 200);
  return { text: caption ?? "", media: [{ index: 0, contentType, mediaSid: id }] };
}

/**
 * The messages and statuses of one delivery (only `field: "messages"` changes), or null when the
 * body isn't a WhatsApp Business Account notification. Entries that don't read are skipped.
 */
export function parseMetaWebhook(json: unknown): MetaWebhook | null {
  const parsed = Payload.safeParse(json);
  if (!parsed.success) return null;
  const out: MetaWebhook = { messages: [], statuses: [] };
  for (const entry of parsed.data.entry.slice(0, MAX_ITEMS)) {
    for (const change of entry.changes.slice(0, MAX_ITEMS)) {
      if (change.field !== "messages") continue;
      const v = Value.safeParse(change.value);
      if (!v.success) continue;
      const phoneNumberId = v.data.metadata.phone_number_id;
      if (!isGraphId(phoneNumberId)) continue;
      const names = new Map<string, string>();
      for (const c of v.data.contacts ?? []) {
        const name = str(c.profile.name, 120);
        if (typeof c.wa_id === "string" && name) names.set(c.wa_id, name);
      }
      for (const m of (v.data.messages ?? []).slice(0, MAX_ITEMS)) {
        const from = e164OfWaId(m.from);
        if (!isWamid(m.id) || !from || typeof m.type !== "string") continue;
        const { text, media } = textAndMedia(m);
        out.messages.push({
          phoneNumberId,
          wamid: m.id,
          from,
          profileName: names.get(from.slice(1))?.trim() || null,
          sentAt: dateOf(m.timestamp),
          type: m.type.slice(0, 40),
          text,
          media,
          groupId: groupIdOf(m.group_id),
        });
      }
      for (const s of (v.data.statuses ?? []).slice(0, MAX_ITEMS)) {
        const status = statusWord(s.status);
        if (!isWamid(s.id) || !status) continue;
        const code = s.errors?.[0]?.code;
        out.statuses.push({
          phoneNumberId,
          wamid: s.id,
          status,
          to: e164OfWaId(s.recipient_id),
          errorCode:
            typeof code === "number" && Number.isInteger(code) && code >= 0 && code < 1e7
              ? String(code)
              : null,
          opaque: str(s.biz_opaque_callback_data, 512),
          at: dateOf(s.timestamp),
        });
      }
    }
  }
  return out;
}
