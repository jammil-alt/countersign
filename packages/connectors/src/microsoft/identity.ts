// Shared sign-in for the Microsoft connectors (`outlook`, `onedrive`, `excel`, `outlook_calendar`;
// docs/plan.md §1.97): the Microsoft identity platform's authorization code flow on the `common`
// endpoint (work and school accounts and personal Microsoft accounts), the token answer, the
// signed-in address from the ID token, the check that a grant carries exactly the scopes a
// connector asks for, rotating refresh tokens, and Graph calls that refresh once after a 401.
// Each connector has its own Entra app (its own client id and secret): Microsoft keeps consent per
// app and account and puts every consented Graph scope in a grant, so one shared app would let an
// Outlook grant carry Excel's file access. Unchecked facts about Microsoft: ../outlook/NOTES.md and
// each connector's own NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { ConnectionContext } from "../connector";
import {
  type FetchLike,
  formEncode,
  globalFetch,
  type HttpResponseLike,
  parseUrl,
  timeoutSignal,
} from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { fromBase64Url, fromUtf8 } from "../runtime";

export const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
// DECISION: the `common` endpoint, so work and school accounts (Microsoft 365) and personal
// Outlook.com accounts can both connect; each app registration must allow both (NOTES.md).
export const MICROSOFT_AUTHORITY = `${MICROSOFT_LOGIN_ORIGIN}/common/oauth2/v2.0`;
export const MICROSOFT_AUTH_URL = `${MICROSOFT_AUTHORITY}/authorize`;
export const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`;
export const MICROSOFT_GRAPH_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_API = `${MICROSOFT_GRAPH_ORIGIN}/v1.0`;
const GRAPH_PREFIX = `${MICROSOFT_GRAPH_ORIGIN}/`;

/** OpenID Connect's sign-in scopes: the address (ID token) and a refresh token. */
export const MICROSOFT_SIGN_IN_SCOPES: readonly string[] = ["openid", "email", "offline_access"];

/** A Graph scope in the full form Microsoft's authorize endpoint takes (`Mail.Send` → URL). */
export function graphScope(name: string): string {
  return `${GRAPH_PREFIX}${name}`;
}

/** A scope as we compare it: lower case, without Graph's URL prefix. */
export function shortScope(scope: string): string {
  const s = scope.trim().toLowerCase();
  return s.startsWith(GRAPH_PREFIX) ? s.slice(GRAPH_PREFIX.length) : s;
}

/** The scopes a grant may carry beside a connector's own: OpenID's, `profile` and `User.Read`. */
// DECISION: Microsoft adds `User.Read` to new app registrations and grants every scope the person
// consented to for the app, so it is allowed; nothing else is (plan §1.52, §1.97).
const ALWAYS_ALLOWED = new Set(["openid", "email", "profile", "offline_access", "user.read"]);

export const MicrosoftTokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    id_token: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);
export type MicrosoftTokenAnswer = z.infer<typeof MicrosoftTokenAnswer>;

const IdTokenClaims = z.looseObject({
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  tid: z.string().min(1),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

/** An address with one `@`, a dotted domain and no spaces or angle brackets (index checks only). */
export function looksLikeAddress(value: string): boolean {
  if (value.length < 6 || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || value[i] === "<" || value[i] === ">") return false;
  }
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && domain.length - dot > 2;
}

/** The ID token's claims we use: the address, and the account's directory (`tid`). */
export interface MicrosoftAccount {
  address: string;
  tid: string;
}

/**
 * The signed-in account, from the ID token Microsoft's token endpoint answered over TLS to our own
 * client secret, so its signature isn't checked (OpenID Connect Core §3.1.3.7); the issuer (on
 * Microsoft's login host, for the token's own tenant), the audience and the expiry are.
 */
// DECISION: the `email` claim, else `preferred_username` when it is an address. The connectors'
// scopes can't read the profile (`/me` needs User.Read), and Graph acts as the signed-in account
// whatever we name, so the address only says which account is connected (outlook/NOTES.md).
export function microsoftIdTokenAccount(
  idToken: string,
  clientId: string,
  now: Date,
): MicrosoftAccount {
  const [, payload] = idToken.split(".");
  const refused = () => new SignInRefusedError("Microsoft didn't say which account signed in");
  if (!payload) throw refused();
  let claims: z.infer<typeof IdTokenClaims>;
  try {
    claims = IdTokenClaims.parse(JSON.parse(fromUtf8(fromBase64Url(payload))));
  } catch {
    throw refused();
  }
  const iss = parseUrl(claims.iss);
  if (iss?.origin !== MICROSOFT_LOGIN_ORIGIN || iss.pathname !== `/${claims.tid}/v2.0`) {
    throw new SignInRefusedError("that sign-in didn't come from Microsoft");
  }
  if (claims.aud !== clientId) throw new SignInRefusedError("that sign-in wasn't for Mezonas");
  if (claims.exp * 1000 < now.getTime() - 60_000) {
    throw new SignInRefusedError("that sign-in has expired; connect again");
  }
  for (const candidate of [claims.email, claims.preferred_username]) {
    const v = candidate?.trim().toLowerCase();
    if (v && looksLikeAddress(v)) return { address: v, tid: claims.tid };
  }
  throw new SignInRefusedError("Microsoft didn't say which mailbox signed in");
}

/** The signed-in address only (Outlook's original helper). */
export function microsoftIdTokenAddress(idToken: string, clientId: string, now: Date): string {
  return microsoftIdTokenAccount(idToken, clientId, now).address;
}

/** The tenant id Microsoft gives every personal (Outlook.com) account. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Graph refused a call, or answered something we can't read. */
export class MicrosoftApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Graph's error code (`itemNotFound`, `nameAlreadyExists`, …), when it gave one. */
    readonly code: string | null = null,
    /** 429 and 5xx: a later try may get through (the step's retry). */
    readonly retryable = status === 429 || status >= 500,
  ) {
    super(message);
    this.name = "MicrosoftApiError";
  }
}

/** The deployment has no Entra app for this connector. */
export class MicrosoftNotConfiguredError extends Error {
  constructor(provider: string, envNames: string) {
    super(`${provider} sign-in is not set up on this deployment (${envNames})`);
    this.name = "MicrosoftNotConfiguredError";
  }
}

/** The stored credentials of a Microsoft connection: tokens and the signed-in address. */
export const MicrosoftCredentials = OAuthTokens.extend({ address: z.string().min(3) });
export type MicrosoftCredentials = z.infer<typeof MicrosoftCredentials>;

/** fetch whose body may be bytes (a file). */
export interface GraphRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}
export type GraphFetch = (url: string, init?: GraphRequestInit) => Promise<HttpResponseLike>;

export interface MicrosoftAppOptions {
  /** The connector's Entra app registration: application (client) id and a client secret. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: GraphFetch | FetchLike;
}

export interface MicrosoftSignInSpec {
  /** The provider's name in plain words ("OneDrive"), for errors. */
  provider: string;
  /** The env names of the app's id and secret, for the "not set up" error. */
  envNames: string;
  /** The Graph scopes asked for, by name (`Files.ReadWrite.AppFolder`); OpenID's are added. */
  graphScopes: readonly string[];
  /** What the person reads when the grant lacks one of `graphScopes`. */
  missingMessage: string;
}

/** A Graph answer: its status, JSON (null when there was none) and headers. */
export interface GraphResponse {
  status: number;
  json: unknown;
  headers: { get(name: string): string | null };
}

export interface GraphBody {
  /** JSON (sent as application/json) or bytes with their type. */
  json?: unknown;
  bytes?: Uint8Array;
  type?: string;
  headers?: Record<string, string>;
}

/**
 * One Graph call for a connection. `path` is under `GRAPH_API` (`/me/drive/...`) or a full URL on
 * graph.microsoft.com (a `@odata.nextLink`); nothing else is called with the token. Statuses in
 * `accept` are returned as they are; any other non-2xx throws MicrosoftApiError, a 401 after one
 * refresh ReconnectRequiredError.
 */
export type GraphCall = (
  method: string,
  path: string,
  body?: GraphBody,
  opts?: { accept?: readonly number[]; timeoutMs?: number },
) => Promise<GraphResponse>;

export interface MicrosoftSignIn {
  readonly configured: boolean;
  /** Every scope asked for: OpenID's and the Graph scopes, in Microsoft's full form. */
  readonly scopes: readonly string[];
  clientId(): string;
  authorizeUrl(req: { redirectUri: string; state: string }): string;
  /**
   * Exchanges a callback's code: refuses a grant without every Graph scope asked for, or with any
   * other (beyond OpenID's, `profile` and `User.Read`), or without a refresh token or ID token.
   */
  exchange(
    code: string,
    redirectUri: string,
    now?: Date,
  ): Promise<{
    credentials: MicrosoftCredentials;
    account: MicrosoftAccount;
    scopes: string[];
    accessToken: string;
  }>;
  refresher: TokenRefresher;
  /** Graph calls with the connection's tokens: refreshed before expiry and once after a 401. */
  graph(ctx: Pick<ConnectionContext, "credentials" | "now">): GraphCall;
  /** Graph calls with one access token (during sign-in, before anything is stored). */
  graphWith(accessToken: string): GraphCall;
}

function readJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Graph's `{error: {code, message}}`, when it is there. */
export function graphError(json: unknown): { code: string | null; message: string } {
  const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    code: typeof e?.code === "string" ? e.code : null,
    message: typeof e?.message === "string" ? e.message : "no reason given",
  };
}

/** The Graph URL for a path under v1.0, or a full URL on Graph's own host; anything else throws. */
export function microsoftGraphUrl(path: string): string {
  if (path.startsWith("/")) return `${GRAPH_API}${path}`;
  const u = parseUrl(path);
  if (u?.origin !== MICROSOFT_GRAPH_ORIGIN || u.protocol !== "https:") {
    throw new MicrosoftApiError(502, "Microsoft pointed us outside Microsoft Graph", null, false);
  }
  return u.href;
}

export function microsoftSignIn(
  options: MicrosoftAppOptions,
  spec: MicrosoftSignInSpec,
): MicrosoftSignIn {
  const doFetch = (): GraphFetch =>
    (options.fetch as GraphFetch | undefined) ?? (globalFetch() as unknown as GraphFetch);
  const configured = Boolean(options.clientId && options.clientSecret);
  const scopes = [...MICROSOFT_SIGN_IN_SCOPES, ...spec.graphScopes.map(graphScope)];
  const required = spec.graphScopes.map((s) => s.toLowerCase());
  const allowed = new Set([...ALWAYS_ALLOWED, ...required]);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) {
      throw new MicrosoftNotConfiguredError(spec.provider, spec.envNames);
    }
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>): Promise<MicrosoftTokenAnswer> {
    const res = await doFetch()(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const parsed = MicrosoftTokenAnswer.safeParse(readJson(await res.text()));
    if (!parsed.success) {
      throw new MicrosoftApiError(res.status, "Microsoft's token answer has an unexpected shape");
    }
    return parsed.data;
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const c = client();
      const answer = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: c.id,
        client_secret: c.secret,
        scope: scopes.join(" "),
      });
      if ("error" in answer) {
        // invalid_grant: revoked, expired, or the password changed.
        throw new ReconnectRequiredError(`Microsoft refused the refresh: ${answer.error}`);
      }
      // Microsoft rotates refresh tokens: the new one is kept (tokenManager persists it).
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  async function once(
    token: string,
    method: string,
    path: string,
    body: GraphBody | undefined,
    timeoutMs: number,
  ): Promise<HttpResponseLike> {
    const data =
      body?.bytes !== undefined
        ? body.bytes
        : body?.json !== undefined
          ? JSON.stringify(body.json)
          : undefined;
    const type =
      body?.bytes !== undefined
        ? (body.type ?? "application/octet-stream")
        : body?.json !== undefined
          ? "application/json"
          : undefined;
    return doFetch()(microsoftGraphUrl(path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(type ? { "content-type": type } : {}),
        ...(body?.headers ?? {}),
      },
      ...(data !== undefined ? { body: data } : {}),
      redirect: "manual",
      signal: timeoutSignal(timeoutMs),
    });
  }

  async function finish(
    res: HttpResponseLike,
    accept: readonly number[] | undefined,
  ): Promise<GraphResponse> {
    const json = readJson(await res.text());
    if (res.status === 401) {
      throw new ReconnectRequiredError(`Microsoft refused the access token for ${spec.provider}`);
    }
    if (!res.ok && !accept?.includes(res.status)) {
      const e = graphError(json);
      throw new MicrosoftApiError(
        res.status,
        `${spec.provider} refused the request (${res.status}): ${e.message}`,
        e.code,
      );
    }
    return { status: res.status, json, headers: res.headers };
  }

  return {
    configured,
    scopes,
    clientId: () => client().id,

    authorizeUrl(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        response_type: "code",
        redirect_uri: req.redirectUri,
        response_mode: "query",
        scope: scopes.join(" "),
        // The person picks the account each time (a reconnect may be another account).
        prompt: "select_account",
        state: req.state,
      });
      return `${MICROSOFT_AUTH_URL}?${query}`;
    },

    async exchange(code, redirectUri, now = new Date()) {
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
      });
      if ("error" in answer) throw new Error(`Microsoft refused the sign-in: ${answer.error}`);
      const granted = (answer.scope ?? "").split(" ").filter(Boolean);
      const short = granted.map(shortScope);
      if (required.some((r) => !short.includes(r))) {
        throw new SignInRefusedError(spec.missingMessage);
      }
      if (short.some((s) => !allowed.has(s))) {
        throw new SignInRefusedError(
          "Microsoft gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Microsoft gave no refresh token");
      if (!answer.id_token) {
        throw new SignInRefusedError("Microsoft didn't say which account signed in");
      }
      const account = microsoftIdTokenAccount(answer.id_token, c.id, now);
      const credentials = MicrosoftCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        scope: granted.join(" "),
        address: account.address,
      });
      return { credentials, account, scopes: granted, accessToken: answer.access_token };
    },

    refresher,

    graph(ctx) {
      const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
      return async (method, path, body, opts) => {
        const timeoutMs = opts?.timeoutMs ?? 30_000;
        const res = await tokens.withAccessToken(
          (token) => once(token, method, path, body, timeoutMs),
          (r) => r.status === 401,
        );
        return finish(res, opts?.accept);
      };
    },

    graphWith(accessToken) {
      return async (method, path, body, opts) =>
        finish(
          await once(accessToken, method, path, body, opts?.timeoutMs ?? 30_000),
          opts?.accept,
        );
    },
  };
}

/** The credentials as a JSON object for the vault. */
export function credentialsJson(c: MicrosoftCredentials): JsonObject {
  return c as unknown as JsonObject;
}
