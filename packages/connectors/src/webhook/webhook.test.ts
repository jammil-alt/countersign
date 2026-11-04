import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { checkPublicHttpsUrl, constantTimeEqual, formDecode, hmacSha256Hex } from "../http";
import { captureBefore, executeWrite, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { ConnectorRegistry } from "../registry";
import { utf8 } from "../runtime";
import { fakeReceiver } from "../testing";
import {
  addHook,
  createWebhookConnector,
  deliveryKey,
  deliveryText,
  hookUrl,
  MAX_DELIVERY_BYTES,
  MAX_HOOKS,
  parseDelivery,
  readWebhookConfig,
  readWebhookCredentials,
  removeHook,
  setOutbound,
  verifyDelivery,
  WEBHOOK_RECEIVED_EVENT,
  WEBHOOK_SEND_TOOL,
  WebhookReceivedPayload,
} from "./index";

const NOW = new Date("2026-11-04T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";

function ctx(credentials: JsonObject | null, over: Partial<ConnectionRef> = {}): WriteContext {
  return {
    tenantId: tenant,
    connection: {
      id: "0190f0c8-0000-7000-8000-0000000000c1",
      tenantId: tenant,
      connector: "webhook",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
      ...over,
    },
    credentials: memoryCredentials(credentials),
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: "run-1:send:0",
  };
}

const empty = () => ({ config: readWebhookConfig({}), credentials: readWebhookCredentials(null) });

describe("webhook connector", () => {
  it("registers one external create tool, approval by default, and its event type", () => {
    const c = createWebhookConnector();
    new ConnectorRegistry([c]);
    expect(c.manifest.tools.map((t) => [t.id, t.sideEffect, t.verb, t.connector])).toEqual([
      [WEBHOOK_SEND_TOOL, "external", "create", "webhook"],
    ]);
    expect(c.manifest.events?.map((e) => e.type)).toEqual([WEBHOOK_RECEIVED_EVENT]);
    const sample = c.manifest.events?.[0]?.sample;
    expect(WebhookReceivedPayload.safeParse(sample).success).toBe(true);
    expect(c.manifest.auth).toBe("none");
  });

  it("adds and removes hooks: ids in config, tokens only in the credentials", () => {
    const a = addHook(empty(), "New form entries", NOW);
    expect(a.config.hooks).toEqual([
      { id: a.hook.id, name: "New form entries", createdAt: NOW.toISOString() },
    ]);
    expect(JSON.stringify(a.config)).not.toContain(a.token);
    expect(a.credentials.tokens[a.hook.id]).toBe(a.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    const b = addHook(a, "Orders", NOW);
    expect(b.token).not.toBe(a.token);
    const r = removeHook(b, a.hook.id);
    expect(r.removed?.id).toBe(a.hook.id);
    expect(r.config.hooks.map((h) => h.name)).toEqual(["Orders"]);
    expect(Object.keys(r.credentials.tokens)).toEqual([b.hook.id]);
    expect(hookUrl("https://app.mezonas.com/", tenant, a.hook.id, "t+k")).toBe(
      `https://app.mezonas.com/api/hooks/${tenant}/${a.hook.id}?token=t%2Bk`,
    );
    let s = empty();
    for (let i = 0; i < MAX_HOOKS; i++) s = addHook(s, `h${i}`, NOW);
    expect(() => addHook(s, "one too many", NOW)).toThrow(/at most/);
    expect(() => addHook(empty(), "  ", NOW)).toThrow();
  });

  it("sets the outbound URL only for public https hosts, with a new signing secret per URL", () => {
    const set = setOutbound(empty(), "https://hooks.zapier.com/hooks/catch/123/abc/", NOW);
    expect(set.config.outbound).toEqual({ host: "hooks.zapier.com", setAt: NOW.toISOString() });
    expect(JSON.stringify(set.config)).not.toContain("catch");
    expect(set.credentials.outbound?.url).toBe("https://hooks.zapier.com/hooks/catch/123/abc/");
    const again = setOutbound(set, "https://hooks.zapier.com/hooks/catch/123/abc/", NOW);
    expect(again.credentials.outbound?.signingSecret).toBe(set.credentials.outbound?.signingSecret);
    const moved = setOutbound(set, "https://hook.eu1.make.com/xyz", NOW);
    expect(moved.credentials.outbound?.signingSecret).not.toBe(
      set.credentials.outbound?.signingSecret,
    );
    expect(setOutbound(set, null, NOW).credentials.outbound).toBeNull();
    for (const bad of [
      "http://hooks.zapier.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://192.168.0.10/x",
      "https://2130706433/x",
      "https://intranet/x",
      "https://db.internal/x",
      "https://user:pw@hooks.zapier.com/x",
      "https://hooks.zapier.com:8443/x",
      "not a url",
    ]) {
      expect(() => setOutbound(empty(), bad, NOW), bad).toThrow();
    }
  });

  it("accepts a delivery with the token or a fresh signature, and nothing else", async () => {
    const token = "a".repeat(43);
    const body = '{"email":"pat@example.com"}';
    const base = { token, body, now: NOW, headers: {}, queryToken: undefined };
    expect(await verifyDelivery({ ...base, queryToken: token })).toEqual({
      ok: true,
      signed: false,
    });
    expect(await verifyDelivery({ ...base, headers: { "x-mezonas-token": token } })).toEqual({
      ok: true,
      signed: false,
    });
    expect((await verifyDelivery({ ...base, queryToken: `${token}x` })).ok).toBe(false);
    expect((await verifyDelivery(base)).ok).toBe(false);
    expect((await verifyDelivery({ ...base, token: undefined, queryToken: token })).ok).toBe(false);

    const ts = String(NOW.getTime() / 1000);
    const sig = `sha256=${await hmacSha256Hex(token, `${ts}.${body}`)}`;
    const signed = { "x-mezonas-signature": sig, "x-mezonas-timestamp": ts };
    expect(await verifyDelivery({ ...base, headers: signed })).toEqual({ ok: true, signed: true });
    // A replay outside the window, or a changed body, is refused.
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);
    expect((await verifyDelivery({ ...base, headers: signed, now: later })).ok).toBe(false);
    expect((await verifyDelivery({ ...base, headers: signed, body: '{"email":"x"}' })).ok).toBe(
      false,
    );
    // A wrong signature isn't rescued by a right token.
    expect(
      (
        await verifyDelivery({
          ...base,
          queryToken: token,
          headers: { ...signed, "x-mezonas-signature": "sha256=00" },
        })
      ).ok,
    ).toBe(false);
  });

  it("parses JSON and forms, refuses other types, big bodies and bad UTF-8", () => {
    expect(parseDelivery("application/json; charset=utf-8", '{"a":1}')).toEqual({
      ok: true,
      format: "json",
      data: { a: 1 },
    });
    expect(parseDelivery("application/json", "[1,2]")).toMatchObject({ data: { value: [1, 2] } });
    expect(
      parseDelivery("application/x-www-form-urlencoded", "name=Pat+Lee&email=pat%40example.com"),
    ).toEqual({
      ok: true,
      format: "form",
      data: { name: "Pat Lee", email: "pat@example.com" },
    });
    expect(parseDelivery("application/json", "{nope")).toMatchObject({ ok: false, status: 400 });
    expect(parseDelivery("text/xml", "<a/>")).toMatchObject({ ok: false, status: 415 });
    expect(deliveryText(new Uint8Array(MAX_DELIVERY_BYTES + 1))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(deliveryText(new Uint8Array([0xff, 0xfe]))).toMatchObject({ ok: false, status: 400 });
    expect(formDecode("a=1&a=2&b")).toEqual({ a: "2", b: "" });
  });

  it("keys a delivery by the sender's Idempotency-Key, else the body's hash", async () => {
    const body = utf8('{"a":1}');
    expect(await deliveryKey({ "idempotency-key": "zap-run-42" }, body)).toBe("key:zap-run-42");
    const h = await deliveryKey({}, body);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await deliveryKey({}, utf8('{"a":1}'))).toBe(h);
    expect(await deliveryKey({ "idempotency-key": "bad key with spaces" }, body)).toBe(h);
  });

  it("keys a signed delivery by its signature, so a replay with a new Idempotency-Key is the same delivery", async () => {
    const body = utf8('{"a":1}');
    const signed = { "x-mezonas-signature": "sha256=ABCDEF0123", "idempotency-key": "first" };
    const replay = { "x-mezonas-signature": "sha256=abcdef0123", "idempotency-key": "second" };
    const key = await deliveryKey(signed, body, { signed: true });
    expect(key).toBe("sig:abcdef0123");
    expect(await deliveryKey(replay, body, { signed: true })).toBe(key);
    expect(await deliveryKey({ "idempotency-key": "first" }, body, { signed: true })).not.toBe(key);
  });

  it("sends an approved event once: JSON, Idempotency-Key, a signature the receiver can check", async () => {
    const receiver = fakeReceiver({ status: 200, body: { status: "success", id: "zap-1" } });
    const connector = createWebhookConnector({ fetch: receiver.fetch });
    const state = setOutbound(empty(), "https://hooks.zapier.com/hooks/catch/1/a/", NOW);
    const c = ctx(state.credentials as unknown as JsonObject);
    const input = { event: "invoice.flagged", data: { invoice: "INV-1042", total: "1250.00" } };
    expect((await captureBefore(connector, WEBHOOK_SEND_TOOL, input, c)).before).toBeNull();
    const r = await executeWrite(connector, WEBHOOK_SEND_TOOL, input, c);
    expect(r.output).toEqual({
      host: "hooks.zapier.com",
      status: 200,
      response: '{"status":"success","id":"zap-1"}',
    });
    expect(r.summary).toBe("Sent the event to hooks.zapier.com");
    expect(receiver.received).toHaveLength(1);
    const sent = receiver.received[0];
    expect(sent?.url).toBe("https://hooks.zapier.com/hooks/catch/1/a/");
    expect(sent?.headers["idempotency-key"]).toBe("run-1:send:0");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      id: "run-1:send:0",
      event: "invoice.flagged",
      data: input.data,
      sentAt: NOW.toISOString(),
      source: "mezonas",
    });
    const ts = sent?.headers["x-mezonas-timestamp"] ?? "";
    const expected = `sha256=${await hmacSha256Hex(state.credentials.outbound?.signingSecret ?? "", `${ts}.${sent?.body}`)}`;
    expect(constantTimeEqual(sent?.headers["x-mezonas-signature"] ?? "", expected)).toBe(true);
  });

  it("fails cleanly without an outbound URL, on a refused answer, and when create is off", async () => {
    const receiver = fakeReceiver({ status: 410 });
    const connector = createWebhookConnector({ fetch: receiver.fetch });
    const input = { event: "x", data: {} };
    await expect(executeWrite(connector, WEBHOOK_SEND_TOOL, input, ctx(null))).rejects.toThrow(
      /no outbound URL/,
    );
    const state = setOutbound(empty(), "https://hooks.zapier.com/hooks/catch/1/a/", NOW);
    await expect(
      executeWrite(
        connector,
        WEBHOOK_SEND_TOOL,
        input,
        ctx(state.credentials as unknown as JsonObject),
      ),
    ).rejects.toThrow(/answered 410/);
    // A URL stored under older rules is checked again before sending.
    const stale = {
      outbound: { url: "https://10.0.0.5/hook", signingSecret: "s".repeat(43) },
      tokens: {},
    };
    await expect(executeWrite(connector, WEBHOOK_SEND_TOOL, input, ctx(stale))).rejects.toThrow(
      /not allowed/,
    );
    const off = ctx(state.credentials as unknown as JsonObject, {
      permissions: { ...DEFAULT_PERMISSIONS, create: "off" },
    });
    await expect(executeWrite(connector, WEBHOOK_SEND_TOOL, input, off)).rejects.toBeInstanceOf(
      ToolCallError,
    );
    expect(receiver.received).toHaveLength(1);
  });

  it("checks URLs as written", () => {
    expect(checkPublicHttpsUrl("https://hooks.zapier.com/x").ok).toBe(true);
    expect(checkPublicHttpsUrl("https://n8n.example.com:443/webhook/1").ok).toBe(true);
    expect(checkPublicHttpsUrl("https://[2606:4700::1111]/x").ok).toBe(true);
    expect(checkPublicHttpsUrl("https://100.64.0.1/x").ok).toBe(false);
    expect(checkPublicHttpsUrl("https://[::ffff:10.0.0.1]/x").ok).toBe(false);
    // IPv4 hidden inside IPv6: IPv4-compatible, NAT64, 6to4; and site-local and multicast.
    for (const host of [
      "[::127.0.0.1]",
      "[::7f00:1]",
      "[64:ff9b::a00:1]",
      "[2002:a00:1::]",
      "[fec0::1]",
      "[ff02::1]",
    ]) {
      expect(checkPublicHttpsUrl(`https://${host}/x`).ok, host).toBe(false);
    }
  });
});
