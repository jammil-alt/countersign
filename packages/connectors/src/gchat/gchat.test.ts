// The gchat connector against a fake Google (W4-E, docs/plan.md §1.60): Chat's bearer tokens are
// verified (signature by a published key, issuer, audience, expiry) with the keys cached; binding
// codes are random, single-client and found in a mention; spaces bind and unbind (never a DM);
// model text loses every mention; `gchat.message.post` is behind approval by default, refuses a
// space the client hasn't bound, and posts once per action, also after a lost answer.
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { connectionDefaults } from "../permissions";
import { toBase64Url, utf8 } from "../runtime";
import { FAKE_GCHAT, fakeGoogleChat } from "./fake";
import {
  BindAttemptLimiter,
  bindingCodeHash,
  bindingCodeMatches,
  bindSpace,
  CHAT_CERTS_URL,
  CHAT_ISSUER,
  ChatSigningKeys,
  chatMessageIds,
  createGchatConnector,
  findBindingCode,
  GCHAT_MAX_SPACES,
  GCHAT_POST_TOOL,
  type GchatConfig,
  generateBindingCode,
  maxAgeOf,
  normalizeBindingCode,
  parseChatEvent,
  parseServiceAccount,
  plainChatText,
  readGchatConfig,
  unbindSpace,
  verifyChatToken,
} from "./index";
import { certificatePublicKey, decodeJwt } from "./jwt";

const TENANT_A = "0192f7a0-0000-7000-8000-0000000000aa";
const TENANT_B = "0192f7a0-0000-7000-8000-0000000000bb";
const CONN_A = "0192f7a0-0000-7000-8000-00000000000a";
const CONN_B = "0192f7a0-0000-7000-8000-00000000000b";
const SPACE = "spaces/AAAAops42";
const BOUND: GchatConfig = {
  spaces: [
    {
      name: SPACE,
      displayName: "Shop floor",
      kind: "space",
      boundAt: "2026-11-06T15:00:00.000Z",
      boundBy: "Ana Ruiz",
    },
  ],
};

function connection(config: GchatConfig = BOUND): ConnectionRef {
  return {
    id: CONN_A,
    tenantId: TENANT_A,
    connector: "gchat",
    status: "connected",
    externalAccountId: null,
    config: config as unknown as ConnectionRef["config"],
    permissions: {},
  };
}

async function setup(config: GchatConfig = BOUND) {
  const google = await fakeGoogleChat();
  google.addAppTo(SPACE);
  const connector = createGchatConnector({
    serviceAccount: google.serviceAccount,
    projectNumber: google.projectNumber,
    fetch: google.fetch,
  });
  const ctx = {
    tenantId: TENANT_A,
    connection: connection(config),
    credentials: memoryCredentials(null),
    logger: noopLogger,
    now: () => new Date(),
    idempotencyKey: "0192f7a0-run:post:post:0",
  };
  return { google, connector, ctx };
}

describe("Google Chat's bearer token", () => {
  it("accepts Chat's own token and refuses every other", async () => {
    const google = await fakeGoogleChat();
    const keys = new ChatSigningKeys(() => google.fetch);
    const opts = { projectNumber: FAKE_GCHAT.projectNumber, keys, now: new Date() };
    const ok = await verifyChatToken(await google.signEvent(), opts);
    expect(ok).toMatchObject({ ok: true, claims: { iss: CHAT_ISSUER } });
    const refusal = async (t: string | null) => {
      const r = await verifyChatToken(t, opts);
      return r.ok ? "accepted" : r.reason;
    };
    expect(await refusal(await google.signEvent({ aud: "999999999999" }))).toBe("audience");
    expect(await refusal(await google.signEvent({ expiresInS: -120 }))).toBe("expired");
    // Signed by someone else under Chat's key id: the signature doesn't hold.
    expect(await refusal(await google.signEvent({ signer: "stranger" }))).toBe("signature");
    expect(await refusal(await google.signEvent({ kid: "not-published" }))).toBe("unknown_key");
    expect(
      await refusal(await google.signEvent({ iss: "someone@example.iam.gserviceaccount.com" })),
    ).toBe("issuer");
    expect(await refusal(null)).toBe("missing");
    expect(await refusal("not.a.jwt.at.all")).toBe("malformed");
    expect(await refusal("x".repeat(9000))).toBe("malformed");
    // `alg: none` (or anything but RS256) is never accepted, whatever the signature says.
    const good = await google.signEvent();
    const [, claims, sig] = good.split(".");
    const none = toBase64Url(utf8(JSON.stringify({ alg: "none", kid: FAKE_GCHAT.chatKeyId })));
    expect(await refusal(`${none}.${claims}.${sig}`)).toBe("algorithm");
  });

  it("caches Google's certificates and refetches for an unknown key at most once a minute", async () => {
    const google = await fakeGoogleChat();
    let at = Date.parse("2026-11-06T15:00:00Z");
    const now = () => new Date(at);
    const keys = new ChatSigningKeys(() => google.fetch, now);
    const fetches = () => google.requests.filter((r) => r.url === CHAT_CERTS_URL).length;
    const opts = () => ({ projectNumber: FAKE_GCHAT.projectNumber, keys, now: new Date() });
    for (let i = 0; i < 3; i++) await verifyChatToken(await google.signEvent(), opts());
    expect(fetches()).toBe(1);
    await verifyChatToken(await google.signEvent({ kid: "rotated-1" }), opts());
    await verifyChatToken(await google.signEvent({ kid: "rotated-2" }), opts());
    // Within the cache's life an unknown key fetched once more, not twice.
    expect(fetches()).toBe(1);
    at += 61_000;
    await verifyChatToken(await google.signEvent({ kid: "rotated-3" }), opts());
    expect(fetches()).toBe(2);
    // Past max-age (3600 s) the certificates are fetched again.
    at += 3600_000;
    await verifyChatToken(await google.signEvent(), opts());
    expect(fetches()).toBe(3);
    expect(maxAgeOf("public, max-age=19271, must-revalidate")).toBe(19271);
    expect(maxAgeOf("no-store")).toBeNull();
    expect(maxAgeOf("max-age=12a")).toBeNull();
  });

  it("the connector's webhook check reads the authorization header", async () => {
    const { google, connector } = await setup();
    const token = await google.signEvent();
    expect(
      await connector.verifyWebhook?.({ authorization: `Bearer ${token}` }, new Uint8Array()),
    ).toBe(true);
    expect(await connector.verifyWebhook?.({ authorization: token }, new Uint8Array())).toBe(false);
    expect(await connector.verifyWebhook?.({}, new Uint8Array())).toBe(false);
    const unset = createGchatConnector({ fetch: google.fetch });
    expect(unset.isConfigured?.()).toBe(false);
    expect(
      await unset.verifyWebhook?.({ authorization: `Bearer ${token}` }, new Uint8Array()),
    ).toBe(false);
  });

  it("reads only a certificate's key, and nothing from garbage", () => {
    expect(certificatePublicKey(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toBeNull();
    expect(certificatePublicKey(new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]))).toBeNull();
    expect(certificatePublicKey(new Uint8Array())).toBeNull();
  });
});

describe("the service account", () => {
  it("is read from its key JSON, or not at all", async () => {
    const google = await fakeGoogleChat();
    expect(parseServiceAccount(google.serviceAccount)).toMatchObject({
      clientEmail: FAKE_GCHAT.clientEmail,
      keyId: FAKE_GCHAT.keyId,
    });
    expect(parseServiceAccount("{")).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ type: "authorized_user" }))).toBeNull();
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(
      createGchatConnector({
        serviceAccount: google.serviceAccount,
        projectNumber: "12ab",
      }).isConfigured?.(),
    ).toBe(false);
  });

  it("signs a chat.bot assertion for Google's token endpoint and keeps the token", async () => {
    const { google, connector, ctx } = await setup();
    await executeWrite(connector, GCHAT_POST_TOOL, { space: SPACE, text: "One" }, ctx);
    await executeWrite(
      connector,
      GCHAT_POST_TOOL,
      { space: SPACE, text: "Two" },
      { ...ctx, idempotencyKey: "0192f7a0-run:post:post:1" },
    );
    const tokenCalls = google.requests.filter(
      (r) => r.url === "https://oauth2.googleapis.com/token",
    );
    expect(tokenCalls).toHaveLength(1);
    // A refused token (a rotated key) gets one new token and one retry.
    google.expireTokens();
    await executeWrite(
      connector,
      GCHAT_POST_TOOL,
      { space: SPACE, text: "Three" },
      { ...ctx, idempotencyKey: "0192f7a0-run:post:post:2" },
    );
    expect(
      google.requests.filter((r) => r.url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(2);
    expect(google.messages.map((m) => m.text)).toEqual(["One", "Two", "Three"]);
  });
});

describe("binding codes", () => {
  it("are random, readable and forgiving to type", () => {
    const a = generateBindingCode();
    expect(a).toMatch(/^MZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(Array.from({ length: 200 }, generateBindingCode)).size).toBe(200);
    const canonical = normalizeBindingCode(a);
    expect(canonical).toBe(a.replace(/-/g, ""));
    expect(normalizeBindingCode("mz-7k2q-9xhd-4rtm")).toBe("MZ7K2Q9XHD4RTM");
    expect(normalizeBindingCode("MZ-7K2Q-9XHD-4RTO")).toBe("MZ7K2Q9XHD4RT0");
    expect(normalizeBindingCode("MZ-7K2Q-9XHD-4RT")).toBeNull();
    expect(normalizeBindingCode("MZ-7K2Q-9XHD-4RTU")).toBeNull();
    expect(normalizeBindingCode("AB-7K2Q-9XHD-4RTM")).toBeNull();
  });

  it("are found in the text after the mention, and only there", () => {
    expect(findBindingCode("MZ-7K2Q-9XHD-4RTM")).toBe("MZ7K2Q9XHD4RTM");
    expect(findBindingCode("  here it is: (mz-7k2q-9xhd-4rtm).\nthanks")).toBe("MZ7K2Q9XHD4RTM");
    expect(findBindingCode("hello there")).toBeNull();
    expect(findBindingCode(`${"x".repeat(3000)} MZ-7K2Q-9XHD-4RTM`)).toBeNull();
    expect(findBindingCode(null)).toBeNull();
  });

  it("match only the client and connection they were made for", async () => {
    const code = "MZ7K2Q9XHD4RTM";
    const hash = await bindingCodeHash(TENANT_A, CONN_A, code);
    expect(hash).toHaveLength(64);
    expect(await bindingCodeMatches(hash, TENANT_A, CONN_A, code)).toBe(true);
    // The same code checked as client B's (or B's connection) never matches A's.
    expect(await bindingCodeMatches(hash, TENANT_B, CONN_B, code)).toBe(false);
    expect(await bindingCodeMatches(hash, TENANT_B, CONN_A, code)).toBe(false);
    expect(await bindingCodeMatches(hash, TENANT_A, CONN_A, "MZ7K2Q9XHD4RTN")).toBe(false);
  });

  it("wrong ones are limited per space", () => {
    const limiter = new BindAttemptLimiter(3, 1000, 2);
    expect(limiter.allowed(SPACE, 0)).toBe(true);
    for (let i = 0; i < 3; i++) limiter.failed(SPACE, 10);
    expect(limiter.allowed(SPACE, 20)).toBe(false);
    expect(limiter.allowed("spaces/other", 20)).toBe(true);
    expect(limiter.allowed(SPACE, 1011)).toBe(true);
    // Capacity: the oldest space is forgotten.
    limiter.failed("spaces/b", 30);
    limiter.failed("spaces/c", 30);
    expect(limiter.allowed(SPACE, 40)).toBe(true);
  });
});

describe("spaces", () => {
  const at = new Date("2026-11-06T16:00:00Z");
  it("bind once, never a DM, up to the limit; unbind", () => {
    const empty: GchatConfig = { spaces: [] };
    const space = { name: SPACE, displayName: "Shop floor", kind: "space" as const };
    const r = bindSpace(empty, space, "Ana Ruiz", at);
    expect(r).toEqual({
      ok: true,
      config: {
        spaces: [{ ...space, boundAt: at.toISOString(), boundBy: "Ana Ruiz" }],
      },
    });
    if (!r.ok) throw new Error("not bound");
    expect(bindSpace(r.config, space, null, at)).toEqual({ ok: false, reason: "already" });
    expect(bindSpace(empty, { ...space, kind: "dm" }, null, at)).toEqual({
      ok: false,
      reason: "dm",
    });
    const full: GchatConfig = {
      spaces: Array.from({ length: GCHAT_MAX_SPACES }, (_, i) => ({
        ...space,
        name: `spaces/s${i}`,
        kind: "space" as const,
        boundAt: at.toISOString(),
        boundBy: null,
      })),
    };
    expect(bindSpace(full, space, null, at)).toEqual({ ok: false, reason: "full" });
    const un = unbindSpace(r.config, SPACE);
    expect(un.removed?.name).toBe(SPACE);
    expect(un.config.spaces).toEqual([]);
    expect(unbindSpace(un.config, SPACE).removed).toBeNull();
  });

  it("are read from config leniently", () => {
    expect(readGchatConfig(null)).toEqual({ spaces: [] });
    expect(readGchatConfig({ spaces: "x" })).toEqual({ spaces: [] });
    expect(readGchatConfig({ spaces: [{ name: "spaces/../x" }, ...BOUND.spaces] })).toEqual(BOUND);
  });

  it("events are read for their space and the text after the mention", () => {
    const e = parseChatEvent({
      type: "MESSAGE",
      space: { name: SPACE, spaceType: "SPACE", displayName: "Shop floor" },
      message: { text: "@Mezonas MZ-7K2Q-9XHD-4RTM", argumentText: " MZ-7K2Q-9XHD-4RTM" },
      user: { name: "users/1", displayName: "Ana Ruiz", type: "HUMAN" },
    });
    expect(e).toEqual({
      type: "MESSAGE",
      space: { name: SPACE, displayName: "Shop floor", kind: "space" },
      text: " MZ-7K2Q-9XHD-4RTM",
      user: { name: "users/1", displayName: "Ana Ruiz", human: true },
    });
    expect(
      parseChatEvent({ type: "MESSAGE", space: { name: "spaces/x", type: "DM" } })?.space?.kind,
    ).toBe("dm");
    expect(parseChatEvent({ type: "CARD_CLICKED", space: { name: "rooms/x" } })).toMatchObject({
      type: "OTHER",
      space: null,
    });
    expect(parseChatEvent("nope")).toBeNull();
  });
});

describe("plain text for Chat", () => {
  it("drops every mention, writes links out and keeps the rest", () => {
    expect(plainChatText("Heads up <users/all>: bill INV-1042 is due.")).toBe(
      "Heads up : bill INV-1042 is due.",
    );
    expect(plainChatText("<users/123456789> please check")).toBe("please check");
    expect(plainChatText("ping <users/app> and <USERS/ALL>")).toBe("ping  and");
    expect(plainChatText("See <https://evil.example/x|the invoice>")).toBe(
      "See the invoice (https://evil.example/x)",
    );
    expect(plainChatText("Docs: <https://mezonas.com>")).toBe("Docs: https://mezonas.com");
    expect(plainChatText("<javascript:alert(1)|Open>")).toBe("Open (javascript:alert(1))");
    expect(plainChatText("2 < 3 and 5 > 4, <3")).toBe("2 < 3 and 5 > 4, <3");
    // Pieces left around a dropped mention can't make a new one.
    expect(plainChatText("<us<users/all>ers/all>")).toBe("");
    expect(plainChatText("<<users/all>users/all>")).not.toContain("users/all>");
    expect(plainChatText("a\u0000b\u0007c\nd\te")).toBe("abc\nd\te");
    const nested = `${"<".repeat(20)}users/all${">".repeat(20)}`;
    expect(plainChatText(nested)).not.toMatch(/<users\//i);
  });
});

describe("gchat.message.post", () => {
  it("is an external create behind approval by default", async () => {
    const { connector } = await setup();
    const spec = connector.manifest.tools.find((t) => t.id === GCHAT_POST_TOOL);
    expect(spec).toMatchObject({ sideEffect: "external", verb: "create", entity: "message" });
    expect(connector.manifest.auth).toBe("none");
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ create: "approval", delete: "off" });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix,
        stepApproval: "required",
        agentMode: "act",
      }),
    ).toBe("approval");
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix,
        stepApproval: "not_required",
        agentMode: "act",
      }),
    ).toBe("approval");
  });

  it("shows the bound space and the text as it will go, and posts nothing then", async () => {
    const { google, connector, ctx } = await setup();
    const { before } = await captureBefore(
      connector,
      GCHAT_POST_TOOL,
      { space: SPACE, text: "<users/all> Cherry veneer is in." },
      ctx,
    );
    expect(before).toEqual({
      space: { name: SPACE, displayName: "Shop floor", kind: "space" },
      text: "Cherry veneer is in.",
    });
    expect(google.messages).toHaveLength(0);
  });

  it("refuses a space this client hasn't bound, before and at the write", async () => {
    const { google, connector, ctx } = await setup();
    google.addAppTo("spaces/BBBBother");
    const other = { space: "spaces/BBBBother", text: "hello" };
    await expect(captureBefore(connector, GCHAT_POST_TOOL, other, ctx)).rejects.toThrow(
      /isn't connected to this client/,
    );
    await expect(executeWrite(connector, GCHAT_POST_TOOL, other, ctx)).rejects.toThrow(
      /isn't connected to this client/,
    );
    // Approved while bound, unbound before it ran: refused.
    await expect(
      executeWrite(
        connector,
        GCHAT_POST_TOOL,
        { space: SPACE, text: "x" },
        {
          ...ctx,
          connection: connection({ spaces: [] }),
        },
      ),
    ).rejects.toThrow(/isn't connected/);
    await expect(
      executeWrite(connector, GCHAT_POST_TOOL, { space: "spaces/../../x", text: "x" }, ctx),
    ).rejects.toThrow(/invalid input/);
    expect(google.messages).toHaveLength(0);
  });

  it("posts once per action with its client-assigned id, also when retried", async () => {
    const { google, connector, ctx } = await setup();
    const input = { space: SPACE, text: "Order 1042 shipped. <users/all>" };
    const first = await executeWrite(connector, GCHAT_POST_TOOL, input, ctx);
    const ids = await chatMessageIds(ctx.idempotencyKey);
    expect(ids.messageId).toMatch(/^client-[0-9a-f]{32}$/);
    expect(first.output).toMatchObject({
      space: SPACE,
      spaceLabel: "Shop floor",
      messageId: ids.messageId,
      text: "Order 1042 shipped.",
      alreadyPosted: false,
    });
    expect(first.summary).toBe("Posted in Shop floor on Google Chat");
    expect(google.messages).toEqual([
      expect.objectContaining({
        space: SPACE,
        text: "Order 1042 shipped.",
        clientAssignedMessageId: ids.messageId,
        requestId: ids.requestId,
      }),
    ]);
    const again = await executeWrite(connector, GCHAT_POST_TOOL, input, ctx);
    expect((again.output as { name: string }).name).toBe((first.output as { name: string }).name);
    expect(google.messages).toHaveLength(1);
  });

  it("posts once after a lost answer: the retry gets the same message", async () => {
    const { google, connector, ctx } = await setup();
    const input = { space: SPACE, text: "Delivery moved to Friday." };
    google.loseNextAnswer();
    await expect(executeWrite(connector, GCHAT_POST_TOOL, input, ctx)).rejects.toThrow(/network/);
    expect(google.messages).toHaveLength(1);
    const retry = await executeWrite(connector, GCHAT_POST_TOOL, input, ctx);
    expect(google.messages).toHaveLength(1);
    expect((retry.output as { name: string }).name).toBe(google.messages[0]?.name);

    // Where Chat no longer knows the request id, its message id is still taken: 409, read back.
    google.forgetRequestIds();
    const third = await executeWrite(connector, GCHAT_POST_TOOL, input, ctx);
    expect(third.output).toMatchObject({ alreadyPosted: true, name: google.messages[0]?.name });
    expect(google.messages).toHaveLength(1);
  });

  it("says plainly when the app was taken out of the space, or Chat fails", async () => {
    const { google, connector, ctx } = await setup();
    google.removeAppFrom(SPACE);
    await expect(
      executeWrite(connector, GCHAT_POST_TOOL, { space: SPACE, text: "x" }, ctx),
    ).rejects.toThrow(/removed from that space/);
    google.addAppTo(SPACE);
    google.failNext(500);
    await expect(
      executeWrite(connector, GCHAT_POST_TOOL, { space: SPACE, text: "x" }, ctx),
    ).rejects.toThrow(/refused the message \(500\)/);
  });

  it("refuses to write where the app's keys aren't set", async () => {
    const google = await fakeGoogleChat();
    google.addAppTo(SPACE);
    const connector = createGchatConnector({ fetch: google.fetch });
    const { ctx } = await setup();
    await expect(
      executeWrite(connector, GCHAT_POST_TOOL, { space: SPACE, text: "x" }, ctx),
    ).rejects.toThrow(/not set up on this deployment/);
  });

  it("the assertion it signs is RS256 with the key id, for chat.bot", async () => {
    const { google, connector, ctx } = await setup();
    let assertion = "";
    const spy = async (url: string, init?: Parameters<typeof google.fetch>[1]) => {
      if (url === "https://oauth2.googleapis.com/token") {
        assertion = formDecode(init?.body ?? "").assertion ?? "";
      }
      return google.fetch(url, init);
    };
    const c = createGchatConnector({
      serviceAccount: google.serviceAccount,
      projectNumber: google.projectNumber,
      fetch: spy,
    });
    await executeWrite(c, GCHAT_POST_TOOL, { space: SPACE, text: "hi" }, ctx);
    const jwt = decodeJwt(assertion);
    expect(jwt?.header).toEqual({ kid: FAKE_GCHAT.keyId, alg: "RS256", typ: "JWT" });
    expect(jwt?.claims).toMatchObject({
      iss: FAKE_GCHAT.clientEmail,
      scope: "https://www.googleapis.com/auth/chat.bot",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(connector).toBeDefined();
  });
});
