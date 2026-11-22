// Signing in from the Mezonas phone app (docs/plan.md §1.116). The app opens the usual WorkOS
// sign-in in the system browser and gets back the same sealed session a browser would hold, which it
// then sends in a header (MOBILE_SESSION_HEADER) instead of a cookie. Every rule of a session holds
// unchanged: the 12-hour limit, the 30-minute idle limit, WorkOS refresh and revocation.
//
//   1. app → GET /api/mobile/sign-in?challenge=S256(verifier): a sealed cookie remembers the
//      challenge, and the browser goes to the normal sign-in with return_to=/api/mobile/handoff.
//   2. sign-in → (the second step, §1.100, when it is on) → /api/mobile/handoff with the new
//      session cookie: the session and the challenge are sealed together into a code that lasts
//      2 minutes, the browser's cookies are cleared, and the browser goes to
//      mezonas://signed-in?code=….
//   3. app → POST /api/mobile/session {code, verifier}: the code opens only here (it is sealed
//      with our key), and only with the verifier whose S256 is the challenge, so a code another
//      app catches on the way back is useless to it (RFC 7636's reason for PKCE).
//
// The second step (§1.100) holds as it does in a browser, and a little more: a session whose step
// is still pending is never handed over or redeemed, so the phone only ever holds a session that
// passed it (or is exempt: SSO, or the step off); and a sign-in for the phone is never let through
// by a remembered browser (`isMobileSignIn`, read by the WorkOS adapter's callback), since the
// session leaves that browser. The account the cookie carries (§1.93) is not handed over: the
// phone's first request reads it again.

import {
  MOBILE_HANDOFF_SEC,
  MOBILE_SESSION_HEADER,
  MOBILE_SIGNED_IN_URL,
  MobileApp,
  PkceChallenge,
} from "@countersign/core";
import { z } from "zod";
import { clearCookie, readCookie, requestCookie, serializeCookie } from "../cookies";
import { bytesToBase64Url, seal, timingSafeEqual, unseal } from "../seal";
import {
  clearSessionCookie,
  epochSec,
  openSession,
  SESSION_COOKIE,
  type SessionPayload,
  STATE_MAX_AGE_SEC,
  sealSession,
  sessionEnds,
} from "./session";

/** `__Host-`: Secure, Path=/, no Domain. Holds the app's challenge while the person signs in. */
export const MOBILE_START_COOKIE = "__Host-cs_mobile";

// §1.219: `a` names the app the sign-in is for; a cookie or code sealed before it has none and is
// the phone's, as it was.
const StartPayload = z.object({ c: PkceChallenge, a: MobileApp.optional(), exp: z.int() });
const HandoffPayload = z.object({
  s: z.string().min(1),
  c: PkceChallenge,
  a: MobileApp.optional(),
  exp: z.int(),
});

/** Where sign-in goes after it finishes, for the app. */
export const MOBILE_HANDOFF_PATH = "/api/mobile/handoff";

/** The cookie that carries the app's challenge through sign-in. */
export async function mobileStartCookie(
  challenge: string,
  password: string,
  now: Date,
  app: MobileApp = "phone",
): Promise<string> {
  const sealed = await seal(
    { c: challenge, a: app, exp: epochSec(now) + STATE_MAX_AGE_SEC },
    password,
    "mobile-start",
  );
  return serializeCookie(MOBILE_START_COOKIE, sealed, { maxAgeSec: STATE_MAX_AGE_SEC });
}

export type MobileHandoff =
  | {
      readonly ok: true;
      readonly app: MobileApp;
      readonly redirectTo: string;
      readonly setCookies: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "no_start" | "no_session" | "second_factor_pending";
    };

/**
 * Whether this request is part of a sign-in for the phone app: it carries the app's start cookie.
 * The WorkOS adapter's callback reads it: such a sign-in is never let through by a remembered
 * browser (§1.100), since the session it makes goes to the phone, not this browser.
 */
export function isMobileSignIn(request: Request): boolean {
  return Boolean(requestCookie(request, MOBILE_START_COOKIE));
}

/** The app's sign-in this browser is in the middle of, read from the start cookie. */
async function startOf(
  request: Request,
  password: string,
  now: Date,
): Promise<{ readonly c: string; readonly a: MobileApp } | null> {
  const raw = requestCookie(request, MOBILE_START_COOKIE);
  if (!raw) return null;
  const start = StartPayload.safeParse(await unseal(raw, password, "mobile-start"));
  if (!start.success || start.data.exp <= epochSec(now)) return null;
  return { c: start.data.c, a: start.data.a ?? "phone" };
}

/**
 * §1.219: which app this browser's sign-in is for (the start cookie, opened and in date), or null
 * when it is in no app's sign-in. The audit rows and the confirm page name it.
 */
export async function mobileSignInApp(
  request: Request,
  password: string,
  now: Date,
): Promise<MobileApp | null> {
  return (await startOf(request, password, now))?.a ?? null;
}

/**
 * A session as the phone gets it: open, past the second step, within its 12 hours, marked as a
 * phone session (`ph`), and without the account the cookie carries (§1.93; the phone reads it
 * again on its first request).
 */
async function forThePhone(
  sealed: string,
  password: string,
  now: Date,
): Promise<{ readonly sealed: string; readonly payload: SessionPayload } | "none" | "pending"> {
  const opened = await openSession(sealed, password);
  if (!opened || epochSec(now) >= sessionEnds(opened)) return "none";
  // DECISION (§1.116 with §1.100): a pending second step is never handed to the phone, whatever
  // the route in front of this already checked.
  if (opened.mf === "pending") return "pending";
  // §1.116: marked as the phone's, so removing a phone ends it; sealed again without the account.
  const { acct: _carried, ...rest } = opened;
  const payload: SessionPayload = { ...rest, ph: true };
  return { sealed: await sealSession(payload, password), payload };
}

/**
 * After sign-in, in the browser: the session cookie and the app's challenge become one sealed
 * code for the app. The browser keeps neither: the session belongs to the phone now. `current` is
 * the session as the API just identified it (rotated by a WorkOS refresh, if it was); without it,
 * the request's own cookie.
 */
export async function mobileHandoff(
  request: Request,
  password: string,
  now: Date,
  current?: string | null,
): Promise<MobileHandoff> {
  const clear = [clearCookie(MOBILE_START_COOKIE)];
  const start = await startOf(request, password, now);
  if (!start) return { ok: false, reason: "no_start" };
  const raw = current || requestCookie(request, SESSION_COOKIE);
  const session = raw ? await forThePhone(raw, password, now) : "none";
  if (session === "none") return { ok: false, reason: "no_session" };
  if (session === "pending") return { ok: false, reason: "second_factor_pending" };
  const code = await seal(
    { s: session.sealed, c: start.c, a: start.a, exp: epochSec(now) + MOBILE_HANDOFF_SEC },
    password,
    "mobile-handoff",
  );
  return {
    ok: true,
    app: start.a,
    redirectTo: `${MOBILE_SIGNED_IN_URL}?code=${encodeURIComponent(code)}`,
    setCookies: [...clear, clearSessionCookie()],
  };
}

/** S256 of a PKCE verifier (RFC 7636 §4.2). */
export async function pkceChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export type MobileRedeem =
  | {
      readonly ok: true;
      readonly app: MobileApp;
      readonly session: string;
      readonly userId: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: "invalid_code" | "expired" | "verifier_mismatch" };

/** The app's code and verifier, traded for its session. */
export async function mobileRedeem(
  code: string,
  verifier: string,
  password: string,
  now: Date,
): Promise<MobileRedeem> {
  const parsed = HandoffPayload.safeParse(await unseal(code, password, "mobile-handoff"));
  if (!parsed.success) return { ok: false, reason: "invalid_code" };
  if (parsed.data.exp <= epochSec(now)) return { ok: false, reason: "expired" };
  if (!timingSafeEqual(await pkceChallengeOf(verifier), parsed.data.c)) {
    return { ok: false, reason: "verifier_mismatch" };
  }
  const session = await openSession(parsed.data.s, password);
  // A handoff never holds a pending step (`forThePhone`); checked again all the same.
  if (!session || session.mf === "pending") return { ok: false, reason: "invalid_code" };
  if (epochSec(now) >= sessionEnds(session)) return { ok: false, reason: "expired" };
  return {
    ok: true,
    app: parsed.data.a ?? "phone",
    session: parsed.data.s,
    userId: session.uid,
    expiresAt: new Date(sessionEnds(session) * 1000),
  };
}

// ── The session in a header ─────────────────────────────────────────────────────────────────────

/**
 * The request as the API reads it: an app's MOBILE_SESSION_HEADER becomes the session cookie, so
 * every session rule runs as it does for a browser. A request that also carries cookies keeps
 * only the header's session: the app never has the browser's.
 */
export function withMobileSession(request: Request): Request {
  const value = request.headers.get(MOBILE_SESSION_HEADER);
  if (value === null) return request;
  const headers = new Headers(request.headers);
  headers.delete(MOBILE_SESSION_HEADER);
  // DECISION: an empty or malformed header is no session at all (the cookie is dropped too), so
  // a request can't fall back to a browser cookie it happens to carry.
  if (/^[A-Za-z0-9\-_.~]+$/.test(value)) headers.set("cookie", `${SESSION_COOKIE}=${value}`);
  else headers.delete("cookie");
  return new Request(request, { headers });
}

/**
 * What the app gets back in MOBILE_SESSION_HEADER from the session cookie a response would set:
 * the new sealed value, `""` when it was cleared, or null when the session didn't change.
 */
export function mobileSessionFromSetCookies(setCookies: readonly string[]): string | null {
  let out: string | null = null;
  for (const cookie of setCookies) {
    const [pair] = cookie.split(";");
    if (!pair) continue;
    const value = readCookie(pair, SESSION_COOKIE);
    if (pair.trim().startsWith(`${SESSION_COOKIE}=`)) {
      const cleared = /;\s*Max-Age=0\b/i.test(cookie);
      out = cleared ? "" : (value ?? "");
    }
  }
  return out;
}
