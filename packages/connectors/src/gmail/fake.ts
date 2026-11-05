// A fake Google for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): the OAuth token endpoint (authorization codes, refresh, `invalid_grant`), revocation, and
// Gmail's `users.messages.send`, which accepts only live access tokens that carry `gmail.send` and
// keeps every message it was given. Shaped like Google's answers as far as we know them (NOTES.md).

import PostalMime from "postal-mime";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { fromBase64, fromUtf8, toBase64Url, utf8 } from "../runtime";
import { GMAIL_API, GMAIL_SCOPES, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from "./index";

export const FAKE_GOOGLE = {
  clientId: "1234-mezonas.apps.googleusercontent.com",
  clientSecret: "GOCSPX-fake-secret",
} as const;

export interface FakeGmailMessage {
  id: string;
  threadId: string;
  /** The account it was sent from (the access token's). */
  account: string;
  /** What we posted as `raw`. */
  raw: string;
  /** The message itself, decoded from `raw`. */
  message: string;
}

interface Grant {
  address: string;
  scopes: string[];
  emailVerified: boolean;
  revoked: boolean;
}

export interface FakeGoogle {
  fetch: FetchLike;
  /** Every request, in order (bodies included: tests check what was sent where). */
  requests: { url: string; method: string; body: string | undefined }[];
  sent: FakeGmailMessage[];
  /** A code for the consent screen's answer: the account, and the scopes the person allowed. */
  issueCode(opts?: { address?: string; scopes?: string[]; emailVerified?: boolean }): string;
  /** Every access token issued so far, and every refresh token (to check none leaks). */
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  /** The next sends' tokens are refused with 401, as for an expired access token. */
  expireAccessTokens(): void;
  /** The refresh tokens stop working (`invalid_grant`), as after 7 days in Testing. */
  expireRefreshTokens(): void;
  /** The next this-many sends fail with this status. */
  failSends(count: number, status: number): void;
  revoked(): string[];
}

/** A sent message as a real MIME parser reads it, for assertions. */
export async function readSentEmail(message: string) {
  const m = await PostalMime.parse(utf8(message));
  return {
    from: m.from?.address ?? null,
    to: (m.to ?? []).map((a) => a.address ?? ""),
    replyTo: (m.replyTo ?? []).map((a) => a.address ?? ""),
    subject: m.subject ?? null,
    text: m.text ?? null,
    messageId: m.messageId ?? null,
    date: m.date ?? null,
  };
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

/** An unsigned ID token: the connector reads it straight from the token endpoint (NOTES.md). */
function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
  return `${part({ alg: "RS256", kid: "fake" })}.${part(claims)}.c2ln`;
}

export function fakeGoogle(): FakeGoogle {
  let n = 0;
  const requests: FakeGoogle["requests"] = [];
  const sent: FakeGmailMessage[] = [];
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const accessTokens = new Map<string, { grant: Grant; refreshToken: string; live: boolean }>();
  const revokedTokens: string[] = [];
  let failing = { count: 0, status: 500 };

  function tokens(grant: Grant, refreshToken: string, withRefresh: boolean) {
    const accessToken = `ya29.fake-access-${++n}`;
    accessTokens.set(accessToken, { grant, refreshToken, live: true });
    return {
      access_token: accessToken,
      expires_in: 3599,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
      ...(withRefresh ? { refresh_token: refreshToken } : {}),
      ...(grant.scopes.includes("openid")
        ? {
            id_token: idToken({
              iss: "https://accounts.google.com",
              aud: FAKE_GOOGLE.clientId,
              sub: `sub-${grant.address}`,
              email: grant.address,
              email_verified: grant.emailVerified,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          }
        : {}),
    };
  }

  function token(form: Record<string, string>): HttpResponseLike {
    if (
      form.client_id !== FAKE_GOOGLE.clientId ||
      form.client_secret !== FAKE_GOOGLE.clientSecret
    ) {
      return respond(401, { error: "invalid_client" });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) return respond(400, { error: "invalid_grant" });
      codes.delete(form.code ?? "");
      const refreshToken = `1//fake-refresh-${++n}`;
      refreshTokens.set(refreshToken, grant);
      return respond(200, tokens(grant, refreshToken, true));
    }
    if (form.grant_type === "refresh_token") {
      const grant = refreshTokens.get(form.refresh_token ?? "");
      if (!grant || grant.revoked) {
        return respond(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      // Google answers a refresh without a new refresh token or ID token.
      const { id_token: _id, ...rest } = tokens(grant, form.refresh_token ?? "", false);
      return respond(200, rest);
    }
    return respond(400, { error: "unsupported_grant_type" });
  }

  function revoke(form: Record<string, string>): HttpResponseLike {
    const t = form.token ?? "";
    const grant = refreshTokens.get(t) ?? accessTokens.get(t)?.grant;
    if (!grant || grant.revoked) return respond(400, { error: "invalid_token" });
    grant.revoked = true;
    revokedTokens.push(t);
    return respond(200, {});
  }

  function send(init: HttpRequestInit | undefined): HttpResponseLike {
    const auth = init?.headers?.authorization ?? "";
    const at = accessTokens.get(auth.replace(/^Bearer /, ""));
    if (!at?.live || at.grant.revoked) {
      return respond(401, {
        error: { code: 401, message: "Request had invalid authentication credentials." },
      });
    }
    if (!at.grant.scopes.includes(GMAIL_SCOPES[2] as string)) {
      return respond(403, {
        error: { code: 403, message: "Request had insufficient authentication scopes." },
      });
    }
    if (failing.count > 0) {
      failing.count--;
      return respond(failing.status, { error: { code: failing.status, message: "Backend Error" } });
    }
    let raw: string;
    try {
      raw = (JSON.parse(init?.body ?? "{}") as { raw?: unknown }).raw as string;
      if (typeof raw !== "string" || !/^[A-Za-z0-9_=-]+$/.test(raw)) throw new Error("raw");
    } catch {
      return respond(400, { error: { code: 400, message: "Invalid value for raw" } });
    }
    const message = fromUtf8(fromBase64(raw));
    const id = `18f${String(++n).padStart(13, "0")}`;
    sent.push({ id, threadId: id, account: at.grant.address, raw, message });
    return respond(200, { id, threadId: id, labelIds: ["SENT"] });
  }

  return {
    requests,
    sent,
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? "GET", body: init?.body });
      const form = () => formDecode(init?.body ?? "");
      if (url === GOOGLE_TOKEN_URL && init?.method === "POST") return token(form());
      if (url === GOOGLE_REVOKE_URL && init?.method === "POST") return revoke(form());
      if (url === `${GMAIL_API}/users/me/messages/send` && init?.method === "POST") {
        return send(init);
      }
      return respond(404, { error: { code: 404, message: `no fake for ${url}` } });
    },
    issueCode(opts = {}) {
      const code = `4/fake-code-${++n}`;
      codes.set(code, {
        address: opts.address ?? "pat.lee@gmail.test",
        scopes: opts.scopes ?? [...GMAIL_SCOPES],
        emailVerified: opts.emailVerified ?? true,
        revoked: false,
      });
      return code;
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
    failSends(count, status) {
      failing = { count, status };
    },
    revoked: () => [...revokedTokens],
  };
}
