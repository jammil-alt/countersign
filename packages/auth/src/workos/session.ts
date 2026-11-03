// The sealed session cookie: what is in it, how long it lasts, and when it is refreshed (ported
// from Plenary Labs' apps/api/src/identity/session.ts).
//
// It holds the app user, the WorkOS user, the WorkOS refresh token and session id, and three
// times. Sealed with AES-GCM (../seal.ts): a changed byte is a cookie that does not open, treated
// exactly like no cookie. Memberships are not in it; they are read per request, so removing
// someone from a client takes effect at once.
//
// Lifetime:
//   - `exp`: an absolute limit, 30 days after sign-in.
//   - `rat` ("refresh at"): 5 minutes after the last refresh. After it, the refresh token is
//     exchanged with WorkOS before the request is admitted, so a session ended in WorkOS stops
//     working here within five minutes.
// Two allowances keep a refresh from signing people out for the wrong reasons:
//   - Racing tabs: refresh tokens rotate, so of two requests with the same due cookie the second
//     is refused by WorkOS. Within RACE_GRACE_SEC of `rat` that request is admitted on the old
//     cookie; the first request's response already gave the browser the new one.
//   - WorkOS unreachable (network or 5xx): admitted for up to OUTAGE_GRACE_SEC past `rat`.

import { z } from "zod";
import { clearCookie, serializeCookie } from "../cookies";
import { seal, unseal } from "../seal";
import { type WorkOSAuthentication, type WorkOSClient, WorkOSError } from "./client";

/** `__Host-`: Secure, Path=/, no Domain, so a subdomain can neither read nor plant it. */
export const SESSION_COOKIE = "__Host-cs_session";
export const STATE_COOKIE = "__Host-cs_auth_state";

export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
export const REFRESH_INTERVAL_SEC = 5 * 60;
export const RACE_GRACE_SEC = 60;
export const OUTAGE_GRACE_SEC = 15 * 60;
export const STATE_MAX_AGE_SEC = 10 * 60;

export const SessionPayload = z.object({
  v: z.literal(1),
  /** app_user.id */
  uid: z.uuid(),
  /** app_user.workos_user_id */
  wuid: z.string().min(1),
  email: z.string().min(1),
  /** The WorkOS organization chosen at sign-in, when there was one. Sent back on refresh. */
  worg: z.string().nullable(),
  /** WorkOS session id, for the logout URL. */
  sid: z.string().nullable(),
  /** WorkOS refresh token. */
  rt: z.string().min(1),
  iat: z.int(),
  rat: z.int(),
  exp: z.int(),
});
export type SessionPayload = z.infer<typeof SessionPayload>;

export const StatePayload = z.object({
  /** The nonce WorkOS echoes back as `state`. */
  n: z.string().min(16),
  /** The same-origin path to land on. */
  r: z.string(),
  exp: z.int(),
});
export type StatePayload = z.infer<typeof StatePayload>;

export interface NewSession {
  readonly userId: string;
  readonly workosUserId: string;
  readonly email: string;
  readonly workosOrganizationId: string | null;
  readonly sessionId: string | null;
  readonly refreshToken: string;
}

/** Seconds since the epoch. */
export const epochSec = (now: Date) => Math.floor(now.getTime() / 1000);

export function newSession(input: NewSession, now: number): SessionPayload {
  return {
    v: 1,
    uid: input.userId,
    wuid: input.workosUserId,
    email: input.email,
    worg: input.workosOrganizationId,
    sid: input.sessionId,
    rt: input.refreshToken,
    iat: now,
    rat: now + REFRESH_INTERVAL_SEC,
    exp: now + SESSION_MAX_AGE_SEC,
  };
}

export const sealSession = (session: SessionPayload, password: string) =>
  seal(session, password, "session");

/** The session in a cookie value, or null when it does not open or is not one of ours. */
export async function openSession(
  sealed: string,
  password: string,
): Promise<SessionPayload | null> {
  const parsed = SessionPayload.safeParse(await unseal(sealed, password, "session"));
  return parsed.success ? parsed.data : null;
}

export const sealState = (state: StatePayload, password: string) => seal(state, password, "state");

export async function openState(sealed: string, password: string): Promise<StatePayload | null> {
  const parsed = StatePayload.safeParse(await unseal(sealed, password, "state"));
  return parsed.success ? parsed.data : null;
}

export type SessionResolution =
  | { readonly status: "valid"; readonly session: SessionPayload; readonly rotated: boolean }
  | { readonly status: "invalid"; readonly reason: string };

/** Decide whether a session admits this request, refreshing it with WorkOS when it is due. */
export async function resolveSession(
  session: SessionPayload,
  now: number,
  workos: Pick<WorkOSClient, "refresh">,
): Promise<SessionResolution> {
  if (now >= session.exp) return { status: "invalid", reason: "session expired" };
  if (now < session.rat) return { status: "valid", session, rotated: false };

  let refreshed: WorkOSAuthentication;
  try {
    refreshed = await workos.refresh(session.rt, session.worg);
  } catch (error) {
    const unreachable =
      !(error instanceof WorkOSError) || error.status === null || error.status >= 500;
    const grace = unreachable ? OUTAGE_GRACE_SEC : RACE_GRACE_SEC;
    if (now < session.rat + grace) return { status: "valid", session, rotated: false };
    return {
      status: "invalid",
      reason: unreachable ? "WorkOS could not refresh the session" : "WorkOS ended the session",
    };
  }

  // A refresh that comes back as somebody else is not a refresh.
  if (refreshed.user.id !== session.wuid) {
    return { status: "invalid", reason: "the refreshed session belongs to another user" };
  }
  return {
    status: "valid",
    rotated: true,
    session: {
      ...session,
      rt: refreshed.refreshToken,
      sid: refreshed.sessionId ?? session.sid,
      rat: now + REFRESH_INTERVAL_SEC,
    },
  };
}

export const sessionCookie = (sealed: string, session: SessionPayload, now: number) =>
  serializeCookie(SESSION_COOKIE, sealed, { maxAgeSec: session.exp - now });
export const clearSessionCookie = () => clearCookie(SESSION_COOKIE);
export const stateCookie = (sealed: string) =>
  serializeCookie(STATE_COOKIE, sealed, { maxAgeSec: STATE_MAX_AGE_SEC });
export const clearStateCookie = () => clearCookie(STATE_COOKIE);

/**
 * `return_to` as a same-origin path, `/` when not given, or null when given and not one. Only a
 * path is kept, so the redirect after sign-in cannot leave the app however it is spelled
 * (`//evil.example`, `/\evil.example`, a control character smuggled in).
 */
export function safeReturnTo(raw: string | null | undefined, appOrigin: string): string | null {
  if (raw === undefined || raw === null || raw === "") return "/";
  if (raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== appOrigin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
