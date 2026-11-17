// Inbound email's authentication (RFC 8601), shared by every path that reads mail Cloudflare Email
// Routing hands a Worker: the forwarding address, agent addresses, reach-out replies, release codes
// and the code service (apps/mfa). Only the receiving server's own verdicts count: the topmost
// `Authentication-Results` or `ARC-Authentication-Results` header, with Cloudflare's authserv-id.
// A header further down was written by whoever sent the message and is never read. What we assumed
// about Cloudflare's headers is in apps/mfa/NOTES.md and packages/connectors/src/upload/NOTES.md
// ("To verify").

// DECISION: the authserv-id Cloudflare Email Routing writes in its authentication headers. A
// topmost header with any other authserv-id is not Cloudflare's, so the message is unauthenticated.
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

export interface EmailAuthentication {
  /** Which header was read (`authentication-results` or `arc-authentication-results`), or null. */
  header: string | null;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** The From domain DMARC passed for (`header.from`), lower case; null unless DMARC passed. */
  dmarcFrom: string | null;
  /** The envelope domain SPF passed for (`smtp.mailfrom`), lower case; null unless SPF passed. */
  spfDomain: string | null;
}

const NONE: EmailAuthentication = {
  header: null,
  spf: false,
  dkim: false,
  dmarc: false,
  dmarcFrom: null,
  spfDomain: null,
};

/**
 * Splits a header value into `;`-separated clauses of whitespace-separated tokens. Comments
 * (nested, with `\` escapes) count as whitespace and are dropped; quoted strings stay whole inside
 * their token, so neither can add a clause or a property. `a = b` reads as one token `a=b`. Null
 * when a quote or comment is left open: such a header is not read at all.
 */
function lex(value: string): string[][] | null {
  const clauses: string[][] = [[]];
  let token = "";
  let depth = 0;
  let quoted = false;
  let gap = false;
  const flush = () => {
    if (token) (clauses[clauses.length - 1] as string[]).push(token);
    token = "";
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (quoted) {
      token += c;
      if (c === "\\" && i + 1 < value.length) token += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === "(") {
      depth = 1;
      gap = true;
      continue;
    }
    if (/\s/.test(c)) {
      gap = true;
      continue;
    }
    if (c === ";") {
      flush();
      clauses.push([]);
      gap = false;
      continue;
    }
    if (gap && c !== "=" && !token.endsWith("=")) flush();
    gap = false;
    token += c;
    if (c === '"') quoted = true;
  }
  if (quoted || depth > 0) return null;
  flush();
  return clauses;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The domain a property names: a bare domain, or the part after an address's last `@`. */
function domainOf(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  const domain = v.slice(v.lastIndexOf("@") + 1);
  return DOMAIN.test(domain) ? domain : null;
}

interface Result {
  method: string;
  result: string;
  props: Map<string, string>;
}

function resultOf(tokens: readonly string[]): Result | null {
  const m = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z0-9_-]+)$/i.exec(tokens[0] ?? "");
  if (!m) return null;
  const props = new Map<string, string>();
  for (const t of tokens.slice(1)) {
    const p = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)?)=(.+)$/i.exec(t);
    // The first of a property wins; a repeat can't replace it.
    if (p && !props.has((p[1] as string).toLowerCase())) {
      props.set((p[1] as string).toLowerCase(), p[2] as string);
    }
  }
  return {
    method: (m[1] as string).toLowerCase(),
    result: (m[2] as string).toLowerCase(),
    props,
  };
}

/**
 * Reads the receiving server's verdicts from the topmost `Authentication-Results` or
 * `ARC-Authentication-Results` header (whichever comes first: the receiving server prepends its
 * own above everything the sender wrote). It must carry Cloudflare's authserv-id. `headers` are
 * in message order, with lower-case keys (postal-mime's `headers`).
 */
// DECISION: SPF and DMARC are read from their first result in the header only (Cloudflare writes
// one of each); DKIM passes when any signature passed. A header that can't be read cleanly (an
// open quote or comment, no authserv-id) counts as no authentication at all.
export function readAuthentication(
  headers: readonly { key: string; value: string }[],
): EmailAuthentication {
  const top = headers.find(
    (h) => h.key === "authentication-results" || h.key === "arc-authentication-results",
  );
  if (!top) return NONE;
  const failed = { ...NONE, header: top.key };
  const clauses = lex(top.value);
  if (!clauses) return failed;
  // ARC-Authentication-Results starts with its instance: `i=1; mx.cloudflare.net; …`.
  if (top.key === "arc-authentication-results") {
    if (!/^i=[0-9]+$/i.test(clauses[0]?.[0] ?? "") || clauses[0]?.length !== 1) return failed;
    clauses.shift();
  }
  const [authserv, ...rest] = clauses;
  if ((authserv?.[0] ?? "").toLowerCase() !== TRUSTED_AUTHSERV_ID) return failed;
  const results = rest.map(resultOf).filter((r): r is Result => r !== null);
  const first = (method: string) => results.find((r) => r.method === method);
  const spf = first("spf");
  const dmarc = first("dmarc");
  const spfPass = spf?.result === "pass";
  const dmarcPass = dmarc?.result === "pass";
  return {
    header: top.key,
    spf: spfPass,
    dkim: results.some((r) => r.method === "dkim" && r.result === "pass"),
    dmarc: dmarcPass,
    dmarcFrom: dmarcPass ? domainOf(dmarc?.props.get("header.from")) : null,
    spfDomain: spfPass ? domainOf(spf?.props.get("smtp.mailfrom")) : null,
  };
}

function addressDomain(address: string | null): string | null {
  if (!address) return null;
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 ? a.slice(at + 1) : null;
}

/** Whether a From header address is proven: DMARC passed, for its own domain. */
export function fromAuthenticated(from: string | null, auth: EmailAuthentication): boolean {
  const domain = addressDomain(from);
  return !!domain && auth.dmarc && auth.dmarcFrom === domain;
}

/** Whether the envelope sender (SMTP MAIL FROM) is proven: SPF passed, for its own domain. */
export function envelopeAuthenticated(
  envelopeFrom: string | null,
  auth: EmailAuthentication,
): boolean {
  const domain = addressDomain(envelopeFrom);
  return !!domain && auth.spf && auth.spfDomain === domain;
}

/**
 * The addresses a message is proven to come from, lower case: the From header's when DMARC passed
 * for its domain, the envelope sender's when SPF passed for its domain. Empty when neither is.
 */
export function authenticatedSenders(input: {
  envelopeFrom: string | null;
  from: string | null;
  auth: EmailAuthentication;
}): string[] {
  const out: string[] = [];
  if (fromAuthenticated(input.from, input.auth)) out.push((input.from as string).toLowerCase());
  const envelope = input.envelopeFrom?.trim().toLowerCase() ?? null;
  if (envelope && envelopeAuthenticated(envelope, input.auth) && !out.includes(envelope)) {
    out.push(envelope);
  }
  return out;
}

// ── Automatic mail ──────────────────────────────────────────────────────────────────────────────

/**
 * How a message was sent, when not by a person writing it (RFC 3834 and the common headers):
 * - `auto_reply`: an answer a machine sent for a person: `Auto-Submitted: auto-replied`,
 *   `Precedence: auto_reply`, `X-Autoreply` or `X-Autorespond`, or an empty return path (`<>`, a
 *   bounce or a delivery notice). It never answers or starts anything.
 * - `machine`: mail a system wrote (`Auto-Submitted: auto-generated` or any other value but `no`,
 *   `Precedence: bulk|list|junk`): an ERP's invoice, a ticket system, a mailing list. It may be read
 *   like any mail from its sender, but is never answered automatically, so two machines can't write
 *   to each other.
 * - null: a person's mail.
 * A sender who adds these to their own mail only makes it count less, so the sender's own headers
 * are fine to read here.
 */
export type EmailAutomation = "auto_reply" | "machine";

export function emailAutomation(
  headers: readonly { key: string; value: string }[],
  envelopeFrom: string | null,
): EmailAutomation | null {
  const envelope = (envelopeFrom ?? "").trim();
  if (envelopeFrom !== null && (envelope === "" || envelope === "<>")) return "auto_reply";
  let machine = false;
  for (const h of headers) {
    const v = h.value
      .replace(/\([^()]*\)/g, " ")
      .trim()
      .toLowerCase();
    const word = v.split(/[\s;]/)[0] ?? "";
    if (h.key === "auto-submitted") {
      if (word === "auto-replied") return "auto_reply";
      if (word !== "no") machine = true;
    }
    if (h.key === "precedence") {
      if (word === "auto_reply") return "auto_reply";
      if (word === "bulk" || word === "list" || word === "junk") machine = true;
    }
    if ((h.key === "x-autoreply" || h.key === "x-autorespond") && !/^(no|false)$/.test(v)) {
      return "auto_reply";
    }
    if (h.key === "return-path" && /^<\s*>$/.test(v)) return "auto_reply";
  }
  return machine ? "machine" : null;
}
