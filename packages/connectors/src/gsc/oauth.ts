// "gsc_oauth": Google Search Console by Google sign-in (M50, docs/plan.md §1.78), beside `gsc`'s
// service account. A person at the client signs in to their Google account from the portal and we
// ask for `webmasters.readonly` and nothing else, on the deployment's Google OAuth client (the one
// Gmail, Drive and Sheets use: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET); unset, it is "not
// available yet". At sign-in we list the properties the account can read (verified ones only) and
// keep them in `config`; the one to read is `config.property`: the only one, else the only Domain
// property, else the one the Marketing pack picks when a person points a site's search figures at
// the connection (its domain's). The nightly sync reads it exactly as `gsc` does (./index.ts).
// Nothing here logs or keeps a code, a token or a response body. Unchecked facts: ./NOTES.md.
//
// Google's verification of the OAuth client must include this scope before clients use it: an
// app in testing gets refresh tokens that end after 7 days (owner action, docs/plan.md §1.78).

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import { type ConnectionContext, type Connector, defineConnector } from "../connector";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from "../gmail/index";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { GSC_API, GSC_SCOPE, isGscProperty, readGscProperty } from "./index";
import {
  SEARCH_ENTITY,
  type SearchConnector,
  SearchImportError,
  type SearchRead,
  type SearchSpan,
} from "./records";

export const GSC_OAUTH_CONNECTOR_ID = "gsc_oauth";
/** Google's answer for a property the account may read; `siteUnverifiedUser` may not. */
export const GSC_READ_LEVELS = ["siteOwner", "siteFullUser", "siteRestrictedUser"] as const;
/** The most properties kept from one account (a person with hundreds is not a small business). */
export const GSC_MAX_PROPERTIES = 50;

export const GscOauthCredentials = OAuthTokens;

/** What `connection.config` holds: the properties the account can read, and the one read. */
export const GscOauthConfig = z.looseObject({
  /** The property the sync reads; null until one is chosen (several, none a sole Domain one). */
  property: z.string().nullable(),
  properties: z.array(z.string()).max(GSC_MAX_PROPERTIES),
});
export type GscOauthConfig = z.infer<typeof GscOauthConfig>;

const TokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const SiteList = z.looseObject({
  siteEntry: z
    .array(z.looseObject({ siteUrl: z.string(), permissionLevel: z.string() }))
    .optional(),
});

export class GscOauthNotConfiguredError extends Error {
  constructor() {
    super(
      "Search Console sign-in is not set up on this deployment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)",
    );
    this.name = "GscOauthNotConfiguredError";
  }
}

export interface GscOauthOptions {
  /** Google Cloud's OAuth client ("Mezonas web"), the one Gmail uses. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: () => FetchLike;
}

/**
 * The property to read among those an account can: the only one, else the only Domain property
 * (`sc-domain:`, which covers every protocol and subdomain), else none until a site picks one.
 */
// DECISION: never the first of several: two properties of one site (a Domain and a URL-prefix
// one) count the same searches, and two sites' properties are two sites, so a guess either
// double counts or reads the wrong site.
export function defaultGscProperty(properties: readonly string[]): string | null {
  if (properties.length === 1) return properties[0] ?? null;
  const domains = properties.filter((p) => p.startsWith("sc-domain:"));
  return domains.length === 1 ? (domains[0] ?? null) : null;
}

/**
 * The property among `properties` that is this site's (its domain without `www.`): its Domain
 * property, else its https URL-prefix one (with or without `www.`), else its http one; null when
 * the account can't read the site.
 */
export function gscPropertyForDomain(properties: readonly string[], domain: string): string | null {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  const wanted = [
    `sc-domain:${d}`,
    `https://${d}/`,
    `https://www.${d}/`,
    `http://${d}/`,
    `http://www.${d}/`,
  ];
  for (const w of wanted) {
    const found = properties.find((p) => p.toLowerCase() === w);
    if (found) return found;
  }
  return null;
}

async function readJson(res: { text(): Promise<string> }): Promise<unknown> {
  const text = await res.text();
  if (text.length > 1_000_000) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createGscOauthConnector(options: GscOauthOptions = {}): SearchConnector {
  const configured = Boolean(options.clientId && options.clientSecret);
  const doFetch = options.fetch ?? globalFetch;
  const client = () => {
    if (!options.clientId || !options.clientSecret) throw new GscOauthNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  };

  async function tokenCall(fields: Record<string, string>): Promise<z.infer<typeof TokenAnswer>> {
    const res = await doFetch()(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const parsed = TokenAnswer.safeParse(await readJson(res));
    if (!parsed.success) throw new Error("Google's token answer has an unexpected shape");
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
      });
      if ("error" in answer) {
        throw new ReconnectRequiredError(`Google refused the refresh: ${answer.error}`);
      }
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  /** The verified properties this token's account can read, sorted. */
  async function properties(token: string): Promise<string[]> {
    const res = await doFetch()(GSC_API, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    if (!res.ok) {
      throw new SignInRefusedError(
        `Search Console didn't list your properties (${res.status}). Try connecting again.`,
      );
    }
    const list = SiteList.safeParse(await readJson(res));
    const entries = list.success ? (list.data.siteEntry ?? []) : [];
    const readable = entries
      .filter((e) => (GSC_READ_LEVELS as readonly string[]).includes(e.permissionLevel))
      .map((e) => e.siteUrl.trim())
      .filter(isGscProperty);
    return [...new Set(readable)].sort().slice(0, GSC_MAX_PROPERTIES);
  }

  async function read(ctx: ConnectionContext, span: SearchSpan): Promise<SearchRead> {
    const config = GscOauthConfig.safeParse(ctx.connection.config);
    const property = config.success ? config.data.property : null;
    if (!property || !isGscProperty(property)) {
      throw new SearchImportError(
        "no Search Console property is chosen for this connection: point a site's search figures at it",
      );
    }
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    let token: string;
    try {
      token = await tokens.accessToken();
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        throw new SearchImportError("Google ended the sign-in: connect Search Console again");
      }
      throw error;
    }
    return readGscProperty(property, token, span, doFetch());
  }

  const connector: Connector = defineConnector({
    id: GSC_OAUTH_CONNECTOR_ID,
    name: "Google Search Console (Google sign-in)",
    description:
      "Your site's Google search figures, read only, by signing in with the Google account that has your site in Search Console: the searches it showed up for, its pages, clicks and positions, imported each night with 16 months of history.",
    icon: "search",
    auth: "oauth2",
    entities: [SEARCH_ENTITY.queryPage, SEARCH_ENTITY.page],
    tools: [],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        redirect_uri: req.redirectUri,
        response_type: "code",
        scope: GSC_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state: req.state,
      });
      return { redirectUrl: `${GOOGLE_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Google callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Google refused the sign-in: ${answer.error}`);
      const scopes = (answer.scope ?? "").split(" ").filter(Boolean);
      if (!scopes.includes(GSC_SCOPE)) {
        throw new SignInRefusedError(
          "Google didn't give us permission to read your Search Console figures. Connect again and allow it.",
        );
      }
      if (scopes.some((s) => s !== GSC_SCOPE)) {
        throw new SignInRefusedError(
          "Google gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Google gave no refresh token");
      const found = await properties(answer.access_token);
      if (found.length === 0) {
        throw new SignInRefusedError(
          "This Google account can't read any Search Console property. Sign in with the account that has your site in Search Console.",
        );
      }
      const now = new Date();
      const credentials = GscOauthCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        scope: scopes.join(" "),
      });
      const config: GscOauthConfig = { property: defaultGscProperty(found), properties: found };
      return {
        // DECISION: the property read is the account's name here: the Google account's address
        // would need another scope (`email`), which we don't ask for.
        externalAccountId: config.property,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: refresher,
    // DECISION: no `revoke`, as Drive: the Google OAuth client is shared with Gmail, Drive and
    // Sheets, and Google's revoke ends every scope the account gave that client. Disconnecting
    // drops our tokens; the person can remove Mezonas in their Google account.
  });
  return { ...connector, search: { provider: "google", read } };
}
