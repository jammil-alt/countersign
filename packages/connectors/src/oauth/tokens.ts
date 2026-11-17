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
   * Exchanges the refresh token for new tokens. Throws ReconnectRequiredError only when the
   * provider says the grant is gone (revoked, expired: `invalid_grant`), so the client must sign
   * in again; any other refusal or failure is a TokenRefreshError (`refreshRefused`).
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
 * The provider's token endpoint failed, or refused for a reason that is not a dead grant: our
 * app's keys (`invalid_client`), a provider incident (`server_error`,
 * `temporarily_unavailable`), a rate limit, an answer we couldn't read. The client's sign-in is
 * still good, so the connection is left as it is: the call fails like any other transient error
 * (the step's retry, the next sync). Nothing was sent to the provider's API, so nothing was
 * written (`notWritten`).
 */
export class TokenRefreshError extends Error {
  readonly notWritten = true;
  readonly retryable = true;
  constructor(
    /** The provider's error code (`invalid_client`), or `HTTP_<status>`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

/** OAuth's code for a refresh token that is revoked, expired or already spent (RFC 6749 §5.2). */
export const DEAD_GRANT_CODES: readonly string[] = ["invalid_grant"];

/**
 * A refused refresh as the error to throw: ReconnectRequiredError only when the provider's code
 * says the grant itself is dead (`deadCodes`: `invalid_grant`, plus a provider's own word for it);
 * anything else is a TokenRefreshError, which leaves the connection connected.
 */
// DECISION: only the codes that mean the refresh token is dead disconnect a client. A wrong or
// rotated client secret, or a provider incident that answers OAuth errors, would otherwise mark
// every client's connection `error`, and only a fresh sign-in by each client sets it back.
export function refreshRefused(
  provider: string,
  error: unknown,
  deadCodes: readonly string[] = DEAD_GRANT_CODES,
): ReconnectRequiredError | TokenRefreshError {
  // The provider's code goes into messages and logs: a short token only.
  const code =
    typeof error === "string" && /^[A-Za-z0-9_. -]{1,64}$/.test(error) ? error : "unknown_error";
  return deadCodes.includes(code)
    ? new ReconnectRequiredError(`${provider} refused the refresh: ${code}`)
    : new TokenRefreshError(code, `${provider}'s token endpoint refused the refresh: ${code}`);
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

/**
 * After a refused refresh, the stored tokens are read again after these waits, in case another
 * isolate's refresh is still saving (a refresh call and a save take well under a second).
 */
const REREAD_WAITS_MS = [100, 300, 600];

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const st = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown })
      .setTimeout;
    st(resolve, ms);
  });

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
 *
 * Across isolates (docs/enterprise-readiness.md E1): a refresh starts from the stored tokens read
 * afresh, not the accessor's cache; the new tokens are saved only if the stored refresh token is
 * still the one the refresh started from (compare-and-swap, `CredentialsAccessor.update`), else
 * the other isolate's newer tokens are used; and a refused refresh (`invalid_grant`) whose token
 * another isolate has since replaced carries on with the stored tokens instead of disconnecting.
 */
// DECISION: compare-and-swap rather than a lock (no new infrastructure): the window that remains
// is two isolates both spending the same refresh token at the provider at the same moment, and
// with a provider that refuses a spent token the loser then finds the winner's tokens stored.
export function tokenManager(opts: {
  credentials: CredentialsAccessor;
  refresher: TokenRefresher;
  now?: () => Date;
  skewMs?: number;
  /** Waits between re-reads after a refused refresh (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
}): TokenManager {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  let inflight: Promise<OAuthTokens> | null = null;

  function parse(stored: JsonObject | null): { stored: JsonObject; tokens: OAuthTokens } {
    if (stored === null) throw new ReconnectRequiredError("the connection has no credentials");
    const parsed = OAuthTokens.safeParse(stored);
    if (!parsed.success) throw new ReconnectRequiredError("the stored tokens are not valid");
    return { stored, tokens: parsed.data };
  }

  async function current(): Promise<{ stored: JsonObject; tokens: OAuthTokens }> {
    return parse(await opts.credentials.get());
  }

  /** The stored tokens read again, past the accessor's cache (another isolate may have written). */
  async function latest(): Promise<{ stored: JsonObject; tokens: OAuthTokens }> {
    const update = opts.credentials.update?.bind(opts.credentials);
    return parse(update ? await update(() => null) : await opts.credentials.get());
  }

  /** Saves the refresh's answer unless the stored refresh token moved on; what is stored after. */
  async function save(startedFrom: string, next: OAuthTokens): Promise<OAuthTokens> {
    const merge = (stored: JsonObject): JsonObject => {
      const merged = { ...stored, ...next } as JsonObject;
      // Some providers omit an unchanged refresh token; keep the old one then.
      if (next.refreshToken === undefined) merged.refreshToken = startedFrom;
      return merged;
    };
    const update = opts.credentials.update?.bind(opts.credentials);
    if (!update) {
      const { stored } = await current();
      const merged = merge(stored);
      await opts.credentials.set(merged);
      return OAuthTokens.parse(merged);
    }
    const after = await update((stored) => {
      const s = OAuthTokens.safeParse(stored);
      // Another isolate refreshed (or the connection was signed out) meanwhile: keep what's stored.
      if (stored === null || !s.success || s.data.refreshToken !== startedFrom) return null;
      return merge(stored);
    });
    return parse(after).tokens;
  }

  /** The stored tokens once their refresh token is no longer `spent`, or null if it stays. */
  async function rotatedSince(spent: string): Promise<OAuthTokens | null> {
    // Without `update` the accessor can only give its cached copy: one look is enough.
    const waits = opts.credentials.update ? [0, ...REREAD_WAITS_MS] : [0];
    for (const wait of waits) {
      if (wait > 0) await sleep(wait);
      const { tokens } = await latest();
      if (tokens.refreshToken && tokens.refreshToken !== spent) return tokens;
    }
    return null;
  }

  function refresh(): Promise<OAuthTokens> {
    inflight ??= (async () => {
      try {
        const cached = (await current()).tokens;
        let { tokens } = await latest();
        // Another isolate refreshed since this one read the tokens: use its fresh ones.
        if (
          tokens.accessToken !== cached.accessToken &&
          !needsRefresh(tokens, now(), opts.skewMs)
        ) {
          return tokens;
        }
        for (let attempt = 0; ; attempt++) {
          const startedFrom = tokens.refreshToken;
          if (!startedFrom) throw new ReconnectRequiredError("no refresh token");
          let next: OAuthTokens;
          try {
            next = OAuthTokens.parse(await opts.refresher.refresh(tokens, { now: now() }));
          } catch (error) {
            if (!(error instanceof ReconnectRequiredError) || attempt > 0) throw error;
            // Refused: if another isolate rotated the refresh token meanwhile, the grant is alive
            // and its tokens are stored (or are about to be: the provider may refuse us before
            // the other isolate has saved its answer). Only a refusal of the stored token, still
            // stored after a short wait, is a dead grant.
            const stored = await rotatedSince(startedFrom);
            if (!stored) throw error;
            if (!needsRefresh(stored, now(), opts.skewMs)) return stored;
            tokens = stored;
            continue;
          }
          return await save(startedFrom, next);
        }
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
