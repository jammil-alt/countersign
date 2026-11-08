import { z } from "zod";
import {
  fromBase64Url,
  fromUtf8,
  hmacKey,
  randomBytes,
  subtle,
  toBase64Url,
  utf8,
} from "../runtime";

/**
 * The OAuth `state` parameter: signed (HMAC-SHA256), bound to the client, the connector and the
 * user who started the sign-in, and short-lived. The callback runs in that user's session and
 * checks all three, so a callback can't be replayed into another client, connector or user (the
 * classic login-CSRF swap), and a stale link stops working.
 */
// DECISION: a stateless signed token, not a stored row: nothing to clean up, and the binding to the
// session user already blocks CSRF. The nonce is returned so a caller can also make it single-use.
/**
 * Where the sign-in started: the client portal, or the back office (the operator signing in to a
 * tool of the Sandbox client, docs/plan.md §1.5). The callback forwards and checks on it.
 */
export type OAuthOrigin = "portal" | "ops";

export interface OAuthStateClaims {
  tenantId: string;
  connector: string;
  userId: string;
  origin: OAuthOrigin;
  /** Random, base64url. */
  nonce: string;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
  /**
   * B-5 (docs/plan.md §1.79): for a connector a client may connect several times (a second bank),
   * which connection this sign-in is for: `new` for another, or the id of the one signed in again.
   * Absent: the client's one connection, as before.
   */
  target?: string;
}

const Payload = z.object({
  v: z.literal(1),
  t: z.string().min(1),
  c: z.string().min(1),
  u: z.string().min(1),
  n: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  /** Set only for the back office; a portal state has no `o`, as before. */
  o: z.literal("ops").optional(),
  /** B-5: `new`, or a connection id; absent as before. */
  x: z
    .string()
    .regex(/^(new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)
    .optional(),
});

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Tolerated clock difference between the Worker that signed and the one that verifies. */
const CLOCK_SKEW_S = 60;
const LABEL = "countersign/oauth-state/v1.";

export interface StateKeyOptions {
  /** At least 32 bytes of secret (a Worker secret, never shared with any other app). */
  secret: string | Uint8Array;
  now?: Date;
}

async function key(secret: string | Uint8Array) {
  const raw = typeof secret === "string" ? utf8(secret) : secret;
  if (raw.length < 32) throw new Error("the OAuth state secret must be at least 32 bytes");
  return hmacKey(raw);
}

export interface OAuthStateBinding {
  tenantId: string;
  connector: string;
  userId: string;
  /** Default `portal`. */
  origin?: OAuthOrigin;
  /** B-5: which connection a multi-connection sign-in is for (`new` or an id). */
  target?: string;
}

// DECISION: the origin is an optional `o: "ops"` in the same v1 payload, so a portal state is
// byte-for-byte the shape it was, and a portal sign-in in flight across a deploy still verifies.
export async function createOAuthState(
  binding: OAuthStateBinding,
  opts: StateKeyOptions & { ttlMs?: number },
): Promise<{ state: string; claims: OAuthStateClaims }> {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const ttl = Math.ceil((opts.ttlMs ?? OAUTH_STATE_TTL_MS) / 1000);
  const claims: OAuthStateClaims = {
    tenantId: binding.tenantId,
    connector: binding.connector,
    userId: binding.userId,
    origin: binding.origin ?? "portal",
    nonce: toBase64Url(randomBytes(16)),
    issuedAt: now,
    expiresAt: now + ttl,
    ...(binding.target ? { target: binding.target } : {}),
  };
  const payload = toBase64Url(
    utf8(
      JSON.stringify({
        v: 1,
        t: claims.tenantId,
        c: claims.connector,
        u: claims.userId,
        n: claims.nonce,
        iat: claims.issuedAt,
        exp: claims.expiresAt,
        ...(claims.origin === "ops" ? { o: "ops" } : {}),
        ...(claims.target ? { x: claims.target } : {}),
      }),
    ),
  );
  const sig = await subtle().sign("HMAC", await key(opts.secret), utf8(LABEL + payload));
  return { state: `${payload}.${toBase64Url(new Uint8Array(sig))}`, claims };
}

export type OAuthStateFailure = "malformed" | "signature" | "expired" | "mismatch";

export type OAuthStateResult =
  | { ok: true; claims: OAuthStateClaims }
  | { ok: false; reason: OAuthStateFailure };

/**
 * Reads a state without a session to check it against: the signature first (nothing in an unsigned
 * payload is trusted), then the payload, then expiry. The callback forwarder uses it to tell a
 * back-office sign-in from a portal one; the callback routes use `verifyOAuthState`.
 */
export async function readOAuthState(
  state: string,
  opts: StateKeyOptions,
): Promise<OAuthStateResult> {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig);
    fromBase64Url(payload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await subtle().verify(
    "HMAC",
    await key(opts.secret),
    sigBytes,
    utf8(LABEL + payload),
  );
  if (!valid) return { ok: false, reason: "signature" };

  let parsed: z.infer<typeof Payload>;
  try {
    const result = Payload.safeParse(JSON.parse(fromUtf8(fromBase64Url(payload))));
    if (!result.success) return { ok: false, reason: "malformed" };
    parsed = result.data;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (now >= parsed.exp || parsed.iat > now + CLOCK_SKEW_S) return { ok: false, reason: "expired" };
  return {
    ok: true,
    claims: {
      tenantId: parsed.t,
      connector: parsed.c,
      userId: parsed.u,
      origin: parsed.o ?? "portal",
      nonce: parsed.n,
      issuedAt: parsed.iat,
      expiresAt: parsed.exp,
      ...(parsed.x ? { target: parsed.x } : {}),
    },
  };
}

/**
 * Checks the signature first (nothing in an unsigned payload is trusted), then expiry, then that
 * the state belongs to this client, connector, user and origin (default the portal), so a state
 * started in the back office never completes in the portal, nor the other way round.
 */
export async function verifyOAuthState(
  state: string,
  expected: OAuthStateBinding,
  opts: StateKeyOptions,
): Promise<OAuthStateResult> {
  const read = await readOAuthState(state, opts);
  if (!read.ok) return read;
  const { claims } = read;
  if (
    claims.tenantId !== expected.tenantId ||
    claims.connector !== expected.connector ||
    claims.userId !== expected.userId ||
    claims.origin !== (expected.origin ?? "portal")
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return read;
}
