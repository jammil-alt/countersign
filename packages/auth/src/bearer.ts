// OAuth 2.1 bearer tokens for a protected resource (the MCP server, docs/plan.md §1.34): read the
// token from the request, verify it against the authorization server's keys, and build the
// metadata and the `WWW-Authenticate` challenge that point an MCP client at sign-in.
//
// The authorization server is WorkOS AuthKit (each environment's own); this file knows nothing of
// WorkOS beyond what OAuth says, so a client-facing MCP server can use it unchanged with its own
// resource URL. Mapping the token's subject to an app_user is the API's job (it has the database).
//
// Verification (RFC 9068 / RFC 8707, as the MCP authorization spec asks of a resource server):
// a JWT signed by one of the issuer's keys (RS256 or ES256 only, never `none` or HMAC), `iss` the
// issuer exactly, `aud` naming this resource, not expired, not issued in the future, and with a
// subject. Anything else is `invalid_token`; nothing about the token is echoed back.

import { errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** RFC 9728 path of the protected resource metadata. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export interface AccessTokenCheck {
  /** The authorization server's `issuer`, compared exactly. */
  readonly issuer: string;
  /** What `aud` must contain: this resource's URL (RFC 8707). */
  readonly audience: string;
  /** The issuer's signing keys (a remote JWKS in the Worker, a local one in tests). */
  readonly keys: JWTVerifyGetKey;
  /** Seconds of clock skew allowed on `exp`, `nbf` and `iat`. Default 60. */
  readonly clockToleranceSec?: number;
}

export interface VerifiedAccessToken {
  readonly ok: true;
  /** `sub`: the authorization server's user id (a WorkOS user id with AuthKit). */
  readonly subject: string;
  /** `sid`, when the issuer puts the sign-in session in the token. */
  readonly sessionId: string | null;
  readonly expiresAt: Date;
}

export interface RejectedAccessToken {
  readonly ok: false;
  /** RFC 6750 error code for the challenge. */
  readonly error: "invalid_token";
  /** A fixed phrase, safe to send: never the token, a claim or a library message. */
  readonly description: string;
}

/** `Authorization: Bearer <token>`, or null when the request has none (or another scheme). */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

const ALGORITHMS = ["RS256", "ES256"];

function reject(description: string): RejectedAccessToken {
  return { ok: false, error: "invalid_token", description };
}

export async function verifyAccessToken(
  token: string,
  check: AccessTokenCheck,
  now: Date = new Date(),
): Promise<VerifiedAccessToken | RejectedAccessToken> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, check.keys, {
      issuer: check.issuer,
      audience: check.audience,
      algorithms: ALGORITHMS,
      requiredClaims: ["exp", "sub"],
      clockTolerance: check.clockToleranceSec ?? 60,
      currentDate: now,
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) return reject("the access token has expired");
    if (error instanceof errors.JWTClaimValidationFailed) {
      if (error.claim === "aud") return reject("the access token is not for this server");
      if (error.claim === "iss") return reject("the access token is from another issuer");
      return reject("the access token's claims are not valid");
    }
    return reject("the access token is not valid");
  }
  const subject = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  if (!subject || typeof payload.exp !== "number") {
    return reject("the access token's claims are not valid");
  }
  return {
    ok: true,
    subject,
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** RFC 9728 metadata for a protected resource. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly ["header"];
  readonly resource_name: string;
  readonly scopes_supported?: readonly string[];
  readonly resource_documentation?: string;
}

export function protectedResourceMetadata(input: {
  resource: string;
  authorizationServer: string;
  name: string;
  scopes?: readonly string[];
  documentation?: string;
}): ProtectedResourceMetadata {
  return {
    resource: input.resource,
    authorization_servers: [input.authorizationServer],
    bearer_methods_supported: ["header"],
    resource_name: input.name,
    ...(input.scopes ? { scopes_supported: input.scopes } : {}),
    ...(input.documentation ? { resource_documentation: input.documentation } : {}),
  };
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

/**
 * The `WWW-Authenticate` challenge of a 401 (RFC 6750 §3 with RFC 9728 §5.1): where the metadata
 * is, and, for a token that was sent and refused, why.
 */
export function bearerChallenge(input: {
  resourceMetadataUrl: string;
  error?: "invalid_token" | "invalid_request" | "insufficient_scope";
  description?: string;
  scope?: string;
}): string {
  const parts = [`resource_metadata=${quoted(input.resourceMetadataUrl)}`];
  if (input.error) parts.push(`error=${quoted(input.error)}`);
  if (input.description) parts.push(`error_description=${quoted(input.description)}`);
  if (input.scope) parts.push(`scope=${quoted(input.scope)}`);
  return `Bearer ${parts.join(", ")}`;
}
