import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  bearerChallenge,
  bearerToken,
  protectedResourceMetadata,
  verifyAccessToken,
} from "./bearer";

const ISSUER = "https://auth.example.test";
const RESOURCE = "https://app.example.test/mcp";
const NOW = new Date("2026-11-06T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

const signing = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" };
const keys = createLocalJWKSet({ keys: [jwk] });
const check = { issuer: ISSUER, audience: RESOURCE, keys };

function token(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; kid?: string } = {},
): Promise<string> {
  return new SignJWT({ sid: "session_1", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer((claims.iss as string) ?? ISSUER)
    .setAudience((claims.aud as string | string[]) ?? RESOURCE)
    .setSubject((claims.sub as string) ?? "user_01")
    .setIssuedAt(nowSec - 10)
    .setExpirationTime((claims.exp as number) ?? nowSec + 300)
    .sign(opts.key ?? signing.privateKey);
}

describe("verifyAccessToken", () => {
  it("accepts a token from the issuer, for this resource, in date", async () => {
    const out = await verifyAccessToken(await token(), check, NOW);
    expect(out).toEqual({
      ok: true,
      subject: "user_01",
      sessionId: "session_1",
      expiresAt: new Date((nowSec + 300) * 1000),
    });
  });

  it("accepts an audience list that names this resource", async () => {
    const out = await verifyAccessToken(
      await token({ aud: ["https://other.test", RESOURCE] }),
      check,
      NOW,
    );
    expect(out.ok).toBe(true);
  });

  it("refuses an expired token", async () => {
    const out = await verifyAccessToken(await token({ exp: nowSec - 120 }), check, NOW);
    expect(out).toEqual({
      ok: false,
      error: "invalid_token",
      description: "the access token has expired",
    });
  });

  it("refuses a token for another audience", async () => {
    const out = await verifyAccessToken(await token({ aud: "https://elsewhere.test" }), check, NOW);
    expect(out).toMatchObject({
      ok: false,
      description: "the access token is not for this server",
    });
  });

  it("refuses a token from another issuer", async () => {
    const out = await verifyAccessToken(await token({ iss: "https://evil.test" }), check, NOW);
    expect(out).toMatchObject({
      ok: false,
      description: "the access token is from another issuer",
    });
  });

  it("refuses a token signed by another key, and garbage", async () => {
    const forged = await token({}, { key: stranger.privateKey });
    expect((await verifyAccessToken(forged, check, NOW)).ok).toBe(false);
    expect((await verifyAccessToken("not.a.jwt", check, NOW)).ok).toBe(false);
    expect((await verifyAccessToken("", check, NOW)).ok).toBe(false);
  });

  it("refuses HMAC and unsigned tokens", async () => {
    const hmac = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject("user_01")
      .setExpirationTime(nowSec + 300)
      .sign(new TextEncoder().encode("a-shared-secret-of-enough-length!!"));
    expect((await verifyAccessToken(hmac, check, NOW)).ok).toBe(false);
    const header = btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "");
    const body = btoa(
      JSON.stringify({ iss: ISSUER, aud: RESOURCE, sub: "user_01", exp: nowSec + 300 }),
    ).replace(/=+$/, "");
    expect((await verifyAccessToken(`${header}.${body}.`, check, NOW)).ok).toBe(false);
  });

  it("refuses a token without a subject", async () => {
    const noSub = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime(nowSec + 300)
      .sign(signing.privateKey);
    expect((await verifyAccessToken(noSub, check, NOW)).ok).toBe(false);
  });
});

describe("bearer helpers", () => {
  it("reads only a Bearer authorization header", () => {
    const req = (h?: string) =>
      new Request("https://x.test", h ? { headers: { authorization: h } } : {});
    expect(bearerToken(req("Bearer abc.def-ghi_jk"))).toBe("abc.def-ghi_jk");
    expect(bearerToken(req("bearer abc"))).toBe("abc");
    expect(bearerToken(req("Basic dXNlcjpwYXNz"))).toBeNull();
    expect(bearerToken(req("Bearer "))).toBeNull();
    expect(bearerToken(req("Bearer a b"))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });

  it("builds the metadata and the challenge", () => {
    expect(
      protectedResourceMetadata({
        resource: RESOURCE,
        authorizationServer: ISSUER,
        name: "Mezonas",
      }),
    ).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource_name: "Mezonas",
    });
    expect(bearerChallenge({ resourceMetadataUrl: "https://app.test/.well-known/x" })).toBe(
      'Bearer resource_metadata="https://app.test/.well-known/x"',
    );
    expect(
      bearerChallenge({
        resourceMetadataUrl: "https://app.test/m",
        error: "invalid_token",
        description: 'bad "token"',
      }),
    ).toBe(
      'Bearer resource_metadata="https://app.test/m", error="invalid_token", error_description="bad token"',
    );
  });
});
