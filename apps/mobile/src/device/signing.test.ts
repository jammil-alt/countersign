// The phone's signature, checked the way the API checks it: Web Crypto, ECDSA P-256 over SHA-256
// of core's `deviceSignedText`, the public key imported from the JWK the phone registered.

import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  DevicePublicKey,
  DeviceSignature,
  deviceSignedText,
  itemFingerprintText,
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
