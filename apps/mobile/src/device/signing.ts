// The phone's signing key and what it signs (docs/plan.md §1.99). The key is ECDSA P-256; its
// private half lives only in the phone's secure store behind Face ID or a fingerprint
// (src/state/store.ts), its public half is registered with POST /api/me/devices as a JWK. A
// signature covers `deviceSignedText` (core): the device, the item, the decision, the item's
// fingerprint and the time. The API checks it with Web Crypto (ECDSA, SHA-256, r‖s).
import {
  type DevicePublicKey,
  type DeviceSignature,
  deviceSignedText,
  itemFingerprintText,
} from "@countersign/core";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, fromHex, toHex, utf8 } from "../util/bytes";

/** A new private key from 48 random bytes (reduced onto the curve's order by noble). */
export function newPrivateKey(seed: Uint8Array): Uint8Array {
  if (seed.length < 40) throw new Error("the seed needs at least 40 random bytes");
  return p256.utils.randomSecretKey(seed);
}

/** The public half as the API stores it: an EC P-256 JWK, x and y base64url. */
export function publicJwk(privateKey: Uint8Array): DevicePublicKey {
  const point = p256.getPublicKey(privateKey, false);
  // Uncompressed SEC1: 0x04, then x (32 bytes), then y (32 bytes).
  return {
    kty: "EC",
    crv: "P-256",
    x: base64url(point.slice(1, 33)),
    y: base64url(point.slice(33, 65)),
  };
}

/** The private key as stored: hex text, since the secure store keeps strings. */
export const encodePrivateKey = (key: Uint8Array) => toHex(key);
export const decodePrivateKey = (text: string) => fromHex(text);

/** SHA-256 of the item as the person reads it (core `itemFingerprintText`), hex. */
export function itemFingerprint(item: {
  id: string;
  title: string;
  display?: unknown;
  payload?: unknown;
}): string {
  return toHex(sha256(utf8(itemFingerprintText(item))));
}

/**
 * Signs a decision on an item. `at` is when the person signed; the API refuses a time more than
 * five minutes from its own.
 */
export function signDecision(input: {
  privateKey: Uint8Array;
  deviceId: string;
  item: { id: string; title: string; display?: unknown; payload?: unknown };
  decision: "approve" | "reject";
  at: Date;
}): DeviceSignature {
  const fingerprint = itemFingerprint(input.item);
  const at = input.at.toISOString();
  const text = deviceSignedText({
    deviceId: input.deviceId,
    itemId: input.item.id,
    decision: input.decision,
    fingerprint,
    at,
  });
  // prehash (SHA-256 of the text), low-S, compact r‖s: what Web Crypto's ECDSA verify expects.
  const signature = p256.sign(utf8(text), input.privateKey, { prehash: true, lowS: true });
  return { deviceId: input.deviceId, at, fingerprint, signature: base64url(signature) };
}
