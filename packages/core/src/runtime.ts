// The few Web Platform APIs core uses (Web Crypto, TextEncoder). They exist in browsers, Workers
// and Node 22 alike, but core's tsconfig has no DOM/Node/Workers types on purpose, so they are
// reached through globalThis with the narrow types below.

interface SubtleCryptoLike {
  digest(algorithm: "SHA-1" | "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: SubtleCryptoLike;
}

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

const g = globalThis as unknown as {
  crypto?: CryptoLike;
  TextEncoder?: new () => TextEncoderLike;
};

export function webCrypto(): CryptoLike {
  if (!g.crypto?.subtle) throw new Error("Web Crypto is not available in this runtime");
  return g.crypto;
}

export function utf8(input: string): Uint8Array {
  if (!g.TextEncoder) throw new Error("TextEncoder is not available in this runtime");
  return new g.TextEncoder().encode(input);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
