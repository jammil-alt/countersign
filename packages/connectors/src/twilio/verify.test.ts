// What the Twilio Verify client sends (docs/plan.md §1.83; VERIFY_NOTES.md lists what isn't
// checked against Twilio's docs) and how it reads the answers.

import { describe, expect, it } from "vitest";
import type { FetchLike } from "../http";
import { createVerifyClient, verifyLocale } from "./verify";

const config = {
  accountSid: `AC${"1".repeat(32)}`,
  authToken: "token",
  serviceSid: `VA${"2".repeat(32)}`,
};

/** A form body as an object (no web-platform URLSearchParams in this package). */
function form(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (body ?? "").split("&")) {
    if (!pair) continue;
    const [k = "", v = ""] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

function recorder(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
    const a = answers.shift() ?? { status: 200, body: {} };
    const text = a.status === 204 ? "" : JSON.stringify(a.body);
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  return { fetch, calls };
}

const service = `https://verify.twilio.com/v2/Services/${config.serviceSid}`;

describe("Twilio Verify client", () => {
  it("sends a code by text or WhatsApp, in the person's language", async () => {
    const r = recorder([{ status: 201, body: { status: "pending" } }]);
    await createVerifyClient(config, r.fetch).send("+15550100000", "whatsapp", "pt-br");
    expect(r.calls[0]).toMatchObject({ url: `${service}/Verifications`, method: "POST" });
    expect(form(r.calls[0]?.body)).toEqual({
      To: "+15550100000",
      Channel: "whatsapp",
      Locale: "pt-br",
    });
  });

  it("checks a code: approved is a yes, anything else or a 404 is a no", async () => {
    const r = recorder([
      { status: 200, body: { status: "approved" } },
      { status: 200, body: { status: "pending" } },
      { status: 404, body: { code: 20404, message: "not found" } },
    ]);
    const client = createVerifyClient(config, r.fetch);
    expect(await client.check("+15550100000", "123456")).toBe(true);
    expect(await client.check("+15550100000", "000000")).toBe(false);
    expect(await client.check("+15550100000", "000000")).toBe(false);
    expect(r.calls[0]?.url).toBe(`${service}/VerificationCheck`);
    expect(form(r.calls[0]?.body)["Code"]).toBe("123456");
  });

  it("sets up an authenticator under the person's entity, and proves and checks its codes", async () => {
    const r = recorder([
      {
        status: 201,
        body: {
          sid: "YF1",
          status: "unverified",
          binding: { secret: "ABC", uri: "otpauth://totp/Mezonas:ann?secret=ABC" },
        },
      },
      { status: 200, body: { status: "verified" } },
      { status: 201, body: { status: "approved" } },
      { status: 201, body: { status: "pending" } },
      { status: 204, body: null },
    ]);
    const client = createVerifyClient(config, r.fetch);
    expect(await client.startTotp("user-1", "ann@example.com")).toEqual({
      factorSid: "YF1",
      uri: "otpauth://totp/Mezonas:ann?secret=ABC",
      secret: "ABC",
    });
    expect(await client.confirmTotp("user-1", "YF1", "111111")).toBe(true);
    expect(await client.checkTotp("user-1", "YF1", "222222")).toBe(true);
    expect(await client.checkTotp("user-1", "YF1", "333333")).toBe(false);
    await client.deleteTotp("user-1", "YF1");
    expect(r.calls.map((c) => `${c.method} ${c.url.replace(service, "")}`)).toEqual([
      "POST /Entities/user-1/Factors",
      "POST /Entities/user-1/Factors/YF1",
      "POST /Entities/user-1/Challenges",
      "POST /Entities/user-1/Challenges",
      "DELETE /Entities/user-1/Factors/YF1",
    ]);
    expect(form(r.calls[0]?.body)["FactorType"]).toBe("totp");
    expect(form(r.calls[2]?.body)).toEqual({ FactorSid: "YF1", AuthPayload: "222222" });
  });

  it("maps our locales to Verify's", () => {
    expect(verifyLocale("pt-BR")).toBe("pt-br");
    expect(verifyLocale(null)).toBeNull();
  });
});
