// INTEG lens: the code service's public webhook (apps/mfa `POST /twilio/sms/:identityId`) driven
// through its real Hono app, with Twilio's real signature scheme and a recording Identity stub in
// place of the Durable Object namespace. `cloudflare:workers` is stubbed so the module loads in Node.

import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

// Loaded by a path TypeScript doesn't follow: apps/mfa's Worker types are not apps/api's.
const MFA = new URL("../../../mfa/src", import.meta.url).pathname;
type MfaApp = {
  request(url: string, init: RequestInit, env: unknown): Promise<Response> | Response;
};
const { app } = (await import(/* @vite-ignore */ `${MFA}/index.ts`)) as { app: MfaApp };
const { twilioSignature } = (await import(/* @vite-ignore */ `${MFA}/twilio.ts`)) as {
  twilioSignature(token: string, url: string, params: Record<string, string>): Promise<string>;
};

const ORIGIN = "https://codes.mezonas.test";
const TOKEN = "twilio-auth-token-for-tests";
const ACCOUNT = `AC${"1".repeat(32)}`;
const IDENTITY = "abcdefghijkl";

describe("INTEG mfa: Twilio's signed inbound text", () => {
  it("INTEG-3: a replayed signed text (same MessageSid) reaches the identity only once", async () => {
    const received: unknown[] = [];
    const stub = {
      receive: async (m: unknown) => {
        received.push(m);
        return { outcome: "filled" };
      },
    };
    const env = {
      MFA_TWILIO_AUTH_TOKEN: TOKEN,
      MFA_TWILIO_ACCOUNT_SID: ACCOUNT,
      MFA_ORIGIN: ORIGIN,
      IDENTITY: { idFromName: (n: string) => n, get: () => stub },
    };
    const params = {
      AccountSid: ACCOUNT,
      MessageSid: `SM${"a".repeat(32)}`,
      From: "+15550001111",
      To: "+15550002222",
      Body: "Your Supplier code is 481516",
    };
    const path = `/twilio/sms/${IDENTITY}`;
    const signature = await twilioSignature(TOKEN, `${ORIGIN}${path}`, params);
    const post = () =>
      app.request(
        `${ORIGIN}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": signature,
          },
          body: new URLSearchParams(params).toString(),
        },
        env,
      );
    expect((await post()).status).toBe(200);
    // The same request again, later (captured, or Twilio's own retry): it must not be handed to
    // the identity a second time, where it would fill whatever wait is open now.
    await post();
    expect(received).toHaveLength(1);
  });
});
