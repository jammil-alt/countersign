import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32, hotp, parseOtpauthUri, totp } from "./totp";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("HOTP (RFC 4226 appendix D)", () => {
  it("matches the published values for counters 0 to 9", async () => {
    const secret = ascii("12345678901234567890");
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (const [i, code] of expected.entries()) expect(await hotp(secret, i)).toBe(code);
  });
});

describe("TOTP (RFC 6238 appendix B)", () => {
  const secrets = {
    SHA1: ascii("12345678901234567890"),
    SHA256: ascii("12345678901234567890123456789012"),
    SHA512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
  } as const;
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [t, sha1, sha256, sha512] of vectors) {
    it(`gives the published codes at T=${t}`, async () => {
      const at = new Date(t * 1000);
      const p = { digits: 8, period: 30 } as const;
      expect(await totp({ ...p, algorithm: "SHA1", secret: secrets.SHA1 }, at)).toBe(sha1);
      expect(await totp({ ...p, algorithm: "SHA256", secret: secrets.SHA256 }, at)).toBe(sha256);
      expect(await totp({ ...p, algorithm: "SHA512", secret: secrets.SHA512 }, at)).toBe(sha512);
    });
  }
});

describe("otpauth URIs", () => {
  it("reads the secret and the defaults", () => {
    const secret = encodeBase32(ascii("12345678901234567890"));
    const p = parseOtpauthUri(`otpauth://totp/Acme:agent?secret=${secret}&issuer=Acme`);
    expect(p).toMatchObject({ algorithm: "SHA1", digits: 6, period: 30 });
    expect(new TextDecoder().decode(p.secret)).toBe("12345678901234567890");
  });

  it("reads the algorithm, digits and period, and lower-case secrets with padding", () => {
    const secret = `${encodeBase32(ascii("12345678901234567890")).toLowerCase()}====`;
    const p = parseOtpauthUri(
      `otpauth://totp/x?secret=${secret}&algorithm=sha256&digits=8&period=60`,
    );
    expect(p).toMatchObject({ algorithm: "SHA256", digits: 8, period: 60 });
  });

  it("refuses HOTP, a missing or short secret and odd settings", () => {
    const secret = encodeBase32(ascii("12345678901234567890"));
    expect(() => parseOtpauthUri(`otpauth://hotp/x?secret=${secret}&counter=1`)).toThrow(/totp/);
    expect(() => parseOtpauthUri("otpauth://totp/x")).toThrow(/secret/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSW")).toThrow(/secret/);
    expect(() => parseOtpauthUri(`otpauth://totp/x?secret=${secret}&digits=4`)).toThrow(/digits/);
    expect(() => parseOtpauthUri(`otpauth://totp/x?secret=${secret}&algorithm=MD5`)).toThrow();
    expect(() => parseOtpauthUri("https://example.com")).toThrow(/otpauth/);
  });

  it("round-trips base32", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    expect(decodeBase32("not base32!")).toBeNull();
  });
});
