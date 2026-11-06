// One-time codes that bind a Google Chat space to a client (docs/plan.md §1.60). The client admin
// asks for one in the portal and mentions the app with it in the space; the code is the only proof
// a space is the client's (never an email domain). Each code: 12 symbols of Crockford's base32
// from the platform's CSPRNG (60 bits), shown once, kept only as a SHA-256 over the client and
// connection it was made for (so it can never match another client's), inside the connection's
// encrypted credentials, for 15 minutes, used once. Matching is in constant time.

import { constantTimeEqual } from "../http";
import { randomBytes, sha256Bytes, toHex, utf8 } from "../runtime";

/** Crockford's base32: no I, L, O or U. 32 symbols, so a byte & 31 is uniform. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "MZ";
const SYMBOLS = 12;

// DECISION: 15 minutes, long enough to add the app to a space and mention it; one pending code per
// connection (a new one replaces it); at most 5 made per connection per hour.
export const BINDING_CODE_TTL_MS = 15 * 60 * 1000;
export const BINDING_CODES_PER_HOUR = 5;

/** `MZ-7K2Q-9XHD-4RTM`: what the client admin types after the app's name. */
export function generateBindingCode(): string {
  const bytes = randomBytes(SYMBOLS);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/**
 * A token as a canonical code (`MZ` and 12 symbols, no dashes), forgiving case, dashes and the
 * letters people mistype for digits (O → 0, I and L → 1); null when it isn't one.
 */
export function normalizeBindingCode(token: string): string | null {
  if (token.length < PREFIX.length + SYMBOLS || token.length > 32) return null;
  let out = "";
  for (const raw of token.toUpperCase()) {
    if (raw === "-") continue;
    const ch = raw === "O" ? "0" : raw === "I" || raw === "L" ? "1" : raw;
    out += ch;
  }
  if (out.length !== PREFIX.length + SYMBOLS || !out.startsWith(PREFIX)) return null;
  for (const ch of out.slice(PREFIX.length)) if (!ALPHABET.includes(ch)) return null;
  return out;
}

const TRIM = new Set([".", ",", ";", ":", "!", "?", '"', "'", "(", ")", "[", "]", "`", "*", "_"]);
/** Only the start of a message is looked at. */
const MAX_SCAN = 2000;

/** The first code in a message's text (what follows the app's mention), or null. */
export function findBindingCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.slice(0, MAX_SCAN);
  let token = "";
  const tryToken = (t: string): string | null => {
    let a = 0;
    let b = t.length;
    while (a < b && TRIM.has(t[a] as string)) a++;
    while (b > a && TRIM.has(t[b - 1] as string)) b--;
    return normalizeBindingCode(t.slice(a, b));
  };
  for (const ch of s) {
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") {
      const found = token ? tryToken(token) : null;
      if (found) return found;
      token = "";
      continue;
    }
    // A token far longer than a code can't be one; stop collecting it.
    if (token.length <= 40) token += ch;
  }
  return token ? tryToken(token) : null;
}

/** What is stored for a code: SHA-256 over the client, the connection and the canonical code. */
export async function bindingCodeHash(
  tenantId: string,
  connectionId: string,
  canonicalCode: string,
): Promise<string> {
  return toHex(
    await sha256Bytes(utf8(`gchat-bind:v1:${tenantId}:${connectionId}:${canonicalCode}`)),
  );
}

/** Whether `canonicalCode` is the one stored for this client's connection (constant time). */
export async function bindingCodeMatches(
  stored: string,
  tenantId: string,
  connectionId: string,
  canonicalCode: string,
): Promise<boolean> {
  return constantTimeEqual(await bindingCodeHash(tenantId, connectionId, canonicalCode), stored);
}

/**
 * Wrong codes posted in a space, counted per space in this isolate: after 10 in 15 minutes the
 * space is told to wait. A guess has 1 in 2^60 odds anyway; this keeps a space from being used
 * to hammer the lookup. At most 1000 spaces are tracked (the oldest window is dropped).
 */
// DECISION: per isolate, no storage: codes are 60 bits and live 15 minutes, so the limit is about
// load, not odds; a global counter would need a table (and a migration) for no real gain.
export class BindAttemptLimiter {
  private readonly windows = new Map<string, { start: number; failures: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly capacity = 1000,
  ) {}

  /** Whether this space may try a code now. */
  allowed(space: string, nowMs: number): boolean {
    const w = this.windows.get(space);
    if (!w || nowMs - w.start >= this.windowMs) return true;
    return w.failures < this.max;
  }

  /** A wrong code from this space. */
  failed(space: string, nowMs: number): void {
    const w = this.windows.get(space);
    if (w && nowMs - w.start < this.windowMs) {
      w.failures += 1;
      return;
    }
    if (!w && this.windows.size >= this.capacity) {
      const oldest = this.windows.keys().next();
      if (!oldest.done) this.windows.delete(oldest.value);
    }
    this.windows.delete(space);
    this.windows.set(space, { start: nowMs, failures: 1 });
  }
}
