import { describe, expect, it } from "vitest";
import {
  CredentialCipher,
  CredentialError,
  credentialKeysFromEnv,
  generateEncryptionKey,
  memoryTenantKeys,
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
    const env = await cipher.encryptV1(secret, binding);
    expect(env).toMatchObject({ v: 1, alg: "A256GCM", kid: cipher.currentKeyId });
    expect(JSON.stringify(env)).not.toContain("at-123");
    expect(await cipher.decryptV1(env, binding)).toEqual(secret);
  });

  it("uses a fresh IV every time", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const a = await cipher.encryptV1(secret, binding);
    const b = await cipher.encryptV1(secret, binding);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("refuses a ciphertext written with a key it does not hold", async () => {
    const a = await CredentialCipher.create({ current: generateEncryptionKey() });
    const b = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await a.encryptV1(secret, binding);
    await expectCode(b.decryptV1(env, binding), "unknown_key");
  });

  it("fails to decrypt with the wrong key even if the key id is forged", async () => {
    const a = await CredentialCipher.create({ current: generateEncryptionKey() });
    const b = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = { ...(await a.encryptV1(secret, binding)), kid: b.currentKeyId };
    await expectCode(b.decryptV1(env, binding), "decrypt_failed");
  });

  it("binds ciphertext to its client and connection", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encryptV1(secret, binding);
    await expectCode(
      cipher.decryptV1(env, { ...binding, tenantId: "0190f0c8-0000-7000-8000-000000000002" }),
      "decrypt_failed",
    );
    await expectCode(
      cipher.decryptV1(env, { ...binding, connectionId: "0190f0c8-0000-7000-8000-0000000000bb" }),
      "decrypt_failed",
    );
  });

  it("detects tampering", async () => {
    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const env = await cipher.encryptV1(secret, binding);
    const flipped = env.ct.startsWith("A") ? `B${env.ct.slice(1)}` : `A${env.ct.slice(1)}`;
    await expectCode(cipher.decryptV1({ ...env, ct: flipped }, binding), "decrypt_failed");
    await expectCode(cipher.decryptV1({ ...env, v: 3 }, binding), "malformed");
    // A v2 envelope needs the client's key, which the master cipher alone does not hold.
    await expectCode(cipher.decryptV1({ ...env, v: 2 }, binding), "unknown_key");
    await expectCode(cipher.decryptV1("nope", binding), "malformed");
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
    const env = await before.encryptV1(secret, binding);

    const after = await CredentialCipher.create(
      credentialKeysFromEnv({ ENCRYPTION_KEY: newKey, ENCRYPTION_KEY_PREVIOUS: ` ${oldKey} ,` }),
    );
    expect(after.keyIds).toEqual([after.currentKeyId, before.currentKeyId]);
    expect(after.needsRotation(env)).toBe(true);
    expect(await after.decryptV1(env, binding)).toEqual(secret);

    const rotated = await after.rotate(env, binding);
    expect(rotated.kid).toBe(after.currentKeyId);
    expect(after.needsRotation(rotated)).toBe(false);
    expect(await after.rotate(rotated, binding)).toEqual(rotated);

    // Once the old key is dropped, only rotated rows decrypt.
    const done = await CredentialCipher.create({ current: newKey });
    expect(await done.decryptV1(rotated, binding)).toEqual(secret);
    await expectCode(done.decryptV1(env, binding), "unknown_key");
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
    const env = await cipher.encryptV1(secret, binding);
    const ok = await cipher.decryptV1(env, binding, z.object({ realmId: z.string() }));
    expect(ok.realmId).toBe("9130");
    await expectCode(cipher.decryptV1(env, binding, z.object({ apiKey: z.string() })), "malformed");
  });

  it("requires ENCRYPTION_KEY in the env", () => {
    expect(() => credentialKeysFromEnv({})).toThrow(CredentialError);
  });
});

describe("encryptedCredentials", () => {
  it("decrypts lazily, caches, and writes back encrypted", async () => {
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
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
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const acc = encryptedCredentials({
      cipher,
      binding,
      load: async () => null,
      save: async () => {},
    });
    expect(await acc.get()).toBeNull();
  });
});

describe("VaultCipher: each client's own data key (envelope v2)", () => {
  const otherClient = { ...binding, tenantId: "0190f0c8-0000-7000-8000-000000000002" };

  async function setup(key = generateEncryptionKey()) {
    const master = await CredentialCipher.create({ current: key });
    const store = memoryTenantKeys();
    return { master, store, vault: master.forClients(store) };
  }

  it("writes v2 under the client's key, created on first use and wrapped by the master key", async () => {
    const { master, store, vault } = await setup();
    const env = await vault.encrypt(secret, binding);
    expect(env).toMatchObject({ v: 2, alg: "A256GCM" });
    expect(JSON.stringify(env)).not.toContain("at-123");
    expect(store.records.size).toBe(1);
    const record = store.records.get(env.kid);
    expect(record?.tenantId).toBe(binding.tenantId);
    expect(record?.wrapped?.kid).toBe(master.currentKeyId);
    expect(await vault.decrypt(env, binding)).toEqual(secret);
    // The same key serves the client's next write; another client gets its own.
    expect((await vault.encrypt(secret, binding)).kid).toBe(env.kid);
    expect((await vault.encrypt(secret, otherClient)).kid).not.toBe(env.kid);
  });

  it("still decrypts v1, and re-encrypts it as v2", async () => {
    const { master, vault } = await setup();
    const v1 = await master.encryptV1(secret, binding);
    expect(vault.needsReencrypt(v1)).toBe(true);
    expect(await vault.decrypt(v1, binding)).toEqual(secret);
    const v2 = await vault.reencrypt(v1, binding);
    expect(v2.v).toBe(2);
    expect(vault.needsReencrypt(v2)).toBe(false);
    expect(await vault.decrypt(v2, binding)).toEqual(secret);
    expect(await vault.reencrypt(v2, binding)).toEqual(v2);
  });

  it("a ciphertext copied to another client or another connection does not open", async () => {
    const { vault } = await setup();
    const env = await vault.encrypt(secret, binding);
    // Another client: its keys don't include this id.
    await expectCode(vault.decrypt(env, otherClient), "unknown_key");
    // Another client that has a key: still not this one.
    await vault.encrypt(secret, otherClient);
    await expectCode(vault.decrypt(env, otherClient), "unknown_key");
    await expectCode(
      vault.decrypt(env, { ...binding, connectionId: "0190f0c8-0000-7000-8000-0000000000bb" }),
      "decrypt_failed",
    );
  });

  it("a wrapped key opens only for its own client", async () => {
    const { master } = await setup();
    const wrapped = await master.wrap(new Uint8Array(32).fill(7), binding.tenantId);
    expect((await master.unwrap(wrapped, binding.tenantId))[0]).toBe(7);
    await expectCode(master.unwrap(wrapped, otherClient.tenantId), "decrypt_failed");
  });

  it("a destroyed key makes everything it encrypted unreadable, and stores nothing new", async () => {
    const { master, store } = await setup();
    const env = await master.forClients(store).encrypt(secret, binding);
    store.destroy(binding.tenantId);
    // A fresh cipher, so no unwrapped key is cached.
    const vault = master.forClients(store);
    await expectCode(vault.decrypt(env, binding), "key_destroyed");
    await expectCode(vault.encrypt(secret, binding), "key_destroyed");
  });

  it("a master key rotation re-wraps client keys; their envelopes stay as they are", async () => {
    const oldKey = generateEncryptionKey();
    const { master: before, store } = await setup(oldKey);
    const env = await before.forClients(store).encrypt(secret, binding);
    const newKey = generateEncryptionKey();
    const after = await CredentialCipher.create({ current: newKey, previous: [oldKey] });
    const record = store.records.get(env.kid);
    if (!record?.wrapped) throw new Error("no key");
    expect(after.needsRewrap(record.wrapped)).toBe(true);
    record.wrapped = await after.rewrap(record.wrapped, binding.tenantId);
    expect(after.needsRewrap(record.wrapped)).toBe(false);
    expect(await after.rotate(env, binding)).toEqual(env);
    // A deployment without the master key that wrapped it can't open it.
    const other = await CredentialCipher.create({ current: generateEncryptionKey() });
    await expectCode(other.forClients(store).decrypt(env, binding), "unknown_key");
    // The re-wrapped key opens the same envelope without the old master key.
    const afterOnly = await CredentialCipher.create({ current: newKey });
    expect(await afterOnly.forClients(store).decrypt(env, binding)).toEqual(secret);
  });
});
