// The Mezonas phone app (docs/plan.md §1.97): how it signs in, which phones a person registered,
// and the signature a phone adds when its owner signs a Desk item with Face ID or a fingerprint.
// Shared by apps/api, which checks all of it, and apps/mobile, which produces it. Pure: hashing
// and verification run in the API with Web Crypto; the app signs with its own library.

import { z } from "zod";
import { canonicalJson } from "../canonical";

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

export const DevicePlatform = z.enum(["ios", "android"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** An Expo push token (`ExponentPushToken[…]`): what Expo's push service sends to. */
export const PushToken = z
  .string()
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9\-_]+\]$/, "not an Expo push token");

/** The public half of a phone's signing key: an EC P-256 JWK (no private part). */
export const DevicePublicKey = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9\-_]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9\-_]{43}$/),
});
export type DevicePublicKey = z.infer<typeof DevicePublicKey>;

/** One of the person's phones, as Settings shows it. Never the push token or the key. */
export const MyDevice = z.object({
  id: z.string(),
  name: z.string(),
  platform: DevicePlatform,
  /** It has a push token: notifications reach it. */
  push: z.boolean(),
  /** It has a signing key: Face ID signing works from it. */
  signing: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type MyDevice = z.infer<typeof MyDevice>;

/** A person's push settings (`tenant.settings.user_notifications[userId].push*`). */
export const MyPush = z.object({
  /** Notifications on their phones. */
  on: z.boolean(),
  /** Items waiting: within the next pass (`now`), or at most once an hour like email. */
  every: z.enum(["now", "hour"]),
  /** The lock screen names the business ("Northside Millwork: 3 items wait on you"). */
  showClient: z.boolean(),
  /** How many of their phones can get them. */
  devices: z.number().int().min(0),
});
export type MyPush = z.infer<typeof MyPush>;

// ── Signing an item from a phone ────────────────────────────────────────────────────────────────

/** How far a signature's time may be from the server's, either way. */
export const DEVICE_SIGNATURE_SKEW_SEC = 5 * 60;

export const DeviceSignature = z.strictObject({
  deviceId: z.string().uuid(),
  /** When the person signed (ISO 8601), part of what is signed. */
  at: z.string().datetime(),
  /** The item as the person saw it: `itemFingerprint` of the Desk item. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** ECDSA P-256 over SHA-256 of `deviceSignedText(...)`, r‖s (64 bytes), base64url. */
  signature: z.string().regex(/^[A-Za-z0-9\-_]{86}$/),
});
export type DeviceSignature = z.infer<typeof DeviceSignature>;

/**
 * What a phone signs: fixed lines, so the same inputs always give the same bytes. The decision is
 * part of it, so an approval's signature can't be replayed as anything else.
 */
export function deviceSignedText(input: {
  deviceId: string;
  itemId: string;
  decision: "approve" | "reject";
  fingerprint: string;
  at: string;
}): string {
  return [
    "mezonas-sign:v1",
    input.deviceId,
    input.itemId,
    input.decision,
    input.fingerprint,
    input.at,
  ].join("\n");
}

/**
 * The part of a Desk item a signature covers: its title, the change's display and its payload
 * (the input to be written, the person's edit, the record before, the lines and amounts), in
 * canonical JSON. A change after the person looked is a different fingerprint, and the signature
 * is refused.
 */
// DECISION: the fingerprint covers the item as the portal returns it to the person (title,
// display and payload) rather than internal ids or timestamps, so the app and the API compute it
// from the same object, with nothing the portal hides. `display` alone is the tool's field layout,
// not the values, which is why the payload is in it.
export function itemFingerprintText(item: {
  id: string;
  title: string;
  display?: unknown;
  payload?: unknown;
}): string {
  return canonicalJson({
    id: item.id,
    title: item.title,
    display: item.display ?? null,
    payload: item.payload ?? null,
  });
}
