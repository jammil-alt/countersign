// "gmail": send only (ARCHITECTURE §6.4, owner 2026-11-05). A person at the client signs in to their
// own Google account from the portal and lets agents send from it; we ask Google for `gmail.send`
// and nothing else of Gmail, so nothing here can read, search, label or draft mail. Reading is done
// by forwarding (§6.5): replies come back to the client's forwarding address through the Reply-To
// header. `gmail.send` takes the same input as Resend's `email.send`, so reach out (plan §1.25)
// uses either as an agent's email channel. Unchecked facts about Google: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
// P-3: attachments both ways
import { AttachmentSummary } from "@countersign/core";
import { z } from "zod";
import { type AttachmentLimits, describeOutbound, loadOutbound, summaries } from "../attachments";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import {
  EmailBlockedError,
  EmailSendInput,
  EmailSendOutput,
  type EmailServices,
  taggedReplyTo,
} from "../resend/index";
import { fromBase64Url, fromUtf8 } from "../runtime";
import { buildPlainMessage, gmailRaw } from "./mime";

export const GMAIL_CONNECTOR_ID = "gmail";
export const GMAIL_SEND_TOOL = "gmail.send";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
// P-3: a message with attachments goes as media (`message/rfc822`) to the upload URI, which takes
// up to 35 MB; the JSON `raw` body is for plain text (NOTES.md: both to verify).
export const GMAIL_UPLOAD_SEND_URL =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
/** Gmail's 25 MB per message, after base64 (4/3): 18 MB of files leaves room for the rest. */
export const GMAIL_ATTACHMENT_LIMITS: AttachmentLimits = {
  provider: "Gmail",
  maxCount: 5,
  maxTotalBytes: 18 * 1024 * 1024,
};

/** The one Gmail scope we ask for: send only (a sensitive scope, no CASA). */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
// DECISION: `openid email` beside `gmail.send`, so the token answer carries an ID token with the
// address that signed in. `gmail.send` alone can't read the profile (users.getProfile needs a read
// scope), and we need the address to show which mailbox is connected and to send From it. Both are
// Google's basic sign-in scopes, not Gmail scopes, and add nothing to the review (NOTES.md).
export const GMAIL_SCOPES: readonly string[] = ["openid", "email", GMAIL_SEND_SCOPE];

/** Every Google scope other than these is refused if a grant carries it: we hold nothing more. */
const ALLOWED_SCOPES = new Set([...GMAIL_SCOPES, "https://www.googleapis.com/auth/userinfo.email"]);

/** The encrypted credentials: the shared token fields and the address they belong to. */
export const GmailCredentials = OAuthTokens.extend({ address: z.string().min(3) });
export type GmailCredentials = z.infer<typeof GmailCredentials>;

const TokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    id_token: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const IdTokenClaims = z.looseObject({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  email: z.string().min(3),
  email_verified: z.union([z.boolean(), z.literal("true")]),
});

/**
 * The ID token's claims. It comes straight from Google's token endpoint over TLS, in answer to our
 * own client secret, so its signature isn't checked (OpenID Connect Core §3.1.3.7); the issuer, the
 * audience, the expiry and a verified address still are.
 */
export function idTokenAddress(idToken: string, clientId: string, now: Date): string {
  const [, payload] = idToken.split(".");
  if (!payload) throw new SignInRefusedError("Google didn't say which account signed in");
  let claims: z.infer<typeof IdTokenClaims>;
  try {
    claims = IdTokenClaims.parse(JSON.parse(fromUtf8(fromBase64Url(payload))));
  } catch {
    throw new SignInRefusedError("Google didn't say which account signed in");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new SignInRefusedError("that sign-in wasn't for Mezonas");
  if (claims.exp * 1000 < now.getTime() - 60_000) {
    throw new SignInRefusedError("that sign-in has expired; connect again");
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new SignInRefusedError("Google hasn't verified that account's address");
  }
  return claims.email.trim().toLowerCase();
}

/** The scopes Google granted (granular consent lets a person untick some). */
export function grantedScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export class GmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Gmail sign-in is not set up on this deployment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)",
    );
    this.name = "GmailNotConfiguredError";
  }
}

export const GmailSendOutput = EmailSendOutput.extend({
  /** Gmail's thread id for the sent message. */
  threadId: z.string().nullable(),
});
export type GmailSendOutput = z.infer<typeof GmailSendOutput>;

/** What the approver sees and `external_action.before` keeps: the email as it would go. */
export const GmailSendBefore = z.object({
  contact: z.object({ id: z.string(), name: z.string() }),
  to: z.string(),
  from: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  // P-3
  /** The attachments by name and size. */
  attachments: z.array(AttachmentSummary).optional(),
});

export interface GmailOptions {
  /** Google Cloud's OAuth client ("Mezonas web"). */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

function emailServices(ctx: ToolContext): EmailServices {
  const s = ctx.services?.email;
  if (!s?.startAttempt || !s.attemptFor) {
    throw new EmailBlockedError("Gmail sends need the platform's contact and send records");
  }
  return s;
}

/** The connected address: the connection's account, else the one kept with the tokens. */
async function senderOf(ctx: ToolContext): Promise<string> {
  if (ctx.connection.externalAccountId) return ctx.connection.externalAccountId;
  const creds = GmailCredentials.safeParse(await ctx.credentials.get());
  if (!creds.success) throw new ReconnectRequiredError("the Gmail connection has no valid sign-in");
  return creds.data.address;
}

async function replyToFor(services: EmailServices, tag: string | undefined) {
  const forwarding = services.replyAddress ? await services.replyAddress() : null;
  return taggedReplyTo(forwarding, tag);
}

/** Our own Message-ID on the sender's domain, from the action's key: a reply's In-Reply-To names it. */
function messageIdFor(idempotencyKey: string, from: string): string {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<${idempotencyKey.replace(/[^A-Za-z0-9.-]/g, ".")}.mezonas@${domain}>`;
}

/** A connection with no address of its own: we don't know whom to send to, so nothing is sent. */
export class GmailNoAddressError extends Error {
  constructor() {
    super("we don't know this mailbox's address; connect Gmail again");
    this.name = "GmailNoAddressError";
  }
}

/** The person's own test email: the words only. The recipient is never an input. */
export interface GmailSelfTest {
  subject: string;
  text: string;
  /** A fresh key for our Message-ID. */
  key: string;
}

export interface GmailConnector extends Connector {
  /**
   * Sends one plain-text email from the connected mailbox to that same mailbox: a person checking
   * their own connection (the portal's "Send a test email"). Not a tool, so no agent can call it.
   * The address is the connection's own and must match the one kept with the tokens.
   */
  sendToSelf(
    ctx: ConnectionContext,
    email: GmailSelfTest,
  ): Promise<{ id: string; threadId: string | null; to: string }>;
}

export function isGmailConnector(c: Connector | undefined): c is GmailConnector {
  return (
    c?.manifest.id === GMAIL_CONNECTOR_ID &&
    typeof (c as Partial<GmailConnector>).sendToSelf === "function"
  );
}

export function createGmailConnector(options: GmailOptions = {}): GmailConnector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new GmailNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>): Promise<z.infer<typeof TokenAnswer>> {
    const res = await doFetch()(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new GmailApiError(res.status, "Google's token endpoint did not answer JSON");
    }
    const parsed = TokenAnswer.safeParse(body);
    if (!parsed.success) {
      throw new GmailApiError(res.status, "Google's token answer has an unexpected shape");
    }
    return parsed.data;
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const c = client();
      const answer = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: c.id,
        client_secret: c.secret,
      });
      if ("error" in answer) {
        // invalid_grant: revoked, or expired (after 7 days while the app is in Testing).
        throw new ReconnectRequiredError(`Google refused the refresh: ${answer.error}`);
      }
      // Google keeps the refresh token; tokenManager keeps the old one when none comes back.
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  /** `users.messages.send`, with one refresh and retry if the access token is refused. */
  async function send(
    ctx: ConnectionContext,
    raw: string,
    // P-3: with attachments, the message itself (ASCII: every part is base64) to the upload URI.
    media?: string,
  ): Promise<{ id: string; threadId: string | null }> {
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      (token) =>
        media === undefined
          ? doFetch()(`${GMAIL_API}/users/me/messages/send`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ raw }),
              redirect: "manual",
              signal: timeoutSignal(30_000),
            })
          : doFetch()(GMAIL_UPLOAD_SEND_URL, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "message/rfc822",
                accept: "application/json",
              },
              body: media,
              redirect: "manual",
              signal: timeoutSignal(60_000),
            }),
      (r) => r.status === 401,
    );
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401) throw new ReconnectRequiredError("Google refused the access token");
    if (!res.ok) {
      const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
      throw new GmailApiError(
        res.status,
        `Gmail refused the email (${res.status}): ${typeof msg === "string" ? msg : "no reason given"}`,
      );
    }
    const ok = z.object({ id: z.string().min(1), threadId: z.string().optional() }).safeParse(json);
    if (!ok.success) throw new GmailApiError(res.status, "Gmail's answer has no message id");
    return { id: ok.data.id, threadId: ok.data.threadId ?? null };
  }

  async function sendToSelf(ctx: ConnectionContext, email: GmailSelfTest) {
    const stored = ctx.connection.externalAccountId?.trim().toLowerCase();
    if (!stored) throw new GmailNoAddressError();
    const creds = GmailCredentials.safeParse(await ctx.credentials.get());
    if (!creds.success)
      throw new ReconnectRequiredError("the Gmail connection has no valid sign-in");
    // DECISION: the tokens' own address must be the stored one, so the test can only go to the
    // mailbox that signed in (Gmail sends as the token's account whatever From says).
    if (creds.data.address.trim().toLowerCase() !== stored) throw new GmailNoAddressError();
    const raw = gmailRaw(
      buildPlainMessage({
        from: { address: stored },
        to: stored,
        subject: email.subject,
        text: email.text,
        messageId: messageIdFor(`test.${email.key}`, stored),
        date: ctx.now(),
      }),
    );
    const res = await send(ctx, raw);
    return { ...res, to: stored };
  }

  const connector = defineConnector({
    id: GMAIL_CONNECTOR_ID,
    name: "Gmail",
    description: "Send email from your Gmail. We can't read your mailbox.",
    icon: "mail",
    auth: "oauth2",
    entities: [],
    // v0.12 W2-A: record types for the matrix (docs/plan.md §1.44).
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        redirect_uri: req.redirectUri,
        response_type: "code",
        scope: GMAIL_SCOPES.join(" "),
        // A refresh token, every time: Google gives one only with offline access, and on a
        // reconnect only when consent is asked again.
        access_type: "offline",
        prompt: "consent",
        // Never widen to scopes granted to Mezonas before.
        include_granted_scopes: "false",
        state: req.state,
      });
      return { redirectUrl: `${GOOGLE_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Google callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Google refused the sign-in: ${answer.error}`);
      const scopes = grantedScopes(answer.scope);
      if (!scopes.includes(GMAIL_SEND_SCOPE)) {
        // Granular consent: the person unticked "Send email on your behalf".
        throw new SignInRefusedError(
          "Google didn't give us permission to send email. Connect again and allow it.",
        );
      }
      const extra = scopes.filter((s) => !ALLOWED_SCOPES.has(s));
      if (extra.length > 0) {
        throw new SignInRefusedError(
          "Google gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Google gave no refresh token");
      if (!answer.id_token)
        throw new SignInRefusedError("Google didn't say which account signed in");
      const now = new Date();
      const address = idTokenAddress(answer.id_token, c.id, now);
      const credentials: GmailCredentials = GmailCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        scope: scopes.join(" "),
        address,
      });
      return {
        externalAccountId: address,
        credentials: credentials as unknown as JsonObject,
        config: { address, scopes: ["gmail.send"] },
      };
    },

    tokens: refresher,

    async revoke(ctx: ConnectionContext) {
      const creds = OAuthTokens.safeParse(await ctx.credentials.get());
      if (!creds.success) return;
      // Revoking the refresh token ends the whole grant (and its access tokens).
      const token = creds.data.refreshToken ?? creds.data.accessToken;
      const res = await doFetch()(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formEncode({ token }),
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      // 400 invalid_token: already revoked (the person removed us in their Google account).
      if (!res.ok && res.status !== 400) {
        throw new GmailApiError(res.status, `Google didn't revoke the grant (${res.status})`);
      }
    },

    tools: [
      defineWriteTool({
        id: GMAIL_SEND_TOOL,
        entity: "message",
        description:
          "Email a contact from the connected Gmail account. Only contacts who agreed to email; plain text. Replies come back through the client's forwarding address.",
        verb: "create",
        summary: "Emailed {{contactName}} from Gmail",
        recipient: { path: "to", channel: "email" },
        input: EmailSendInput,
        output: GmailSendOutput,
        beforeSchema: GmailSendBefore,
        async before(input, ctx) {
          const services = emailServices(ctx);
          const check = await services.checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          const attachments = await describeOutbound(
            ctx,
            input.attachments,
            GMAIL_ATTACHMENT_LIMITS,
          );
          return {
            contact: check.contact,
            to: input.to,
            from: await senderOf(ctx),
            replyTo: await replyToFor(services, input.replyTag),
            subject: input.subject,
            text: input.text,
            ...(attachments.length ? { attachments } : {}),
          };
        },
        async run(input, ctx) {
          const services = emailServices(ctx);
          // A re-run after a crash returns what was sent, before any check.
          const sent = await services.sentFor(ctx.idempotencyKey);
          if (sent) return GmailSendOutput.parse({ threadId: null, ...sent });
          // DECISION: Gmail takes no idempotency key and `gmail.send` can't list sent mail, so a
          // send that was started and never recorded may have gone out: it is never sent again
          // (executed once); the operator checks the mailbox (UnconfirmedWriteError).
          const started = await services.attemptFor?.(ctx.idempotencyKey);
          if (started) {
            throw new UnconfirmedWriteError(
              `The email to ${started.contactName} may have been sent from Gmail`,
              `we started it at ${started.startedAt.toISOString()} and have no record of it, and we can't read the mailbox to check`,
              {
                channel: "email",
                to: started.to,
                from: started.from,
                subject: started.subject,
                startedAt: started.startedAt.toISOString(),
              },
            );
          }
          const check = await services.checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          const from = await senderOf(ctx);
          const replyTo = await replyToFor(services, input.replyTag);
          const messageId = messageIdFor(ctx.idempotencyKey, from);
          // P-3: read from storage for this one send; refused before anything is started.
          const files = await loadOutbound(ctx, input.attachments, GMAIL_ATTACHMENT_LIMITS);
          const mime = buildPlainMessage({
            from: { address: from },
            to: input.to,
            replyTo,
            subject: input.subject,
            text: input.text,
            messageId,
            date: ctx.now(),
            ...(files.length ? { attachments: files } : {}),
          });
          const raw = files.length ? "" : gmailRaw(mime);
          await services.startAttempt?.({
            idempotencyKey: ctx.idempotencyKey,
            connectionId: ctx.connection.id,
            contactId: check.contact.id,
            contactName: check.contact.name,
            to: input.to,
            from,
            subject: input.subject,
            startedAt: ctx.now(),
          });
          const res = await send(ctx, raw, files.length ? mime : undefined);
          const output: GmailSendOutput = {
            id: res.id,
            threadId: res.threadId,
            to: input.to,
            from,
            replyTo,
            contactName: check.contact.name,
            messageId,
            ...(files.length ? { attachments: summaries(files) } : {}),
          };
          await services.recordOutbound({
            connectionId: ctx.connection.id,
            contactId: check.contact.id,
            output,
            subject: input.subject,
            text: input.text,
            idempotencyKey: ctx.idempotencyKey,
            sentAt: ctx.now(),
          });
          return output;
        },
      }),
    ],
  });
  return Object.assign(connector, { sendToSelf });
}
