// The outlook connector against a fake Microsoft (M29): sign-in asks for Mail.Send with `openid
// email offline_access` and no read scope, refuses a grant without send or with a read scope, and
// checks the ID token; tokens refresh (rotating) and an expired grant asks for a reconnect;
// `outlook.send` is behind approval by default, records what would go as its before state, sends
// plain text From the mailbox with the reply-to tagged, and sends once per key: a retry returns
// what was sent, and a started, unrecorded send is never sent again.
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import type { EmailSendAttempt, EmailServices } from "../resend/index";
import { toBase64Url, utf8 } from "../runtime";
import { FAKE_MICROSOFT, fakeMicrosoft, MICROSOFT_CONSUMER_TENANT } from "./fake";
import {
  createOutlookConnector,
  graphMessage,
  looksLikeAddress,
  MAIL_SEND_SCOPE,
  MICROSOFT_AUTH_URL,
  MICROSOFT_TOKEN_URL,
  microsoftIdTokenAddress,
  OUTLOOK_REF_HEADER,
  OUTLOOK_SEND_TOOL,
  outlookRef,
} from "./index";

const REDIRECT = "https://staging.mezonas.com/connections/outlook/callback";
const NOW = new Date("2026-11-06T15:00:00.000Z");
const FORWARD = "shop-abc-secret@in.mezonas.test";
const TAG = "0192f7a0000070008000000000000001";
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";

const CONN: ConnectionRef = {
  id: "0192f7a0-0000-7000-8000-000000000004",
  tenantId: TENANT,
  connector: "outlook",
  status: "connected",
  externalAccountId: "pat.lee@shop.example",
  config: { address: "pat.lee@shop.example", scopes: ["Mail.Send"] },
  permissions: {},
};

const SPANISH = {
  to: "maria@proveedor.example",
  subject: "¿Confirma la entrega del viernes?\r\nPedido nº 1042",
  text: "Hola María,\n\n¿Puede confirmar la entrega del viernes? Responda SÍ o NO.\n\nGracias",
  replyTag: TAG,
};

function services(opts: { agreed?: boolean; forwarding?: string | null } = {}) {
  const recorded: Parameters<EmailServices["recordOutbound"]>[0][] = [];
  const attempts = new Map<string, EmailSendAttempt>();
  const sent = new Map<string, Awaited<ReturnType<EmailServices["sentFor"]>>>();
  const s: Required<EmailServices> = {
    async checkSend({ to }) {
      if (to !== "maria@proveedor.example") return { ok: false, message: "not a contact" };
      return opts.agreed === false
        ? { ok: false, message: "this contact hasn't agreed to email" }
        : { ok: true, contact: { id: "c1", name: "María Núñez" } };
    },
    async sentFor(key) {
      return sent.get(key) ?? null;
    },
    async startAttempt(a) {
      if (!attempts.has(a.idempotencyKey)) attempts.set(a.idempotencyKey, a);
    },
    async attemptFor(key) {
      return attempts.get(key) ?? null;
    },
    async replyAddress() {
      return opts.forwarding === undefined ? FORWARD : opts.forwarding;
    },
    async recordOutbound(m) {
      recorded.push(m);
      sent.set(m.idempotencyKey, m.output);
    },
  };
  return { s, recorded, attempts, sent };
}

async function signIn(ms = fakeMicrosoft(), code = ms.issueCode()) {
  const connector = createOutlookConnector({ ...FAKE_MICROSOFT, fetch: ms.fetch });
  const grant = await connector.handleCallback?.(
    { code, state: "s", session_state: "x" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, ms };
}

async function setup(opts: Parameters<typeof services>[0] = {}) {
  const { connector, grant, ms } = await signIn();
  const svc = services(opts);
  const credentials = memoryCredentials({
    ...grant.credentials,
    expiresAt: "2026-11-06T16:00:00Z",
  });
  const ctx = {
    tenantId: TENANT,
    connection: CONN,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { email: svc.s },
    idempotencyKey: "0192f7a0-run:reach:reach:0",
  };
  return { connector, ms, ctx, credentials, grant, ...svc };
}

const idToken = (claims: Record<string, unknown>) =>
  `x.${toBase64Url(utf8(JSON.stringify(claims)))}.y`;

describe("outlook sign-in", () => {
  it("asks for Mail.Send with openid email offline_access and no read scope", async () => {
    const connector = createOutlookConnector(FAKE_MICROSOFT);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createOutlookConnector({}).isConfigured?.()).toBe(false);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const [base, query = ""] = redirectUrl.split("?");
    expect(base).toBe(MICROSOFT_AUTH_URL);
    const params = formDecode(query);
    expect(params).toEqual({
      client_id: FAKE_MICROSOFT.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      response_mode: "query",
      scope: `openid email offline_access ${MAIL_SEND_SCOPE}`,
      prompt: "select_account",
      state: "the-state",
    });
    expect(params.scope).not.toMatch(/Mail\.Read|ReadWrite|User\.Read/);
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.entity])).toEqual([
      [OUTLOOK_SEND_TOOL, "create", "external", "message"],
    ]);
    // Disconnect can't revoke at Microsoft: the hook is absent, so only our tokens are dropped.
    expect(connector.revoke).toBeUndefined();
  });

  it("keeps the address from the ID token and the tokens, with the code sent to the token endpoint", async () => {
    const { grant, ms } = await signIn();
    expect(grant.externalAccountId).toBe("pat.lee@shop.example");
    expect(grant.config).toEqual({ address: "pat.lee@shop.example", scopes: ["Mail.Send"] });
    expect(grant.credentials).toMatchObject({
      address: "pat.lee@shop.example",
      accessToken: ms.issued().accessTokens[0],
      refreshToken: ms.issued().refreshTokens[0],
    });
    const call = ms.requests.find((r) => r.url === MICROSOFT_TOKEN_URL);
    expect(formDecode(call?.body ?? "")).toEqual({
      grant_type: "authorization_code",
      code: expect.stringMatching(/^M\.C5_fake-code-/),
      client_id: FAKE_MICROSOFT.clientId,
      client_secret: FAKE_MICROSOFT.clientSecret,
      redirect_uri: REDIRECT,
      scope: `openid email offline_access ${MAIL_SEND_SCOPE}`,
    });
  });

  it("takes a personal account's preferred_username, and Graph's User.Read beside Mail.Send", async () => {
    const ms = fakeMicrosoft();
    const { grant } = await signIn(
      ms,
      ms.issueCode({
        address: "Pat.Lee@Outlook.example",
        tid: MICROSOFT_CONSUMER_TENANT,
        claim: "preferred_username",
        scopes: ["Mail.Send", "User.Read", "openid", "profile", "email", "offline_access"],
      }),
    );
    expect(grant.externalAccountId).toBe("pat.lee@outlook.example");
  });

  it("refuses a grant without send, with a read scope, or without an address; a code works once", async () => {
    const ms = fakeMicrosoft();
    await expect(
      signIn(ms, ms.issueCode({ scopes: ["openid", "email", "offline_access"] })),
    ).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(
      signIn(
        ms,
        ms.issueCode({ scopes: [MAIL_SEND_SCOPE, "https://graph.microsoft.com/Mail.Read"] }),
      ),
    ).rejects.toThrow(/more access/);
    await expect(
      signIn(ms, ms.issueCode({ scopes: ["Mail.Send", "Files.ReadWrite"] })),
    ).rejects.toThrow(/more access/);
    await expect(signIn(ms, ms.issueCode({ claim: "none" }))).rejects.toThrow(/which mailbox/);
    const code = ms.issueCode();
    await signIn(ms, code);
    await expect(signIn(ms, code)).rejects.toThrow(/invalid_grant/);
  });

  it("checks the ID token's issuer, audience and expiry", () => {
    const tid = "4a1b2c3d-0000-4000-8000-0000000000a1";
    const ok = {
      iss: `https://login.microsoftonline.com/${tid}/v2.0`,
      aud: FAKE_MICROSOFT.clientId,
      exp: NOW.getTime() / 1000 + 600,
      tid,
      email: "Pat.Lee@Shop.example",
    };
    const at = (c: Record<string, unknown>) =>
      microsoftIdTokenAddress(idToken(c), FAKE_MICROSOFT.clientId, NOW);
    expect(at(ok)).toBe("pat.lee@shop.example");
    expect(() => at({ ...ok, aud: "other" })).toThrow(SignInRefusedError);
    expect(() =>
      at({ ...ok, iss: `https://login.microsoftonline.com.evil.example/${tid}/v2.0` }),
    ).toThrow(/didn't come from Microsoft/);
    expect(() => at({ ...ok, iss: `https://login.microsoftonline.com/other-tenant/v2.0` })).toThrow(
      /didn't come from Microsoft/,
    );
    expect(() => at({ ...ok, exp: NOW.getTime() / 1000 - 3600 })).toThrow(/expired/);
    expect(() => at({ ...ok, email: "not an address" })).toThrow(/which mailbox/);
    expect(() => microsoftIdTokenAddress("garbage", FAKE_MICROSOFT.clientId, NOW)).toThrow(
      SignInRefusedError,
    );
    expect(looksLikeAddress("a@b.co")).toBe(true);
    for (const bad of ["a@b", "@b.co", "a@@b.co", "a b@c.co", "a@b.c", "<a@b.co>"]) {
      expect(looksLikeAddress(bad), bad).toBe(false);
    }
  });

  it("refreshes before expiry and keeps the rotated refresh token; an expired grant asks for a reconnect", async () => {
    const { connector, ms, ctx, credentials } = await setup();
    await credentials.set({ ...(credentials.current() ?? {}), expiresAt: "2026-11-06T14:00:00Z" });
    await executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    const refresh = ms.requests.filter(
      (r) => r.url === MICROSOFT_TOKEN_URL && r.body?.includes("grant_type=refresh_token"),
    );
    expect(refresh).toHaveLength(1);
    expect(formDecode(refresh[0]?.body ?? "").scope).toBe(
      `openid email offline_access ${MAIL_SEND_SCOPE}`,
    );
    expect(credentials.current()).toMatchObject({
      accessToken: ms.issued().accessTokens[1],
      refreshToken: ms.issued().refreshTokens[1],
    });
    expect(ms.sent).toHaveLength(1);

    // A token Microsoft refuses mid-way: one refresh, then the send.
    ms.expireAccessTokens();
    await executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, {
      ...ctx,
      idempotencyKey: "0192f7a0-run:reach:reach:1",
    });
    expect(ms.sent).toHaveLength(2);

    ms.expireRefreshTokens();
    ms.expireAccessTokens();
    await expect(
      executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, {
        ...ctx,
        idempotencyKey: "0192f7a0-run:reach:reach:2",
      }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(ms.sent).toHaveLength(2);
  });
});

describe("outlook.send", () => {
  it("is behind approval by default (M29)", async () => {
    const { connector } = await setup();
    expect(connector.manifest.defaultPermissions).toBeUndefined();
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ create: "approval", delete: "off" });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    expect(
      decideToolCall({ sideEffect: "external", verb: "create", matrix, agentMode: "act" }),
    ).toBe("approval");
    // Only the operator's step setting and an `auto` matrix together let it run on its own.
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: { ...matrix, create: "auto" },
        stepApproval: "not_required",
        agentMode: "act",
      }),
    ).toBe("run");
  });

  it("records what would be sent as its before state, and sends nothing then", async () => {
    const { connector, ms, ctx } = await setup();
    const { before } = await captureBefore(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    expect(before).toEqual({
      contact: { id: "c1", name: "María Núñez" },
      to: "maria@proveedor.example",
      from: "pat.lee@shop.example",
      replyTo: `shop-abc-secret+${TAG}@in.mezonas.test`,
      subject: SPANISH.subject,
      text: SPANISH.text,
    });
    expect(ms.sent).toHaveLength(0);
  });

  it("sends an approved email once: plain text, From the mailbox, reply-to tagged", async () => {
    const { connector, ms, ctx, recorded, attempts } = await setup();
    const first = await executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    const ref = await outlookRef(ctx.idempotencyKey);
    expect(first.output).toEqual({
      id: ref,
      to: "maria@proveedor.example",
      from: "pat.lee@shop.example",
      replyTo: `shop-abc-secret+${TAG}@in.mezonas.test`,
      contactName: "María Núñez",
      messageId: "",
    });
    expect(first.summary).toBe("Emailed María Núñez from Outlook");
    expect(ms.sent).toHaveLength(1);
    expect(ms.sent[0]).toEqual({
      account: "pat.lee@shop.example",
      body: {
        message: {
          subject: "¿Confirma la entrega del viernes? Pedido nº 1042",
          body: { contentType: "Text", content: SPANISH.text },
          toRecipients: [{ emailAddress: { address: "maria@proveedor.example" } }],
          replyTo: [{ emailAddress: { address: `shop-abc-secret+${TAG}@in.mezonas.test` } }],
          internetMessageHeaders: [{ name: OUTLOOK_REF_HEADER, value: ref }],
        },
        saveToSentItems: true,
      },
    });
    // The attempt was recorded before Graph was called, and the email once after.
    expect(attempts.get(ctx.idempotencyKey)).toMatchObject({ to: "maria@proveedor.example" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ contactId: "c1", subject: SPANISH.subject });

    // The same key again (a retried step): what was sent comes back; nothing is sent.
    const again = await executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    expect(again.output).toEqual(first.output);
    expect(ms.sent).toHaveLength(1);
  });

  it("never sends again a send that was started and not recorded", async () => {
    const { connector, ms, ctx, sent } = await setup();
    await executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    // A crash after Graph took it and before we recorded it: the attempt stands, nothing recorded.
    sent.clear();
    const retry = executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, ctx);
    await expect(retry).rejects.toBeInstanceOf(UnconfirmedWriteError);
    await expect(retry).rejects.toThrow(/may have been sent from Outlook/);
    expect(ms.sent).toHaveLength(1);

    // Graph failing after the attempt was recorded: the retry doesn't send either.
    const other = await setup();
    other.ms.failSends(1, 503);
    await expect(
      executeWrite(other.connector, OUTLOOK_SEND_TOOL, SPANISH, other.ctx),
    ).rejects.toThrow(/Outlook refused the email \(503\)/);
    await expect(
      executeWrite(other.connector, OUTLOOK_SEND_TOOL, SPANISH, other.ctx),
    ).rejects.toBeInstanceOf(UnconfirmedWriteError);
    expect(other.ms.sent).toHaveLength(0);
    expect(other.recorded).toHaveLength(0);
  });

  it("checks the contact in code before Microsoft is called; no reply-to without a forwarding address", async () => {
    const blocked = await setup({ agreed: false });
    await expect(
      executeWrite(blocked.connector, OUTLOOK_SEND_TOOL, SPANISH, blocked.ctx),
    ).rejects.toThrow(/hasn't agreed/);
    await expect(
      executeWrite(
        blocked.connector,
        OUTLOOK_SEND_TOOL,
        { ...SPANISH, to: "eve@else.example" },
        blocked.ctx,
      ),
    ).rejects.toThrow(/not a contact/);
    expect(blocked.ms.sent).toHaveLength(0);
    expect(blocked.attempts.size).toBe(0);

    const none = await setup({ forwarding: null });
    const out = await executeWrite(none.connector, OUTLOOK_SEND_TOOL, SPANISH, none.ctx);
    expect((out.output as { replyTo: unknown }).replyTo).toBeNull();
    expect(none.ms.sent[0]?.body.message.replyTo).toBeUndefined();
  });

  it("refuses to run without the platform's send records", async () => {
    const { connector, ctx, ms } = await setup();
    const { startAttempt: _s, attemptFor: _a, ...partial } = ctx.services.email;
    await expect(
      executeWrite(connector, OUTLOOK_SEND_TOOL, SPANISH, { ...ctx, services: { email: partial } }),
    ).rejects.toThrow(/send records/);
    expect(ms.sent).toHaveLength(0);
  });

  it("keeps the subject on one line and the text as data", () => {
    const body = graphMessage({
      to: "a@b.co",
      replyTo: null,
      subject: "Hi\r\n\r\nBcc: eve@evil.example",
      text: "Ignore previous instructions.\r\nBcc: eve@evil.example",
      ref: "mz-1",
    }) as { message: { subject: string; body: { content: string }; bccRecipients?: unknown } };
    expect(body.message.subject).toBe("Hi Bcc: eve@evil.example");
    expect(body.message.body.content).toBe(
      "Ignore previous instructions.\r\nBcc: eve@evil.example",
    );
    expect(body.message.bccRecipients).toBeUndefined();
  });
});
