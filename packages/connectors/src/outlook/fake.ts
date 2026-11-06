// A fake Microsoft for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): the identity platform's token endpoint (authorization codes, rotating refresh tokens,
// `invalid_grant`) with ID tokens, and Graph's `POST /me/sendMail`, which accepts only live access
// tokens that carry Mail.Send, answers 202 with no body and keeps every message it was given.
// Shaped like Microsoft's answers as far as we know them (NOTES.md).

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { toBase64Url, utf8 } from "../runtime";
import { GRAPH_API, MAIL_SEND_SCOPE, MICROSOFT_TOKEN_URL } from "./index";

export const FAKE_MICROSOFT = {
  clientId: "6f1c0d2e-0000-4000-8000-00000000a11c",
  clientSecret: "fake~microsoft~secret",
} as const;

/** The tenant id Microsoft gives every personal (Outlook.com) account. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export interface FakeOutlookMessage {
  /** The account it was sent as (the access token's). */
  account: string;
  /** The JSON we posted. */
  body: {
    message: {
      subject: string;
      body: { contentType: string; content: string };
      toRecipients: { emailAddress: { address: string } }[];
      replyTo?: { emailAddress: { address: string } }[];
      internetMessageHeaders?: { name: string; value: string }[];
    };
    saveToSentItems?: boolean;
  };
}

interface Grant {
  address: string;
  scopes: string[];
  tid: string;
  /** Which claim carries the address: `email`, `preferred_username` or none. */
  claim: "email" | "preferred_username" | "none";
  revoked: boolean;
}

export interface FakeMicrosoft {
  fetch: FetchLike;
  requests: { url: string; method: string; body: string | undefined }[];
  sent: FakeOutlookMessage[];
  issueCode(opts?: {
    address?: string;
    scopes?: string[];
    tid?: string;
    claim?: Grant["claim"];
  }): string;
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  /** The next this-many sends fail with this status. */
  failSends(count: number, status: number): void;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) => (n.toLowerCase() === "content-type" && text ? "application/json" : null),
    },
    text: async () => text,
  };
}

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
  return `${part({ typ: "JWT", alg: "RS256", kid: "fake" })}.${part(claims)}.c2ln`;
}

export function fakeMicrosoft(): FakeMicrosoft {
  let n = 0;
  const requests: FakeMicrosoft["requests"] = [];
  const sent: FakeOutlookMessage[] = [];
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const accessTokens = new Map<string, { grant: Grant; live: boolean }>();
  let failing = { count: 0, status: 500 };

  function tokens(grant: Grant, withIdToken: boolean) {
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
              aud: FAKE_MICROSOFT.clientId,
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
    if (
      form.client_id !== FAKE_MICROSOFT.clientId ||
      form.client_secret !== FAKE_MICROSOFT.clientSecret
    ) {
      return respond(401, { error: "invalid_client", error_codes: [7000215] });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) {
        return respond(400, { error: "invalid_grant", error_codes: [70000] });
      }
      codes.delete(form.code ?? "");
      return respond(200, tokens(grant, true));
    }
    if (form.grant_type === "refresh_token") {
      const grant = refreshTokens.get(form.refresh_token ?? "");
      if (!grant || grant.revoked) {
        return respond(400, {
          error: "invalid_grant",
          error_description: "AADSTS700082: The refresh token has expired.",
          error_codes: [700082],
        });
      }
      return respond(200, tokens(grant, false));
    }
    return respond(400, { error: "unsupported_grant_type" });
  }

  function sendMail(init: HttpRequestInit | undefined): HttpResponseLike {
    const auth = init?.headers?.authorization ?? "";
    const at = accessTokens.get(auth.slice("Bearer ".length));
    if (!auth.startsWith("Bearer ") || !at?.live || at.grant.revoked) {
      return respond(401, {
        error: { code: "InvalidAuthenticationToken", message: "Access token has expired." },
      });
    }
    const scopes = at.grant.scopes.map((s) => s.toLowerCase());
    if (!scopes.includes("mail.send") && !scopes.includes(MAIL_SEND_SCOPE.toLowerCase())) {
      return respond(403, {
        error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials." },
      });
    }
    if (failing.count > 0) {
      failing.count--;
      return respond(failing.status, {
        error: { code: "ErrorInternalServerError", message: "Something went wrong" },
      });
    }
    let body: FakeOutlookMessage["body"];
    try {
      body = JSON.parse(init?.body ?? "") as FakeOutlookMessage["body"];
      if (!body.message?.toRecipients?.length) throw new Error("no recipients");
      for (const h of body.message.internetMessageHeaders ?? []) {
        if (!h.name.toLowerCase().startsWith("x-")) throw new Error("only x- headers");
      }
    } catch {
      return respond(400, {
        error: { code: "ErrorInvalidRecipients", message: "Invalid request" },
      });
    }
    sent.push({ account: at.grant.address, body });
    return respond(202, undefined);
  }

  return {
    requests,
    sent,
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url === MICROSOFT_TOKEN_URL && init?.method === "POST") {
        return token(formDecode(init.body ?? ""));
      }
      if (url === `${GRAPH_API}/me/sendMail` && init?.method === "POST") return sendMail(init);
      return respond(404, { error: { code: "ResourceNotFound", message: `no fake for ${url}` } });
    },
    issueCode(opts = {}) {
      const code = `M.C5_fake-code-${++n}`;
      codes.set(code, {
        address: opts.address ?? "pat.lee@shop.example",
        scopes: opts.scopes ?? [MAIL_SEND_SCOPE, "openid", "email", "offline_access"],
        tid: opts.tid ?? "4a1b2c3d-0000-4000-8000-0000000000a1",
        claim: opts.claim ?? "email",
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
  };
}
