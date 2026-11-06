// The MCP server inside workerd: /mcp and its metadata reach the Worker (not the web app's
// index.html), it is off where no AuthKit domain is set (as locally), the rate limiter binding
// answers, and jose verifies an access token with Web Crypto.

import { env, SELF } from "cloudflare:test";
import { verifyAccessToken } from "@countersign/auth";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import type { RateLimiterBinding } from "./env";

it("routes /mcp and the OAuth metadata to the Worker, off without an AuthKit domain", async () => {
  for (const path of [
    "/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ]) {
    const res = await SELF.fetch(`http://example.com${path}`);
    expect(res.status, path).toBe(404);
    expect(res.headers.get("content-type"), path).toContain("application/json");
  }
});

it("has the MCP rate limiter binding", async () => {
  const limiter = (env as unknown as { MCP_RATE_LIMIT: RateLimiterBinding }).MCP_RATE_LIMIT;
  expect(await limiter.limit({ key: "runtime-test" })).toEqual({ success: true });
});

it("verifies an RS256 access token in workerd", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k" }] });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuer("https://auth.test")
    .setAudience("https://app.test/mcp")
    .setSubject("user_1")
    .setExpirationTime("5m")
    .sign(privateKey);
  const out = await verifyAccessToken(token, {
    issuer: "https://auth.test",
    audience: "https://app.test/mcp",
    keys,
  });
  expect(out).toMatchObject({ ok: true, subject: "user_1" });
});
