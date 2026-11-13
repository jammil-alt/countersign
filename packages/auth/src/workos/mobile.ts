// Signing in from the Mezonas phone app (docs/plan.md §1.97). The app opens the usual WorkOS
// sign-in in the system browser and gets back the same sealed session a browser would hold, which it
// then sends in a header (MOBILE_SESSION_HEADER) instead of a cookie. Every rule of a session holds
// unchanged: the 12-hour limit, the 30-minute idle limit, WorkOS refresh and revocation.
//
//   1. app → GET /api/mobile/sign-in?challenge=S256(verifier): a sealed cookie remembers the
//      challenge, and the browser goes to the normal sign-in with return_to=/api/mobile/handoff.
//   2. sign-in → /api/mobile/handoff with the new session cookie: the session and the challenge
//      are sealed together into a code that lasts 2 minutes, the browser's cookies are cleared,
//      and the browser goes to mezonas://signed-in?code=….
//   3. app → POST /api/mobile/session {code, verifier}: the code opens only here (it is sealed
//      with our key), and only with the verifier whose S256 is the challenge, so a code another
//      app catches on the way back is useless to it (RFC 7636's reason for PKCE).

import {
  MOBILE_HANDOFF_SEC,
  MOBILE_SESSION_HEADER,
  MOBILE_SIGNED_IN_URL,
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
  STATE_MAX_AGE_SEC,
  sessionEnds,
} from "./session";

/** `__Host-`: Secure, Path=/, no Domain. Holds the app's challenge while the person signs in. */
export const MOBILE_START_COOKIE = "__Host-cs_mobile";

const StartPayload = z.object({ c: PkceChallenge, exp: z.int() });
const HandoffPayload = z.object({ s: z.string().min(1), c: PkceChallenge, exp: z.int() });

/** Where sign-in goes after it finishes, for the app. */
export const MOBILE_HANDOFF_PATH = "/api/mobile/handoff";

/** The cookie that carries the app's challenge through sign-in. */
export async function mobileStartCookie(
  challenge: string,
  password: string,
  now: Date,
): Promise<string> {
  const sealed = await seal(
    { c: challenge, exp: epochSec(now) + STATE_MAX_AGE_SEC },
    password,
    "mobile-start",
  );
  return serializeCookie(MOBILE_START_COOKIE, sealed, { maxAgeSec: STATE_MAX_AGE_SEC });
}

export type MobileHandoff =
  | { readonly ok: true; readonly redirectTo: string; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: "no_start" | "no_session" };

/**
 * After sign-in, in the browser: the session cookie and the app's challenge become one sealed
 * code for the app. The browser keeps neither: the session belongs to the phone now.
 */
export async function mobileHandoff(
  request: Request,
  password: string,
  now: Date,
): Promise<MobileHandoff> {
  const clear = [clearCookie(MOBILE_START_COOKIE)];
  const rawStart = requestCookie(request, MOBILE_START_COOKIE);
  const start = rawStart
    ? StartPayload.safeParse(await unseal(rawStart, password, "mobile-start"))
    : null;
  if (!start?.success || start.data.exp <= epochSec(now)) {
    return { ok: false, reason: "no_start" };
  }
  const raw = requestCookie(request, SESSION_COOKIE);
  const session = raw ? await openSession(raw, password) : null;
  if (!raw || !session) return { ok: false, reason: "no_session" };
  const code = await seal(
    { s: raw, c: start.data.c, exp: epochSec(now) + MOBILE_HANDOFF_SEC },
    password,
    "mobile-handoff",
  );
  return {
    ok: true,
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
  | { readonly ok: true; readonly session: string; readonly expiresAt: Date }
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
  if (!session) return { ok: false, reason: "invalid_code" };
  return { ok: true, session: parsed.data.s, expiresAt: new Date(sessionEnds(session) * 1000) };
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
