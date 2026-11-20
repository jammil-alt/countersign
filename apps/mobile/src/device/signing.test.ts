// The phone's signature, checked the way the API checks it: Web Crypto, ECDSA P-256 over SHA-256
// of core's `deviceSignedText`, the public key imported from the JWK the phone registered.

import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  DevicePublicKey,
  DeviceSignature,
  deviceSignedText,
  itemFingerprintText,
  SignInApprovalDecideBody,
  SignInApprovalsBody,
  signInApprovalText,
  signInListText,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { fromBase64url } from "../util/bytes";
import {
  decodePrivateKey,
  encodePrivateKey,
  itemFingerprint,
  newPrivateKey,
  publicJwk,
  signDecision,
  signedDecision,
  signSignInDecision,
  signSignInList,
} from "./signing";

const item = {
  id: "0190a1b2-0000-7000-8000-00000000b001",
  title: "Send PO 1042 to Hardwood Supply for $4,820.00",
  display: { connectorName: "QuickBooks", tool: null },
};
const deviceId = "0190a1b2-0000-7000-8000-00000000d001";

async function verify(jwk: DevicePublicKey, signature: string, text: string): Promise<boolean> {
  const key = await webcrypto.subtle.importKey(
    "jwk",
    { ...jwk, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64url(signature),
    new TextEncoder().encode(text),
  );
}

describe("signing a Desk item on the phone", () => {
  const privateKey = newPrivateKey(new Uint8Array(randomBytes(48)));
  const jwk = publicJwk(privateKey);

  it("registers a public key the contract accepts", () => {
    expect(DevicePublicKey.safeParse(jwk).success).toBe(true);
    expect(decodePrivateKey(encodePrivateKey(privateKey))).toEqual(privateKey);
  });

  it("fingerprints the item with core's text", () => {
    const expected = createHash("sha256").update(itemFingerprintText(item)).digest("hex");
    expect(itemFingerprint(item)).toBe(expected);
  });

  it("makes a signature the API's Web Crypto check accepts, and only for what was signed", async () => {
    const at = new Date("2026-11-13T15:00:00.000Z");
    const sig = signDecision({ privateKey, deviceId, item, decision: "approve", at });
    expect(DeviceSignature.safeParse(sig).success).toBe(true);
    expect(sig.at).toBe(at.toISOString());
    const signed = deviceSignedText({
      deviceId,
      itemId: item.id,
      decision: "approve",
      fingerprint: sig.fingerprint,
      at: sig.at,
    });
    expect(await verify(jwk, sig.signature, signed)).toBe(true);
    // The same signature is not a rejection, nor another item, nor another time.
    expect(await verify(jwk, sig.signature, signed.replace("\napprove\n", "\nreject\n"))).toBe(
      false,
    );
    expect(await verify(jwk, sig.signature, signed.replace(item.id, deviceId))).toBe(false);
    expect(await verify(jwk, sig.signature, signed.replace("15:00:00", "15:00:01"))).toBe(false);
  });

  it("is refused under another phone's key", async () => {
    const other = publicJwk(newPrivateKey(new Uint8Array(randomBytes(48))));
    const sig = signDecision({ privateKey, deviceId, item, decision: "reject", at: new Date() });
    const signed = deviceSignedText({
      deviceId,
      itemId: item.id,
      decision: "reject",
      fingerprint: sig.fingerprint,
      at: sig.at,
    });
    expect(await verify(jwk, sig.signature, signed)).toBe(true);
    expect(await verify(other, sig.signature, signed)).toBe(false);
  });

  it("refuses a short seed", () => {
    expect(() => newPrivateKey(new Uint8Array(16))).toThrow();
  });
});

// Audit 5.2: the API refuses a decision from the app's session without the phone's signature, so
// every decision the app sends (a change signed or rejected, a question answered, a quick answer)
// is built here, signed, or not sent at all.
describe("a decision as the app sends it", () => {
  const privateKey = newPrivateKey(new Uint8Array(randomBytes(48)));
  const jwk = publicJwk(privateKey);
  const readKey = async () => encodePrivateKey(privateKey);

  it("signs an answer with the phone's key, as a yes on the item as shown", async () => {
    const out = await signedDecision({
      deviceId,
      item,
      decision: "approve",
      answer: "yes",
      prompt: "Answer with Face ID",
      readKey,
    });
    if (!out.ok) throw new Error(out.problem);
    expect(out.body).toMatchObject({ decision: "approve", answer: "yes" });
    expect(out.body.fingerprint).toBe(itemFingerprint(item));
    const sig = out.body.deviceSignature;
    expect(sig).toMatchObject({ deviceId, fingerprint: itemFingerprint(item) });
    const signed = deviceSignedText({
      deviceId,
      itemId: item.id,
      decision: "approve",
      fingerprint: sig.fingerprint,
      at: sig.at,
    });
    expect(await verify(jwk, sig.signature, signed)).toBe(true);
  });

  it("sends nothing from a phone not set up to sign, or when Face ID didn't finish", async () => {
    let asked = 0;
    const counting = async () => {
      asked++;
      return encodePrivateKey(privateKey);
    };
    const unset = await signedDecision({
      deviceId: null,
      item,
      decision: "reject",
      prompt: "Reject with Face ID",
      readKey: counting,
    });
    expect(unset).toMatchObject({ ok: false });
    expect(asked).toBe(0);
    const cancelled = await signedDecision({
      deviceId,
      item,
      decision: "approve",
      prompt: "Sign with Face ID",
      readKey: async () => null,
    });
    expect(cancelled).toMatchObject({ ok: false });
  });
});

describe("approving a sign-in on the phone (§1.154)", () => {
  const privateKey = newPrivateKey(new Uint8Array(randomBytes(48)));
  const jwk = publicJwk(privateKey);
  const userId = "0190a1b2-0000-7000-8000-00000000a001";
  const approvalId = "0190a1b2-0000-7000-8000-00000000c001";
  const at = new Date("2026-11-18T12:00:00.000Z");

  it("signs the list of waiting sign-ins as the API checks it", async () => {
    const body = signSignInList({ privateKey, userId, deviceId, at });
    expect(SignInApprovalsBody.safeParse(body).success).toBe(true);
    const text = signInListText({ userId, deviceId, at: body.at });
    expect(await verify(jwk, body.signature, text)).toBe(true);
    // Not as a Desk item's, nor as a decision.
    expect(
      await verify(
        jwk,
        body.signature,
        signInApprovalText({
          approvalId,
          userId,
          deviceId,
          decision: "deny",
          number: null,
          at: body.at,
        }),
      ),
    ).toBe(false);
  });

  it("signs a decision with its number, and only that decision", async () => {
    const body = signSignInDecision({
      privateKey,
      approvalId,
      userId,
      deviceId,
      decision: "approve",
      number: 47,
      at,
    });
    expect(SignInApprovalDecideBody.safeParse(body).success).toBe(true);
    const text = (number: number | null, decision: "approve" | "deny" = "approve") =>
      signInApprovalText({ approvalId, userId, deviceId, decision, number, at: body.at });
    expect(await verify(jwk, body.signature, text(47))).toBe(true);
    expect(await verify(jwk, body.signature, text(48))).toBe(false);
    expect(await verify(jwk, body.signature, text(null, "deny"))).toBe(false);
    const deny = signSignInDecision({
      privateKey,
      approvalId,
      userId,
      deviceId,
      decision: "deny",
      number: null,
      at,
    });
    expect(await verify(jwk, deny.signature, text(null, "deny"))).toBe(true);
  });
});
