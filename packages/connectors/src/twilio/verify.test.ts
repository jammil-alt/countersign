// Twilio Verify for sign-in codes (docs/plan.md §1.83): the requests sent, and how answers read.

import { describe, expect, it } from "vitest";
import type { FetchLike, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { memoryCodeVerifier, TWILIO_VERIFY_API, twilioCodeVerifier } from "./verify";

const SERVICE = "VA00000000000000000000000000000001";

function fakeFetch(answers: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; form: Record<string, string>; auth: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      form: init?.body ? formDecode(String(init.body)) : {},
      auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
    });
    const a = answers.shift() ?? { status: 500 };
    const text = a.body === undefined ? "" : JSON.stringify(a.body);
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as HttpResponseLike;
  };
  return { fetch, calls };
}

const verifierWith = (answers: { status: number; body?: unknown }[]) => {
  const f = fakeFetch(answers);
  const v = twilioCodeVerifier({
    accountSid: "AC00000000000000000000000000000001",
    authToken: "token",
    serviceSid: SERVICE,
    fetch: f.fetch,
  });
  return { v, calls: f.calls };
};

describe("twilioCodeVerifier", () => {
  it("sends a code and checks it", async () => {
    const { v, calls } = verifierWith([
      { status: 201, body: { status: "pending" } },
      { status: 200, body: { status: "approved" } },
      { status: 200, body: { status: "pending" } },
      { status: 404, body: { code: 20404, message: "not found" } },
    ]);
    await v.sendCode("+15551234567", "whatsapp");
    expect(calls[0]).toMatchObject({
      url: `${TWILIO_VERIFY_API}/Services/${SERVICE}/Verifications`,
      method: "POST",
      form: { To: "+15551234567", Channel: "whatsapp" },
    });
    expect(calls[0]?.auth).toMatch(/^Basic /);
    expect(await v.checkCode("+15551234567", "123456")).toBe(true);
    expect(calls[1]).toMatchObject({
      url: `${TWILIO_VERIFY_API}/Services/${SERVICE}/VerificationCheck`,
      form: { To: "+15551234567", Code: "123456" },
    });
    expect(await v.checkCode("+15551234567", "000000")).toBe(false);
    // No verification waiting (expired, or used): a wrong code, not an error.
    expect(await v.checkCode("+15551234567", "123456")).toBe(false);
  });

  it("creates, verifies, challenges and deletes an authenticator app", async () => {
    const { v, calls } = verifierWith([
      {
        status: 201,
        body: { sid: "YF1", status: "unverified", binding: { uri: "otpauth://x", secret: "S" } },
      },
      { status: 200, body: { status: "verified" } },
      { status: 201, body: { status: "approved" } },
      { status: 201, body: { status: "pending" } },
      { status: 204 },
      { status: 404, body: { code: 20404 } },
    ]);
    const user = "00000000-0000-4000-8000-000000000001";
    expect(await v.createTotp(user, "admin@example.com")).toEqual({
      factorSid: "YF1",
      uri: "otpauth://x",
    });
    expect(calls[0]).toMatchObject({
      url: `${TWILIO_VERIFY_API}/Services/${SERVICE}/Entities/${user}/Factors`,
      form: { FactorType: "totp", FriendlyName: "admin@example.com" },
    });
    expect(await v.verifyTotp(user, "YF1", "123456")).toBe(true);
    expect(calls[1]?.url).toBe(
      `${TWILIO_VERIFY_API}/Services/${SERVICE}/Entities/${user}/Factors/YF1`,
    );
    expect(calls[1]?.form).toEqual({ AuthPayload: "123456" });
    expect(await v.checkTotp(user, "YF1", "123456")).toBe(true);
    expect(calls[2]).toMatchObject({
      url: `${TWILIO_VERIFY_API}/Services/${SERVICE}/Entities/${user}/Challenges`,
      form: { FactorSid: "YF1", AuthPayload: "123456" },
    });
    expect(await v.checkTotp(user, "YF1", "000000")).toBe(false);
    await v.deleteTotp(user, "YF1");
    expect(calls[4]?.method).toBe("DELETE");
    // Already gone: fine.
    await expect(v.deleteTotp(user, "YF1")).resolves.toBeUndefined();
  });

  it("surfaces Twilio being down as an error, not a wrong code", async () => {
    const { v } = verifierWith([{ status: 503, body: { message: "unavailable" } }]);
    await expect(v.checkCode("+15551234567", "123456")).rejects.toThrow();
  });
});

describe("memoryCodeVerifier", () => {
  it("accepts its code only for what it sent or made", async () => {
    const m = memoryCodeVerifier();
    expect(await m.checkCode("+15551234567", "123456")).toBe(false);
    await m.sendCode("+15551234567", "sms");
    expect(await m.checkCode("+15551234567", "123456")).toBe(true);
    const { factorSid } = await m.createTotp("u1", "x");
    expect(await m.checkTotp("u1", factorSid, "123456")).toBe(false);
    expect(await m.verifyTotp("u1", factorSid, "123456")).toBe(true);
    expect(await m.checkTotp("u1", factorSid, "123456")).toBe(true);
    expect(await m.checkTotp("u2", factorSid, "123456")).toBe(false);
  });
});
