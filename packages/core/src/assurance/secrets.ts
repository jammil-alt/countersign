// "No secret reaches a model" and "OAuth asks for no more than needed" (docs/agent-assurance-plan.md
// §4b; §1.231.2): the pure parts. The API opens the client's stored secrets and its stored model
// requests in the client's scope, and asks these whether a request holds one; nothing here keeps,
// returns or logs a secret's value (invariant 13). What is found is named by its kind only.

/** Key names whose string values are secrets: tokens, keys, passwords, signing secrets. */
const SECRET_KEY = /token|secret|password|passphrase|apikey|api_key|privatekey/i;
/** Key names that match the above but are not secrets. */
const NOT_SECRET_KEY = /^(tokenType|token_type|tokenUrl)$/i;
/** Shorter values match too much ordinary text to say anything. */
const MIN_SECRET_LENGTH = 8;

/**
 * The secret values in a connection's opened credentials: every string under a key that names a
 * token, key, password or secret, at any depth (a webhook's `tokens.<name>`), at least 8 long.
 * Ids, addresses, scopes and expiry times are left out.
 */
export function secretValues(credentials: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, secretPath: boolean) => {
    if (typeof v === "string") {
      if (secretPath && v.length >= MIN_SECRET_LENGTH) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, secretPath);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        walk(x, secretPath || (SECRET_KEY.test(k) && !NOT_SECRET_KEY.test(k)));
      }
    }
  };
  walk(credentials, false);
  return [...out];
}

/** Whether `text` (a stored request, as JSON) holds any of `secrets`, raw or JSON-escaped. */
export function holdsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)));
}

/**
 * Strings shaped like a key or token of a well-known kind, whoever's they are. Named, never
 * returned: the check's evidence says "an OpenAI-style key", not the key.
 */
// DECISION (§1.231.2): a short list of shapes with distinctive prefixes, so ordinary text (an
// invoice number, an id) never reads as a secret. A bare JWT counts: a stored request has no
// reason to hold a signed session or ID token.
export const SECRET_SHAPES: readonly { id: string; pattern: RegExp }[] = [
  { id: "private_key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: "model_api_key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { id: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "google_access_token", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { id: "stripe_key", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** The kinds of secret-shaped strings in `text`, by id. */
export function secretShapesIn(text: string): string[] {
  return SECRET_SHAPES.filter((s) => s.pattern.test(text)).map((s) => s.id);
}

// ── OAuth scopes ─────────────────────────────────────────────────────────────────────────────────

const SCOPE_PREFIXES = ["https://www.googleapis.com/auth/", "https://graph.microsoft.com/"];

/** A scope as compared: lower case, without Google's or Microsoft Graph's address in front. */
export function normalScope(scope: string): string {
  let s = scope.trim().toLowerCase();
  for (const p of SCOPE_PREFIXES) if (s.startsWith(p)) s = s.slice(p.length);
  return s;
}

/** A stored grant's scopes (`OAuthTokens.scope`): space- or comma-separated, as providers send. */
export function parseScopes(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** The granted scopes that aren't among the declared ones. */
export function scopesBeyond(granted: readonly string[], declared: readonly string[]): string[] {
  const ok = new Set(declared.map(normalScope));
  return granted.filter((g) => !ok.has(normalScope(g)));
}
