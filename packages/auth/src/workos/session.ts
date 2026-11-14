// The sealed session cookie: what is in it, how long it lasts, and when it is refreshed (ported
// from Plenary Labs' apps/api/src/identity/session.ts).
//
// It holds the app user, the WorkOS user, the WorkOS refresh token and session id, three times,
// and the account (the user's memberships) as last read, for ACCOUNT_WINDOW_SEC (../account.ts,
// docs/plan.md §1.93). Sealed with AES-GCM (../seal.ts): a changed byte is a cookie that does not
// open, treated exactly like no cookie. A new sign-in starts without an account; sign-out and the
// idle lock clear the cookie, and the account with it.
//
// Lifetime (docs/plan.md §1.35):
//   - `exp`: an absolute limit, 12 hours after sign-in (SESSION_MAX_AGE_SEC in core). A cookie
//     from before that limit (30 days) ends 12 hours after its own sign-in too.
//   - `lat` ("last active"): the last request the person made themselves (the app sends
//     SESSION_ACTIVITY_HEADER). After SESSION_IDLE_SEC without one, the session ends. A cookie
//     without `lat` counts its last refresh as activity.
//   - `rat` ("refresh at"): 5 minutes after the last refresh. After it, the refresh token is
//     exchanged with WorkOS before the request is admitted, so a session ended in WorkOS stops
//     working here within five minutes.
// Two allowances keep a refresh from signing people out for the wrong reasons:
//   - Racing tabs: refresh tokens rotate, so of two requests with the same due cookie the second
//     is refused by WorkOS. Within RACE_GRACE_SEC of `rat` that request is admitted on the old
//     cookie; the first request's response already gave the browser the new one.
//   - WorkOS unreachable (network or 5xx): admitted for up to OUTAGE_GRACE_SEC past `rat`.

import {
  SESSION_MAX_AGE_SEC as MAX_AGE,
  SECOND_FACTOR_PENDING_SEC,
  SECOND_FACTOR_REMEMBER_SEC,
  SESSION_ACTIVITY_WINDOW_SEC,
  SESSION_IDLE_SEC,
  SecondFactorState,
} from "@countersign/core";
import { z } from "zod";
import { clearCookie, serializeCookie } from "../cookies";
import { seal, unseal } from "../seal";
import { type WorkOSAuthentication, type WorkOSClient, WorkOSError } from "./client";

/** `__Host-`: Secure, Path=/, no Domain, so a subdomain can neither read nor plant it. */
export const SESSION_COOKIE = "__Host-cs_session";
export const STATE_COOKIE = "__Host-cs_auth_state";
/** §1.99: a browser that passed the second step, remembered for 30 days. */
export const DEVICE_COOKIE = "__Host-cs_device";

export const SESSION_MAX_AGE_SEC = MAX_AGE;
export const IDLE_TIMEOUT_SEC = SESSION_IDLE_SEC;
export const REFRESH_INTERVAL_SEC = 5 * 60;
export const RACE_GRACE_SEC = 60;
export const OUTAGE_GRACE_SEC = 15 * 60;
/** How long a sign-in may take, start to callback: long enough for an emailed code (plan §1.35). */
export const STATE_MAX_AGE_SEC = 30 * 60;

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
  /** Last activity (seconds); absent on cookies from before the idle limit. */
  lat: z.int().optional(),
  /**
   * §1.99: the second step. `pending` until passed (by `mfx`, else the sign-in starts again),
   * `done`, or `exempt` (the step is off here, or the sign-in was the person's company SSO).
   * Absent on cookies from before the step; refused once the step is on.
   */
  mf: SecondFactorState.optional(),
  mfx: z.int().optional(),
  /**
   * The account as last read (`compactAccount`), checked by `expandAccount` when used: a shape we
   * no longer read is a read, never a signed-out session.
   */
  acct: z.unknown().optional(),
});
export type SessionPayload = z.infer<typeof SessionPayload>;

/** §1.99: the remembered browser. `fid` is the method it passed with: a reset removes it. */
export const DevicePayload = z.object({
  uid: z.uuid(),
  fid: z.uuid(),
  exp: z.int(),
});
export type DevicePayload = z.infer<typeof DevicePayload>;

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
  /** §1.99: where the new session starts with the second step (default exempt: the step is off). */
  readonly secondFactor?: SecondFactorState;
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
    lat: now,
    mf: input.secondFactor ?? "exempt",
    ...(input.secondFactor === "pending" ? { mfx: now + SECOND_FACTOR_PENDING_SEC } : {}),
  };
}

/** When the session ends whatever happens: its own `exp`, or 12 hours after sign-in. */
export const sessionEnds = (session: SessionPayload): number =>
  Math.min(session.exp, session.iat + SESSION_MAX_AGE_SEC);

/** The session's last activity; an old cookie without `lat` counts its last refresh. */
export const lastActive = (session: SessionPayload): number =>
  session.lat ?? session.rat - REFRESH_INTERVAL_SEC;

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

export const sealDevice = (device: DevicePayload, password: string) =>
  seal(device, password, "device");

/** The remembered browser in a cookie value, or null when it does not open or has expired. */
export async function openDevice(
  sealed: string,
  password: string,
  now: number,
): Promise<DevicePayload | null> {
  const parsed = DevicePayload.safeParse(await unseal(sealed, password, "device"));
  return parsed.success && now < parsed.data.exp ? parsed.data : null;
}

/** A browser remembered for 30 days for this person and method. */
export async function deviceCookie(
  input: { userId: string; factorId: string },
  password: string,
  now: number,
): Promise<string> {
  const sealed = await sealDevice(
    { uid: input.userId, fid: input.factorId, exp: now + SECOND_FACTOR_REMEMBER_SEC },
    password,
  );
  return serializeCookie(DEVICE_COOKIE, sealed, { maxAgeSec: SECOND_FACTOR_REMEMBER_SEC });
}
export const clearDeviceCookie = () => clearCookie(DEVICE_COOKIE);

// DECISION: the one automatic restart of a failed callback (plan §1.35, "Sign-in callback") is
// marked in the `state` WorkOS echoes back, as `2.` before the nonce. The callback reads it from
// its own URL, so a browser that drops the state cookie still can't loop. A nonce is base64url,
// so it never holds a dot. The mark is part of the nonce kept in the state cookie, so the CSRF
// check (state cookie equals `state`, unexpired) is unchanged.
const RESTART_MARK = "2.";

/** The nonce for a sign-in started again by the callback. */
export const restartNonce = (nonce: string) => `${RESTART_MARK}${nonce}`;

/** Whether a callback's `state` comes from a sign-in the callback already started again. */
export const isRestartState = (stateParam: string) =>
  stateParam.slice(0, RESTART_MARK.length) === RESTART_MARK;

export async function openState(sealed: string, password: string): Promise<StatePayload | null> {
  const parsed = StatePayload.safeParse(await unseal(sealed, password, "state"));
  return parsed.success ? parsed.data : null;
}

export type SessionResolution =
  | {
      readonly status: "valid";
      readonly session: SessionPayload;
      readonly rotated: boolean;
      /**
       * Admitted on the race or outage grace: the refresh failed, so `session` still holds the old
       * refresh token, which another request may already have spent (docs/plan.md §1.93).
       */
      readonly grace?: true;
    }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Decide whether a session admits this request, refreshing it with WorkOS when it is due.
 * `active`: the person made this request themselves (SESSION_ACTIVITY_HEADER), so it moves `lat`.
 */
export async function resolveSession(
  session: SessionPayload,
  now: number,
  workos: Pick<WorkOSClient, "refresh">,
  active = false,
): Promise<SessionResolution> {
  if (now >= sessionEnds(session)) return { status: "invalid", reason: "session expired" };
  if (now - lastActive(session) >= IDLE_TIMEOUT_SEC) {
    return { status: "invalid", reason: "signed out after 30 minutes without activity" };
  }
  // DECISION: `lat` is written at most once a minute, so an active person's every click doesn't
  // re-seal the cookie; the idle limit is 30 minutes, so a minute's slack changes nothing.
  const touched =
    active && now - lastActive(session) >= SESSION_ACTIVITY_WINDOW_SEC
      ? { ...session, lat: now }
      : session;
  if (now < session.rat) {
    return { status: "valid", session: touched, rotated: touched !== session };
  }

  let refreshed: WorkOSAuthentication;
  try {
    refreshed = await workos.refresh(session.rt, session.worg);
  } catch (error) {
    const unreachable =
      !(error instanceof WorkOSError) || error.status === null || error.status >= 500;
    const grace = unreachable ? OUTAGE_GRACE_SEC : RACE_GRACE_SEC;
    if (now < session.rat + grace) {
      // DECISION: admitted on a grace, the cookie is never re-sealed, not even to move `lat`: it
      // holds the refresh token this request failed to use, which another tab may have spent
      // already, and a cookie written now could land last and end the session at the next
      // refresh (docs/plan.md §1.93). The next request that refreshes moves `lat`.
      return { status: "valid", session, rotated: false, grace: true };
    }
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
      ...touched,
      rt: refreshed.refreshToken,
      sid: refreshed.sessionId ?? session.sid,
      rat: now + REFRESH_INTERVAL_SEC,
    },
  };
}

export const sessionCookie = (sealed: string, session: SessionPayload, now: number) =>
  serializeCookie(SESSION_COOKIE, sealed, { maxAgeSec: sessionEnds(session) - now });
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
