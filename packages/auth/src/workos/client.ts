// The WorkOS User Management API over `fetch`, ported from Plenary Labs'
// apps/api/src/identity/workos.ts (the calls Countersign needs; no QA password grant).
//
// Not `@workos-inc/node`: a handful of HTTP calls, no Node-compat shims in the Worker bundle, and
// one seam (`fetch`) every test stubs. The session cookie is ours (./session.ts), so the only
// WorkOS state we hold is the refresh token and the session id inside it.
//
// Endpoints (https://workos.com/docs/reference/authkit):
//   GET  /user_management/authorize                  (the browser is sent here)
//   POST /user_management/authenticate               grant_type=authorization_code | refresh_token
//   GET  /user_management/sessions/logout            (the browser is sent here)
//   POST /user_management/sessions/revoke
//   GET  /organizations/:id
//   POST /user_management/invitations
//   POST /user_management/invitations/:id/revoke

import { base64UrlToBytes } from "../seal";

export const WORKOS_API = "https://api.workos.com";

/** A call WorkOS refused (`status` set) or that never reached it (`status` null). */
export class WorkOSError extends Error {
  override name = "WorkOSError";
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface WorkOSUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Anything but a literal `true` reads as false, so a missing field fails closed. */
  readonly emailVerified: boolean;
}

export interface WorkOSAuthentication {
  readonly user: WorkOSUser;
  readonly organizationId: string | null;
  readonly refreshToken: string;
  /** The `sid` claim of the access token: what the logout URL needs. */
  readonly sessionId: string | null;
}

export interface WorkOSClient {
  authorizationUrl(input: { redirectUri: string; state: string }): string;
  authenticateWithCode(code: string): Promise<WorkOSAuthentication>;
  refresh(refreshToken: string, organizationId: string | null): Promise<WorkOSAuthentication>;
  logoutUrl(sessionId: string, returnTo: string): string;
  /** End a WorkOS session from here, for a sign-in we refused. */
  revokeSession(sessionId: string): Promise<void>;
  organizationName(organizationId: string): Promise<string | null>;
  /** WorkOS emails the invitation itself. */
  sendInvitation(email: string): Promise<{ id: string; acceptUrl: string | null }>;
  /** `not_pending` when WorkOS will not revoke it: accepted, expired, revoked or gone. */
  revokeInvitation(invitationId: string): Promise<"revoked" | "not_pending">;
}

export interface WorkOSOptions {
  readonly clientId: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The `sid` claim, read without verifying the signature. Safe here: the token came straight back
 * from WorkOS over TLS in answer to our client secret. It is never accepted from a browser.
 */
export function sessionIdOf(accessToken: unknown): string | null {
  if (typeof accessToken !== "string") return null;
  const payload = accessToken.split(".")[1];
  const bytes = payload ? base64UrlToBytes(payload) : null;
  if (!bytes) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return text(claims.sid);
  } catch {
    return null;
  }
}

function toUser(raw: unknown): WorkOSUser | null {
  const user = (raw ?? {}) as Record<string, unknown>;
  const id = text(user.id);
  const email = text(user.email);
  if (!id || !email) return null;
  return {
    id,
    email,
    firstName: text(user.first_name),
    lastName: text(user.last_name),
    emailVerified: user.email_verified === true,
  };
}

function toAuthentication(body: unknown): WorkOSAuthentication {
  const record = (body ?? {}) as Record<string, unknown>;
  const user = toUser(record.user);
  const refreshToken = text(record.refresh_token);
  if (!user || !refreshToken) {
    throw new WorkOSError("WorkOS answered without a user or a refresh token", 502);
  }
  return {
    user,
    organizationId: text(record.organization_id),
    refreshToken,
    sessionId: sessionIdOf(record.access_token),
  };
}

export function createWorkOS(options: WorkOSOptions): WorkOSClient {
  const base = options.baseUrl ?? WORKOS_API;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new WorkOSError(`WorkOS could not be reached: ${String(cause)}`, null);
    }
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const record = (parsed ?? {}) as Record<string, unknown>;
      // Only the code travels on: WorkOS error messages can echo an email address back.
      const code = text(record.code) ?? text(record.error);
      throw new WorkOSError(`WorkOS answered ${response.status}`, response.status, code);
    }
    return parsed;
  }

  const authenticate = (grant: Record<string, string>) =>
    call("POST", "/user_management/authenticate", {
      client_id: options.clientId,
      client_secret: options.apiKey,
      ...grant,
    }).then(toAuthentication);

  return {
    authorizationUrl({ redirectUri, state }) {
      const url = new URL(`${base}/user_management/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("provider", "authkit");
      url.searchParams.set("state", state);
      return url.toString();
    },

    authenticateWithCode(code) {
      return authenticate({ grant_type: "authorization_code", code });
    },

    refresh(refreshToken, organizationId) {
      return authenticate({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...(organizationId ? { organization_id: organizationId } : {}),
      });
    },

    logoutUrl(sessionId, returnTo) {
      const url = new URL(`${base}/user_management/sessions/logout`);
      url.searchParams.set("session_id", sessionId);
      url.searchParams.set("return_to", returnTo);
      return url.toString();
    },

    async revokeSession(sessionId) {
      await call("POST", "/user_management/sessions/revoke", { session_id: sessionId });
    },

    async organizationName(organizationId) {
      const body = (await call("GET", `/organizations/${encodeURIComponent(organizationId)}`)) as
        | Record<string, unknown>
        | undefined;
      return text(body?.name);
    },

    async sendInvitation(email) {
      const body = (await call("POST", "/user_management/invitations", { email })) as
        | Record<string, unknown>
        | undefined;
      const id = text(body?.id);
      if (!id) throw new WorkOSError("WorkOS answered an invitation without an id", 502);
      return { id, acceptUrl: text(body?.accept_invitation_url) };
    },

    async revokeInvitation(invitationId) {
      try {
        await call(
          "POST",
          `/user_management/invitations/${encodeURIComponent(invitationId)}/revoke`,
        );
        return "revoked";
      } catch (error) {
        // Not pending any more (accepted, expired, gone) is not a failure; 401/403 and 5xx are.
        if (error instanceof WorkOSError && [400, 404, 409, 422].includes(error.status ?? 0)) {
          return "not_pending";
        }
        throw error;
      }
    },
  };
}
