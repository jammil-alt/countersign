import { describe, expect, it } from "vitest";
import { generateEncryptionKey } from "./credentials";
import { generateReleaseCode, ReleaseCodeKeys } from "./release-codes";

const ID = "0190f0a0-0000-7000-8000-000000000001";

describe("release codes", () => {
  it("are six digits, spread over the whole range", () => {
    const codes = Array.from({ length: 2000 }, generateReleaseCode);
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    // Nearly all distinct, and leading digits all show up (no bias towards small numbers).
    expect(new Set(codes).size).toBeGreaterThan(1990);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
  });

  it("are kept as an HMAC bound to the request, never as the code", async () => {
    const keys = await ReleaseCodeKeys.create({ current: generateEncryptionKey() });
    const hash = await keys.hash(ID, "123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("123456");
    expect(await keys.matches(ID, "123456", hash)).toBe(true);
    expect(await keys.matches(ID, "123457", hash)).toBe(false);
    // The same code for another request hashes differently.
    expect(await keys.hash(`${ID.slice(0, -1)}2`, "123456")).not.toBe(hash);
    expect(await keys.matches(`${ID.slice(0, -1)}2`, "123456", hash)).toBe(false);
  });

  it("use a key derived from ENCRYPTION_KEY: another key can't check them; the previous key still can", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    const before = await ReleaseCodeKeys.create({ current: oldKey });
    const hash = await before.hash(ID, "654321");
    expect(
      await (await ReleaseCodeKeys.create({ current: newKey })).matches(ID, "654321", hash),
    ).toBe(false);
    const rotated = await ReleaseCodeKeys.create({ current: newKey, previous: [oldKey] });
    expect(await rotated.matches(ID, "654321", hash)).toBe(true);
  });

  it("refuse a key that isn't 32 bytes", async () => {
    await expect(ReleaseCodeKeys.create({ current: "c2hvcnQ=" })).rejects.toThrow(/32 bytes/);
  });
});
