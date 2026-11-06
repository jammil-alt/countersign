// v0.14 capture: an inbound message's attachments, against the fake Twilio (docs/plan.md §1.55).
// What is kept (index, type, media SID: never a link), the fetch's guards (Twilio's API origin
// only, one redirect to a listed origin without credentials, the size limit before and while
// reading, the declared type), and `message.get` with the platform's facts.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { parseUrl } from "../http";
import { runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import type { MessagingServices } from "../messaging/services";
import { MESSAGE_GET_TOOL } from "../messaging/spec";
import { FAKE_TWILIO_MAIN, FAKE_TWILIO_MEDIA_HOST, fakeTwilio } from "./fake";
import { createSubaccount, createTwilioConnector, parseInbound } from "./index";
import {
  fetchTwilioMedia,
  inboundMedia,
  isMediaSid,
  mediaSidOf,
  TransientMediaError,
  twilioMediaUrl,
} from "./media";

const PAT = "+15555550100";
const OURS = "+15125550101";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ME = `ME${"a".repeat(32)}`;
const MM = `MM${"b".repeat(32)}`;
const AC = `AC${"c".repeat(32)}`;

async function setup() {
  const twilio = fakeTwilio();
  const sub = await createSubaccount(twilio.fetch, FAKE_TWILIO_MAIN, "Client A");
  const send = (media: NonNullable<Parameters<typeof twilio.inbound>[0]["media"]>) =>
    twilio.inbound({
      account: sub.accountSid,
      from: PAT,
      to: OURS,
      body: "",
      url: "https://app.mezonas.test/api/twilio/x/messages",
      channel: "whatsapp",
      media,
    });
  return { twilio, sub, send };
}

describe("what an inbound message keeps of its attachments", () => {
  it("reads the media SID out of Twilio's link and nothing else", () => {
    expect(
      mediaSidOf(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Media/${ME}`),
    ).toBe(ME);
    for (const bad of [
      `https://evil.example/2010-04-01/Accounts/${AC}/Messages/${MM}/Media/${ME}`,
      `https://api.twilio.com.evil.example/Accounts/${AC}/Messages/${MM}/Media/${ME}`,
      `http://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Media/${ME}`,
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Media/ME123`,
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Other/${ME}`,
      "not a url",
      "",
    ]) {
      expect(mediaSidOf(bad), bad).toBeNull();
    }
    expect(isMediaSid(ME)).toBe(true);
    expect(isMediaSid(`ME${"A".repeat(32)}`)).toBe(false);
  });

  it("keeps index, declared type and media SID from the webhook, capped at 10", async () => {
    const { send } = await setup();
    const msg = await send([
      { contentType: "image/JPG", bytes: PNG },
      { contentType: "application/pdf; charset=binary", bytes: PNG },
    ]);
    const parsed = parseInbound(msg.params);
    expect(parsed?.media).toEqual([
      { index: 0, contentType: "image/jpeg", mediaSid: msg.mediaSids[0] },
      { index: 1, contentType: "application/pdf", mediaSid: msg.mediaSids[1] },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("https://");
    expect(inboundMedia(new Map([["NumMedia", "99"]]))).toHaveLength(10);
    expect(inboundMedia(new Map([["NumMedia", "x"]]))).toEqual([]);
    // A link that isn't Twilio's keeps the attachment's existence, without an id to fetch it by.
    expect(
      inboundMedia(
        new Map([
          ["NumMedia", "1"],
          ["MediaUrl0", "https://evil.example/x"],
          ["MediaContentType0", "image/png"],
        ]),
      ),
    ).toEqual([{ index: 0, contentType: "image/png", mediaSid: null }]);
  });

  it("builds the media link from validated SIDs only, on Twilio's API origin", () => {
    expect(twilioMediaUrl({ accountSid: AC, messageSid: MM, mediaSid: ME })?.origin).toBe(
      "https://api.twilio.com",
    );
    expect(twilioMediaUrl({ accountSid: AC, messageSid: MM, mediaSid: "../../x" })).toBeNull();
    expect(twilioMediaUrl({ accountSid: "AC1", messageSid: MM, mediaSid: ME })).toBeNull();
  });
});

describe("fetching an attachment", () => {
  it("fetches with the subaccount's credentials, follows one redirect without them", async () => {
    const { twilio, sub, send } = await setup();
    const msg = await send([{ contentType: "image/png", bytes: PNG }]);
    const got = await fetchTwilioMedia(twilio.fetch, sub, {
      messageSid: msg.sid,
      mediaSid: msg.mediaSids[0] ?? null,
      contentType: "image/png",
      maxBytes: 1024,
    });
    expect(got).toEqual({ ok: true, bytes: PNG, contentType: "image/png" });
    const reqs = twilio.mediaRequests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ account: sub.accountSid, authorized: true });
    expect(parseUrl(reqs[1]?.url ?? "")?.origin).toBe(FAKE_TWILIO_MEDIA_HOST);
    expect(reqs[1]?.authorized).toBe(false);
  });

  it("refuses a redirect to an origin not on the list, or over plain HTTP", async () => {
    const { twilio, sub, send } = await setup();
    for (const to of [
      "https://evil.example/steal",
      "http://media.twiliocdn.com/x",
      "https://media.twiliocdn.com.evil.example/x",
      "https://user:pw@media.twiliocdn.com/x",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const msg = await send([{ contentType: "image/png", bytes: PNG, redirectTo: to }]);
      const before = twilio.requests.length;
      const got = await fetchTwilioMedia(twilio.fetch, sub, {
        messageSid: msg.sid,
        mediaSid: msg.mediaSids[0] ?? null,
        contentType: "image/png",
        maxBytes: 1024,
      });
      expect(got, to).toEqual({ ok: false, status: "failed", reason: "redirect_refused" });
      // Nothing was requested from the redirect's target.
      expect(twilio.requests.length - before).toBe(1);
    }
  });

  it("refuses a file over the limit, declared or counted while reading", async () => {
    const { twilio, sub, send } = await setup();
    const big = new Uint8Array(200_000);
    big.set(PNG);
    for (const noLength of [false, true]) {
      const msg = await send([{ contentType: "image/png", bytes: big, noLength }]);
      const got = await fetchTwilioMedia(twilio.fetch, sub, {
        messageSid: msg.sid,
        mediaSid: msg.mediaSids[0] ?? null,
        contentType: "image/png",
        maxBytes: 100_000,
      });
      expect(got, `noLength ${noLength}`).toEqual({
        ok: false,
        status: "refused",
        reason: "too_large",
      });
    }
  });

  it("refuses a type other than the declared one; fails on gone, id-less or another account's media", async () => {
    const { twilio, sub, send } = await setup();
    const msg = await send([{ contentType: "image/png", bytes: PNG, servedType: "text/html" }]);
    const input = {
      messageSid: msg.sid,
      mediaSid: msg.mediaSids[0] ?? null,
      contentType: "image/png",
      maxBytes: 1024,
    };
    expect(await fetchTwilioMedia(twilio.fetch, sub, input)).toEqual({
      ok: false,
      status: "refused",
      reason: "type_mismatch",
    });
    expect(await fetchTwilioMedia(twilio.fetch, sub, { ...input, mediaSid: null })).toEqual({
      ok: false,
      status: "failed",
      reason: "no_media_id",
    });
    expect(
      await fetchTwilioMedia(twilio.fetch, sub, { ...input, mediaSid: `ME${"9".repeat(32)}` }),
    ).toEqual({ ok: false, status: "failed", reason: "gone" });
    // Another client's subaccount can't read this one's media.
    const other = await createSubaccount(twilio.fetch, FAKE_TWILIO_MAIN, "Client B");
    const theirs = await fetchTwilioMedia(twilio.fetch, other, input);
    expect(theirs.ok).toBe(false);
  });

  it("throws a transient error when Twilio is down, for the step to retry", async () => {
    const { twilio, sub, send } = await setup();
    const msg = await send([{ contentType: "image/png", bytes: PNG, failWith: 503 }]);
    await expect(
      fetchTwilioMedia(twilio.fetch, sub, {
        messageSid: msg.sid,
        mediaSid: msg.mediaSids[0] ?? null,
        contentType: "image/png",
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(TransientMediaError);
  });
});

describe("message.get with the platform's facts", () => {
  it("adds the conversation and attachments, and hides text a conversation doesn't keep", async () => {
    const { twilio, sub } = await setup();
    const msg = await twilio.inbound({
      account: sub.accountSid,
      from: PAT,
      to: OURS,
      body: "Here is the invoice",
      url: "https://app.mezonas.test/api/twilio/x/messages",
      channel: "whatsapp",
      media: [{ contentType: "image/png", bytes: PNG }],
    });
    const connector = createTwilioConnector({ fetch: twilio.fetch });
    const facts = (kept: boolean): Pick<MessagingServices, "messageFacts"> => ({
      async messageFacts(sids) {
        return new Map(
          sids.map((sid) => [
            sid,
            {
              kept,
              conversation: { id: "conv-1", kind: "direct" as const, title: "Pat" },
              attachments: [
                {
                  index: 0,
                  contentType: "image/png",
                  sizeBytes: 12,
                  status: "filed" as const,
                  documentId: "doc-1",
                },
              ],
            },
          ]),
        );
      },
    });
    const ctx = (kept: boolean) => {
      const connection: ConnectionRef = {
        id: "0190f0c8-0000-7000-8000-0000000000c1",
        tenantId: "0190f0c8-0000-7000-8000-000000000001",
        connector: "twilio",
        status: "connected",
        externalAccountId: sub.accountSid,
        config: {} as JsonObject,
        permissions: DEFAULT_PERMISSIONS,
      };
      return {
        tenantId: connection.tenantId,
        connection,
        credentials: memoryCredentials(sub as unknown as JsonObject),
        logger: memoryLogger(),
        now: () => new Date(),
        services: { messaging: facts(kept) as MessagingServices },
      };
    };
    const kept = await runReadTool(connector, MESSAGE_GET_TOOL, { sid: msg.sid }, ctx(true));
    expect(kept.output).toMatchObject({
      message: {
        text: "Here is the invoice",
        kept: true,
        conversation: { id: "conv-1" },
        attachments: [{ status: "filed", documentId: "doc-1" }],
      },
    });
    const dropped = await runReadTool(connector, MESSAGE_GET_TOOL, { sid: msg.sid }, ctx(false));
    expect(dropped.output).toMatchObject({ message: { text: "", kept: false } });
    expect(JSON.stringify(kept.output)).not.toContain("twilio.com");
  });
});
