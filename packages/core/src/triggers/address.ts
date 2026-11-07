// The agent's own email address (ARCHITECTURE §10.8): `<agent>.<client label>-<client id in
// base32>@<EMAIL_FORWARDING_DOMAIN>`, received by the Worker's `email()` like forwarding. The
// client id lets the handler open the right client's transaction (RLS) with no lookup across
// clients; the agent is found by its command name among that client's agents only.
// Parsing walks the string with index scans (no regex over the address).

// DECISION: agent addresses are built on the existing forwarding domain (owner default,
// 2026-11-06), not `<agent>@<client>.agents.mezonas.com`, which needs Email Routing per client
// subdomain and a Cloudflare API token (docs/plan.md §7).

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 16 bytes in base32 without padding. */
const ID_CHARS = 26;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
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
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function isHex(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");
}

function uuidBytes(id: string): Uint8Array {
  const hex = id.toLowerCase().split("-").join("");
  if (hex.length !== 32 || ![...hex].every(isHex)) throw new Error(`not a client id: ${id}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesUuid(bytes: Uint8Array): string {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
}

/** The client's name as the address's readable part: lower case, letters, digits and dashes. */
export function agentAddressLabel(clientName: string): string {
  const folded = clientName.slice(0, 200).normalize("NFKD").toLowerCase();
  let out = "";
  for (const ch of folded) {
    if (out.length >= 16) break;
    // An apostrophe joins the word ("Ana's" → "anas"); accents left by NFKD are dropped.
    if (ch === "'" || ch === "’" || (ch >= "̀" && ch <= "ͯ")) continue;
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
    else if (out.length > 0 && !out.endsWith("-")) out += "-";
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "client";
}

/** `remy.millwork-<id>@in.mezonas.com`. */
export function agentAddress(input: {
  commandName: string;
  clientName: string;
  tenantId: string;
  domain: string;
}): string {
  const name = input.commandName.toLowerCase();
  if (!name || ![...name].every(isWordChar)) throw new Error("not a command name");
  const domain = input.domain.trim().toLowerCase();
  return `${name}.${agentAddressLabel(input.clientName)}-${base32(uuidBytes(input.tenantId))}@${domain}`;
}

export interface ParsedAgentAddress {
  tenantId: string;
  commandName: string;
  label: string;
}

/**
 * The client and command name an address names, or null when it isn't an agent address on
 * `domain`. The caller still compares the whole address with the one it computes for that client
 * (`sameAgentAddress`), so a label or name that isn't that client's is refused.
 */
export function parseAgentAddress(address: string, domain: string): ParsedAgentAddress | null {
  const a = address.trim().toLowerCase();
  if (a.length > 254) return null;
  const at = a.lastIndexOf("@");
  if (at < 0 || a.slice(at + 1) !== domain.trim().toLowerCase()) return null;
  let local = a.slice(0, at);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  const dot = local.indexOf(".");
  const dash = local.lastIndexOf("-");
  if (dot <= 0 || dash <= dot + 1) return null;
  const commandName = local.slice(0, dot);
  const label = local.slice(dot + 1, dash);
  const id = local.slice(dash + 1);
  if (id.length !== ID_CHARS) return null;
  if (![...commandName].every(isWordChar) || ![...label].every(isWordChar)) return null;
  const bytes = unbase32(id);
  if (bytes?.length !== 16) return null;
  return { tenantId: bytesUuid(bytes), commandName, label };
}

/** Constant-time comparison of two addresses, ignoring case and a `+tag`. */
export function sameAgentAddress(a: string, b: string): boolean {
  const strip = (v: string) => {
    const x = v.trim().toLowerCase();
    const at = x.lastIndexOf("@");
    const plus = x.indexOf("+");
    return plus >= 0 && plus < at ? x.slice(0, plus) + x.slice(at) : x;
  };
  const x = strip(a);
  const y = strip(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}
