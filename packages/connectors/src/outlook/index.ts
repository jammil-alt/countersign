// "outlook": Outlook and Microsoft 365 mail, send only (ARCHITECTURE §6.11, docs/plan.md §1.52). A
// person at the client signs in to their Microsoft account from the portal and lets agents send
// from it; we ask Microsoft for delegated `Mail.Send` (with `openid email offline_access` for the
// address and a refresh token) and no read scope, so nothing here can read, search or file mail.
// Replies come back by forwarding, through the tagged Reply-To, as for Gmail. `outlook.send` takes
// the same input as `email.send` and `gmail.send`, and has Gmail's once-only rule: Graph's
// `sendMail` takes no idempotency key, so the attempt is recorded first and a started, unrecorded
// send is never sent again. Unchecked facts about Microsoft: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, formEncode, globalFetch, parseUrl, timeoutSignal } from "../http";
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
import { fromBase64Url, fromUtf8, sha256Bytes, toHex, utf8 } from "../runtime";

export const OUTLOOK_CONNECTOR_ID = "outlook";
export const OUTLOOK_SEND_TOOL = "outlook.send";

export const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
// DECISION: the `common` endpoint, so work and school accounts (Microsoft 365) and personal
// Outlook.com accounts can both connect; the app registration must allow both (NOTES.md).
export const MICROSOFT_AUTHORITY = `${MICROSOFT_LOGIN_ORIGIN}/common/oauth2/v2.0`;
export const MICROSOFT_AUTH_URL = `${MICROSOFT_AUTHORITY}/authorize`;
export const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`;
export const GRAPH_API = "https://graph.microsoft.com/v1.0";

/** The one Graph scope: send as the signed-in person. No read scope, ever. */
export const MAIL_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";
export const OUTLOOK_SCOPES: readonly string[] = [
  "openid",
  "email",
  "offline_access",
  MAIL_SEND_SCOPE,
];

// DECISION: a grant may carry, besides Mail.Send, only OpenID's sign-in scopes and Graph's
// `User.Read` (Microsoft adds it to new app registrations and grants consented scopes together).
// Anything else (Mail.Read, Mail.ReadWrite, Files.*, …) is refused and nothing is stored, as for
// Gmail. Compared in lower case, short or full Graph form.
const GRAPH_PREFIX = "https://graph.microsoft.com/";
const ALLOWED_SCOPES = new Set(
  ["openid", "email", "profile", "offline_access", "mail.send", "user.read"].flatMap((s) =>
    s.includes(".") ? [s, `${GRAPH_PREFIX}${s}`] : [s],
  ),
);
const SEND_SCOPES = new Set(["mail.send", `${GRAPH_PREFIX}mail.send`]);

/** The header that carries our reference on every message (Graph allows only `X-` headers). */
export const OUTLOOK_REF_HEADER = "X-Mezonas-Ref";

export const OutlookCredentials = OAuthTokens.extend({ address: z.string().min(3) });
export type OutlookCredentials = z.infer<typeof OutlookCredentials>;

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
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  tid: z.string().min(1),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

/** An address with one `@`, a dotted domain and no spaces or angle brackets (index checks only). */
export function looksLikeAddress(value: string): boolean {
  if (value.length < 6 || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || value[i] === "<" || value[i] === ">") return false;
  }
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && domain.length - dot > 2;
}

/**
 * The signed-in address, from the ID token Microsoft's token endpoint answered over TLS to our own
 * client secret, so its signature isn't checked (OpenID Connect Core §3.1.3.7); the issuer (on
 * Microsoft's login host, for the token's own tenant), the audience and the expiry are.
 */
// DECISION: the `email` claim, else `preferred_username` when it is an address. Mail.Send can't
// read the profile (`/me` needs User.Read), and Graph sends as the signed-in mailbox whatever we
// name, so the address only says which mailbox is connected and what the record shows (NOTES.md).
export function microsoftIdTokenAddress(idToken: string, clientId: string, now: Date): string {
  const [, payload] = idToken.split(".");
  const refused = () => new SignInRefusedError("Microsoft didn't say which account signed in");
  if (!payload) throw refused();
  let claims: z.infer<typeof IdTokenClaims>;
  try {
    claims = IdTokenClaims.parse(JSON.parse(fromUtf8(fromBase64Url(payload))));
  } catch {
    throw refused();
  }
  const iss = parseUrl(claims.iss);
  if (iss?.origin !== MICROSOFT_LOGIN_ORIGIN || iss.pathname !== `/${claims.tid}/v2.0`) {
    throw new SignInRefusedError("that sign-in didn't come from Microsoft");
  }
  if (claims.aud !== clientId) throw new SignInRefusedError("that sign-in wasn't for Mezonas");
  if (claims.exp * 1000 < now.getTime() - 60_000) {
    throw new SignInRefusedError("that sign-in has expired; connect again");
  }
  for (const candidate of [claims.email, claims.preferred_username]) {
    const v = candidate?.trim().toLowerCase();
    if (v && looksLikeAddress(v)) return v;
  }
  throw new SignInRefusedError("Microsoft didn't say which mailbox signed in");
}

export class OutlookApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OutlookApiError";
  }
}

export class OutlookNotConfiguredError extends Error {
  constructor() {
    super(
      "Outlook sign-in is not set up on this deployment (OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET)",
    );
    this.name = "OutlookNotConfiguredError";
  }
}

/** `email.send`'s output. Graph answers a send with 202 and no body, so `id` is our own reference. */
// DECISION: `id` is our `X-Mezonas-Ref` (from the action's key; it is on the sent message) and
// `messageId` is empty: Graph assigns the Internet Message-ID itself and `sendMail` doesn't say
// it, and without a read scope we can't look it up. Replies are matched by the tagged Reply-To.
export const OutlookSendOutput = EmailSendOutput;
export type OutlookSendOutput = z.infer<typeof OutlookSendOutput>;

/** What the approver sees and `external_action.before` keeps: the email as it would go. */
export const OutlookSendBefore = z.object({
  contact: z.object({ id: z.string(), name: z.string() }),
  to: z.string(),
  from: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
});

export interface OutlookOptions {
  /** The Entra app registration ("Mezonas"): application (client) id and a client secret. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

function emailServices(ctx: ToolContext): EmailServices {
  const s = ctx.services?.email;
  if (!s?.startAttempt || !s.attemptFor) {
    throw new EmailBlockedError("Outlook sends need the platform's contact and send records");
  }
  return s;
}

async function senderOf(ctx: ToolContext): Promise<string> {
  if (ctx.connection.externalAccountId) return ctx.connection.externalAccountId;
  const creds = OutlookCredentials.safeParse(await ctx.credentials.get());
  if (!creds.success)
    throw new ReconnectRequiredError("the Outlook connection has no valid sign-in");
  return creds.data.address;
}

async function replyToFor(services: EmailServices, tag: string | undefined) {
  const forwarding = services.replyAddress ? await services.replyAddress() : null;
  return taggedReplyTo(forwarding, tag);
}

/** Our reference for an action's send: on the message as `X-Mezonas-Ref`, and the output's `id`. */
export async function outlookRef(idempotencyKey: string): Promise<string> {
  return `mz-${toHex(await sha256Bytes(utf8(`outlook:${idempotencyKey}`))).slice(0, 32)}`;
}

/** One line: line breaks in a subject become spaces (Graph would keep them). */
function oneLine(s: string): string {
  let out = "";
  let lastBreak = false;
  for (const ch of s) {
    const br = ch === "\r" || ch === "\n";
    if (br && !lastBreak) out += " ";
    if (!br) out += ch;
    lastBreak = br;
  }
  return out;
}

/** The Graph `sendMail` body: plain text, to the contact, replies to the forwarding address. */
export function graphMessage(m: {
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  ref: string;
}): JsonObject {
  return {
    message: {
      subject: oneLine(m.subject),
      body: { contentType: "Text", content: m.text },
      toRecipients: [{ emailAddress: { address: m.to } }],
      ...(m.replyTo ? { replyTo: [{ emailAddress: { address: m.replyTo } }] } : {}),
      internetMessageHeaders: [{ name: OUTLOOK_REF_HEADER, value: m.ref }],
    },
    saveToSentItems: true,
  };
}

export function createOutlookConnector(options: OutlookOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new OutlookNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>): Promise<z.infer<typeof TokenAnswer>> {
    const res = await doFetch()(MICROSOFT_TOKEN_URL, {
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
      throw new OutlookApiError(res.status, "Microsoft's token endpoint did not answer JSON");
    }
    const parsed = TokenAnswer.safeParse(body);
    if (!parsed.success) {
      throw new OutlookApiError(res.status, "Microsoft's token answer has an unexpected shape");
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
        scope: OUTLOOK_SCOPES.join(" "),
      });
      if ("error" in answer) {
        // invalid_grant: revoked, expired, or the password changed.
        throw new ReconnectRequiredError(`Microsoft refused the refresh: ${answer.error}`);
      }
      // Microsoft rotates refresh tokens: the new one is kept (tokenManager persists it).
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  /** Graph `sendMail`, with one refresh and retry if the access token is refused. */
  async function send(ctx: ConnectionContext, body: JsonObject): Promise<void> {
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      (token) =>
        doFetch()(`${GRAPH_API}/me/sendMail`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: timeoutSignal(30_000),
        }),
      (r) => r.status === 401,
    );
    if (res.status === 401) throw new ReconnectRequiredError("Microsoft refused the access token");
    if (res.status === 202 || res.ok) return;
    let msg: unknown;
    try {
      msg = (JSON.parse(await res.text()) as { error?: { message?: unknown } }).error?.message;
    } catch {
      msg = undefined;
    }
    throw new OutlookApiError(
      res.status,
      `Outlook refused the email (${res.status}): ${typeof msg === "string" ? msg : "no reason given"}`,
    );
  }

  return defineConnector({
    id: OUTLOOK_CONNECTOR_ID,
    name: "Outlook",
    description:
      "Send email from your Outlook or Microsoft 365 mailbox. We can't read your mailbox.",
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
        response_type: "code",
        redirect_uri: req.redirectUri,
        response_mode: "query",
        scope: OUTLOOK_SCOPES.join(" "),
        // The person picks the mailbox each time (a reconnect may be another account).
        prompt: "select_account",
        state: req.state,
      });
      return { redirectUrl: `${MICROSOFT_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Microsoft callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
        scope: OUTLOOK_SCOPES.join(" "),
      });
      if ("error" in answer) throw new Error(`Microsoft refused the sign-in: ${answer.error}`);
      const scopes = (answer.scope ?? "").split(" ").filter(Boolean);
      const lower = scopes.map((s) => s.toLowerCase());
      if (!lower.some((s) => SEND_SCOPES.has(s))) {
        throw new SignInRefusedError(
          "Microsoft didn't give us permission to send email. Connect again and allow it.",
        );
      }
      if (lower.some((s) => !ALLOWED_SCOPES.has(s))) {
        throw new SignInRefusedError(
          "Microsoft gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Microsoft gave no refresh token");
      if (!answer.id_token) {
        throw new SignInRefusedError("Microsoft didn't say which account signed in");
      }
      const now = new Date();
      const address = microsoftIdTokenAddress(answer.id_token, c.id, now);
      const credentials: OutlookCredentials = OutlookCredentials.parse({
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
        config: { address, scopes: ["Mail.Send"] },
      };
    },

    tokens: refresher,
    // DECISION: no `revoke`. Microsoft's identity platform has no endpoint that revokes one app's
    // delegated refresh token (revokeSignInSessions needs a write scope and signs the person out
    // everywhere), so disconnect drops the stored tokens only; the person removes Mezonas from
    // their account's app permissions to end the grant (NOTES.md, the portal's words).

    tools: [
      defineWriteTool({
        id: OUTLOOK_SEND_TOOL,
        entity: "message",
        description:
          "Email a contact from the connected Outlook mailbox. Only contacts who agreed to email; plain text. Replies come back through the client's forwarding address.",
        verb: "create",
        summary: "Emailed {{contactName}} from Outlook",
        recipient: { path: "to", channel: "email" },
        input: EmailSendInput,
        output: OutlookSendOutput,
        beforeSchema: OutlookSendBefore,
        async before(input, ctx) {
          const services = emailServices(ctx);
          const check = await services.checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          return {
            contact: check.contact,
            to: input.to,
            from: await senderOf(ctx),
            replyTo: await replyToFor(services, input.replyTag),
            subject: input.subject,
            text: input.text,
          };
        },
        async run(input, ctx) {
          const services = emailServices(ctx);
          // A re-run after a crash returns what was sent, before any check.
          const sent = await services.sentFor(ctx.idempotencyKey);
          if (sent) return OutlookSendOutput.parse(sent);
          // DECISION: Graph's sendMail takes no idempotency key and Mail.Send can't read Sent
          // Items, so the send is recorded as started before Graph is called, and a started send
          // with no record is never sent again: the action fails as unconfirmed and the operator
          // checks the mailbox (UnconfirmedWriteError), exactly as gmail.send (plan §1.31).
          const started = await services.attemptFor?.(ctx.idempotencyKey);
          if (started) {
            throw new UnconfirmedWriteError(
              `The email to ${started.contactName} may have been sent from Outlook`,
              `we started it at ${started.startedAt.toISOString()} and have no record of it, and we can't read the mailbox to check`,
              {
                channel: "email",
                to: started.to,
                from: started.from,
                subject: started.subject,
                startedAt: started.startedAt.toISOString(),
                header: OUTLOOK_REF_HEADER,
                ref: await outlookRef(ctx.idempotencyKey),
              },
            );
          }
          const check = await services.checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          const from = await senderOf(ctx);
          const replyTo = await replyToFor(services, input.replyTag);
          const ref = await outlookRef(ctx.idempotencyKey);
          const body = graphMessage({
            to: input.to,
            replyTo,
            subject: input.subject,
            text: input.text,
            ref,
          });
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
          await send(ctx, body);
          const output: OutlookSendOutput = {
            id: ref,
            to: input.to,
            from,
            replyTo,
            contactName: check.contact.name,
            messageId: "",
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
}
