// The Google Chat app's two kinds of token (docs/plan.md §1.60):
// - Outbound, as the app itself: a service account of Mezonas' own signs a JWT for the `chat.bot`
//   scope and exchanges it at Google's token endpoint (OAuth 2.0 for service accounts); the access
//   token is kept until a minute before it expires. No per-client user tokens exist.
// - Inbound, from Google Chat: each event carries `Authorization: Bearer <JWT>` signed by
//   `chat@system.gserviceaccount.com`, whose audience is our Google Cloud project number. It is
//   verified with the certificates Google publishes for that account (kept as long as Google's
//   Cache-Control allows) before anything in the request is read.
// The service account key never leaves this module's closure: not logged, not returned, not put in
// an error message. Unchecked facts about Google: ./NOTES.md.

import { z } from "zod";
import { GOOGLE_TOKEN_URL } from "../gmail/index";
import { type FetchLike, formEncode, timeoutSignal } from "../http";
import {
  type DecodedJwt,
  decodeJwt,
  importCertificateKey,
  importSigningKey,
  type RsaKey,
  signJwt,
  verifyRs256,
} from "./jwt";

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
/** Who signs the tokens on Google Chat's requests to a Chat app (non add-on apps). */
export const CHAT_ISSUER = "chat@system.gserviceaccount.com";
/** Google's published certificates for that account (x509 PEM by key id). */
export const CHAT_CERTS_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;

/** The key JSON of a service account, as Google Cloud downloads it. Only what we use. */
const ServiceAccountKey = z.looseObject({
  type: z.literal("service_account"),
  client_email: z.string().min(3).max(320),
  private_key: z.string().min(100).max(16_000),
  private_key_id: z.string().max(200).optional(),
});

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  keyId: string | null;
}

/** The secret `GOOGLE_CHAT_SERVICE_ACCOUNT` read leniently: null when it isn't a key JSON. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  if (!raw || raw.length > 32_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = ServiceAccountKey.safeParse(parsed);
  if (!r.success || !r.data.client_email.includes("@")) return null;
  return {
    clientEmail: r.data.client_email,
    privateKey: r.data.private_key,
    keyId: r.data.private_key_id ?? null,
  };
}

/** A Google Cloud project number: digits only (the audience of Chat's tokens). */
export function isProjectNumber(value: string | undefined | null): value is string {
  if (!value || value.length > 20) return false;
  for (const ch of value) if (ch < "0" || ch > "9") return false;
  return true;
}

export class GchatAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GchatAuthError";
  }
}

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive(),
});

/** Seconds left on a token when we stop using it. */
const TOKEN_MARGIN_S = 60;

/** The app's access token for the Chat API, cached until shortly before it expires. */
export class AppTokens {
  private cached: { token: string; until: number } | null = null;
  private key: Promise<RsaKey> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetch: () => FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Forget the cached token (Google refused it). */
  drop(): void {
    this.cached = null;
  }

  async get(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.until > nowMs) return this.cached.token;
    this.key ??= importSigningKey(this.account.privateKey);
    let key: RsaKey;
    try {
      key = await this.key;
    } catch {
      this.key = null;
      throw new GchatAuthError("the Google Chat service account key can't be read");
    }
    const iat = Math.floor(nowMs / 1000);
    const assertion = await signJwt(key, this.account.keyId ? { kid: this.account.keyId } : {}, {
      iss: this.account.clientEmail,
      scope: CHAT_BOT_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    const res = await this.fetch()(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    const answer = TokenAnswer.safeParse(body);
    if (!res.ok || !answer.success) {
      // Google's error code only (e.g. invalid_grant): never the assertion or the key.
      const code = (body as { error?: unknown } | null)?.error;
      throw new GchatAuthError(
        `Google refused the Chat app's sign-in (${res.status}${typeof code === "string" ? `, ${code.slice(0, 60)}` : ""})`,
      );
    }
    const life = Math.max(0, answer.data.expires_in - TOKEN_MARGIN_S);
    this.cached = { token: answer.data.access_token, until: nowMs + life * 1000 };
    return answer.data.access_token;
  }
}

// --- Inbound: Google Chat's bearer token ---------------------------------------------------------

/** Why a token was refused (for tests and the operator's logs; never sent to the caller). */
export type ChatTokenRefusal =
  | "missing"
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired";

export type ChatTokenCheck =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: ChatTokenRefusal };

/** Clock skew allowed on `exp`, `iat` and `nbf`. */
const SKEW_S = 60;
/** At most this many published keys are kept. */
const MAX_KEYS = 20;
/** The certificates' body is a few KB; anything far larger is not Google's. */
const MAX_CERTS_BYTES = 64 * 1024;
/** How long keys are kept when Google gives no max-age, and at most. */
const DEFAULT_KEYS_TTL_S = 3600;
const MAX_KEYS_TTL_S = 24 * 3600;
/** An unknown key id refetches the certificates at most this often. */
const REFETCH_MIN_MS = 60_000;

/** `max-age=N` from a Cache-Control header, parsed by hand; null when absent. */
export function maxAgeOf(cacheControl: string | null): number | null {
  if (!cacheControl || cacheControl.length > 512) return null;
  for (const part of cacheControl.split(",")) {
    const p = part.trim().toLowerCase();
    if (!p.startsWith("max-age=")) continue;
    const v = p.slice("max-age=".length);
    if (v.length === 0 || v.length > 9) return null;
    for (const ch of v) if (ch < "0" || ch > "9") return null;
    return Number(v);
  }
  return null;
}

/** Google's certificates for Chat's tokens, by key id, fetched on demand and cached. */
export class ChatSigningKeys {
  private keys = new Map<string, RsaKey>();
  private until = 0;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly fetch: () => FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<void> {
    const nowMs = this.now().getTime();
    this.fetchedAt = nowMs;
    const res = await this.fetch()(CHAT_CERTS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: timeoutSignal(10_000),
    });
    if (!res.ok) throw new GchatAuthError(`Google's Chat certificates answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_CERTS_BYTES)
      throw new GchatAuthError("Google's certificates are too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new GchatAuthError("Google's certificates are not JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new GchatAuthError("Google's certificates have an unexpected shape");
    }
    const next = new Map<string, RsaKey>();
    for (const [kid, pem] of Object.entries(body as Record<string, unknown>)) {
      if (next.size >= MAX_KEYS) break;
      if (typeof pem !== "string" || kid.length === 0 || kid.length > 200) continue;
      const key = await importCertificateKey(pem);
      if (key) next.set(kid, key);
    }
    const ttl = Math.min(
      maxAgeOf(res.headers.get("cache-control")) ?? DEFAULT_KEYS_TTL_S,
      MAX_KEYS_TTL_S,
    );
    this.keys = next;
    this.until = nowMs + ttl * 1000;
  }

  private async refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  /** The key with this id: from the cache, else after one refetch (rate-limited). */
  async get(kid: string): Promise<RsaKey | null> {
    const nowMs = this.now().getTime();
    if (nowMs >= this.until) {
      await this.refresh();
    } else if (!this.keys.has(kid) && nowMs - this.fetchedAt >= REFETCH_MIN_MS) {
      await this.refresh();
    }
    return this.keys.get(kid) ?? null;
  }
}

/** `Authorization: Bearer <token>` → the token, parsed by hand; null when there is none. */
export function bearerOf(header: string | null | undefined): string | null {
  if (!header || header.length > 16_384) return null;
  const sp = header.indexOf(" ");
  if (sp < 0 || header.slice(0, sp).toLowerCase() !== "bearer") return null;
  const token = header.slice(sp + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies a Google Chat request's bearer token: a JWT with `alg` RS256 and a `kid` among
 * Google's published keys for Chat, signed by it, `iss` exactly Chat's account, `aud` exactly
 * our project number, not expired (and not issued in the future).
 */
export async function verifyChatToken(
  token: string | null,
  opts: { projectNumber: string; keys: ChatSigningKeys; now: Date },
): Promise<ChatTokenCheck> {
  if (!token) return { ok: false, reason: "missing" };
  const jwt: DecodedJwt | null = decodeJwt(token);
  if (!jwt) return { ok: false, reason: "malformed" };
  if (jwt.header.alg !== "RS256") return { ok: false, reason: "algorithm" };
  const kid = jwt.header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 200) {
    return { ok: false, reason: "unknown_key" };
  }
  let key: RsaKey | null;
  try {
    key = await opts.keys.get(kid);
  } catch {
    // Google's certificates unreachable: nothing can be verified, so nothing is accepted.
    return { ok: false, reason: "unknown_key" };
  }
  if (!key) return { ok: false, reason: "unknown_key" };
  if (!(await verifyRs256(key, jwt))) return { ok: false, reason: "signature" };
  const c = jwt.claims;
  if (c.iss !== CHAT_ISSUER) return { ok: false, reason: "issuer" };
  // DECISION: `aud` must be exactly the project number (the Chat API's "Authentication Audience"
  // set to Project Number); an array or the endpoint URL is refused.
  if (c.aud !== opts.projectNumber) return { ok: false, reason: "audience" };
  const nowS = opts.now.getTime() / 1000;
  if (typeof c.exp !== "number" || c.exp + SKEW_S < nowS) return { ok: false, reason: "expired" };
  if (typeof c.iat === "number" && c.iat - SKEW_S > nowS) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf - SKEW_S > nowS) return { ok: false, reason: "expired" };
  return { ok: true, claims: c };
}
