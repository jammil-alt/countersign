import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { CredentialsAccessor } from "../credentials-accessor";

/**
 * The token part of an OAuth connection's credentials. Connectors keep other fields beside it
 * (QBO's realmId), so unknown keys are kept.
 */
export const OAuthTokens = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO time the access token expires. */
  expiresAt: z.iso.datetime({ offset: true }),
  refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  scope: z.string().optional(),
  tokenType: z.string().optional(),
});
export type OAuthTokens = z.infer<typeof OAuthTokens>;

/** A connector's refresh call (the provider's token endpoint). */
export interface TokenRefresher {
  /**
   * Exchanges the refresh token for new tokens. Throws ReconnectRequiredError when the provider
   * says the grant is gone (revoked, expired: `invalid_grant`), so the client must sign in again.
   */
  refresh(tokens: OAuthTokens, opts: { now: Date }): Promise<OAuthTokens>;
}

/** The client has to sign in to the tool again; the platform marks the connection `error`. */
export class ReconnectRequiredError extends Error {
  constructor(message = "the connection needs to be reconnected") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/**
 * The provider's sign-in worked but its grant isn't one we can keep (a permission left unticked,
 * an unverified account). The message is plain words for the person who signed in; the platform
 * shows it as it is and stores nothing.
 */
export class SignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefusedError";
  }
}

/** Refresh this long before expiry, so a token never expires mid-call. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function needsRefresh(tokens: OAuthTokens, now: Date, skewMs = REFRESH_SKEW_MS): boolean {
  return Date.parse(tokens.expiresAt) - skewMs <= now.getTime();
}

export interface TokenManager {
  /** A valid access token, refreshing (and persisting) first when it is about to expire. */
  accessToken(): Promise<string>;
  /** Refreshes now (e.g. after a 401) and persists the result. */
  refresh(): Promise<OAuthTokens>;
  /**
   * Runs `fn` with an access token; if the result says the token was refused (`isUnauthorized`,
   * e.g. HTTP 401), refreshes once and runs it again.
   */
  withAccessToken<T>(
    fn: (accessToken: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean,
  ): Promise<T>;
}

/**
 * The shared refresh helper (ARCHITECTURE §6.2: refresh on 401 or before expiry, and persist the
 * new refresh token every time). Concurrent callers share one refresh, because providers like
 * Intuit rotate refresh tokens and a second refresh with the old one would fail.
 */
export function tokenManager(opts: {
  credentials: CredentialsAccessor;
  refresher: TokenRefresher;
  now?: () => Date;
  skewMs?: number;
}): TokenManager {
  const now = opts.now ?? (() => new Date());
  let inflight: Promise<OAuthTokens> | null = null;

  async function current(): Promise<{ stored: JsonObject; tokens: OAuthTokens }> {
    const stored = await opts.credentials.get();
    if (stored === null) throw new ReconnectRequiredError("the connection has no credentials");
    const parsed = OAuthTokens.safeParse(stored);
    if (!parsed.success) throw new ReconnectRequiredError("the stored tokens are not valid");
    return { stored, tokens: parsed.data };
  }

  function refresh(): Promise<OAuthTokens> {
    inflight ??= (async () => {
      try {
        const { stored, tokens } = await current();
        if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
        const next = OAuthTokens.parse(await opts.refresher.refresh(tokens, { now: now() }));
        // Some providers omit an unchanged refresh token; keep the old one then.
        const merged = { ...stored, ...next } as JsonObject;
        if (next.refreshToken === undefined && tokens.refreshToken !== undefined) {
          merged.refreshToken = tokens.refreshToken;
        }
        await opts.credentials.set(merged);
        return OAuthTokens.parse(merged);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function accessToken(): Promise<string> {
    const { tokens } = await current();
    if (!needsRefresh(tokens, now(), opts.skewMs)) return tokens.accessToken;
    return (await refresh()).accessToken;
  }

  return {
    accessToken,
    refresh,
    async withAccessToken(fn, isUnauthorized) {
      const first = await fn(await accessToken());
      if (!isUnauthorized(first)) return first;
      return fn((await refresh()).accessToken);
    },
  };
}
