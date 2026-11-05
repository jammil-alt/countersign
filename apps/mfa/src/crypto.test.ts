import { describe, expect, it } from "vitest";
import { newIdentityId, SealKey, sealContext } from "./crypto";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("sealing", () => {
  it("opens only under the same key and context", async () => {
    const key = await SealKey.fromBase64(KEY);
    const ctx = sealContext({
      identityId: "abcdefgh2345",
      siteKey: "acme",
      purpose: "authenticator",
    });
    const env = await key.seal("JBSWY3DPEHPK3PXP", ctx);
    expect(env).not.toContain("JBSWY3DPEHPK3PXP");
    expect(env).toMatch(/^v1\./);
    expect(await key.open(env, ctx)).toBe("JBSWY3DPEHPK3PXP");
    // Moved to another identity or site: it does not open.
    const other = sealContext({
      identityId: "abcdefgh2346",
      siteKey: "acme",
      purpose: "authenticator",
    });
    await expect(key.open(env, other)).rejects.toThrow();
    const otherSite = sealContext({
      identityId: "abcdefgh2345",
      siteKey: "beta",
      purpose: "authenticator",
    });
    await expect(key.open(env, otherSite)).rejects.toThrow();
    const otherKey = await SealKey.fromBase64(btoa("x".repeat(32)));
    await expect(otherKey.open(env, ctx)).rejects.toThrow();
  });

  it("refuses a missing or short key", async () => {
    await expect(SealKey.fromBase64(undefined)).rejects.toThrow(/not set/);
    await expect(SealKey.fromBase64(btoa("short"))).rejects.toThrow(/32 bytes/);
  });

  it("makes identity ids of 12 base32 characters", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newIdentityId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{12}$/);
  });
});
