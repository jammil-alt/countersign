// The Mezonas phone app (docs/plan.md §1.116): how it signs in. Shared by apps/api, which checks
// it, and apps/mobile, which produces it. Pure.

import { z } from "zod";

/**
 * The header that carries the app's sealed session, both ways: the app sends it in place of the
 * browser's cookie, and the API answers with the session sealed again (a WorkOS refresh) or an
 * empty value (signed out).
 */
// DECISION: the app holds the very session the browser would (the sealed WorkOS session), carried
// in a header instead of a cookie, so every rule of a session (12-hour limit, 30-minute idle
// limit, WorkOS refresh and revocation, the account it carries) holds unchanged on the phone.
export const MOBILE_SESSION_HEADER = "x-mezonas-session";

/** The app's URL scheme, and where sign-in hands the session back to the app. */
export const MOBILE_APP_SCHEME = "mezonas";
export const MOBILE_SIGNED_IN_URL = `${MOBILE_APP_SCHEME}://signed-in`;

/** How long the handoff code from sign-in to the app lasts. */
export const MOBILE_HANDOFF_SEC = 120;

/** A PKCE verifier (RFC 7636 §4.1): 43 to 128 unreserved characters. */
export const PkceVerifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, "not a PKCE verifier");
/** Its S256 challenge: base64url of SHA-256, 43 characters. */
export const PkceChallenge = z.string().regex(/^[A-Za-z0-9\-_]{43}$/, "not a PKCE challenge");
