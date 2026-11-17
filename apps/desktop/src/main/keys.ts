// This computer's own key (docs/plan.md §1.124): an EC P-256 pair made when the computer is paired.
// The private half never leaves the computer (it is kept in the vault, encrypted by the operating
// system); the public half goes to Mezonas, which checks every request the computer signs with it.
// ECDSA over SHA-256 with the signature as r‖s, which is what Web Crypto verifies in the Worker.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  DESKTOP_DEVICE_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIME_HEADER,
  type DesktopPublicKey,
  desktopRequestText,
} from "@countersign/core";

export interface DeviceKey {
  privatePem: string;
  publicJwk: DesktopPublicKey;
}

export function newDeviceKey(): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicJwk: { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) },
  };
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The headers that prove a request came from this computer, for this method, path and body. */
export function signedHeaders(input: {
  deviceId: string;
  privatePem: string;
  method: string;
  path: string;
  body: Uint8Array | string;
  at: Date;
}): Record<string, string> {
  const at = input.at.toISOString();
  const text = desktopRequestText({
    deviceId: input.deviceId,
    method: input.method,
    path: input.path,
    bodySha256: sha256Hex(input.body),
    at,
  });
  const signature = sign("sha256", Buffer.from(text, "utf8"), {
    key: input.privatePem,
    dsaEncoding: "ieee-p1363",
  });
  return {
    [DESKTOP_DEVICE_HEADER]: input.deviceId,
    [DESKTOP_TIME_HEADER]: at,
    [DESKTOP_SIGNATURE_HEADER]: signature.toString("base64url"),
  };
}

/** A PKCE pair (RFC 7636) for signing in through the browser. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
