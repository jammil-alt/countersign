// Every route that takes a body with no session reads it bounded: a declared length over the
// route's limit is refused without reading, and a body with no length is read only up to the
// limit, so nothing much larger is ever held. Each request here streams far more than any of these
// routes takes, with no length, and counts what the route pulled from it.

import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";

const h = await createApiHarness({
  env: {
    STRIPE_WEBHOOK_SECRET: "whsec_public_bodies",
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
    ELEVENLABS_API_KEY: "el-key",
    ELEVENLABS_WEBHOOK_SECRET: "el-secret",
    MOBILE_SIGNIN: "on",
  },
});
afterAll(() => h?.close());

const CHUNK = 64 * 1024;
/** Past every limit below (the largest is 2 MiB, an ElevenLabs call record). */
const TOTAL = 8 * 1024 * 1024;
const LARGEST_LIMIT = 2 * 1024 * 1024;

/** A body of `TOTAL` bytes made on demand, with a count of what was pulled from it. */
function endless() {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= TOTAL) {
          controller.close();
          return;
        }
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

const T = "0b6f1f0e-7a3c-4d6e-9b1a-2c3d4e5f6a7b";
const U = "1c7a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "a".repeat(40);

const PUBLIC_POSTS: readonly [method: string, path: string][] = [
  ["POST", `/api/twilio/${T}/messages`],
  ["POST", `/api/twilio/${T}/status`],
  ["POST", `/api/twilio/${T}/voice`],
  ["POST", `/api/twilio/${T}/voice/answer?call=${U}`],
  ["POST", `/api/twilio/${T}/voice/status`],
  ["POST", "/api/billing/stripe/webhook"],
  ["POST", "/api/connections/qbo/webhook"],
  ["POST", `/api/connections/bankfeed/webhook/${T}`],
  ["POST", `/api/hooks/${T}/${U}`],
  ["POST", "/api/hooks/gchat"],
  ["POST", "/api/hooks/teams"],
  ["POST", "/api/hooks/whatsapp_meta"],
  ["POST", `/api/hooks/zoho_crm/${T}/${U}`],
  ["POST", `/api/in/marketing/${T}/${U}`],
  ["POST", "/api/elevenlabs/post-call"],
  ["POST", `/api/voice/${T}/tools/lookup`],
  ["POST", `/api/text-signup/${TOKEN}`],
  ["POST", `/api/text-signup/${TOKEN}/decline`],
  ["POST", "/api/mobile/session"],
  ["PUT", `/api/forms/${TOKEN}/draft`],
  ["POST", `/api/forms/${TOKEN}`],
  ["POST", `/api/forms/${TOKEN}/files?question=q`],
  ["POST", "/api/auth/dev/sign-in"],
  ["POST", "/api/auth/sign-out"],
  ["POST", "/api/auth/second-factor/setup"],
  ["POST", "/api/auth/second-factor/send"],
  ["POST", "/api/auth/second-factor/verify"],
  ["POST", "/api/auth/second-factor/recovery"],
];

describe.skipIf(!h)("bodies of routes with no session", () => {
  const H = h as ApiHarness;

  it.each(PUBLIC_POSTS)("%s %s reads no more than its limit", async (method, path) => {
    const { body, pulled } = endless();
    const res = await H.app.request(
      path,
      {
        method,
        body,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-a-token",
        },
        duplex: "half",
      } as RequestInit,
      H.env,
    );
    await res.text();
    expect(res.status).not.toBe(500);
    expect(pulled()).toBeLessThanOrEqual(LARGEST_LIMIT + 2 * CHUNK);
  });

  it("refuses a public JSON body past its limit with 413, read no further", async () => {
    const { body, pulled } = endless();
    const res = await H.app.request(
      `/api/text-signup/${TOKEN}`,
      {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        duplex: "half",
      } as RequestInit,
      H.env,
    );
    expect(res.status).toBe(413);
    expect(pulled()).toBeLessThan(TOTAL);
  });

  it("refuses a declared length past the limit without reading the body", async () => {
    const { body, pulled } = endless();
    const res = await H.app.request(
      `/api/twilio/${T}/messages`,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(TOTAL),
        },
        duplex: "half",
      } as RequestInit,
      H.env,
    );
    expect(res.status).toBe(413);
    expect(pulled()).toBe(0);
  });
});
