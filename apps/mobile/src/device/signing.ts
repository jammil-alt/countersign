// The phone's signing key and what it signs (docs/plan.md §1.116). The key is ECDSA P-256; its
// private half lives only in the phone's secure store behind Face ID or a fingerprint
// (src/state/store.ts), its public half is registered with POST /api/me/devices as a JWK. A
// signature covers `deviceSignedText` (core): the device, the item, the decision, the item's
// fingerprint and the time, and, in its `v2` text (§1.203), the answer and the note sent with it. The API checks it with Web Crypto (ECDSA, SHA-256, r‖s).
import {
  type DevicePublicKey,
  type DeviceSignature,
  deviceSignedText,
  itemFingerprintText,
  type SignInApprovalDecideBody,
  type SignInApprovalsBody,
  signInApprovalText,
  signInListText,
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
 * Signs a decision on an item, with the answer and the note sent with it (`v2`, §1.203). `at` is
 * when the person signed; the API refuses a time more than five minutes from its own.
 */
// DECISION (§1.203): the app signs `v2` only; the API still takes `v1` from phones in the field.
export function signDecision(input: {
  privateKey: Uint8Array;
  deviceId: string;
  item: { id: string; title: string; display?: unknown; payload?: unknown };
  decision: "approve" | "reject";
  answer?: string;
  note?: string;
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
    version: "v2",
    answer: input.answer,
    note: input.note,
  });
  // prehash (SHA-256 of the text), low-S, compact r‖s: what Web Crypto's ECDSA verify expects.
  const signature = p256.sign(utf8(text), input.privateKey, { prehash: true, lowS: true });
  return {
    deviceId: input.deviceId,
    at,
    fingerprint,
    signature: base64url(signature),
    version: "v2",
  };
}

/** What the app sends to decide an item (`POST /api/inbox/:id/resolve`), signed on this phone. */
export interface SignedDecisionBody {
  decision: "approve" | "reject";
  answer?: string;
  /** A note with the decision; the signature covers it (§1.203). */
  note?: string;
  /** Audit 3.4: the item as the person saw it. */
  fingerprint: string;
  deviceSignature: DeviceSignature;
}

/**
 * Audit 5.2: every decision the app sends, a change signed or rejected, a question answered or a
 * quick answer, carries this phone's signature: the API refuses the app's session without one
 * (403 `signature_required`). Reading the key is the Face ID or fingerprint check (`readKey`,
 * src/state/store.ts). A phone not set up to sign, or a check that didn't finish, sends nothing.
 */
export async function signedDecision(input: {
  deviceId: string | null;
  item: { id: string; title: string; display?: unknown; payload?: unknown };
  decision: "approve" | "reject";
  answer?: string;
  note?: string;
  prompt: string;
  readKey: (prompt: string) => Promise<string | null>;
  at?: Date;
}): Promise<{ ok: true; body: SignedDecisionBody } | { ok: false; problem: string }> {
  if (!input.deviceId) {
    return {
      ok: false,
      problem: "This phone isn't set up to sign. Set it up in Settings, then try again.",
    };
  }
  const key = await input.readKey(input.prompt);
  if (!key) return { ok: false, problem: "Face ID didn't finish, so nothing was sent." };
  const deviceSignature = signDecision({
    privateKey: decodePrivateKey(key),
    deviceId: input.deviceId,
    item: input.item,
    decision: input.decision,
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    at: input.at ?? new Date(),
  });
  return {
    ok: true,
    body: {
      decision: input.decision,
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      fingerprint: deviceSignature.fingerprint,
      deviceSignature,
    },
  };
}

// ── Approving a sign-in (docs/plan.md §1.154) ────────────────────────────────────────────────────

const signText = (text: string, privateKey: Uint8Array) =>
  base64url(p256.sign(utf8(text), privateKey, { prehash: true, lowS: true }));

/** The body that lists the sign-ins waiting on this phone, signed with its key. */
export function signSignInList(input: {
  privateKey: Uint8Array;
  userId: string;
  deviceId: string;
  at: Date;
}): SignInApprovalsBody {
  const at = input.at.toISOString();
  const { userId, deviceId } = input;
  return {
    userId,
    deviceId,
    at,
    signature: signText(signInListText({ userId, deviceId, at }), input.privateKey),
  };
}

/** The body that approves a waiting sign-in with the number picked, or denies it, signed. */
export function signSignInDecision(input: {
  privateKey: Uint8Array;
  approvalId: string;
  userId: string;
  deviceId: string;
  decision: "approve" | "deny";
  number: number | null;
  at: Date;
}): SignInApprovalDecideBody {
  const at = input.at.toISOString();
  const { approvalId, userId, deviceId, decision, number } = input;
  return {
    userId,
    deviceId,
    at,
    decision,
    number,
    signature: signText(
      signInApprovalText({ approvalId, userId, deviceId, decision, number, at }),
      input.privateKey,
    ),
  };
}
