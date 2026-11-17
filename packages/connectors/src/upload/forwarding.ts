// Email forwarding (ARCHITECTURE §6.5, docs/plan.md §1.2): each client has a private address on
// EMAIL_FORWARDING_DOMAIN; Cloudflare Email Routing hands mail for it to the Worker's `email()`
// handler, which keeps PDF and image attachments from allowed senders as documents. Headers are
// kept; bodies never are (invariant 12).

import {
  type EmailAuthentication,
  type EmailAutomation,
  emailAutomation,
  readAuthentication,
} from "@countersign/core";
import PostalMime from "postal-mime";
import { randomBytes, utf8 } from "../runtime";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function uuidBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a client id: ${id}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesUuid(bytes: Uint8Array): string {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A short, readable lead for the address from the client's name. */
export function addressLabel(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/g, "");
  return slug || "client";
}

/** 8 random base32 characters (40 bits): the part of the address nobody can guess. */
export function newForwardingSecret(): string {
  return base32(randomBytes(5));
}

/**
 * `<label>-<client id, base32>-<secret>@<domain>`. The client id lets the Worker open the right
 * client's transaction (RLS) without a cross-client lookup; the secret, checked against the
 * stored address, is what makes it private.
 */
// DECISION: the address carries the client id (26 base32 characters) so the email handler needs
// no global lookup table outside RLS; the 40-bit secret is what keeps it unguessable, and the
// handler accepts only the exact address stored on the client's upload connection.
export function forwardingAddress(input: {
  tenantId: string;
  clientName: string;
  secret: string;
  domain: string;
}): string {
  if (!/^[a-z2-7]{8}$/.test(input.secret)) throw new Error("not a forwarding secret");
  const domain = input.domain.trim().toLowerCase();
  return `${addressLabel(input.clientName)}-${base32(uuidBytes(input.tenantId))}-${input.secret}@${domain}`;
}

/** The client an address names, or null when it is not one of ours on `domain`. */
export function parseForwardingAddress(
  address: string,
  domain: string,
): { tenantId: string; secret: string } | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0 || a.slice(at + 1) !== domain.trim().toLowerCase()) return null;
  const local = a.slice(0, at).split("+")[0] ?? "";
  const m = /-([a-z2-7]{26})-([a-z2-7]{8})$/.exec(local);
  if (!m) return null;
  const bytes = unbase32(m[1] as string);
  if (bytes?.length !== 16) return null;
  return { tenantId: bytesUuid(bytes), secret: m[2] as string };
}

// ── Reply addresses (docs/plan.md §1.25) ───────────────────────────────────────────────────────

// DECISION: replies to an agent's email come back to `r-<client id, base32>+<tag>@<domain>`, not to
// the forwarding address, so a vendor never learns the address that keeps the client's invoice
// inbox private (audit, 2026-11-17). The client id opens the client's transaction (as for the
// forwarding address); the tag names the reach-out by its id and carries 8 random characters kept
// on the reach-out's plan (`replyTag`), so it can't be made from the id alone. The `r-` form only
// ever reaches the reply path: it never parses as a forwarding, voice or agent address.
// `r-` + 26 + `+` + 34 is 63 characters, inside SMTP's 64 for a local part.

/** A reply tag for a reach-out: its id in base32 (26) and 8 random base32 characters (34 in all). */
export function newReplyTag(reachOutId: string): string {
  return `${base32(uuidBytes(reachOutId))}${newForwardingSecret()}`;
}

/**
 * The reach-out a reply tag names, or null: a tag from `newReplyTag`, or an earlier one (the id in
 * hex, 32 characters, still on reach-outs sent before reply addresses).
 */
export function replyTagReachOutId(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(t)) return bytesUuid(uuidBytes(t));
  if (!/^[a-z2-7]{34}$/.test(t)) return null;
  const bytes = unbase32(t.slice(0, 26));
  return bytes?.length === 16 ? bytesUuid(bytes) : null;
}

/** `r-<client id, base32>@<domain>`: the base of a client's reply addresses. */
export function replyBaseAddress(input: { tenantId: string; domain: string }): string {
  return `r-${base32(uuidBytes(input.tenantId))}@${input.domain.trim().toLowerCase()}`;
}

/** The reply base for a client's forwarding address (same client and domain), or null. */
export function replyBaseFor(forwarding: string | null | undefined): string | null {
  if (!forwarding) return null;
  const at = forwarding.lastIndexOf("@");
  const domain = forwarding.slice(at + 1);
  const target = at > 0 ? parseForwardingAddress(forwarding, domain) : null;
  return target ? replyBaseAddress({ tenantId: target.tenantId, domain }) : null;
}

/**
 * The Reply-To of an agent's email: the client's reply base with the reach-out's tag, built from
 * the client's forwarding address (null: replies aren't read). An email with no tag answers no
 * reach-out and gets no Reply-To, so replies go to the address it was sent from.
 */
// DECISION: a stored address that isn't a forwarding address (no secret to keep) is tagged as
// before; an untagged email carries no Reply-To rather than the forwarding address.
export function reachReplyTo(
  forwarding: string | null | undefined,
  tag: string | undefined,
): string | null {
  if (!forwarding || !tag) return null;
  const base = replyBaseFor(forwarding) ?? forwarding;
  const at = base.lastIndexOf("@");
  return `${base.slice(0, at)}+${tag}${base.slice(at)}`;
}

/**
 * The client and tag a reply address names (`r-<client id>+<tag>@<domain>`), or null when it is
 * not a reply address on `domain`. `tag` is null when there is none or it isn't a reply tag.
 */
export function parseReplyAddress(
  address: string,
  domain: string,
): { tenantId: string; tag: string | null } | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0 || a.slice(at + 1) !== domain.trim().toLowerCase()) return null;
  const local = a.slice(0, at);
  const m = /^r-([a-z2-7]{26})(?:\+(.*))?$/.exec(local);
  if (!m) return null;
  const bytes = unbase32(m[1] as string);
  if (bytes?.length !== 16) return null;
  const tag = m[2] ?? null;
  return {
    tenantId: bytesUuid(bytes),
    tag: tag !== null && replyTagReachOutId(tag) ? tag : null,
  };
}

/** Constant-time string equality, for the stored address. */
export function sameAddress(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const ADDRESS_RE = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** An allowed-senders entry, cleaned: `ap@shop.com` or `shop.com` (`@shop.com` reads as the domain). */
export function normalizeSender(entry: string): string | null {
  const v = entry.trim().toLowerCase().replace(/^@/, "");
  if (ADDRESS_RE.test(v) || DOMAIN_RE.test(v)) return v;
  return null;
}

/**
 * Whether any of the message's senders is on the list. An entry with `@` matches that address; a
 * bare domain matches that domain and its subdomains.
 */
// DECISION: a message is accepted when its envelope sender (MAIL FROM) matches the client's list
// and SPF passed for that envelope's domain, or its From header matches and that From domain passed
// DMARC (`authenticatedSenders` in @countersign/core): a client's own forwarding rule keeps their
// domain on the envelope, a vendor's mail forwarded by hand keeps the vendor on From. An
// unauthenticated sender is never enough on its own: anyone who learns the address could otherwise
// send as an allowed vendor (security review, 2026-11-04; audit, 2026-11-17).
export function senderAllowed(allowed: readonly string[], senders: readonly string[]): boolean {
  return matchingSender(allowed, senders) !== null;
}

/** The first of the message's senders that is on the list (lower case), or null. */
export function matchingSender(
  allowed: readonly string[],
  senders: readonly string[],
): string | null {
  const list = allowed.map(normalizeSender).filter((v): v is string => v !== null);
  for (const raw of senders) {
    const s = raw.trim().toLowerCase();
    const at = s.lastIndexOf("@");
    if (at < 0) continue;
    const domain = s.slice(at + 1);
    for (const entry of list) {
      if (entry.includes("@") ? entry === s : domain === entry || domain.endsWith(`.${entry}`)) {
        return s;
      }
    }
  }
  return null;
}

/**
 * The From domain that passed DMARC, read from the receiving server's own (topmost, Cloudflare's)
 * authentication header by `readAuthentication` (@countersign/core). Headers further down were
 * written by whoever sent the message and are never read. Null when DMARC did not pass.
 */
export function dmarcPassDomain(headers: readonly { key: string; value: string }[]): string | null {
  return readAuthentication(headers).dmarcFrom;
}

/** Whether a From header address may count as a sender: its domain is the one that passed DMARC. */
export function trustedFromHeader(from: string | null, dmarcDomain: string | null): boolean {
  if (!from || !dmarcDomain) return false;
  const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  return domain === dmarcDomain;
}

/** Cloudflare Email Routing's limit for a message handed to a Worker. */
export const MAX_FORWARDED_BYTES = 25 * 1024 * 1024;

export interface ForwardedHeaders {
  from: string | null;
  to: string[];
  subject: string | null;
  date: string | null;
  messageId: string | null;
  /** The From domain that passed DMARC per the receiving server, or null (`dmarcPassDomain`). */
  dmarcPassFrom: string | null;
  /** The receiving server's verdicts (`readAuthentication`). */
  auth: EmailAuthentication;
  /** Not a person's mail: an auto-reply or bounce, or mail a system wrote (`emailAutomation`). */
  automatic: EmailAutomation | null;
}

export interface ForwardedAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ForwardedEmail {
  headers: ForwardedHeaders;
  attachments: ForwardedAttachment[];
  /** Attachments left out (not a PDF or an image, or an inline image such as a signature logo). */
  skipped: { filename: string; mimeType: string; reason: string }[];
}

const KEPT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The type to store a file as: its declared type, or its extension's when declared generically. */
export function documentMimeType(declared: string, filename: string): string {
  const d = declared.toLowerCase().split(";")[0]?.trim() ?? "";
  if (KEPT_TYPES.has(d)) return d === "image/jpg" ? "image/jpeg" : d;
  const ext = filename.toLowerCase().split(".").at(-1) ?? "";
  return EXTENSION_TYPES[ext] ?? d;
}

export function isDocumentType(mime: string): boolean {
  return KEPT_TYPES.has(mime);
}

function addressOf(a: { address?: string | undefined } | undefined): string | null {
  return a?.address ? a.address.toLowerCase() : null;
}

/** A reply to an email an agent sent (docs/plan.md §1.25): headers and the new text only. */
export interface ReplyEmail {
  from: string | null;
  dmarcPassFrom: string | null;
  /** The receiving server's verdicts (`readAuthentication`). */
  auth: EmailAuthentication;
  /** Not a person's mail: an auto-reply or bounce, or mail a system wrote (`emailAutomation`). */
  automatic: EmailAutomation | null;
  to: string[];
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** The reply's own words (quoted history cut), at most REPLY_TEXT_MAX: untrusted data. */
  text: string;
}

export const REPLY_TEXT_MAX = 4000;

/**
 * The line mail apps put above quoted history, in the portal's six languages (people answer in
 * theirs, plan §1.25): "On … wrote:", "El … escribió:", "Le … a écrit :", "Em … escreveu:",
 * "Il … ha scritto:", "Am … schrieb …:".
 */
const ATTRIBUTION = [
  /^(on|el|le|em|il) .+ (wrote|escribió|a écrit|escreveu|ha scritto)\s*:\s*$/i,
  /^am .+ schrieb .+:\s*$/i,
];

/** The new part of a plain-text reply: up to the quoted history ("On … wrote:", "> " lines). */
export function replyText(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (/^>/.test(line.trim())) break;
    if (ATTRIBUTION.some((r) => r.test(line.trim()))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, REPLY_TEXT_MAX);
}

/**
 * Parses a reply to a reach-out email: the headers that match it to what it answers, and its text,
 * which is kept as untrusted data (never instructions, invariants 9 and 12). Attachments and HTML
 * are dropped here.
 */
export async function parseReplyEmail(
  raw: Uint8Array,
  options: { envelopeFrom?: string | null } = {},
): Promise<ReplyEmail> {
  const email = await PostalMime.parse(raw);
  const auth = readAuthentication(email.headers);
  const header = (k: string) => email.headers.find((h) => h.key === k)?.value ?? null;
  const to = (email.to ?? []).flatMap((a) =>
    a.address ? [a.address.toLowerCase()] : (a.group ?? []).map((m) => m.address.toLowerCase()),
  );
  const refs = (header("references") ?? "").split(/\s+/).filter((r) => r.startsWith("<"));
  return {
    from: email.from && "address" in email.from ? addressOf(email.from) : null,
    dmarcPassFrom: auth.dmarcFrom,
    auth,
    automatic: emailAutomation(email.headers, options.envelopeFrom ?? null),
    to,
    subject: email.subject ?? null,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? header("in-reply-to"),
    references: refs,
    text: replyText(email.text ?? ""),
  };
}

/**
 * Parses a raw message and keeps only what may be stored: a few headers and the PDF and image
 * attachments. The text and HTML bodies are dropped here, before anything is written.
 */
export async function parseForwardedEmail(
  raw: Uint8Array,
  options: { envelopeFrom?: string | null } = {},
): Promise<ForwardedEmail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const auth = readAuthentication(email.headers);
  const attachments: ForwardedAttachment[] = [];
  const skipped: ForwardedEmail["skipped"] = [];
  email.attachments.forEach((a, i) => {
    const filename = a.filename?.trim() || `attachment-${i + 1}`;
    const mimeType = documentMimeType(a.mimeType, filename);
    // DECISION: inline images (cid: references, e.g. a signature logo) are not documents; an
    // image is kept only as a real attachment. PDFs are kept however they are attached.
    if (!isDocumentType(mimeType)) {
      skipped.push({ filename, mimeType, reason: "not a PDF or an image" });
      return;
    }
    if (mimeType !== "application/pdf" && a.disposition !== "attachment" && a.contentId) {
      skipped.push({ filename, mimeType, reason: "an inline image" });
      return;
    }
    const content = a.content;
    const bytes =
      typeof content === "string"
        ? utf8(content)
        : content instanceof Uint8Array
          ? content
          : new Uint8Array(content);
    attachments.push({ filename, mimeType, bytes });
  });
  const to = (email.to ?? []).flatMap((a) =>
    a.address ? [a.address.toLowerCase()] : (a.group ?? []).map((m) => m.address.toLowerCase()),
  );
  return {
    headers: {
      from: email.from && "address" in email.from ? addressOf(email.from) : null,
      to,
      subject: email.subject ?? null,
      date: email.date ?? null,
      messageId: email.messageId ?? null,
      dmarcPassFrom: auth.dmarcFrom,
      auth,
      automatic: emailAutomation(email.headers, options.envelopeFrom ?? null),
    },
    attachments,
    skipped,
  };
}
