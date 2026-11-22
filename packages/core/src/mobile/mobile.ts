// The Mezonas phone app (docs/plan.md §1.116): how it signs in, which phones a person registered,
// and the signature a phone adds when its owner signs a Desk item with Face ID or a fingerprint.
// Shared by apps/api, which checks all of it, and apps/mobile, which produces it. Pure: hashing
// and verification run in the API with Web Crypto; the app signs with its own library.

import { z } from "zod";
import { canonicalJson, sha256Hex } from "../canonical";
import { isPlainObject } from "../json";

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

/** An item's fingerprint (`itemFingerprint`): SHA-256, hex. */
export const ItemFingerprint = z.string().regex(/^[0-9a-f]{64}$/);

/** The signed texts the API accepts: `v1` (phones already in the field) and `v2` (§1.203). */
export const DeviceSignedVersion = z.enum(["v1", "v2"]);
export type DeviceSignedVersion = z.infer<typeof DeviceSignedVersion>;

export const DeviceSignature = z.strictObject({
  deviceId: z.string().uuid(),
  /** When the person signed (ISO 8601), part of what is signed. */
  at: z.string().datetime(),
  /** The item as the person saw it: `itemFingerprint` of the Desk item. */
  fingerprint: ItemFingerprint,
  /** ECDSA P-256 over SHA-256 of `deviceSignedText(...)`, r‖s (64 bytes), base64url. */
  signature: z.string().regex(/^[A-Za-z0-9\-_]{86}$/),
  /**
   * Which signed text (`deviceSignedText`): absent or `v1`, the decision on the item as shown;
   * `v2` also the answer's text and the note sent with it (docs/plan.md §1.203).
   */
  version: DeviceSignedVersion.optional(),
});
export type DeviceSignature = z.infer<typeof DeviceSignature>;

/**
 * What a phone signs: fixed lines, so the same inputs always give the same bytes. The decision is
 * part of it, so an approval's signature can't be replayed as anything else. `v2` adds two lines:
 * the answer and the note sent with the decision, each as canonical JSON (`null` when there is
 * none), so an answer's text or a note changed on the way is a signature that doesn't match.
 */
// DECISION (§1.203): v2 is v1's lines with the answer and the note appended, each one line of
// canonical JSON (JSON escapes a line break, so neither can add a line of its own), rather than
// a hash of them: the text stays readable in a test, and the answer is any JSON the resolve takes,
// not only a string. Absent and `null` are the same line: both are "no answer" to the resolve.
export function deviceSignedText(input: {
  deviceId: string;
  itemId: string;
  decision: "approve" | "reject";
  fingerprint: string;
  at: string;
  /** Absent: `v1`, the text phones already in the field sign. */
  version?: DeviceSignedVersion;
  /** `v2` only: the answer sent with the decision. */
  answer?: unknown;
  /** `v2` only: the note sent with the decision. */
  note?: string | null | undefined;
}): string {
  const v1 = [input.deviceId, input.itemId, input.decision, input.fingerprint, input.at];
  if ((input.version ?? "v1") === "v1") return ["mezonas-sign:v1", ...v1].join("\n");
  return [
    "mezonas-sign:v2",
    ...v1,
    canonicalJson(input.answer ?? null),
    canonicalJson(input.note ?? null),
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
// DECISION (review of audit 3.4): the display's `names` (labels for ids the before state leaves
// bare, looked up from synced records as the response is built) are left out: they are help text
// derived from the records, not what is written or approved, and a lookup may name an id in one
// response and not in another. Everything written and approved (the input, the edit, the record
// before, the title, the tool's display) is covered.
export function itemFingerprintText(item: {
  id: string;
  title: string;
  display?: unknown;
  payload?: unknown;
}): string {
  const display =
    isPlainObject(item.display) && "names" in item.display
      ? Object.fromEntries(Object.entries(item.display).filter(([k]) => k !== "names"))
      : (item.display ?? null);
  return canonicalJson({
    id: item.id,
    title: item.title,
    display,
    payload: item.payload ?? null,
  });
}

/**
 * Audit 3.4: SHA-256 (hex) of `itemFingerprintText`, with Web Crypto: what the web sends with an
 * answer as the item the person saw (`ResolveBody.fingerprint`), and what the API compares it
 * with. The phone computes the same with its own library.
 */
export function itemFingerprint(item: {
  id: string;
  title: string;
  display?: unknown;
  payload?: unknown;
}): Promise<string> {
  return sha256Hex(itemFingerprintText(item));
}
