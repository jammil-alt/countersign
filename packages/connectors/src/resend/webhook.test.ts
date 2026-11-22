// Resend's webhook signature (Svix's scheme) and its events: a delivery signed with the secret is
// accepted, an altered body, a foreign secret, a stale or future timestamp and missing headers are
// not; tags read from either shape.
import { describe, expect, it } from "vitest";
import { toBase64, utf8 } from "../runtime";
import {
  isHandledResendEvent,
  ResendWebhookEvent,
  resendEventTags,
  resendSendTags,
  resendWebhookHeaders,
  verifyResendSignature,
} from "./webhook";

const SECRET = `whsec_${toBase64(utf8("a test signing key, 32 bytes long"))}`;
const OTHER = `whsec_${toBase64(utf8("someone else's signing key, 32 b"))}`;
const NOW = new Date("2026-11-22T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });

async function check(payload: string, headers: Record<string, string>, secret = SECRET, now = NOW) {
  return verifyResendSignature({
    payload,
    headers: {
      id: headers["svix-id"] ?? null,
      timestamp: headers["svix-timestamp"] ?? null,
      signature: headers["svix-signature"] ?? null,
    },
    secret,
    now,
  });
}

describe("verifyResendSignature", () => {
  it("accepts a delivery signed with the endpoint's secret", async () => {
    const h = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS });
    expect(await check(BODY, h)).toEqual({ ok: true, id: "msg_1", timestamp: TS });
  });

  it("matches Svix's published example (its docs' secret, id, timestamp and body)", async () => {
    const r = await verifyResendSignature({
      payload: '{"test": 2432232314}',
      headers: {
        id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
        timestamp: "1614265330",
        signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      },
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      now: new Date(1614265330 * 1000),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts any of several signatures (a secret being rolled)", async () => {
    const mine = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS });
    const theirs = await resendWebhookHeaders(OTHER, BODY, { id: "msg_1", timestamp: TS });
    const both = {
      ...mine,
      "svix-signature": `${theirs["svix-signature"]} ${mine["svix-signature"]}`,
    };
    expect((await check(BODY, both)).ok).toBe(true);
  });

  it("refuses an altered body, another id, a foreign secret", async () => {
    const h = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS });
    expect(await check(`${BODY} `, h)).toEqual({ ok: false, reason: "mismatch" });
    expect(await check(BODY, { ...h, "svix-id": "msg_2" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await check(BODY, h, OTHER)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a stale or future timestamp", async () => {
    const old = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS - 301 });
    expect(await check(BODY, old)).toEqual({ ok: false, reason: "expired" });
    const ahead = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS + 301 });
    expect(await check(BODY, ahead)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses missing or malformed headers and a secret that isn't one", async () => {
    expect(await check(BODY, {})).toEqual({ ok: false, reason: "missing" });
    const h = await resendWebhookHeaders(SECRET, BODY, { id: "msg_1", timestamp: TS });
    expect(await check(BODY, { ...h, "svix-signature": "v2,abc" })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await check(BODY, { ...h, "svix-timestamp": "soon" })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await check(BODY, h, "whsec_short")).toEqual({ ok: false, reason: "bad_secret" });
  });
});

describe("events", () => {
  it("handles delivered and bounced only", () => {
    expect(isHandledResendEvent("email.delivered")).toBe(true);
    expect(isHandledResendEvent("email.bounced")).toBe(true);
    expect(isHandledResendEvent("email.opened")).toBe(false);
    expect(isHandledResendEvent("email.complained")).toBe(false);
  });

  it("reads tags as an object or as the send's list, dropping malformed ones", () => {
    const asObject = ResendWebhookEvent.parse({
      type: "email.bounced",
      data: { email_id: "re_1", tags: { mz_tenant: "abc-1", bad: "has space", n: 3 } },
    });
    expect(resendEventTags(asObject)).toEqual({ mz_tenant: "abc-1" });
    const asList = ResendWebhookEvent.parse({
      type: "email.bounced",
      data: { email_id: "re_1", tags: [{ name: "mz_tenant", value: "abc-1" }] },
    });
    expect(resendEventTags(asList)).toEqual({ mz_tenant: "abc-1" });
    expect(resendSendTags({ a: "b", "c d": "e" })).toEqual([{ name: "a", value: "b" }]);
  });
});
