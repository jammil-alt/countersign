// The Teams bot's two kinds of token (Bot Connector authentication, NOTES.md):
// - Outbound, as the bot itself: an OAuth 2.0 client-credentials token from Microsoft Entra ID for
//   the Bot Connector (`https://api.botframework.com/.default`), from the bot's own Entra tenant
//   (a single-tenant bot), kept until a minute before it expires. It is sent only to a service URL
//   on Teams' allow-listed hosts (`isAllowedServiceUrl`), never to a URL just because an activity
//   named it. No per-client user tokens exist.
// - Inbound, from the Bot Connector: each activity carries `Authorization: Bearer <JWT>` signed
//   with a key from the Bot Connector's OpenID metadata (`login.botframework.com`); its issuer is
//   `https://api.botframework.com`, its audience our app id, and its `serviceUrl` claim must be
//   the activity's own. Keys are cached (24 hours at most) and refetched for an unknown key at
//   most once a minute.
// The app secret never leaves this module's closure: not logged, not returned, not in an error.

import { z } from "zod";
import { type FetchLike, formEncode, parseUrl, timeoutSignal } from "../http";
import { type DecodedJwt, decodeJwt, importRsaJwk, type RsaKey, verifyRs256 } from "./jwt";

/** The Bot Connector's scope for a client-credentials token. */
export const BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default";
/** Who issues the Bot Connector's tokens to a bot. */
export const BOT_CONNECTOR_ISSUER = "https://api.botframework.com";
/** The Bot Connector's OpenID metadata (a static URL, Microsoft says to hard-code it). */
export const BOT_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
/** The only host the signing keys' document may be fetched from. */
const BOT_KEYS_HOST = "login.botframework.com";
/** Microsoft Entra ID's sign-in host (public cloud). */
export const ENTRA_LOGIN_ORIGIN = "https://login.microsoftonline.com";
/** The Bot Framework's channel id for Microsoft Teams. */
export const TEAMS_CHANNEL_ID = "msteams";

/** The token endpoint of the bot's own Entra tenant (a single-tenant bot). */
export function botTokenUrl(tenantId: string): string {
  return `${ENTRA_LOGIN_ORIGIN}/${tenantId}/oauth2/v2.0/token`;
}

/** An Entra id (app, tenant): a GUID, any case. */
export function isGuid(value: string | undefined | null): value is string {
  if (value?.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const ch = value[i] as string;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (ch !== "-") return false;
      continue;
    }
    const hex = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
    if (!hex) return false;
  }
  return true;
}

// --- Service URLs -------------------------------------------------------------------------------

// DECISION: only Teams' public cloud (`smba.trafficmanager.net`, every regional path under it).
// GCC (`smba.infra.gcc.teams.microsoft.com`) is left out until a client needs it, and GCC High
// and DoD can't be reached at all: they sign in at other Entra and Bot Framework hosts. Adding GCC
// is one host here once checked (NOTES.md).
export const TEAMS_SERVICE_HOSTS: readonly string[] = ["smba.trafficmanager.net"];
const SERVICE_HOSTS = new Set(TEAMS_SERVICE_HOSTS);

/**
 * A service URL the bot's token may be sent to: https on port 443, no user or password, no query
 * or fragment, and a host on the allow-list exactly (no subdomain, no look-alike); null otherwise.
 * Returned without its trailing slashes, so `${base}/v3/…` is the path.
 */
export function allowedServiceUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 300 || raw.includes("?") || raw.includes("#")) return null;
  if (raw.includes("\\") || raw.includes("%")) return null;
  const u = parseUrl(raw);
  if (u?.protocol !== "https:" || u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  if (!SERVICE_HOSTS.has(u.hostname.toLowerCase())) return null;
  let path = u.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  // Regional paths are letters, digits, `-`, `.` and `/` (`/teams`, `/amer`, `/amer-client-ss.msg`).
  for (const ch of path) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "." ||
      ch === "/" ||
      ch === "_";
    if (!ok) return null;
  }
  if (path.includes("..") || path.includes("//")) return null;
  return `https://${u.hostname.toLowerCase()}${path}`;
}

export function isAllowedServiceUrl(raw: string | null | undefined): boolean {
  return allowedServiceUrl(raw) !== null;
}

// --- Outbound: the bot's token ------------------------------------------------------------------

export class TeamsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsAuthError";
  }
}

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1).max(8192),
  expires_in: z.number().int().positive(),
});

/** Seconds left on a token when we stop using it. */
const TOKEN_MARGIN_S = 60;

export interface BotIdentity {
  appId: string;
  appSecret: string;
  /** The Entra tenant the bot's app registration lives in. */
  tenantId: string;
}

/** The bot's access token for the Bot Connector, cached until shortly before it expires. */
// DECISION: a single-tenant bot, so the token comes from the bot's own tenant
// (`login.microsoftonline.com/{TEAMS_BOT_TENANT_ID}`), not `botframework.com`: Azure stopped
// creating multi-tenant bots after 31 July 2025. Whether it may post in other tenants' Teams is the
// first thing to check (NOTES.md).
export class BotTokens {
  private cached: { token: string; until: number } | null = null;
  private loading: Promise<string> | null = null;

  constructor(
    private readonly bot: BotIdentity,
    private readonly fetch: () => FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Forget the cached token (the Bot Connector refused it). */
  drop(): void {
    this.cached = null;
  }

  async get(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.until > nowMs) return this.cached.token;
    this.loading ??= this.fetchToken().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetchToken(): Promise<string> {
    const nowMs = this.now().getTime();
    const res = await this.fetch()(botTokenUrl(this.bot.tenantId), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode({
        grant_type: "client_credentials",
        client_id: this.bot.appId,
        client_secret: this.bot.appSecret,
        scope: BOT_CONNECTOR_SCOPE,
      }),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const text = await res.text();
    let body: unknown = null;
    if (text.length <= 64 * 1024) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const answer = TokenAnswer.safeParse(body);
    if (!res.ok || !answer.success) {
      // Entra's error code only (e.g. invalid_client): never the secret or the description.
      const code = (body as { error?: unknown } | null)?.error;
      throw new TeamsAuthError(
        `Microsoft refused the Teams bot's sign-in (${res.status}${typeof code === "string" ? `, ${code.slice(0, 60)}` : ""})`,
      );
    }
    const life = Math.max(0, answer.data.expires_in - TOKEN_MARGIN_S);
    this.cached = { token: answer.data.access_token, until: nowMs + life * 1000 };
    return answer.data.access_token;
  }
}

// --- Inbound: the Bot Connector's bearer token --------------------------------------------------

/** Why a request was refused (for tests and the operator's logs; never sent to the caller). */
export type BotTokenRefusal =
  | "missing"
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "service_url"
  | "endorsement";

export type BotTokenCheck =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: BotTokenRefusal };

/** Clock skew allowed on `exp` and `nbf`: Microsoft's "industry-standard" five minutes. */
const SKEW_S = 300;
/** At most this many published keys are kept. */
const MAX_KEYS = 30;
/** The metadata and keys documents are a few KB; anything far larger is not Microsoft's. */
const MAX_DOC_BYTES = 128 * 1024;
/** How long keys are kept: Microsoft asks for a refresh at least once every 24 hours. */
const MAX_KEYS_TTL_S = 24 * 3600;
/** An unknown key id refetches the keys at most this often. */
const REFETCH_MIN_MS = 60_000;

const OpenIdMetadata = z.looseObject({
  issuer: z.string().max(200).optional(),
  jwks_uri: z.string().max(500),
});

const Jwk = z.looseObject({
  kty: z.string().max(10),
  kid: z.string().min(1).max(200),
  n: z.string().max(2000).optional(),
  e: z.string().max(20).optional(),
  use: z.string().max(20).optional(),
  endorsements: z.array(z.string().max(100)).max(100).optional(),
});
const Jwks = z.looseObject({ keys: z.array(z.unknown()).max(200) });

interface SigningKey {
  key: RsaKey;
  /** The channels (`msteams`, …) this key is endorsed for. */
  endorsements: ReadonlySet<string>;
}

/** `max-age=N` from a Cache-Control header, by hand; null when absent. */
function maxAgeOf(cacheControl: string | null): number | null {
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

async function readJson(
  res: { ok: boolean; status: number; text(): Promise<string> },
  what: string,
): Promise<unknown> {
  if (!res.ok) throw new TeamsAuthError(`${what} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOC_BYTES) throw new TeamsAuthError(`${what} is too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new TeamsAuthError(`${what} is not JSON`);
  }
}

/** The Bot Connector's signing keys, by key id, fetched on demand and cached. */
export class BotSigningKeys {
  private keys = new Map<string, SigningKey>();
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
    const get = (url: string) =>
      this.fetch()(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: timeoutSignal(10_000),
      });
    const meta = OpenIdMetadata.safeParse(
      await readJson(await get(BOT_OPENID_URL), "the Bot Connector's OpenID metadata"),
    );
    if (!meta.success) throw new TeamsAuthError("the Bot Connector's metadata has no keys URL");
    // DECISION: the keys are fetched only from login.botframework.com over https, whatever the
    // metadata says, so a tampered or misrouted metadata answer can't point us at other keys.
    const jwksUrl = parseUrl(meta.data.jwks_uri);
    if (
      jwksUrl?.protocol !== "https:" ||
      jwksUrl.hostname !== BOT_KEYS_HOST ||
      jwksUrl.port !== "" ||
      jwksUrl.username !== "" ||
      jwksUrl.password !== ""
    ) {
      throw new TeamsAuthError("the Bot Connector's keys URL is not on login.botframework.com");
    }
    const res = await get(meta.data.jwks_uri);
    const doc = Jwks.safeParse(await readJson(res, "the Bot Connector's keys"));
    if (!doc.success) throw new TeamsAuthError("the Bot Connector's keys have an unexpected shape");
    const next = new Map<string, SigningKey>();
    for (const raw of doc.data.keys) {
      if (next.size >= MAX_KEYS) break;
      const k = Jwk.safeParse(raw);
      if (!k.success || k.data.kty !== "RSA" || !k.data.n || !k.data.e) continue;
      if (k.data.use && k.data.use !== "sig") continue;
      const key = await importRsaJwk({ kty: "RSA", n: k.data.n, e: k.data.e });
      if (key) next.set(k.data.kid, { key, endorsements: new Set(k.data.endorsements ?? []) });
    }
    const ttl = Math.min(
      maxAgeOf(res.headers.get("cache-control")) ?? MAX_KEYS_TTL_S,
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
  async get(kid: string): Promise<SigningKey | null> {
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
export function bearerToken(header: string | null | undefined): string | null {
  if (!header || header.length > 16_384) return null;
  const sp = header.indexOf(" ");
  if (sp < 0 || header.slice(0, sp).toLowerCase() !== "bearer") return null;
  const token = header.slice(sp + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the Bot Connector's bearer token on an activity: RS256 by a published key (endorsed
 * for the activity's channel), `iss` exactly the Bot Connector, `aud` exactly our app id, within
 * its validity (five minutes' skew), and a `serviceUrl` claim equal to the activity's own.
 */
export async function verifyBotToken(
  token: string | null,
  opts: {
    appId: string;
    keys: BotSigningKeys;
    now: Date;
    /** The activity's `serviceUrl` and `channelId`, read from the body. */
    serviceUrl: string | null;
    channelId: string | null;
  },
): Promise<BotTokenCheck> {
  if (!token) return { ok: false, reason: "missing" };
  const jwt: DecodedJwt | null = decodeJwt(token);
  if (!jwt) return { ok: false, reason: "malformed" };
  if (jwt.header.alg !== "RS256") return { ok: false, reason: "algorithm" };
  const kid = jwt.header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 200) {
    return { ok: false, reason: "unknown_key" };
  }
  let signing: SigningKey | null;
  try {
    signing = await opts.keys.get(kid);
  } catch {
    // The keys unreachable: nothing can be verified, so nothing is accepted.
    return { ok: false, reason: "unknown_key" };
  }
  if (!signing) return { ok: false, reason: "unknown_key" };
  if (!(await verifyRs256(signing.key, jwt))) return { ok: false, reason: "signature" };
  const c = jwt.claims;
  if (c.iss !== BOT_CONNECTOR_ISSUER) return { ok: false, reason: "issuer" };
  // DECISION: `aud` must be exactly the app id; an array, or the id with a scheme, is refused.
  if (c.aud !== opts.appId) return { ok: false, reason: "audience" };
  const nowS = opts.now.getTime() / 1000;
  if (typeof c.exp !== "number" || c.exp + SKEW_S < nowS) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf - SKEW_S > nowS) return { ok: false, reason: "expired" };
  if (typeof c.serviceUrl !== "string" || c.serviceUrl !== opts.serviceUrl) {
    return { ok: false, reason: "service_url" };
  }
  // DECISION: the signing key must be endorsed for the activity's channel (`msteams`), which
  // Microsoft describes as configurable per bot and on by default for published channels.
  if (!opts.channelId || !signing.endorsements.has(opts.channelId)) {
    return { ok: false, reason: "endorsement" };
  }
  return { ok: true, claims: c };
}
