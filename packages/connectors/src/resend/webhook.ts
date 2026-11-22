// Resend's webhooks (docs/plan.md §1.220, C7): what became of an email we sent, signed the way
// Svix signs (Resend delivers its webhooks through Svix). Three headers come with each delivery:
// `svix-id` (the message, the same on every retry), `svix-timestamp` (unix seconds) and
// `svix-signature`, a space-separated list of `v1,<base64>`, each HMAC-SHA256 of
// `<id>.<timestamp>.<raw body>` under the endpoint's signing secret, `whsec_<base64 key>`. A
// delivery is accepted within a tolerance of its timestamp, so a captured one can't be replayed
// later. What we couldn't check against the live service is in NOTES.md.

import { z } from "zod";
import { constantTimeEqual } from "../http";
import { fromBase64, hmacKey, subtle, toBase64, utf8 } from "../runtime";

export const RESEND_WEBHOOK_ID_HEADER = "svix-id";
export const RESEND_WEBHOOK_TIMESTAMP_HEADER = "svix-timestamp";
export const RESEND_WEBHOOK_SIGNATURE_HEADER = "svix-signature";
/** Svix's libraries default to five minutes. */
export const RESEND_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Resend's events are small; anything bigger is refused unread. */
export const RESEND_WEBHOOK_MAX_BYTES = 64 * 1024;

export type ResendSignatureResult =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" | "bad_secret" };

/** The secret's key: the base64 after `whsec_` (Svix), or the whole secret when it has no prefix. */
function secretKey(secret: string): Uint8Array | null {
  const raw = secret.trim();
  try {
    const key = fromBase64(raw.startsWith("whsec_") ? raw.slice("whsec_".length) : raw);
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

async function sign(key: Uint8Array, content: string): Promise<string> {
  const sig = await subtle().sign("HMAC", await hmacKey(key), utf8(content));
  return toBase64(new Uint8Array(sig));
}

/** Checks one delivery's Svix headers against the raw body (exactly as received). */
export async function verifyResendSignature(input: {
  payload: string;
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null };
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): Promise<ResendSignatureResult> {
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "malformed" };
  }
  const signatures = signature
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  if (signatures.length === 0) return { ok: false, reason: "malformed" };
  const key = secretKey(input.secret);
  if (!key) return { ok: false, reason: "bad_secret" };
  const ts = Number(timestamp);
  const tolerance = input.toleranceSeconds ?? RESEND_SIGNATURE_TOLERANCE_SECONDS;
  // DECISION: a timestamp too far in the future is refused like one too old, as Stripe's is here.
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - ts) > tolerance) {
    return { ok: false, reason: "expired" };
  }
  const expected = await sign(key, `${id}.${timestamp}.${input.payload}`);
  // Every v1 is checked (Svix sends more than one while a secret is being rolled).
  let match = false;
  for (const s of signatures) if (constantTimeEqual(s, expected)) match = true;
  return match ? { ok: true, id, timestamp: ts } : { ok: false, reason: "mismatch" };
}

/** The headers Svix would send with a payload (tests and the fake sign with it). */
export async function resendWebhookHeaders(
  secret: string,
  payload: string,
  input: { id: string; timestamp: number },
): Promise<Record<string, string>> {
  const key = secretKey(secret);
  if (!key) throw new Error("not a webhook signing secret");
  const signature = await sign(key, `${input.id}.${input.timestamp}.${payload}`);
  return {
    [RESEND_WEBHOOK_ID_HEADER]: input.id,
    [RESEND_WEBHOOK_TIMESTAMP_HEADER]: String(input.timestamp),
    [RESEND_WEBHOOK_SIGNATURE_HEADER]: `v1,${signature}`,
  };
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────

/** A tag's name or value as Resend takes it: ASCII letters, digits, `_` and `-`, at most 256. */
export const ResendTagText = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

/**
 * One webhook event. Only what we read is named; the rest passes. `data.tags` is read both as an
 * object (`{name: value}`) and as Resend's send shape (`[{name, value}]`): NOTES.md.
 */
export const ResendWebhookEvent = z.object({
  type: z.string().max(100),
  created_at: z.string().max(100).optional(),
  data: z
    .object({
      email_id: z.string().max(200).optional(),
      tags: z
        .union([
          z.record(z.string(), z.unknown()),
          z.array(z.object({ name: z.string(), value: z.unknown() })),
        ])
        .optional(),
      bounce: z
        .object({
          type: z.string().max(100).optional(),
          subType: z.string().max(100).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});
export type ResendWebhookEvent = z.infer<typeof ResendWebhookEvent>;

/** The events we act on: an email reached the mailbox, or came back. Others are acknowledged. */
export const RESEND_HANDLED_EVENTS = ["email.delivered", "email.bounced"] as const;
export type ResendHandledEvent = (typeof RESEND_HANDLED_EVENTS)[number];

export function isHandledResendEvent(type: string): type is ResendHandledEvent {
  return (RESEND_HANDLED_EVENTS as readonly string[]).includes(type);
}

/** An event's tags as `name → value`, only the well-formed ones. */
export function resendEventTags(event: ResendWebhookEvent): Record<string, string> {
  const raw = event.data.tags;
  const pairs: [string, unknown][] = Array.isArray(raw)
    ? raw.map((t) => [t.name, t.value])
    : Object.entries(raw ?? {});
  const out: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (typeof value !== "string") continue;
    if (ResendTagText.safeParse(name).success && ResendTagText.safeParse(value).success) {
      out[name] = value;
    }
  }
  return out;
}

/** Tags in the shape a send takes (`tags` in `POST /emails`). */
export function resendSendTags(tags: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(tags)
    .filter(([n, v]) => ResendTagText.safeParse(n).success && ResendTagText.safeParse(v).success)
    .map(([name, value]) => ({ name, value }));
}
