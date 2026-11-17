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
 * (the step's retry, the next sync). The message is plain words (a run's error can reach the
 * client's portal); the provider's code is in `code`, for the logs.
 */
export class TokenRefreshError extends Error {
  /**
   * Nothing was written: true unless this tool call had already reached the provider before the
   * refresh failed (tokenManager sets it, see `reachedProvider`).
   */
  notWritten = true;
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

/** How long a connection's access may keep failing to renew before it is raised for a person. */
export const ACCESS_FAILING_ATTENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Access to the tool has failed to renew for `ACCESS_FAILING_ATTENTION_MS` without a break (the
 * token endpoint's errors, or the provider refusing a token it has just renewed): the connection
 * needs a person (reason `refresh_failing`, not `signin_expired`). A ReconnectRequiredError, so
 * every caller that raises a connection for a person raises this one too.
 */
// DECISION: kept a ReconnectRequiredError subclass, and `refresh_failing` is special-cased where
// it lands: `dbConnectionAttention` keeps the connection `connected` (no `error`, so syncs go on
// and no "sign in again" email), and every caller's words check `attentionReasonOf` first.
export class AccessFailingError extends ReconnectRequiredError {
  readonly attentionReason = "refresh_failing" as const;
  notWritten = true;
  constructor(
    /** When the failures started (ISO). */
    readonly since: string,
    /** The latest failure's code, for the logs. */
    readonly code: string,
  ) {
    super("we haven't been able to renew our access to this tool for a day; we're looking at it");
    this.name = "AccessFailingError";
  }
}

/** Why a connection needs a person, from the error a connector threw (`signin_expired` else). */
export function attentionReasonOf(error: unknown): "signin_expired" | "refresh_failing" {
  return (error as { attentionReason?: unknown } | null)?.attentionReason === "refresh_failing"
    ? "refresh_failing"
    : "signin_expired";
}

/** OAuth's code for a refresh token that is revoked, expired or already spent (RFC 6749 §5.2). */
export const DEAD_GRANT_CODES: readonly string[] = ["invalid_grant"];

/**
 * Codes that are ours or the provider's to fix, never the client's: our app's keys, a grant type
 * or request we got wrong, a provider incident, a rate limit. Never a reason to disconnect.
 */
export const NOT_THE_CLIENTS_CODES: readonly string[] = [
  "invalid_client",
  "unauthorized_client",
  // A refresh request we built wrong (a bad deploy), never the client's grant. A provider that
  // uses one of these for a dead grant names it in its `deadCodes` (LinkedIn: invalid_request).
  "invalid_request",
  "invalid_scope",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
  // HubSpot's words for our app's keys and grant type.
  "BAD_CLIENT_ID",
  "BAD_CLIENT_SECRET",
  "BAD_GRANT_TYPE",
  // Ramp's API codes for a rate limit and its own trouble.
  "RATE_LIMITED",
  "INTERNAL_SERVER_ERROR",
];

/**
 * A refused refresh as the error to throw: ReconnectRequiredError when the provider's code says
 * the grant itself is dead (`deadCodes`: `invalid_grant`, plus a provider's own word for it), a
 * TokenRefreshError (the connection stays connected) for a code that is ours or the provider's
 * (`NOT_THE_CLIENTS_CODES`). Any other code, or none we can read, follows `otherwise`: `retry`
 * for providers whose token errors we know, `reconnect` where their shape is unchecked and a
 * 400 or 401 was all we had before.
 */
// DECISION: only the codes that mean the refresh token is dead disconnect a client. A wrong or
// rotated client secret, or a provider incident that answers OAuth errors, would otherwise mark
// every client's connection `error`, and only a fresh sign-in by each client sets it back.
// `otherwise: "reconnect"` (HubSpot, Ramp, Podio: unchecked token errors) keeps how those three
// treated any 400/401 before. Now that a lasting failure is raised after a day without setting
// `error` (AccessFailingError, `refresh_failing`), they could move to `retry` once their real
// token errors are seen.
export function refreshRefused(
  provider: string,
  error: unknown,
  deadCodes: readonly string[] = DEAD_GRANT_CODES,
  otherwise: "retry" | "reconnect" = "retry",
): ReconnectRequiredError | TokenRefreshError {
  // The provider's code goes into logs only: a short token.
  const code =
    typeof error === "string" && /^[A-Za-z0-9_. -]{1,64}$/.test(error) ? error : "unknown_error";
  const dead =
    deadCodes.includes(code) ||
    (otherwise === "reconnect" && !NOT_THE_CLIENTS_CODES.includes(code));
  return dead
    ? Object.assign(new ReconnectRequiredError(`${provider} ended our access; connect it again`), {
        code,
      })
    : new TokenRefreshError(
        code,
        `${provider} didn't renew our access just now; we'll keep trying`,
      );
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

/**
 * Per credentials accessor (one tool call or sync step on one connection): whether a call has
 * reached the provider, so a refresh that fails after it no longer says nothing was written.
 */
const reached = new WeakMap<CredentialsAccessor, true>();

/**
 * Whether a call that may write has reached the provider with these credentials (an answer other
 * than 401, or none at all).
 */
export function reachedProvider(credentials: CredentialsAccessor): boolean {
  return reached.has(credentials);
}

/** Fields kept with the tokens while renewing access keeps failing (cleared once a call works). */
const FAILING_SINCE = "accessFailingSince";
const FAILING_LAST = "accessFailingLast";
const FAILING_CODE = "accessFailingCode";

/**
 * Failures further apart than this are not one run of failures: the next one starts the clock
 * again (a blip a week after another, with no calls between, is not a day of failing).
 */
export const ACCESS_FAILING_BREAK_MS = 6 * 60 * 60 * 1000;

export interface TokenManager {
  /** A valid access token, refreshing (and persisting) first when it is about to expire. */
  accessToken(): Promise<string>;
  /** Refreshes now (e.g. after a 401) and persists the result. */
  refresh(): Promise<OAuthTokens>;
  /**
   * For a caller that makes its own calls with `accessToken()`: a call went through, so a record
   * of failing access is cleared.
   */
  worked(): Promise<void>;
  /**
   * Runs `fn` with an access token; if the result says the token was refused (`isUnauthorized`,
   * e.g. HTTP 401), refreshes once and runs it again. A result the provider took clears a record
   * of failing access; one refused again right after a refresh adds to it.
   */
  withAccessToken<T>(
    fn: (accessToken: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean,
    /**
     * `write: false` for a call that changes nothing (a GET): it doesn't count as having reached
     * the provider, so a refresh failing later in the same tool call still says nothing was
     * written. Unsaid, a call counts as a possible write.
     */
    call?: { write?: boolean },
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

  /**
   * Access failed without a dead grant (`error`: the refresh's, or a token refused right after a
   * refresh): records since when, once, with the tokens, and gives the error to throw, an
   * AccessFailingError once it has gone on for `ACCESS_FAILING_ATTENTION_MS`. Best effort: a
   * failure to record leaves the error as it was.
   */
  // DECISION: the start and the latest of the failures are kept with the connection's own
  // encrypted credentials (no new column); a fresh sign-in replaces them, a call the provider
  // takes clears them (`working`), and a gap over `ACCESS_FAILING_BREAK_MS` starts a new run.
  async function failing(error: unknown): Promise<unknown> {
    const code =
      (error as { code?: unknown } | null)?.code ?? (error as Error | null)?.name ?? "error";
    const label = typeof code === "string" ? code.slice(0, 64) : "error";
    let out: unknown = error;
    const update = opts.credentials.update?.bind(opts.credentials);
    if (update) {
      try {
        const at = now();
        const after = await update((stored) => {
          if (stored === null) return null;
          const since = stored[FAILING_SINCE];
          const last = stored[FAILING_LAST] ?? since;
          const unbroken =
            typeof since === "string" &&
            typeof last === "string" &&
            at.getTime() - Date.parse(last) <= ACCESS_FAILING_BREAK_MS;
          return {
            ...stored,
            [FAILING_SINCE]: unbroken ? since : at.toISOString(),
            [FAILING_LAST]: at.toISOString(),
            [FAILING_CODE]: label,
          };
        });
        const since = after?.[FAILING_SINCE];
        if (
          typeof since === "string" &&
          now().getTime() - Date.parse(since) >= ACCESS_FAILING_ATTENTION_MS
        ) {
          out = new AccessFailingError(since, label);
        }
      } catch {
        // Recording is best effort; the call fails with its own error.
      }
    }
    if (out instanceof TokenRefreshError || out instanceof AccessFailingError) {
      out.notWritten = !reachedProvider(opts.credentials);
    }
    return out;
  }

  /** A call the provider took: access works, so a record of failing access is cleared. */
  async function working(): Promise<void> {
    const update = opts.credentials.update?.bind(opts.credentials);
    const cached = await opts.credentials.get().catch(() => null);
    if (!update || !cached || cached[FAILING_SINCE] === undefined) return;
    const cleared = await update((stored) => {
      if (!stored || stored[FAILING_SINCE] === undefined) return null;
      const {
        [FAILING_SINCE]: _since,
        [FAILING_LAST]: _last,
        [FAILING_CODE]: _code,
        ...rest
      } = stored;
      return rest as JsonObject;
    })
      .then(() => true)
      .catch(() => false);
    // An issue raised for it (`refresh_failing`) closes; best effort.
    if (cleared) await opts.credentials.accessRestored?.().catch(() => undefined);
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
            if (!(error instanceof ReconnectRequiredError)) throw await failing(error);
            if (attempt > 0) throw error;
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
    async worked() {
      await working();
    },
    async withAccessToken(fn, isUnauthorized, kind) {
      const mayWrite = kind?.write !== false;
      const call = async (token: string) => {
        let result: Awaited<ReturnType<typeof fn>>;
        try {
          result = await fn(token);
        } catch (error) {
          // No answer (a timeout, a dropped connection): the request may have reached it.
          if (mayWrite) reached.set(opts.credentials, true);
          throw error;
        }
        if (mayWrite && !isUnauthorized(result)) reached.set(opts.credentials, true);
        return result;
      };
      const first = await call(await accessToken());
      if (!isUnauthorized(first)) {
        await working();
        return first;
      }
      const second = await call((await refresh()).accessToken);
      if (!isUnauthorized(second)) {
        await working();
        return second;
      }
      // Refused right after a refresh that worked: not a dead grant, but if it lasts a person
      // should look (the caller fails this call with its own retryable error).
      const raised = await failing(
        Object.assign(new Error("refused_after_refresh"), {
          code: "refused_after_refresh",
        }),
      );
      if (raised instanceof AccessFailingError) throw raised;
      return second;
    },
  };
}
