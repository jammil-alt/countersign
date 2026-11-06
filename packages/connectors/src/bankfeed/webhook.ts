// v0.12 bankfeed: Plaid's webhooks (docs/plan.md §1.52). Every webhook carries a `Plaid-Verification`
// header: a JWT signed with ES256 by one of Plaid's keys, whose `request_body_sha256` claim is the
// SHA-256 of the body as sent. We read the JWT's header without trusting it (alg must be ES256, a
// key id of a plain shape), get that key from Plaid (`/webhook_verification_key/get`, cached),
// check the signature with Web Crypto, refuse a JWT issued more than 5 minutes ago (or ahead of our
// clock), and compare the body's hash in constant time. Anything else is refused. The body is
// Plaid's data, never instructions (invariant 9): it only names an item and what changed.

import { z } from "zod";
import { constantTimeEqual } from "../http";
import {
  type CryptoKeyLike,
  type EcPublicJwk,
  fromBase64Url,
  fromUtf8,
  sha256Bytes,
  subtle,
  toHex,
  utf8,
} from "../runtime";

/** The header Plaid signs webhooks in (lowercase, as headers are read here). */
export const PLAID_VERIFICATION_HEADER = "plaid-verification";
/** The largest webhook body we read; Plaid's are a few hundred bytes. */
export const PLAID_WEBHOOK_MAX_BYTES = 64 * 1024;
/** How old a webhook's `iat` may be (Plaid's guidance: 5 minutes). */
export const PLAID_WEBHOOK_MAX_AGE_S = 5 * 60;
/** A JWT longer than this is not Plaid's: refused before anything is decoded. */
const MAX_JWT_LENGTH = 4096;
/** Key ids are short opaque strings; anything else is refused before Plaid is asked. */
const KID = /^[A-Za-z0-9_-]{1,100}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A verification key as `/webhook_verification_key/get` answers it. */
export const PlaidVerificationKey = z.looseObject({
  alg: z.literal("ES256"),
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  kid: z.string().min(1).max(100),
  x: z.string().min(1).max(100),
  y: z.string().min(1).max(100),
  use: z.string().optional(),
  created_at: z.number().int().nullable().optional(),
  expired_at: z.number().int().nullable().optional(),
});
export type PlaidVerificationKey = z.infer<typeof PlaidVerificationKey>;

const JwtHeader = z.looseObject({
  alg: z.string(),
  kid: z.string(),
  typ: z.string().optional(),
});
const JwtClaims = z.looseObject({
  iat: z.number().int(),
  request_body_sha256: z.string().max(128),
});

export type WebhookRefusal =
  | "missing"
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "expired_key"
  | "signature"
  | "stale"
  | "body_hash";

export type WebhookCheck = { ok: true; kid: string } | { ok: false; reason: WebhookRefusal };

/** Fetches a key by id from Plaid; null when Plaid doesn't know it. */
export type VerificationKeyFetcher = (kid: string) => Promise<PlaidVerificationKey | null>;

interface CachedKey {
  key: CryptoKeyLike;
  expiredAt: number | null;
  fetchedAt: number;
}

/** How long a fetched key is kept before it is asked for again (to learn of its expiry). */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an unknown key id is remembered, so a flood of made-up ids asks Plaid once each. */
const UNKNOWN_TTL_MS = 5 * 60 * 1000;
const MAX_KEYS = 16;
const MAX_UNKNOWN = 64;

// DECISION: keys are cached per connector instance (built once per isolate by platformFor), in
// Maps with a fixed size; the oldest entry goes first. A key with `expired_at` in the past is
// refused (NOTES.md: verify how Plaid rotates keys).
export class PlaidKeyCache {
  private readonly keys = new Map<string, CachedKey>();
  private readonly unknown = new Map<string, number>();

  constructor(private readonly fetchKey: VerificationKeyFetcher) {}

  async get(kid: string, now: Date): Promise<CachedKey | null> {
    const at = now.getTime();
    const hit = this.keys.get(kid);
    if (hit && at - hit.fetchedAt < KEY_TTL_MS) return hit;
    const miss = this.unknown.get(kid);
    if (miss !== undefined && at - miss < UNKNOWN_TTL_MS) return null;
    const raw = await this.fetchKey(kid);
    const parsed = raw ? PlaidVerificationKey.safeParse(raw) : null;
    if (!parsed?.success || parsed.data.kid !== kid) {
      remember(this.unknown, kid, at, MAX_UNKNOWN);
      return null;
    }
    const jwk: EcPublicJwk = { kty: "EC", crv: "P-256", x: parsed.data.x, y: parsed.data.y };
    const key = await subtle().importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const entry: CachedKey = {
      key,
      expiredAt: typeof parsed.data.expired_at === "number" ? parsed.data.expired_at : null,
      fetchedAt: at,
    };
    remember(this.keys, kid, entry, MAX_KEYS);
    this.unknown.delete(kid);
    return entry;
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(fromUtf8(fromBase64Url(part)));
  } catch {
    return null;
  }
}

/**
 * Checks a Plaid webhook: the `Plaid-Verification` JWT (`jwt`) against the raw body bytes.
 * Nothing about the body is trusted until this says ok.
 */
export async function verifyPlaidWebhook(input: {
  jwt: string | null | undefined;
  body: Uint8Array;
  keys: PlaidKeyCache;
  now: Date;
}): Promise<WebhookCheck> {
  const jwt = input.jwt?.trim() ?? "";
  if (!jwt) return { ok: false, reason: "missing" };
  if (jwt.length > MAX_JWT_LENGTH || input.body.length > PLAID_WEBHOOK_MAX_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h = "", p = "", s = ""] = parts;
  const header = JwtHeader.safeParse(decodeJson(h));
  if (!header.success) return { ok: false, reason: "malformed" };
  // Only ES256: a JWT naming any other algorithm ("none", HS256) is refused outright.
  if (header.data.alg !== "ES256") return { ok: false, reason: "algorithm" };
  const kid = header.data.kid;
  if (!KID.test(kid)) return { ok: false, reason: "malformed" };
  const claims = JwtClaims.safeParse(decodeJson(p));
  if (!claims.success) return { ok: false, reason: "malformed" };
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // ES256 signatures are r || s, 32 bytes each.
  if (signature.length !== 64) return { ok: false, reason: "signature" };

  // An old (or future) `iat` is refused before Plaid is asked for any key: a replay costs nothing.
  const nowS = Math.floor(input.now.getTime() / 1000);
  const age = nowS - claims.data.iat;
  if (age > PLAID_WEBHOOK_MAX_AGE_S || age < -PLAID_WEBHOOK_MAX_AGE_S) {
    return { ok: false, reason: "stale" };
  }

  const key = await input.keys.get(kid, input.now);
  if (!key) return { ok: false, reason: "unknown_key" };
  if (key.expiredAt !== null && key.expiredAt <= nowS) return { ok: false, reason: "expired_key" };
  const valid = await subtle().verify(
    { name: "ECDSA", hash: "SHA-256" },
    key.key,
    signature,
    utf8(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: "signature" };

  const claimed = claims.data.request_body_sha256.toLowerCase();
  const actual = toHex(await sha256Bytes(input.body));
  if (!HEX64.test(claimed) || !constantTimeEqual(claimed, actual)) {
    return { ok: false, reason: "body_hash" };
  }
  return { ok: true, kid };
}

/** What we read of a verified webhook's body. */
export const PlaidWebhookBody = z.looseObject({
  webhook_type: z.string().max(64),
  webhook_code: z.string().max(64),
  item_id: z.string().min(1).max(200).optional(),
  environment: z.string().max(32).optional(),
  error: z
    .looseObject({
      error_type: z.string().max(64).optional(),
      error_code: z.string().max(64).optional(),
    })
    .nullable()
    .optional(),
});
export type PlaidWebhookBody = z.infer<typeof PlaidWebhookBody>;

/** What a verified webhook asks of us. */
export type PlaidWebhookAction =
  | { kind: "sync"; itemId: string }
  | { kind: "attention"; itemId: string; code: string }
  | { kind: "ignore" };

// DECISION: transactions webhooks start a sync of the item (SYNC_UPDATES_AVAILABLE, and the older
// DEFAULT_UPDATE / INITIAL_UPDATE / HISTORICAL_UPDATE codes in case an item sends them); an item
// error or a revoked consent puts the connection in `error` so the client can reconnect. Expiry
// warnings and LOGIN_REPAIRED change nothing in v1: the next sync or the reconnect does.
const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "DEFAULT_UPDATE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
]);
const ATTENTION_CODES = new Set(["ERROR", "USER_PERMISSION_REVOKED", "USER_ACCOUNT_REVOKED"]);

export function plaidWebhookAction(body: PlaidWebhookBody): PlaidWebhookAction {
  const itemId = body.item_id;
  if (!itemId) return { kind: "ignore" };
  if (body.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(body.webhook_code)) {
    return { kind: "sync", itemId };
  }
  if (body.webhook_type === "ITEM" && ATTENTION_CODES.has(body.webhook_code)) {
    const code = body.error?.error_code ?? body.webhook_code;
    return { kind: "attention", itemId, code };
  }
  return { kind: "ignore" };
}
