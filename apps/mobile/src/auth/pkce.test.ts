import { randomBytes } from "node:crypto";
import { PkceChallenge, PkceVerifier } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { handoffCode, handoffError, pkceChallenge, pkceVerifier } from "./pkce";

describe("PKCE", () => {
  it("matches RFC 7636's example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes 64-character verifiers the API accepts, with their challenge", () => {
    for (let i = 0; i < 50; i++) {
      const v = pkceVerifier((n) => new Uint8Array(randomBytes(n)));
      expect(v).toHaveLength(64);
      expect(PkceVerifier.safeParse(v).success).toBe(true);
      expect(PkceChallenge.safeParse(pkceChallenge(v)).success).toBe(true);
    }
  });

  it("reads the handoff code, or the refusal, from the app's URL", () => {
    expect(handoffCode("mezonas://signed-in?code=abc.def")).toBe("abc.def");
    expect(handoffCode("mezonas://signed-in?error=not_invited")).toBeNull();
    expect(handoffError("mezonas://signed-in?error=not_invited")).toBe("not_invited");
    expect(handoffCode("mezonas://signed-in")).toBeNull();
    expect(handoffCode(null)).toBeNull();
  });
});
