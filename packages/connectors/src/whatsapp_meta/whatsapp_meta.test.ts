// v0.14 W4-A: WhatsApp through Meta against a fake Graph API (docs/plan.md §1.57): the webhook's
// signature and handshake, the delivery's parsing (groups defensively), the two-step media
// download with one re-resolve on expiry and its origin and size checks, Embedded Signup's code
// exchange (the token in the credentials only, one client per number), `whatsapp.send` with
// Twilio's checks (consent, quiet hours, the 24-hour window, templates, once per key), and the
// registry taking the shared ids from both connectors.

import { describe, expect, it } from "vitest";
import type { ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { hmacSha256Hex, parseUrl } from "../http";
import { executeWrite, runReadTool } from "../invoke";
import { noopLogger } from "../logger";
import type { MessagingServices, OutboundMessage, SendAttempt } from "../messaging/services";
import { SendBlockedError } from "../messaging/services";
import { WHATSAPP_SEND_TOOL } from "../messaging/spec";
import { ConnectorRegistry } from "../registry";
import { utf8 } from "../runtime";
import { createTwilioConnector } from "../twilio/index";
import {
  DEFAULT_FAKE_ACCOUNTS,
  FAKE_META,
  fakeInboundPayload,
  fakeMeta,
  fakeStatusPayload,
} from "./fake";
import { GRAPH_VERSION, graphUrl, isWamid } from "./graph";
import {
  completeEmbeddedSignup,
  createWhatsappMetaConnector,
  fetchMetaMedia,
  MetaCredentials,
  parseMetaWebhook,
  templateParameters,
  verifyMetaChallenge,
  verifyMetaSignature,
} from "./index";
import { newPin } from "./signup";

const enc = (s: string) => utf8(s);
const NUMBER = DEFAULT_FAKE_ACCOUNTS[0]?.numbers[0]?.id as string;
const WABA = DEFAULT_FAKE_ACCOUNTS[0]?.wabaId as string;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** The only origins the connector may call. */
const FAKE_ORIGINS = new Set(["https://graph.facebook.com", "https://lookaside.fbsbx.com"]);

describe("the webhook's signature", () => {
  const body = JSON.stringify(
    fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.HBgLMTU1NTU1NTAxMDAVAgASGBQzQUFGRkU=",
      text: "Olá — the invoice ✓",
    }),
  );

  it("accepts Meta's signature over the raw bytes", async () => {
    const meta = fakeMeta();
    const { signature } = await meta.deliver(JSON.parse(body));
    expect(
      await verifyMetaSignature({
        rawBody: enc(body),
        header: signature,
        appSecret: FAKE_META.appSecret,
      }),
    ).toBe(true);
  });

  it("refuses a tampered body, a re-serialized body, a wrong secret, and a missing header", async () => {
    const meta = fakeMeta();
    const { signature } = await meta.deliver(JSON.parse(body));
    const check = (raw: string, header: string | undefined, secret: string | undefined) =>
      verifyMetaSignature({ rawBody: enc(raw), header, appSecret: secret });
    expect(await check(body.replace("invoice", "lnvoice"), signature, FAKE_META.appSecret)).toBe(
      false,
    );
    // Meta escapes unicode when it signs: the same JSON parsed and serialized again doesn't match.
    let escaped = "";
    for (const ch of body) {
      const code = ch.charCodeAt(0);
      escaped += code > 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    }
    const signedEscaped = `sha256=${await hmacSha256Hex(FAKE_META.appSecret, escaped)}`;
    expect(escaped).not.toBe(body);
    expect(await check(escaped, signedEscaped, FAKE_META.appSecret)).toBe(true);
    const reserialized = JSON.stringify(JSON.parse(escaped));
    expect(reserialized).toBe(body);
    expect(await check(reserialized, signedEscaped, FAKE_META.appSecret)).toBe(false);
    expect(
      await check(JSON.stringify(JSON.parse(body), null, 1), signature, FAKE_META.appSecret),
    ).toBe(false);
    expect(await check(body, signature, "another-secret")).toBe(false);
    expect(await check(body, undefined, FAKE_META.appSecret)).toBe(false);
    expect(await check(body, "", FAKE_META.appSecret)).toBe(false);
    expect(await check(body, signature.replace("sha256=", "sha1="), FAKE_META.appSecret)).toBe(
      false,
    );
    expect(await check(body, `${signature}0`, FAKE_META.appSecret)).toBe(false);
    expect(await check(body, "sha256=zz", FAKE_META.appSecret)).toBe(false);
    // No secret (the deployment without one) never verifies anything.
    expect(await check(body, signature, "")).toBe(false);
    expect(await check(body, signature, undefined)).toBe(false);
  });
});

describe("the handshake", () => {
  const ok = {
    mode: "subscribe",
    token: FAKE_META.verifyToken,
    verifyToken: FAKE_META.verifyToken,
  };
  it("echoes the challenge when the token is ours", () => {
    expect(verifyMetaChallenge({ ...ok, challenge: "1158201444" })).toBe("1158201444");
  });
  it("refuses a wrong token, another mode, no challenge, odd challenges, and no verify token", () => {
    expect(verifyMetaChallenge({ ...ok, token: "guess", challenge: "1" })).toBeNull();
    expect(verifyMetaChallenge({ ...ok, mode: "unsubscribe", challenge: "1" })).toBeNull();
    expect(verifyMetaChallenge({ ...ok, challenge: undefined })).toBeNull();
    expect(verifyMetaChallenge({ ...ok, challenge: "<script>" })).toBeNull();
    expect(verifyMetaChallenge({ ...ok, challenge: "9".repeat(200) })).toBeNull();
    expect(verifyMetaChallenge({ ...ok, verifyToken: undefined, challenge: "1" })).toBeNull();
  });
});

describe("parsing a delivery", () => {
  it("reads text, media (never a link), statuses and the receiving number", () => {
    const text = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.TEXT1",
      text: "Hello",
      profileName: "Pat Lee",
    });
    const doc = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.DOC1",
      media: { type: "document", id: "123456", mime: "application/pdf", caption: "Invoice 7" },
    });
    const voice = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.VOICE1",
      media: { type: "audio", id: "654321", mime: "audio/ogg; codecs=opus" },
    });
    const sticker = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.STICK1",
      media: { type: "sticker", id: "777", mime: "image/webp" },
    });
    const got = [text, doc, voice, sticker].map((p) => parseMetaWebhook(p)?.messages[0]);
    expect(got[0]).toMatchObject({
      phoneNumberId: NUMBER,
      wamid: "wamid.TEXT1",
      from: "+15555550100",
      profileName: "Pat Lee",
      text: "Hello",
      media: [],
      groupId: null,
    });
    expect(got[1]).toMatchObject({
      text: "Invoice 7",
      media: [{ index: 0, contentType: "application/pdf", mediaSid: "123456" }],
    });
    expect(got[2]?.media).toEqual([{ index: 0, contentType: "audio/ogg", mediaSid: "654321" }]);
    // A sticker is not an attachment.
    expect(got[3]?.media).toEqual([]);
    expect(JSON.stringify(got)).not.toContain("http");

    const st = parseMetaWebhook(
      fakeStatusPayload({
        phoneNumberId: NUMBER,
        wamid: "wamid.OUT1",
        status: "failed",
        to: "+15555550100",
        opaque: "run:step:0",
        errorCode: 131047,
      }),
    );
    expect(st?.statuses).toEqual([
      expect.objectContaining({
        wamid: "wamid.OUT1",
        status: "failed",
        to: "+15555550100",
        errorCode: "131047",
        opaque: "run:step:0",
      }),
    ]);
  });

  it("skips what doesn't read, and isn't a WhatsApp account's delivery", () => {
    expect(parseMetaWebhook({ object: "page", entry: [] })).toBeNull();
    expect(parseMetaWebhook("nope")).toBeNull();
    const bad = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "not-a-wamid",
      text: "x",
    });
    expect(parseMetaWebhook(bad)?.messages).toEqual([]);
    const badNumber = fakeInboundPayload({
      phoneNumberId: "../me",
      from: "+15555550100",
      wamid: "wamid.X",
      text: "x",
    });
    expect(parseMetaWebhook(badNumber)?.messages).toEqual([]);
  });

  it("reads a group's id defensively (unverified shape)", () => {
    const p = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.G1",
      text: "hi all",
      groupId: "120363025246125486@g.us",
    });
    expect(parseMetaWebhook(p)?.messages[0]?.groupId).toBe("120363025246125486@g.us");
    const odd = fakeInboundPayload({
      phoneNumberId: NUMBER,
      from: "+15555550100",
      wamid: "wamid.G2",
      text: "hi",
      groupId: "<x>",
    });
    expect(parseMetaWebhook(odd)?.messages[0]?.groupId).toBeNull();
  });
});

describe("Graph URLs", () => {
  it("pins v26.0, and takes only ids and fixed words", () => {
    expect(graphUrl([NUMBER, "messages"])).toBe(
      `https://graph.facebook.com/${GRAPH_VERSION}/${NUMBER}/messages`,
    );
    expect(GRAPH_VERSION).toBe("v26.0");
    expect(graphUrl(["..", "messages"])).toBeNull();
    expect(graphUrl(["me"])).toBeNull();
    expect(graphUrl(["evil.example"])).toBeNull();
    expect(isWamid("wamid.HBgL+/=_-")).toBe(true);
    expect(isWamid("wamid.")).toBe(false);
    expect(isWamid("wamid.<x>")).toBe(false);
  });
});

describe("media: Meta's two-step download", () => {
  const token = () => {
    const meta = fakeMeta();
    const code = meta.issueCode();
    return { meta, code };
  };
  async function tokenFor(meta: ReturnType<typeof fakeMeta>) {
    const grant = await completeEmbeddedSignup(meta.fetch, FAKE_META, {
      code: meta.issueCode(),
    });
    return MetaCredentials.parse(grant.credentials);
  }

  it("resolves on the client's number, then downloads with the bearer token", async () => {
    const { meta } = token();
    const creds = await tokenFor(meta);
    const id = meta.addMedia({ phoneNumberId: NUMBER, mimeType: "image/png", bytes: PNG });
    const got = await fetchMetaMedia(meta.fetch, {
      token: creds.accessToken,
      phoneNumberId: NUMBER,
      mediaId: id,
      contentType: "image/png",
      maxBytes: 1000,
    });
    expect(got).toEqual({ ok: true, bytes: PNG, contentType: "image/png" });
    const calls = meta.requests.filter((r) => r.url.includes(id));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`https://graph.facebook.com/v26.0/${id}?phone_number_id=${NUMBER}`);
    expect(calls.every((r) => r.authorization === creds.accessToken)).toBe(true);
    expect(parseUrl(calls[1]?.url ?? "")?.origin).toBe("https://lookaside.fbsbx.com");
  });

  it("re-resolves once when the link expired, and gives up on a second dead link", async () => {
    const { meta } = token();
    const creds = await tokenFor(meta);
    const id = meta.addMedia({ phoneNumberId: NUMBER, mimeType: "image/png", bytes: PNG });
    const input = {
      token: creds.accessToken,
      phoneNumberId: NUMBER,
      mediaId: id,
      contentType: "image/png",
      maxBytes: 1000,
    };
    meta.expireNextLinks(1);
    expect((await fetchMetaMedia(meta.fetch, input)).ok).toBe(true);
    expect(meta.resolved.get(id)).toBe(2);
    meta.expireNextLinks(2);
    expect(await fetchMetaMedia(meta.fetch, input)).toEqual({
      ok: false,
      status: "failed",
      reason: "gone",
    });
    expect(meta.resolved.get(id)).toBe(4);
  });

  it("refuses another origin, too large (declared or read), another type, and another number", async () => {
    const { meta } = token();
    const creds = await tokenFor(meta);
    const base = { token: creds.accessToken, phoneNumberId: NUMBER, contentType: "image/png" };
    const elsewhere = meta.addMedia({
      phoneNumberId: NUMBER,
      mimeType: "image/png",
      bytes: PNG,
      linkOrigin: "https://lookaside.fbsbx.com.evil.example",
    });
    expect(
      await fetchMetaMedia(meta.fetch, { ...base, mediaId: elsewhere, maxBytes: 1000 }),
    ).toEqual({ ok: false, status: "failed", reason: "redirect_refused" });
    expect(meta.requests.every((r) => FAKE_ORIGINS.has(parseUrl(r.url)?.origin ?? ""))).toBe(true);

    const big = meta.addMedia({ phoneNumberId: NUMBER, mimeType: "image/png", bytes: PNG });
    expect(await fetchMetaMedia(meta.fetch, { ...base, mediaId: big, maxBytes: 4 })).toEqual({
      ok: false,
      status: "refused",
      reason: "too_large",
    });
    const lying = meta.addMedia({
      phoneNumberId: NUMBER,
      mimeType: "image/png",
      bytes: PNG,
      declaredSize: 1,
      noLength: true,
    });
    expect(await fetchMetaMedia(meta.fetch, { ...base, mediaId: lying, maxBytes: 4 })).toEqual({
      ok: false,
      status: "refused",
      reason: "too_large",
    });
    const other = meta.addMedia({
      phoneNumberId: NUMBER,
      mimeType: "image/png",
      bytes: PNG,
      servedType: "text/html",
    });
    expect(await fetchMetaMedia(meta.fetch, { ...base, mediaId: other, maxBytes: 1000 })).toEqual({
      ok: false,
      status: "refused",
      reason: "type_mismatch",
    });
    const theirs = meta.addMedia({ phoneNumberId: "999", mimeType: "image/png", bytes: PNG });
    expect(
      (await fetchMetaMedia(meta.fetch, { ...base, mediaId: theirs, maxBytes: 1000 })).ok,
    ).toBe(false);
    expect(await fetchMetaMedia(meta.fetch, { ...base, mediaId: "../x", maxBytes: 1000 })).toEqual({
      ok: false,
      status: "failed",
      reason: "no_media_id",
    });
  });
});

describe("Embedded Signup", () => {
  it("exchanges the code, checks the token and the number, subscribes and registers", async () => {
    const meta = fakeMeta();
    const asked: string[] = [];
    const grant = await completeEmbeddedSignup(
      meta.fetch,
      FAKE_META,
      { code: meta.issueCode(), waba_id: WABA, phone_number_id: NUMBER },
      async (id) => {
        asked.push(id);
        return false;
      },
    );
    expect(asked).toEqual([NUMBER]);
    expect(grant.externalAccountId).toBe(NUMBER);
    const creds = MetaCredentials.parse(grant.credentials);
    expect(creds).toMatchObject({ wabaId: WABA, phoneNumberId: NUMBER, appId: FAKE_META.appId });
    expect(meta.tokens()).toContain(creds.accessToken);
    expect(meta.subscribed.has(WABA)).toBe(true);
    expect(meta.registered.get(NUMBER)).toBe(creds.pin);
    expect(creds.pin).toMatch(/^\d{6}$/);
    // The config is for people to see: never the token, the PIN or the account's id.
    expect(grant.config).toMatchObject({ phoneNumber: "+15125550199" });
    const config = JSON.stringify(grant.config);
    expect(config).not.toContain(creds.accessToken);
    expect(config).not.toContain(creds.pin);
    expect(config).not.toContain(WABA);
    // The app's secret goes only to Meta's token endpoints, never with the business token.
    for (const r of meta.requests) {
      if (r.url.includes(FAKE_META.appSecret)) {
        expect(parseUrl(r.url)?.pathname).toMatch(/\/(oauth\/access_token|debug_token)$/);
      }
    }
  });

  it("refuses a number another client has, before anything changes at Meta", async () => {
    const meta = fakeMeta();
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode() }, async () => true),
    ).rejects.toThrow("already connected to another Mezonas account");
    expect(meta.subscribed.size).toBe(0);
    expect(meta.registered.size).toBe(0);
  });

  it("refuses an account or number the token can't reach, missing permissions, another app", async () => {
    const meta = fakeMeta();
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode(), waba_id: "42" }),
    ).rejects.toThrow("Pick one WhatsApp Business Account");
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, {
        code: meta.issueCode(),
        phone_number_id: "42",
      }),
    ).rejects.toThrow("Pick one phone number");
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, {
        code: meta.issueCode({ scopes: ["whatsapp_business_messaging"] }),
      }),
    ).rejects.toThrow("permission");
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode({ appId: "999" }) }),
    ).rejects.toThrow("isn't one for Mezonas");
    await expect(completeEmbeddedSignup(meta.fetch, FAKE_META, {})).rejects.toThrow("code");
    expect(meta.registered.size).toBe(0);
  });

  it("undoes the subscription when Meta won't register the number", async () => {
    const meta = fakeMeta();
    meta.refuseRegistration();
    await expect(
      completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode() }),
    ).rejects.toThrow("register the number");
    expect(meta.subscribed.size).toBe(0);
  });

  it("revoke unsubscribes our app from the account", async () => {
    const meta = fakeMeta();
    const grant = await completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode() });
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    await connector.revoke?.({
      tenantId: "t",
      connection: {
        id: "c",
        tenantId: "t",
        connector: "whatsapp_meta",
        status: "connected",
        externalAccountId: NUMBER,
        config: grant.config ?? {},
        permissions: {},
      },
      credentials: memoryCredentials(grant.credentials),
      logger: noopLogger,
      now: () => new Date(),
    });
    expect(meta.subscribed.has(WABA)).toBe(false);
  });
});

// ── whatsapp.send ────────────────────────────────────────────────────────────────────────────────

function fakeServices(opts: {
  block?: "no_consent" | "quiet_hours" | "opted_out";
  lastInboundAt?: Date | null;
}) {
  const sent: OutboundMessage[] = [];
  const attempts = new Map<string, SendAttempt>();
  const statuses = new Map<string, { sid: string; status: string }>();
  const services: MessagingServices = {
    async checkSend(input) {
      if (opts.block === "quiet_hours" && input.ignoreQuietHours) {
        return {
          ok: true,
          contact: { id: "c1", name: "Pat Lee", language: "es" },
          lastInboundAt: opts.lastInboundAt ?? null,
        };
      }
      if (opts.block) return { ok: false, block: opts.block, message: `blocked: ${opts.block}` };
      return {
        ok: true,
        contact: { id: "c1", name: "Pat Lee", language: "es" },
        lastInboundAt: opts.lastInboundAt === undefined ? new Date() : opts.lastInboundAt,
      };
    },
    async sentFor(key) {
      const m = sent.find((s) => s.idempotencyKey === key);
      return m
        ? {
            sid: m.sid,
            status: m.status,
            channel: m.channel,
            to: m.to,
            from: m.from,
            templateId: m.templateId,
            contactId: m.contactId,
            contactName: "Pat Lee",
          }
        : null;
    },
    async startAttempt(a) {
      if (!attempts.has(a.idempotencyKey)) attempts.set(a.idempotencyKey, a);
    },
    async attemptFor(key) {
      return attempts.get(key) ?? null;
    },
    async recordedSids(sids) {
      return sids.filter((s) => sent.some((m) => m.sid === s));
    },
    async recordOutbound(m) {
      if (!sent.some((s) => s.sid === m.sid)) sent.push(m);
    },
    async statusSidFor(key) {
      return statuses.get(key) ?? null;
    },
  };
  return { services, sent, attempts, statuses };
}

async function connectedCtx(meta: ReturnType<typeof fakeMeta>, services: MessagingServices) {
  const grant = await completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode() });
  const ctx: ToolContext = {
    tenantId: "t1",
    connection: {
      id: "conn-meta",
      tenantId: "t1",
      connector: "whatsapp_meta",
      status: "connected",
      externalAccountId: NUMBER,
      config: grant.config ?? {},
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
    },
    credentials: memoryCredentials(grant.credentials),
    logger: noopLogger,
    now: () => new Date("2026-11-06T15:00:00Z"),
    services: { messaging: services },
  };
  return ctx;
}

const write = (ctx: ToolContext, key: string): WriteContext => ({ ...ctx, idempotencyKey: key });

describe("whatsapp.send through Meta", () => {
  it("sends free text inside the window, once per key, with our key for the status callbacks", async () => {
    const meta = fakeMeta();
    const { services, sent } = fakeServices({});
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    const ctx = await connectedCtx(meta, services);
    const input = { to: "+15555550100", text: "Your order is ready" };
    const first = await executeWrite(connector, WHATSAPP_SEND_TOOL, input, write(ctx, "r:s:0"));
    expect(first.output).toMatchObject({
      channel: "whatsapp",
      from: "+15125550199",
      to: "+15555550100",
      template: false,
      usage: { messages: 1 },
    });
    expect(meta.sent).toHaveLength(1);
    expect(meta.sent[0]?.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "15555550100",
      type: "text",
      text: { body: "Your order is ready", preview_url: false },
      biz_opaque_callback_data: "r:s:0",
    });
    const again = await executeWrite(connector, WHATSAPP_SEND_TOOL, input, write(ctx, "r:s:0"));
    expect(again.output).toMatchObject({ usage: { messages: 0 } });
    expect(meta.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("outside the window sends only an approved template, in the contact's language", async () => {
    const meta = fakeMeta();
    const { services } = fakeServices({ lastInboundAt: null });
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    const ctx = await connectedCtx(meta, services);
    await expect(
      executeWrite(
        connector,
        WHATSAPP_SEND_TOOL,
        { to: "+15555550100", text: "hi" },
        write(ctx, "r:s:1"),
      ),
    ).rejects.toThrow("approved template");
    expect(meta.sent).toHaveLength(0);
    const out = await executeWrite(
      connector,
      WHATSAPP_SEND_TOOL,
      {
        to: "+15555550100",
        template: { id: "order_ready", variables: { "2": "Thu", "1": "Pat" } },
      },
      write(ctx, "r:s:2"),
    );
    expect(out.output).toMatchObject({ template: true });
    expect(meta.sent[0]?.body).toMatchObject({
      type: "template",
      template: {
        name: "order_ready",
        language: { code: "es" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Pat" },
              { type: "text", text: "Thu" },
            ],
          },
        ],
      },
    });
  });

  it("checks consent and quiet hours in code before Meta is called", async () => {
    for (const block of ["no_consent", "opted_out", "quiet_hours"] as const) {
      const meta = fakeMeta();
      const { services } = fakeServices({ block });
      const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
      const ctx = await connectedCtx(meta, services);
      const sendCalls = () => meta.requests.filter((r) => r.url.endsWith("/messages")).length;
      await expect(
        executeWrite(
          connector,
          WHATSAPP_SEND_TOOL,
          { to: "+15555550100", text: "hi" },
          write(ctx, `k-${block}`),
        ),
      ).rejects.toBeInstanceOf(SendBlockedError);
      expect(sendCalls()).toBe(0);
    }
  });

  it("a lost answer never sends again: adopted from the status callback, else unconfirmed", async () => {
    const meta = fakeMeta();
    const { services, statuses } = fakeServices({});
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    const ctx = await connectedCtx(meta, services);
    const input = { to: "+15555550100", text: "Ready" };
    meta.loseNextAnswer();
    await expect(
      executeWrite(connector, WHATSAPP_SEND_TOOL, input, write(ctx, "r:s:9")),
    ).rejects.toThrow();
    expect(meta.sent).toHaveLength(1);
    await expect(
      executeWrite(connector, WHATSAPP_SEND_TOOL, input, write(ctx, "r:s:9")),
    ).rejects.toThrow("may have been sent");
    statuses.set("r:s:9", { sid: meta.sent[0]?.wamid as string, status: "delivered" });
    const adopted = await executeWrite(connector, WHATSAPP_SEND_TOOL, input, write(ctx, "r:s:9"));
    expect(adopted.output).toMatchObject({ sid: meta.sent[0]?.wamid, usage: { messages: 1 } });
    expect(meta.sent).toHaveLength(1);
  });

  it("reads answer from what the platform recorded", async () => {
    const meta = fakeMeta();
    const { services } = fakeServices({});
    services.storedMessages = async () => [];
    services.storedMessage = async (sid) =>
      sid === "wamid.KNOWN"
        ? {
            sid,
            direction: "in",
            channel: "whatsapp",
            from: "+15555550100",
            to: "+15125550199",
            text: "hi",
            status: "received",
            sentAt: null,
            numMedia: 0,
            errorCode: null,
          }
        : null;
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    const ctx = await connectedCtx(meta, services);
    const got = await runReadTool(connector, "message.get", { sid: "wamid.KNOWN" }, ctx);
    expect(got.output).toMatchObject({ message: { sid: "wamid.KNOWN", text: "hi" } });
    await expect(runReadTool(connector, "message.get", { sid: "wamid.NOPE" }, ctx)).rejects.toThrow(
      "no message",
    );
    expect(meta.requests.filter((r) => r.url.includes("wamid"))).toHaveLength(0);
  });

  it("orders numbered template variables, and names the others", () => {
    expect(templateParameters({ "10": "c", "2": "b", "1": "a" }).map((p) => p.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(templateParameters({ name: "Pat" })).toEqual([
      { type: "text", parameter_name: "name", text: "Pat" },
    ]);
  });
});

describe("the shared ids", () => {
  it("register from Twilio and Meta, and only shapes that agree", () => {
    const registry = new ConnectorRegistry([
      createTwilioConnector(),
      createWhatsappMetaConnector({ ...FAKE_META }),
    ]);
    expect(registry.providersOf(WHATSAPP_SEND_TOOL).map((c) => c.manifest.id)).toEqual([
      "twilio",
      "whatsapp_meta",
    ]);
    expect(registry.providersOf("sms.send").map((c) => c.manifest.id)).toEqual(["twilio"]);
    expect(registry.findTool(WHATSAPP_SEND_TOOL, "whatsapp_meta")?.connector.manifest.id).toBe(
      "whatsapp_meta",
    );
    expect(registry.findTool(WHATSAPP_SEND_TOOL)?.connector.manifest.id).toBe("twilio");
    expect(registry.findTool("sms.send", "whatsapp_meta")).toBeUndefined();
    // Not configured without every value: "Not available yet".
    expect(createWhatsappMetaConnector({ appId: "1", appSecret: "s" }).isConfigured?.()).toBe(
      false,
    );
    expect(createWhatsappMetaConnector({ ...FAKE_META }).isConfigured?.()).toBe(true);
  });
});

describe("newPin", () => {
  it("is six digits, and every digit turns up", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pin = newPin();
      expect(pin).toMatch(/^\d{6}$/);
      for (const d of pin) seen.add(d);
    }
    expect(seen.size).toBe(10);
  });
});
