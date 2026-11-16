// A fake Microsoft identity platform for the Microsoft connectors' fakes (re-exported by
// @countersign/connectors/testing; never imported by the Worker): the token endpoint (authorization
// codes, rotating refresh tokens, `invalid_grant`) with ID tokens, and the access-token check each
// fake Graph route runs. Shaped like Microsoft's answers as far as we know them (../outlook/NOTES.md).
// Each connector's fake (OneDrive, Excel, Outlook Calendar) puts its Graph routes beside it.

import type { HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { toBase64Url, utf8 } from "../runtime";
import { MICROSOFT_TOKEN_URL, shortScope } from "./identity";

export interface FakeMicrosoftApp {
  clientId: string;
  clientSecret: string;
}

export const FAKE_MICROSOFT_APP: FakeMicrosoftApp = {
  clientId: "6f1c0d2e-0000-4000-8000-00000000b22d",
  clientSecret: "fake~microsoft~app~secret",
};

export interface FakeMicrosoftGrant {
  address: string;
  /** As Microsoft answers them in `scope` (full or short form). */
  scopes: string[];
  tid: string;
  /** Which claim carries the address: `email`, `preferred_username` or none. */
  claim: "email" | "preferred_username" | "none";
  revoked: boolean;
}

export interface FakeMicrosoftIdentity {
  app: FakeMicrosoftApp;
  /** The token endpoint's answer for this request, or null when it isn't one. */
  handle(
    url: string,
    init: { method?: string; body?: unknown } | undefined,
  ): HttpResponseLike | null;
  issueCode(opts?: Partial<Omit<FakeMicrosoftGrant, "revoked">>): string;
  /** The grant behind a live `Authorization: Bearer` header, or null (answer 401). */
  grantFor(headers: Record<string, string> | undefined): FakeMicrosoftGrant | null;
  /** Whether the grant carries this scope (by short name, any case). */
  hasScope(grant: FakeMicrosoftGrant, scope: string): boolean;
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const all: Record<string, string> = {
    ...(text ? { "content-type": "application/json" } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => all[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** Graph's error shape. */
export function graphErrorResponse(status: number, code: string, message: string) {
  return jsonResponse(status, { error: { code, message } });
}

export const unauthorized = () =>
  graphErrorResponse(
    401,
    "InvalidAuthenticationToken",
    "Access token has expired or is not yet valid.",
  );

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
  return `${part({ typ: "JWT", alg: "RS256", kid: "fake" })}.${part(claims)}.c2ln`;
}

export function fakeMicrosoftIdentity(
  defaultScopes: string[],
  app: FakeMicrosoftApp = FAKE_MICROSOFT_APP,
): FakeMicrosoftIdentity {
  let n = 0;
  const codes = new Map<string, FakeMicrosoftGrant>();
  const refreshTokens = new Map<string, FakeMicrosoftGrant>();
  const accessTokens = new Map<string, { grant: FakeMicrosoftGrant; live: boolean }>();

  function tokens(grant: FakeMicrosoftGrant, withIdToken: boolean) {
    const accessToken = `eyJ0eXAi.fake-graph-access-${++n}`;
    accessTokens.set(accessToken, { grant, live: true });
    // Microsoft rotates refresh tokens: every answer carries a new one.
    const refreshToken = `M.C5_fake-refresh-${++n}`;
    refreshTokens.set(refreshToken, grant);
    const now = Math.floor(Date.now() / 1000);
    return {
      token_type: "Bearer",
      scope: grant.scopes.join(" "),
      expires_in: 3600,
      ext_expires_in: 3600,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(withIdToken
        ? {
            id_token: idToken({
              ver: "2.0",
              iss: `https://login.microsoftonline.com/${grant.tid}/v2.0`,
              aud: app.clientId,
              tid: grant.tid,
              oid: `oid-${grant.address}`,
              iat: now,
              nbf: now,
              exp: now + 3600,
              ...(grant.claim === "email" ? { email: grant.address } : {}),
              ...(grant.claim !== "none" ? { preferred_username: grant.address } : {}),
            }),
          }
        : {}),
    };
  }

  function token(form: Record<string, string>): HttpResponseLike {
    if (form.client_id !== app.clientId || form.client_secret !== app.clientSecret) {
      return jsonResponse(401, { error: "invalid_client", error_codes: [7000215] });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) {
        return jsonResponse(400, { error: "invalid_grant", error_codes: [70000] });
      }
      codes.delete(form.code ?? "");
      return jsonResponse(200, tokens(grant, true));
    }
    if (form.grant_type === "refresh_token") {
      const grant = refreshTokens.get(form.refresh_token ?? "");
      if (!grant || grant.revoked) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "AADSTS700082: The refresh token has expired.",
          error_codes: [700082],
        });
      }
      return jsonResponse(200, tokens(grant, false));
    }
    return jsonResponse(400, { error: "unsupported_grant_type" });
  }

  return {
    app,
    handle(url, init) {
      if (url !== MICROSOFT_TOKEN_URL || init?.method !== "POST") return null;
      return token(formDecode(typeof init.body === "string" ? init.body : ""));
    },
    issueCode(opts = {}) {
      const code = `M.C5_fake-code-${++n}`;
      codes.set(code, {
        address: opts.address ?? "pat.lee@shop.example",
        scopes: opts.scopes ?? [...defaultScopes, "openid", "email", "offline_access"],
        tid: opts.tid ?? "4a1b2c3d-0000-4000-8000-0000000000a1",
        claim: opts.claim ?? "email",
        revoked: false,
      });
      return code;
    },
    grantFor(headers) {
      const auth = headers?.authorization ?? "";
      if (!auth.startsWith("Bearer ")) return null;
      const at = accessTokens.get(auth.slice("Bearer ".length));
      if (!at?.live || at.grant.revoked) return null;
      return at.grant;
    },
    hasScope(grant, scope) {
      const want = shortScope(scope);
      return grant.scopes.some((s) => shortScope(s) === want);
    },
    issued: () => ({
      accessTokens: [...accessTokens.keys()],
      refreshTokens: [...refreshTokens.keys()],
    }),
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.live = false;
    },
    expireRefreshTokens() {
      for (const g of refreshTokens.values()) g.revoked = true;
    },
  };
}
