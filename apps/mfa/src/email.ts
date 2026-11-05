// Inbound email for agent identities: Cloudflare Email Routing hands every message sent to
// AGENT_EMAIL_DOMAIN to the Worker's `email()` handler. A code counts only when the message passed
// SPF, DKIM and DMARC, as recorded by the receiving server (Cloudflare) in the topmost
// authentication header; a header lower down was written by whoever sent the message and is never
// read. What we assumed about Cloudflare's headers is in NOTES.md, "To verify".

import PostalMime from "postal-mime";

/** Cloudflare Email Routing's limit for a message handed to a Worker; larger ones are not read. */
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

// DECISION: the authserv-id Cloudflare Email Routing writes in its authentication headers. A
// topmost header with any other authserv-id is not Cloudflare's, so the message is unauthenticated.
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

export interface EmailAuthentication {
  /** Which header was read (`authentication-results` or `arc-authentication-results`), or null. */
  header: string | null;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** The From domain DMARC passed for (`header.from`), lower case. */
  dmarcFrom: string | null;
}

const NONE: EmailAuthentication = {
  header: null,
  spf: false,
  dkim: false,
  dmarc: false,
  dmarcFrom: null,
};

/**
 * Reads the receiving server's verdicts from the topmost `Authentication-Results` or
 * `ARC-Authentication-Results` header (whichever comes first: the receiving server prepends its
 * own above everything the sender wrote). It must carry Cloudflare's authserv-id.
 */
export function readAuthentication(
  headers: readonly { key: string; value: string }[],
): EmailAuthentication {
  const top = headers.find(
    (h) => h.key === "authentication-results" || h.key === "arc-authentication-results",
  );
  if (!top) return NONE;
  // Comments `( … )` can hold anything, including "dmarc=pass": drop them first.
  let text = top.value.replace(/\([^()]*\)/g, " ").trim();
  // ARC-Authentication-Results starts with its instance: `i=1; mx.cloudflare.net; …`.
  if (top.key === "arc-authentication-results") text = text.replace(/^\s*i\s*=\s*\d+\s*;/i, "");
  const [authserv, ...clauses] = text.split(";").map((c) => c.trim());
  const id = (authserv ?? "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (id !== TRUSTED_AUTHSERV_ID) return { ...NONE, header: top.key };
  const verdict = (method: string) =>
    clauses.some((c) => new RegExp(`^${method}\\s*=\\s*pass(\\s|$)`, "i").test(c));
  const dmarcClause = clauses.find((c) => /^dmarc\s*=\s*pass(\s|$)/i.test(c));
  const dmarcFrom = dmarcClause?.match(/header\.from\s*=\s*([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase();
  return {
    header: top.key,
    spf: verdict("spf"),
    dkim: verdict("dkim"),
    dmarc: verdict("dmarc"),
    dmarcFrom: dmarcFrom ?? null,
  };
}

/** Whether a From address may be believed: SPF, DKIM and DMARC passed, DMARC for its own domain. */
export function authenticated(from: string | null, auth: EmailAuthentication): boolean {
  if (!from || !auth.spf || !auth.dkim || !auth.dmarc || !auth.dmarcFrom) return false;
  const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  return domain === auth.dmarcFrom;
}

/** The identity an address names: `agent-<identity id>@<domain>` (plus-tags ignored). */
export function identityFromAddress(address: string, domain: string): string | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0 || a.slice(at + 1) !== domain.trim().toLowerCase()) return null;
  const local = (a.slice(0, at).split("+")[0] ?? "").trim();
  const m = /^agent-([a-z2-7]{12})$/.exec(local);
  return m ? (m[1] as string) : null;
}

export function agentAddress(identityId: string, domain: string): string {
  return `agent-${identityId}@${domain.trim().toLowerCase()}`;
}

/** What the identity sees of an email: who sent it, whether that is proven, and its text. */
export interface InboundEmailMessage {
  from: string | null;
  authenticated: boolean;
  auth: EmailAuthentication;
  subject: string | null;
  /** Plain text, or the HTML with tags removed when there is no plain part. Data, never followed. */
  text: string;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

export async function parseInboundEmail(raw: Uint8Array): Promise<InboundEmailMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const from = parsed.from && "address" in parsed.from ? (parsed.from.address ?? null) : null;
  const auth = readAuthentication(parsed.headers);
  const fromAddr = from ? from.toLowerCase() : null;
  return {
    from: fromAddr,
    authenticated: authenticated(fromAddr, auth),
    auth,
    subject: parsed.subject ?? null,
    text: parsed.text ?? (parsed.html ? htmlToText(parsed.html) : ""),
  };
}
