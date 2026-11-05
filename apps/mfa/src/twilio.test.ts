import { describe, expect, it } from "vitest";
import { buyNumber, releaseNumber, twilioSignature, verifyTwilioSignature } from "./twilio";

const account = { accountSid: "AC123", authToken: "secret-token" };

describe("Twilio webhook signatures", () => {
  it("reproduces Twilio's documented example", async () => {
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    };
    expect(await twilioSignature("12345", url, params)).toBe("GvWf1cFY/Q7PnoempGyD5oXAezc=");
    const signature = "GvWf1cFY/Q7PnoempGyD5oXAezc=";
    expect(await verifyTwilioSignature({ authToken: "12345", url, params, signature })).toBe(true);
    // A changed parameter, URL or token, or no signature: refused.
    expect(
      await verifyTwilioSignature({
        authToken: "12345",
        url,
        params: { ...params, Digits: "9999" },
        signature,
      }),
    ).toBe(false);
    expect(
      await verifyTwilioSignature({ authToken: "12345", url: `${url}&x=1`, params, signature }),
    ).toBe(false);
    expect(await verifyTwilioSignature({ authToken: "54321", url, params, signature })).toBe(false);
    expect(
      await verifyTwilioSignature({ authToken: "12345", url, params, signature: undefined }),
    ).toBe(false);
  });
});

interface Call {
  method: string;
  url: string;
  body: string | null;
  auth: string | null;
}

function fakeTwilio(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });
    const key = `${method} ${new URL(url).pathname}`;
    const answer = answers[key];
    return answer ? answer() : new Response(JSON.stringify({ message: "nope" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("buying and releasing numbers", () => {
  it("searches by area code, buys the first number and points its texts at us", async () => {
    const { calls, fetcher } = fakeTwilio({
      "GET /2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json": () =>
        Response.json({ available_phone_numbers: [{ phone_number: "+14155550100" }] }),
      "POST /2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json": () =>
        Response.json({ sid: "PN1", phone_number: "+14155550100" }, { status: 201 }),
    });
    const bought = await buyNumber(fetcher, account, {
      areaCode: "415",
      smsUrl: "https://codes.example/twilio/sms/abcdefgh2345",
      friendlyName: "mezonas-codes abcdefgh2345",
    });
    expect(bought).toEqual({ sid: "PN1", phoneNumber: "+14155550100" });
    expect(calls[0]?.url).toContain("AreaCode=415");
    expect(calls[0]?.url).toContain("SmsEnabled=true");
    expect(calls[0]?.auth).toBe(`Basic ${btoa("AC123:secret-token")}`);
    const form = new URLSearchParams(calls[1]?.body ?? "");
    expect(form.get("PhoneNumber")).toBe("+14155550100");
    expect(form.get("SmsUrl")).toBe("https://codes.example/twilio/sms/abcdefgh2345");
    expect(form.get("SmsMethod")).toBe("POST");
  });

  it("fails plainly when no number is available, and treats a released number as gone", async () => {
    const { fetcher } = fakeTwilio({
      "GET /2010-04-01/Accounts/AC123/AvailablePhoneNumbers/US/Local.json": () =>
        Response.json({ available_phone_numbers: [] }),
    });
    await expect(
      buyNumber(fetcher, account, { smsUrl: "https://x/y", friendlyName: "x" }),
    ).rejects.toThrow(/no number available/);
    await expect(releaseNumber(fetcher, account, "PN404")).resolves.toBeUndefined();
  });
});
