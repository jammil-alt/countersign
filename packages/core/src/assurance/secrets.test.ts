import { describe, expect, it } from "vitest";
import {
  holdsSecret,
  normalScope,
  parseScopes,
  scopesBeyond,
  secretShapesIn,
  secretValues,
} from "./secrets";

// §1.231.2: what a stored model request is scanned for, and how a grant's scopes are compared.

describe("secrets in a stored request", () => {
  it("takes only the values under secret names, at any depth", () => {
    const values = secretValues({
      accessToken: "at-0123456789abcdef",
      refreshToken: "rt-0123456789abcdef",
      tokenType: "Bearer-long-enough",
      expiresAt: "2026-11-22T00:00:00.000Z",
      scope: "com.intuit.quickbooks.accounting",
      address: "ada@harbor.example",
      realmId: "9130350000000000",
      tokens: { zapier: "z".repeat(40) },
      outbound: { url: "https://hooks.example", signingSecret: "s".repeat(40) },
      password: "short",
      apiKey: "key-abcdefgh",
    });
    expect(values.sort()).toEqual(
      [
        "at-0123456789abcdef",
        "rt-0123456789abcdef",
        "z".repeat(40),
        "s".repeat(40),
        "key-abcdefgh",
      ].sort(),
    );
  });

  it("finds a secret raw or JSON-escaped, and nothing else", () => {
    const secret = 'pa"ss\\word-123';
    const text = JSON.stringify({ messages: [{ content: `log in with ${secret}` }] });
    expect(holdsSecret(text, [secret])).toBe(true);
    expect(holdsSecret(text, ["other-secret-value"])).toBe(false);
  });

  it("names secret-shaped strings by kind, and leaves ordinary text alone", () => {
    const key = `sk-ant-${"a".repeat(30)}`;
    expect(secretShapesIn(`use ${key} and ya29.${"b".repeat(30)}`).sort()).toEqual(
      ["google_access_token", "model_api_key"].sort(),
    );
    expect(secretShapesIn("Invoice INV-2026-0042 for $1,250.00, PO 88123, skus sk-12")).toEqual([]);
  });
});

describe("OAuth scopes", () => {
  it("compares scopes without the providers' addresses and case", () => {
    expect(normalScope("https://www.googleapis.com/auth/gmail.send")).toBe("gmail.send");
    expect(normalScope("https://graph.microsoft.com/Mail.Send")).toBe("mail.send");
    expect(parseScopes("chat:write,channels:read")).toEqual(["chat:write", "channels:read"]);
    expect(parseScopes(undefined)).toBeNull();
    expect(
      scopesBeyond(
        ["openid", "https://www.googleapis.com/auth/gmail.send", "gmail.readonly"],
        ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
      ),
    ).toEqual(["gmail.readonly"]);
  });
});
