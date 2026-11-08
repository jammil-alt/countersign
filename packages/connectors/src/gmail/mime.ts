// The message Gmail sends (`users.messages.send` takes the whole RFC 5322 message, base64url): plain
// text in UTF-8, headers in ASCII. Non-ASCII in the subject or a display name goes as RFC 2047
// encoded words; the body goes as base64. Nothing a caller passes can add a header: every value is
// checked or encoded, and line breaks never reach a header.

import { toBase64, utf8 } from "../runtime";

export interface PlainMessage {
  from: { address: string; name?: string | null };
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  /** Without the angle brackets is fine; they are added. */
  messageId: string;
  date: Date;
  // P-3: attachments both ways (docs/plan.md §1.65)
  /** Files after the text (multipart/mixed); none: a plain text message as before. */
  attachments?: readonly MimeAttachment[];
}

/** A file in the message: its name and type from the document record, its bytes from storage. */
export interface MimeAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** An address as these headers take it: no spaces, angle brackets, quotes or line breaks. */
const ADDRESS = /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]{2,}$/;
/** Characters a Message-ID's parts may hold (RFC 5322 dot-atom text). */
const ID_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeError";
  }
}

function address(value: string, what: string): string {
  const v = value.trim();
  if (!ADDRESS.test(v)) throw new MimeError(`${what} is not an email address`);
  return v;
}

/** Printable ASCII only: what can go in a header as it is. */
function isPlainAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * RFC 2047 encoded words (`=?UTF-8?B?…?=`), each at most 75 characters, never splitting a
 * character's bytes across two words. Joined by folding whitespace (CRLF and a space).
 */
export function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  // 45 bytes encode to 60 base64 characters; with `=?UTF-8?B?` and `?=` that is 72.
  const MAX_BYTES = 45;
  for (const ch of text) {
    const bytes = utf8(ch);
    if (chunk.length + bytes.length > MAX_BYTES) {
      words.push(`=?UTF-8?B?${toBase64(Uint8Array.from(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length > 0) words.push(`=?UTF-8?B?${toBase64(Uint8Array.from(chunk))}?=`);
  return words.join("\r\n ");
}

/** Line breaks and other control characters become spaces: a header value is one line. */
function oneLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A header's free text: as written when it is short plain ASCII, else encoded words. */
export function headerText(value: string): string {
  const v = oneLine(value);
  return isPlainAscii(v) && v.length <= 900 ? v : encodedWords(v);
}

/** `Name <address>`, the name quoted when plain, encoded when not; the bare address without one. */
export function mailbox(addr: string, name?: string | null): string {
  const a = address(addr, "the address");
  const n = name ? oneLine(name) : "";
  if (!n) return a;
  if (isPlainAscii(n)) return `"${n.replace(/["\\]/g, "")}" <${a}>`;
  return `${encodedWords(n)} <${a}>`;
}

/** `<left@right>`: the id's parts are checked, so it can't carry anything else. */
export function messageIdHeader(id: string): string {
  const bare = id.replace(/^<|>$/g, "");
  const at = bare.lastIndexOf("@");
  const left = bare.slice(0, at);
  const right = bare.slice(at + 1);
  if (at <= 0 || !ID_PART.test(left) || !ID_PART.test(right)) {
    throw new MimeError("the Message-ID is not valid");
  }
  return `<${left}@${right}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date in UTC: `Thu, 05 Nov 2026 14:03:09 +0000`. */
export function rfc5322Date(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Bytes as base64 in lines of 76 characters (RFC 2045). */
function base64Lines(bytes: Uint8Array): string {
  const b64 = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/** The body as base64 in lines of 76 characters, its line breaks made CRLF first. */
function base64Body(text: string): string {
  return base64Lines(utf8(text.replace(/\r\n|\r|\n/g, "\r\n")));
}

// P-3: attachments both ways (docs/plan.md §1.65) ─────────────────────────────────────────────────

/** A MIME type as a header takes it: `type/subtype`, letters, digits and `.+-` only. */
function mimeTypeHeader(value: string): string {
  const v = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(v)) {
    throw new MimeError("the attachment's type is not valid");
  }
  return v;
}

/** Characters RFC 2231 leaves as they are in an extended parameter value. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;

/**
 * A file name as `Content-Disposition` and `Content-Type` carry it: quoted when it is plain ASCII,
 * otherwise RFC 2231 (`filename*=UTF-8''…`, percent-encoded) beside an RFC 2047 `name`, as mail
 * apps read one or the other. Line breaks, quotes and backslashes never reach the header.
 */
export function fileNameParams(filename: string): { disposition: string; type: string } {
  const name = oneLine(filename).replace(/["\\]/g, "").slice(0, 200) || "attachment";
  if (isPlainAscii(name)) return { disposition: `filename="${name}"`, type: `name="${name}"` };
  let pct = "";
  for (const b of utf8(name)) {
    const ch = String.fromCharCode(b);
    pct +=
      b < 0x80 && ATTR_CHAR.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return { disposition: `filename*=UTF-8''${pct}`, type: `name="${encodedWords(name)}"` };
}

/**
 * The boundary between parts. `=_` can't occur in base64 and every part here is base64, so the
 * boundary can't appear inside one. Derived from the Message-ID: the same send builds the same
 * message.
 */
function boundaryFor(messageId: string): string {
  const id = messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  return `=_mz_${id || "part"}`;
}

/** The whole message, CRLF line endings, as Gmail's `raw` wants before encoding. */
export function buildPlainMessage(m: PlainMessage): string {
  const headers = [
    `From: ${mailbox(m.from.address, m.from.name)}`,
    `To: ${mailbox(m.to)}`,
    ...(m.replyTo ? [`Reply-To: ${mailbox(m.replyTo)}`] : []),
    `Subject: ${headerText(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: ${messageIdHeader(m.messageId)}`,
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (!m.attachments?.length) {
    return `${[...headers, ...textPart].join("\r\n")}\r\n\r\n${base64Body(m.text)}\r\n`;
  }
  // P-3: multipart/mixed: the text first, then each file as an attachment, all in base64.
  const boundary = boundaryFor(m.messageId);
  const parts = [`${textPart.join("\r\n")}\r\n\r\n${base64Body(m.text)}`];
  for (const a of m.attachments) {
    const names = fileNameParams(a.filename);
    parts.push(
      [
        `Content-Type: ${mimeTypeHeader(a.mimeType)}; ${names.type}`,
        `Content-Disposition: attachment; ${names.disposition}`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(a.bytes),
      ].join("\r\n"),
    );
  }
  const head = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`];
  const body = parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("");
  return `${head.join("\r\n")}\r\n\r\n${body}--${boundary}--\r\n`;
}

/**
 * Gmail's `raw`: the message's bytes, URL-safe base64. Padding is kept, as in Google's own
 * examples (Python's `urlsafe_b64encode`); NOTES.md lists it to verify.
 */
export function gmailRaw(message: string): string {
  return toBase64(utf8(message)).replace(/\+/g, "-").replace(/\//g, "_");
}
