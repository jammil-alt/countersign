import { describe, expect, it } from "vitest";
import {
  ClaimResult,
  CodesInputs,
  CodesResponses,
  OpenWaitInput,
  SetAuthenticatorInput,
} from "./service";

const tenantId = "0190f0c2-7f00-7000-8000-000000000001";
const identityId = "abcdefgh2345";

describe("code service RPC schemas", () => {
  it("requires a sender and a pattern for texted and emailed codes, not for authenticators", () => {
    const base = { tenantId, identityId, siteKey: "acme-supply" };
    expect(OpenWaitInput.safeParse({ ...base, channel: "sms" }).success).toBe(false);
    const sms = OpenWaitInput.parse({
      ...base,
      channel: "sms",
      sender: "+15550001111",
      pattern: "(\\d{6})",
    });
    expect(sms.ttlSeconds).toBe(300);
    expect(OpenWaitInput.parse({ ...base, channel: "totp" }).channel).toBe("totp");
  });

  it("caps a wait at five minutes and refuses a broken pattern", () => {
    const base = { tenantId, identityId, siteKey: "acme", channel: "email", sender: "@acme.com" };
    expect(OpenWaitInput.safeParse({ ...base, pattern: "(\\d{6})", ttlSeconds: 301 }).success).toBe(
      false,
    );
    expect(OpenWaitInput.safeParse({ ...base, pattern: "(\\d{6}" }).success).toBe(false);
  });

  it("refuses calls without a client or with a malformed identity", () => {
    expect(CodesInputs.identity.safeParse({ identityId }).success).toBe(false);
    expect(CodesInputs.identity.safeParse({ tenantId, identityId: "AGENT" }).success).toBe(false);
    expect(
      SetAuthenticatorInput.safeParse({
        tenantId,
        identityId,
        siteKey: "acme",
        otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("reads a claim as a code, pending or expired, and failures by code", () => {
    expect(ClaimResult.parse({ status: "code", code: "123456" })).toEqual({
      status: "code",
      code: "123456",
    });
    const failed = CodesResponses.claim.parse({
      ok: false,
      error: { code: "daily_cap", message: "cap reached" },
    });
    expect(failed.ok).toBe(false);
  });
});
