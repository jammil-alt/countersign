// The gmail connector against a fake Google: sign-in asks for `gmail.send` (plus `openid email` for
// the address) with offline access, refuses a grant without send or with more than we ask for;
// tokens refresh and an expired grant asks for a reconnect; disconnect revokes; `gmail.send`
// builds a proper UTF-8 message (checked with a real MIME parser), From the connected address with
// the reply-to tagged at the client's forwarding address, and sends once per key: a started,
// unrecorded send is never sent again.
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import type { EmailSendAttempt, EmailServices } from "../resend/index";
import { fromBase64, fromUtf8, toBase64Url, utf8 } from "../runtime";
import { FAKE_GOOGLE, fakeGoogle } from "./fake";
import {
  createGmailConnector,
  GMAIL_SEND_SCOPE,
  GMAIL_SEND_TOOL,
  GmailNoAddressError,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  idTokenAddress,
  isGmailConnector,
} from "./index";
import { buildPlainMessage, encodedWords, headerText, MimeError, mailbox } from "./mime";

const REDIRECT = "https://staging.mezonas.com/api/connections/gmail/callback";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const FORWARD = "shop-abc-secret@in.mezonas.test";
const TAG = "0192f7a0000070008000000000000001";

const CONN: ConnectionRef = {
  id: "0192f7a0-0000-7000-8000-000000000002",
  tenantId: "0192f7a0-0000-7000-8000-0000000000aa",
  connector: "gmail",
  status: "connected",
  externalAccountId: "pat.lee@gmail.test",
  config: {},
  permissions: {},
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

async function signIn(google = fakeGoogle(), code = google.issueCode()) {
  const connector = createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch });
  const grant = await connector.handleCallback?.(
    { code, state: "s" },
    { tenantId: CONN.tenantId, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, google };
}

const SPANISH = {
  to: "maria@proveedor.example",
  subject: "¿Confirma la entrega del viernes? Pedido nº 1042 — roble",
  text: "Hola María,\n\n¿Puede confirmar la entrega del viernes? Responda SÍ o NO.\n\nGracias 🙏",
  replyTag: TAG,
};

describe("gmail sign-in", () => {
  it("asks for gmail.send with openid email, offline access and consent every time", async () => {
    const connector = createGmailConnector(FAKE_GOOGLE);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createGmailConnector({}).isConfigured?.()).toBe(false);
    if (!connector.authorize) throw new Error("no authorize");
    const { redirectUrl } = await connector.authorize({
      tenantId: CONN.tenantId,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    });
    const [base, query = ""] = redirectUrl.split("?");
    expect(base).toBe(GOOGLE_AUTH_URL);
    const params = formDecode(query);
    expect(params).toEqual({
      client_id: FAKE_GOOGLE.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `openid email ${GMAIL_SEND_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "the-state",
    });
    // No Gmail scope but send, ever.
    expect(params.scope).not.toMatch(/gmail\.(readonly|labels|compose|modify)/);
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect])).toEqual([
      [GMAIL_SEND_TOOL, "create", "external"],
    ]);
  });

  it("keeps the address from the ID token and the tokens, with the code sent to Google's token endpoint", async () => {
    const { grant, google } = await signIn();
    expect(grant.externalAccountId).toBe("pat.lee@gmail.test");
    expect(grant.config).toEqual({ address: "pat.lee@gmail.test", scopes: ["gmail.send"] });
    expect(grant.credentials).toMatchObject({
      address: "pat.lee@gmail.test",
      refreshToken: google.issued().refreshTokens[0],
      accessToken: google.issued().accessTokens[0],
    });
    const call = google.requests.find((r) => r.url === GOOGLE_TOKEN_URL);
    expect(formDecode(call?.body ?? "")).toEqual({
      grant_type: "authorization_code",
      code: expect.stringMatching(/^4\/fake-code-/),
      client_id: FAKE_GOOGLE.clientId,
      client_secret: FAKE_GOOGLE.clientSecret,
      redirect_uri: REDIRECT,
    });
  });

  it("refuses a grant without send, with more than we ask for, or for an unverified address", async () => {
    const google = fakeGoogle();
    await expect(
      signIn(google, google.issueCode({ scopes: ["openid", "email"] })),
    ).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(
      signIn(
        google,
        google.issueCode({
          scopes: [
            "openid",
            "email",
            GMAIL_SEND_SCOPE,
            "https://www.googleapis.com/auth/gmail.readonly",
          ],
        }),
      ),
    ).rejects.toThrow(/more access/);
    await expect(signIn(google, google.issueCode({ emailVerified: false }))).rejects.toThrow(
      /verified/,
    );
    // A code works once.
    const code = google.issueCode();
    await signIn(google, code);
    await expect(signIn(google, code)).rejects.toThrow(/invalid_grant/);
  });

  it("checks the ID token's audience and expiry", () => {
    const token = (claims: Record<string, unknown>) =>
      `x.${toBase64Url(utf8(JSON.stringify(claims)))}.y`;
    const ok = {
      iss: "https://accounts.google.com",
      aud: FAKE_GOOGLE.clientId,
      exp: NOW.getTime() / 1000 + 600,
      email: "Pat.Lee@Gmail.test",
      email_verified: true,
    };
    expect(idTokenAddress(token(ok), FAKE_GOOGLE.clientId, NOW)).toBe("pat.lee@gmail.test");
    expect(() => idTokenAddress(token({ ...ok, aud: "other" }), FAKE_GOOGLE.clientId, NOW)).toThrow(
      SignInRefusedError,
    );
    expect(() =>
      idTokenAddress(token({ ...ok, exp: NOW.getTime() / 1000 - 3600 }), FAKE_GOOGLE.clientId, NOW),
    ).toThrow(/expired/);
    expect(() => idTokenAddress("garbage", FAKE_GOOGLE.clientId, NOW)).toThrow(SignInRefusedError);
  });

  it("refreshes before expiry and keeps the refresh token; an expired grant asks for a reconnect", async () => {
    const { connector, grant, google } = await signIn();
    const creds = memoryCredentials({
      ...grant.credentials,
      expiresAt: "2026-11-05T14:00:00.000Z",
    });
    const { s } = services();
    const ctx = {
      tenantId: CONN.tenantId,
      connection: CONN,
      credentials: creds,
      logger: noopLogger,
      now: () => NOW,
      services: { email: s },
      idempotencyKey: "run1:reach:reach:0",
    };
    await executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx);
    const refresh = google.requests.filter(
      (r) => r.url === GOOGLE_TOKEN_URL && r.body?.includes("grant_type=refresh_token"),
    );
    expect(refresh).toHaveLength(1);
    expect(creds.current()).toMatchObject({
      refreshToken: grant.credentials.refreshToken,
      accessToken: google.issued().accessTokens[1],
    });
    expect(google.sent).toHaveLength(1);

    // A token Google refuses mid-way: one refresh, then the send.
    google.expireAccessTokens();
    await executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, {
      ...ctx,
      idempotencyKey: "run1:reach:reach:1",
    });
    expect(google.sent).toHaveLength(2);

    // Seven days in Testing: the refresh token stops working.
    google.expireRefreshTokens();
    google.expireAccessTokens();
    await expect(
      executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, {
        ...ctx,
        idempotencyKey: "run1:reach:reach:2",
      }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(google.sent).toHaveLength(2);
  });

  it("revokes the refresh token at Google on disconnect", async () => {
    const { connector, grant, google } = await signIn();
    await connector.revoke?.({
      tenantId: CONN.tenantId,
      connection: CONN,
      credentials: memoryCredentials(grant.credentials),
      logger: noopLogger,
      now: () => NOW,
    });
    const call = google.requests.find((r) => r.url === GOOGLE_REVOKE_URL);
    expect(call?.body).toBe(`token=${encodeURIComponent(String(grant.credentials.refreshToken))}`);
    expect(google.revoked()).toEqual([grant.credentials.refreshToken]);
    // Already revoked (removed in the Google account): not an error.
    await expect(
      connector.revoke?.({
        tenantId: CONN.tenantId,
        connection: CONN,
        credentials: memoryCredentials(grant.credentials),
        logger: noopLogger,
        now: () => NOW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("gmail.send", () => {
  async function setup(opts: Parameters<typeof services>[0] = {}) {
    const { connector, grant, google } = await signIn();
    const svc = services(opts);
    const ctx = {
      tenantId: CONN.tenantId,
      connection: CONN,
      credentials: memoryCredentials(grant.credentials),
      logger: noopLogger,
      now: () => NOW,
      services: { email: svc.s },
      idempotencyKey: "0192f7a0-run:reach:reach:0",
    };
    return { connector, google, ctx, ...svc };
  }

  it("records what would be sent as its before state, and sends nothing then", async () => {
    const { connector, google, ctx } = await setup();
    const { before } = await captureBefore(connector, GMAIL_SEND_TOOL, SPANISH, ctx);
    expect(before).toEqual({
      contact: { id: "c1", name: "María Núñez" },
      to: "maria@proveedor.example",
      from: "pat.lee@gmail.test",
      replyTo: `shop-abc-secret+${TAG}@in.mezonas.test`,
      subject: SPANISH.subject,
      text: SPANISH.text,
    });
    expect(google.sent).toHaveLength(0);
  });

  it("sends a correct UTF-8 message From the mailbox, with the reply-to tagged, once per key", async () => {
    const { connector, google, ctx, recorded } = await setup();
    const first = await executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx);
    expect(first.output).toMatchObject({
      to: "maria@proveedor.example",
      from: "pat.lee@gmail.test",
      replyTo: `shop-abc-secret+${TAG}@in.mezonas.test`,
      contactName: "María Núñez",
      id: google.sent[0]?.id,
      threadId: google.sent[0]?.threadId,
    });
    expect(first.summary).toBe("Emailed María Núñez from Gmail");
    expect(google.sent).toHaveLength(1);
    const sent = google.sent[0];
    expect(sent?.account).toBe("pat.lee@gmail.test");
    // Raw is URL-safe base64; the message itself is 7-bit ASCII with CRLF line endings.
    expect(sent?.raw).toMatch(/^[A-Za-z0-9_=-]+$/);
    expect(sent?.message).not.toMatch(/[^\t\r\n\x20-\x7e]/);
    expect(
      sent?.message
        .split("\r\n\r\n")[0]
        ?.split("\r\n")
        .every((l) => l.length <= 998),
    ).toBe(true);
    expect(sent?.message.replace(/\r\n/g, "")).not.toContain("\n");

    const parsed = await PostalMime.parse(utf8(sent?.message ?? ""));
    expect(parsed.from).toMatchObject({ address: "pat.lee@gmail.test" });
    expect(parsed.to?.[0]).toMatchObject({ address: "maria@proveedor.example" });
    expect(parsed.replyTo?.[0]).toMatchObject({
      address: `shop-abc-secret+${TAG}@in.mezonas.test`,
    });
    expect(parsed.subject).toBe(SPANISH.subject);
    expect(parsed.text?.replace(/\r\n/g, "\n").trimEnd()).toBe(SPANISH.text);
    expect(parsed.messageId).toBe(
      first.output && (first.output as { messageId: string }).messageId,
    );
    expect(parsed.date).toBe(NOW.toISOString());
    expect(sent?.message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(sent?.message).toContain("MIME-Version: 1.0");

    // Recorded once, in the contact's thread.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      contactId: "c1",
      subject: SPANISH.subject,
      text: SPANISH.text,
    });

    // The same key again (a retried step): what was sent comes back; nothing is sent.
    const again = await executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx);
    expect(again.output).toMatchObject({ id: sent?.id });
    expect(google.sent).toHaveLength(1);
  });

  it("never sends again a send that was started and not recorded", async () => {
    const { connector, google, ctx, attempts, sent } = await setup();
    // A crash after Gmail took it and before we recorded it: the attempt stands, nothing recorded.
    await executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx);
    sent.clear();
    expect(attempts.get(ctx.idempotencyKey)).toMatchObject({ to: "maria@proveedor.example" });
    await expect(executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx)).rejects.toBeInstanceOf(
      UnconfirmedWriteError,
    );
    expect(google.sent).toHaveLength(1);
  });

  it("checks the contact in code before Google is called; no reply-to without a forwarding address", async () => {
    const blocked = await setup({ agreed: false });
    await expect(
      executeWrite(blocked.connector, GMAIL_SEND_TOOL, SPANISH, blocked.ctx),
    ).rejects.toThrow(/hasn't agreed/);
    await expect(
      executeWrite(
        blocked.connector,
        GMAIL_SEND_TOOL,
        { ...SPANISH, to: "eve@else.example" },
        blocked.ctx,
      ),
    ).rejects.toThrow(/not a contact/);
    expect(blocked.google.sent).toHaveLength(0);
    expect(blocked.attempts.size).toBe(0);

    const none = await setup({ forwarding: null });
    const out = await executeWrite(none.connector, GMAIL_SEND_TOOL, SPANISH, none.ctx);
    expect((out.output as { replyTo: unknown }).replyTo).toBeNull();
    expect(none.google.sent[0]?.message).not.toContain("Reply-To:");
  });

  it("refuses to run without the platform's send records", async () => {
    const { connector, ctx, google } = await setup();
    const { startAttempt: _s, attemptFor: _a, ...partial } = ctx.services.email;
    await expect(
      executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, { ...ctx, services: { email: partial } }),
    ).rejects.toThrow(/send records/);
    expect(google.sent).toHaveLength(0);
  });

  it("fails cleanly when Gmail refuses, without a second try", async () => {
    const { connector, google, ctx, recorded } = await setup();
    google.failSends(1, 400);
    await expect(executeWrite(connector, GMAIL_SEND_TOOL, SPANISH, ctx)).rejects.toThrow(
      /Gmail refused the email \(400\)/,
    );
    expect(recorded).toHaveLength(0);
  });
});

describe("the person's own test email", () => {
  const TEST = { subject: "Mezonas test email", text: "This is a test from Mezonas.", key: "k1" };

  async function setup(connection: ConnectionRef = CONN) {
    const { connector, grant, google } = await signIn();
    const ctx = {
      tenantId: CONN.tenantId,
      connection,
      credentials: memoryCredentials(grant.credentials),
      logger: noopLogger,
      now: () => NOW,
    };
    return { connector, google, ctx };
  }

  it("is not a tool: no agent can reach it", async () => {
    const { connector } = await setup();
    expect(isGmailConnector(connector)).toBe(true);
    expect(Object.keys(connector.tools)).toEqual([GMAIL_SEND_TOOL]);
    expect(connector.manifest.tools.map((t) => t.id)).toEqual([GMAIL_SEND_TOOL]);
  });

  it("sends one plain email from the connected mailbox to itself, and nowhere else", async () => {
    const { connector, google, ctx } = await setup();
    const out = await connector.sendToSelf(ctx, TEST);
    expect(out).toMatchObject({ to: "pat.lee@gmail.test", id: google.sent[0]?.id });
    expect(google.sent).toHaveLength(1);
    const parsed = await PostalMime.parse(utf8(google.sent[0]?.message ?? ""));
    expect(parsed.from?.address).toBe("pat.lee@gmail.test");
    expect((parsed.to ?? []).map((a) => a.address)).toEqual(["pat.lee@gmail.test"]);
    expect(parsed.replyTo ?? []).toEqual([]);
    expect(parsed.subject).toBe(TEST.subject);
    expect(parsed.text?.trim()).toBe(TEST.text);
    expect(parsed.messageId).toBe("<test.k1.mezonas@gmail.test>");
  });

  it("refuses a connection with no stored address, or one the tokens don't belong to", async () => {
    for (const externalAccountId of [null, "", "someone@else.test"]) {
      const { connector, google, ctx } = await setup({ ...CONN, externalAccountId });
      await expect(connector.sendToSelf(ctx, TEST)).rejects.toBeInstanceOf(GmailNoAddressError);
      expect(google.sent).toHaveLength(0);
    }
  });

  it("refreshes an expired access token as a send does", async () => {
    const { connector, google, ctx } = await setup();
    google.expireAccessTokens();
    await connector.sendToSelf(ctx, TEST);
    expect(google.sent).toHaveLength(1);
  });
});

describe("the message", () => {
  it("encodes non-ASCII headers as encoded words of at most 75 characters, never splitting a character", () => {
    const long = "Pedido nº 1042 — confirmación de entrega 🙏 ".repeat(4);
    const words = encodedWords(long).split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      // Each word decodes to whole characters on its own.
      expect(fromUtf8(fromBase64(w.slice(10, -2)))).toBeTruthy();
    }
    expect(headerText("Friday's delivery")).toBe("Friday's delivery");
  });

  it("can't be given another header", async () => {
    const msg = buildPlainMessage({
      from: { address: "pat.lee@gmail.test", name: "Pat\r\nBcc: eve@evil.example" },
      to: "maria@proveedor.example",
      subject: "Hi\r\nBcc: eve@evil.example",
      text: "Body\r\n\r\nBcc: eve@evil.example",
      messageId: "<a.b@gmail.test>",
      date: NOW,
    });
    const head = msg.split("\r\n\r\n")[0] ?? "";
    expect(head.split("\r\n").filter((l) => /^bcc:/i.test(l))).toEqual([]);
    const parsed = await PostalMime.parse(utf8(msg));
    expect(parsed.bcc ?? []).toEqual([]);
    expect(parsed.subject).toBe("Hi Bcc: eve@evil.example");
    expect(() => mailbox("eve@evil.example>\r\nBcc: x@y.z")).toThrow(MimeError);
    expect(() =>
      buildPlainMessage({
        from: { address: "pat.lee@gmail.test" },
        to: "maria@proveedor.example",
        subject: "x",
        text: "y",
        messageId: "<a\r\nBcc: x@y.z>",
        date: NOW,
      }),
    ).toThrow(MimeError);
  });
});
