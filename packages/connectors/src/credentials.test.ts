import { describe, expect, it } from "vitest";
import {
  CredentialCipher,
  CredentialError,
  credentialKeysFromEnv,
  generateEncryptionKey,
} from "./credentials";
import { encryptedCredentials } from "./credentials-accessor";
import { toBase64 } from "./runtime";

const binding = {
  tenantId: "0190f0c8-0000-7000-8000-000000000001",
  connectionId: "0190f0c8-0000-7000-8000-0000000000aa",
};
const secret = { accessToken: "at-123", refreshToken: "rt-456", realmId: "9130" };

async function expectCode(p: Promise<unknown>, code: CredentialError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CredentialError);
  expect((err as CredentialError).code).toBe(code);
}

describe("CredentialCipher", () => {
  it("round-trips credentials and never stores plaintext", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encrypt(secret, binding);
    expect(env).toMatchObject({ v: 1, alg: "A256GCM", kid: cipher.currentKeyId });
    expect(JSON.stringify(env)).not.toContain("at-123");
    expect(await cipher.decrypt(env, binding)).toEqual(secret);
  });

  it("uses a fresh IV every time", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const a = await cipher.encrypt(secret, binding);
    const b = await cipher.encrypt(secret, binding);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("refuses a ciphertext written with a key it does not hold", async () => {
    const a = await CredentialCipher.create({ current: generateEncryptionKey() });
    const b = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await a.encrypt(secret, binding);
    await expectCode(b.decrypt(env, binding), "unknown_key");
  });

  it("fails to decrypt with the wrong key even if the key id is forged", async () => {
    const a = await CredentialCipher.create({ current: generateEncryptionKey() });
    const b = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = { ...(await a.encrypt(secret, binding)), kid: b.currentKeyId };
    await expectCode(b.decrypt(env, binding), "decrypt_failed");
  });

  it("binds ciphertext to its client and connection", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encrypt(secret, binding);
    await expectCode(
      cipher.decrypt(env, { ...binding, tenantId: "0190f0c8-0000-7000-8000-000000000002" }),
      "decrypt_failed",
    );
    await expectCode(
      cipher.decrypt(env, { ...binding, connectionId: "0190f0c8-0000-7000-8000-0000000000bb" }),
      "decrypt_failed",
    );
  });

  it("detects tampering", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encrypt(secret, binding);
    const flipped = env.ct.startsWith("A") ? `B${env.ct.slice(1)}` : `A${env.ct.slice(1)}`;
    await expectCode(cipher.decrypt({ ...env, ct: flipped }, binding), "decrypt_failed");
    await expectCode(cipher.decrypt({ ...env, v: 2 }, binding), "malformed");
    await expectCode(cipher.decrypt("nope", binding), "malformed");
  });

  it("rejects keys that are not 32 bytes of base64", async () => {
    await expectCode(
      CredentialCipher.create({ current: toBase64(new Uint8Array(16)) }),
      "invalid_key",
    );
    await expectCode(CredentialCipher.create({ current: "not base64!" }), "invalid_key");
  });

  it("rotates: old ciphertexts still decrypt, rotate re-encrypts under the new key", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    const before = await CredentialCipher.create({ current: oldKey });
    const env = await before.encrypt(secret, binding);

    const after = await CredentialCipher.create(
      credentialKeysFromEnv({ ENCRYPTION_KEY: newKey, ENCRYPTION_KEY_PREVIOUS: ` ${oldKey} ,` }),
    );
    expect(after.keyIds).toEqual([after.currentKeyId, before.currentKeyId]);
    expect(after.needsRotation(env)).toBe(true);
    expect(await after.decrypt(env, binding)).toEqual(secret);

    const rotated = await after.rotate(env, binding);
    expect(rotated.kid).toBe(after.currentKeyId);
    expect(after.needsRotation(rotated)).toBe(false);
    expect(await after.rotate(rotated, binding)).toEqual(rotated);

    // Once the old key is dropped, only rotated rows decrypt.
    const done = await CredentialCipher.create({ current: newKey });
    expect(await done.decrypt(rotated, binding)).toEqual(secret);
    await expectCode(done.decrypt(env, binding), "unknown_key");
  });

  it("derives the same key id from the same key", async () => {
    const key = generateEncryptionKey();
    const a = await CredentialCipher.create({ current: key });
    const b = await CredentialCipher.create({ current: key });
    expect(a.currentKeyId).toBe(b.currentKeyId);
    expect(a.currentKeyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("validates decrypted credentials against a schema", async () => {
    const { z } = await import("zod");
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encrypt(secret, binding);
    const ok = await cipher.decrypt(env, binding, z.object({ realmId: z.string() }));
    expect(ok.realmId).toBe("9130");
    await expectCode(cipher.decrypt(env, binding, z.object({ apiKey: z.string() })), "malformed");
  });

  it("requires ENCRYPTION_KEY in the env", () => {
    expect(() => credentialKeysFromEnv({})).toThrow(CredentialError);
  });
});

describe("encryptedCredentials", () => {
  it("decrypts lazily, caches, and writes back encrypted", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    let stored: unknown = await cipher.encrypt(secret, binding);
    let loads = 0;
    const acc = encryptedCredentials({
      cipher,
      binding,
      load: async () => {
        loads += 1;
        return stored;
      },
      save: async (env) => {
        stored = env;
      },
    });
    expect(await acc.get()).toEqual(secret);
    expect(await acc.get()).toEqual(secret);
    expect(loads).toBe(1);
    await acc.set({ ...secret, accessToken: "at-new" });
    expect(JSON.stringify(stored)).not.toContain("at-new");
    expect(await cipher.decrypt(stored, binding)).toMatchObject({ accessToken: "at-new" });
  });

  it("gives null when the connection has no credentials", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const acc = encryptedCredentials({
      cipher,
      binding,
      load: async () => null,
      save: async () => {},
    });
    expect(await acc.get()).toBeNull();
  });
});
