// One-time codes that bind a Teams channel to a client. The client admin asks for one in the
// portal and mentions the bot with it in the channel (`@Mezonas MZ-7K2Q-9XHD-4RTM`); the code is
// the only proof a channel is the client's (never a tenant id or a domain). The codes are Google
// Chat's (../gchat/codes: 12 symbols of Crockford's base32, 60 bits, 15 minutes, once), kept only
// as a SHA-256 over the client and connection they were made for, under a Teams-only label so a
// Google Chat code can never bind a Teams channel. The steps (make, redeem) are pure here so the
// API only loads and saves the connection.

import {
  BINDING_CODE_TTL_MS,
  findBindingCode,
  generateBindingCode,
  normalizeBindingCode,
} from "../gchat/codes";
import { constantTimeEqual } from "../http";
import { sha256Bytes, toHex, utf8 } from "../runtime";

/** A code waiting to be used: only its hash, inside the connection's encrypted credentials. */
export interface TeamsPendingCode {
  hash: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string | null;
}

/** What is stored for a code: SHA-256 over the client, the connection and the canonical code. */
export async function teamsBindingCodeHash(
  tenantId: string,
  connectionId: string,
  canonicalCode: string,
): Promise<string> {
  return toHex(
    await sha256Bytes(utf8(`teams-bind:v1:${tenantId}:${connectionId}:${canonicalCode}`)),
  );
}

/** A new code for this client's connection: the code (shown once) and what to store. */
export async function makeTeamsBindingCode(input: {
  tenantId: string;
  connectionId: string;
  createdBy: string | null;
  now: Date;
}): Promise<{ code: string; pending: TeamsPendingCode }> {
  const code = generateBindingCode();
  const canonical = normalizeBindingCode(code);
  if (!canonical) throw new Error("a generated code did not read back");
  return {
    code,
    pending: {
      hash: await teamsBindingCodeHash(input.tenantId, input.connectionId, canonical),
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + BINDING_CODE_TTL_MS).toISOString(),
      createdBy: input.createdBy,
    },
  };
}

export type TeamsCodeCheck = "ok" | "none" | "wrong" | "expired";

/**
 * Whether `canonicalCode` is this connection's waiting code, still live. Compared before the
 * expiry is looked at, so an expired code takes as long as a live one. A used code is gone from
 * the credentials (the caller stores `pending: null` once it binds), so a second use is `none`.
 */
export async function checkTeamsBindingCode(
  pending: TeamsPendingCode | null | undefined,
  tenantId: string,
  connectionId: string,
  canonicalCode: string,
  now: Date,
): Promise<TeamsCodeCheck> {
  if (!pending) return "none";
  const same = constantTimeEqual(
    await teamsBindingCodeHash(tenantId, connectionId, canonicalCode),
    pending.hash,
  );
  if (!same) return "wrong";
  if (Date.parse(pending.expiresAt) <= now.getTime()) return "expired";
  return "ok";
}

/** How many symbols a mention's markup may run to before we stop looking for its end. */
const MAX_TAG = 400;

/**
 * A message's text with Teams' markup taken out: `<at>Mezonas</at>` (the bot's mention, and any
 * other) is dropped whole, every other tag is dropped, and the few entities Teams writes for
 * spaces are spaces. Only ever searched for a code.
 */
export function teamsMessageWords(text: string): string {
  let out = "";
  let i = 0;
  const s = text.slice(0, 4000);
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "<") {
      const close = s.indexOf(">", i + 1);
      if (close > i && close - i <= MAX_TAG) {
        const tag = s
          .slice(i + 1, close)
          .trim()
          .toLowerCase();
        if (tag === "at" || tag.startsWith("at ")) {
          const end = s.toLowerCase().indexOf("</at>", close + 1);
          i = end < 0 ? close + 1 : end + "</at>".length;
          out += " ";
          continue;
        }
        out += " ";
        i = close + 1;
        continue;
      }
    }
    if (ch === "&") {
      const lower = s.slice(i, i + 6).toLowerCase();
      if (lower.startsWith("&nbsp;")) {
        out += " ";
        i += 6;
        continue;
      }
    }
    out += ch === " " ? " " : ch;
    i += 1;
  }
  return out;
}

/** The first code in a Teams message (after its mentions are taken out), or null. */
export function findTeamsBindingCode(text: string | null | undefined): string | null {
  if (!text) return null;
  return findBindingCode(teamsMessageWords(text));
}
