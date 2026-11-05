// Matching an inbound message to an open wait, reading the code out of it, and naming what an
// unmatched message looks like. Code only, never a model: the wait's own pattern decides what the
// code is (ARCHITECTURE §6.9). Message text is data; links in it are never followed, and are
// removed before the pattern runs so a sign-in link's token can never come out as a "code".

import { CODES_CODE_MAX, type CodeAlertKind } from "@countersign/core";

/** Text longer than this is cut before matching, so a pattern's work stays bounded. */
export const MATCH_TEXT_MAX = 20_000;

/** A phone number or short code as Twilio reports it, without spaces or punctuation. */
export function normalizePhone(value: string): string {
  return value.trim().replace(/[\s().-]/g, "");
}

/**
 * Whether a message's sender is the wait's: for texts, the same number or short code; for email, the
 * same address, or (when the wait names `@domain`) that domain or one of its subdomains. The email
 * sender is the From address, counted only when DMARC passed for its domain (email.ts).
 */
export function senderMatches(
  channel: "sms" | "email",
  expected: string,
  actual: string | null,
): boolean {
  if (!actual) return false;
  if (channel === "sms") return normalizePhone(expected) === normalizePhone(actual);
  const want = expected.trim().toLowerCase();
  const got = actual.trim().toLowerCase();
  if (want.startsWith("@")) {
    const domain = want.slice(1);
    const at = got.lastIndexOf("@");
    if (at < 0 || !domain) return false;
    const gotDomain = got.slice(at + 1);
    return gotDomain === domain || gotDomain.endsWith(`.${domain}`);
  }
  return want === got;
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** The text a pattern runs over: links removed, length bounded. */
export function matchableText(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join("\n")
    .slice(0, MATCH_TEXT_MAX)
    .replace(URL_RE, " ");
}

/**
 * The code in `text` by the wait's pattern: its first capture group, or the whole match when it has
 * none. Null when nothing matches or the result is empty or too long to be a code.
 */
export function extractCode(pattern: string, text: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const m = re.exec(text);
  if (!m) return null;
  const code = (m[1] ?? m[0]).trim();
  if (!code || code.length > CODES_CODE_MAX) return null;
  return code;
}

const RESET_RE =
  /\b(?:reset|forgot|recover|change)\w*\s+(?:your\s+)?password\b|\bpassword\s+(?:reset|recovery|change)\b|\baccount\s+recovery\b|\breset\s+link\b/i;
const CODE_RE =
  /\b(?:code|passcode|verification|verify|one[-\s]?time|otp|2fa|two[-\s]?(?:factor|step)|security\s+key|sign[-\s]?in|log[-\s]?in)\b|\b\d{4,8}\b/i;

/** What a message no wait was open for looks like (for the alert raised about it). */
export function classifyUnmatched(text: string): CodeAlertKind {
  if (RESET_RE.test(text)) return "reset_attempt";
  if (CODE_RE.test(text)) return "unsolicited_code";
  return "unexpected_message";
}
