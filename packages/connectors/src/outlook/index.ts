// "outlook": Outlook and Microsoft 365 mail, send only (ARCHITECTURE §6.11, docs/plan.md §1.52). A
// person at the client signs in to their Microsoft account from the portal and lets agents send
// from it; we ask Microsoft for delegated `Mail.Send` (with `openid email offline_access` for the
// address and a refresh token) and no read scope, so nothing here can read, search or file mail.
// Replies come back by forwarding, through the tagged Reply-To, as for Gmail. `outlook.send` takes
// the same input as `email.send` and `gmail.send`, and has Gmail's once-only rule: Graph's
// `sendMail` takes no idempotency key, so the attempt is recorded first and a started, unrecorded
// send is never sent again. Unchecked facts about Microsoft: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
// P-3: attachments both ways
import { AttachmentSummary } from "@countersign/core";
import { z } from "zod";
import {
  type AttachmentLimits,
  describeOutbound,
  type LoadedAttachment,
  loadOutbound,
  summaries,
} from "../attachments";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";
import {
  GRAPH_API,
  graphScope,
  MICROSOFT_SIGN_IN_SCOPES,
  MicrosoftApiError,
  MicrosoftCredentials,
  microsoftSignIn,
} from "../microsoft/identity";
import { ReconnectRequiredError, tokenManager } from "../oauth/tokens";
import {
  EmailBlockedError,
  EmailSendInput,
  EmailSendOutput,
  type EmailServices,
  taggedReplyTo,
} from "../resend/index";
import { sha256Bytes, toBase64, toHex, utf8 } from "../runtime";

export const OUTLOOK_CONNECTOR_ID = "outlook";
export const OUTLOOK_SEND_TOOL = "outlook.send";

// §1.97: the identity platform's constants and the sign-in now live in ../microsoft/identity.ts,
// shared with OneDrive, Excel and Outlook Calendar; re-exported here under their old names.
export {
  GRAPH_API,
  looksLikeAddress,
  MICROSOFT_AUTH_URL,
  MICROSOFT_AUTHORITY,
  MICROSOFT_LOGIN_ORIGIN,
  MICROSOFT_TOKEN_URL,
  microsoftIdTokenAddress,
} from "../microsoft/identity";

/** The one Graph scope: send as the signed-in person. No read scope, ever. */
export const MAIL_SEND_SCOPE = graphScope("Mail.Send");
export const OUTLOOK_SCOPES: readonly string[] = [...MICROSOFT_SIGN_IN_SCOPES, MAIL_SEND_SCOPE];
// DECISION: a grant may carry, besides Mail.Send, only OpenID's sign-in scopes and Graph's
// `User.Read` (Microsoft adds it to new app registrations and grants consented scopes together).
// Anything else (Mail.Read, Mail.ReadWrite, Files.*, …) is refused and nothing is stored, as for
// Gmail. Compared in lower case, short or full Graph form (microsoftSignIn's `exchange`).

/** The header that carries our reference on every message (Graph allows only `X-` headers). */
export const OUTLOOK_REF_HEADER = "X-Mezonas-Ref";

export const OutlookCredentials = MicrosoftCredentials;
export type OutlookCredentials = MicrosoftCredentials;

/** Graph refused a send (Outlook's name for the shared error). */
export const OutlookApiError = MicrosoftApiError;

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
  // P-3
  /** The attachments by name and size. */
  attachments: z.array(AttachmentSummary).optional(),
});

// P-3: Graph's `sendMail` takes the whole request, attachments inline in base64, up to 4 MB; a
// bigger file needs an upload session on a draft, which needs a read-write scope we don't ask
// for (NOTES.md). 3 MB of files is 4 MB in base64, so the request stays near Graph's limit.
export const OUTLOOK_ATTACHMENT_LIMITS: AttachmentLimits = {
  provider: "Outlook",
  maxCount: 5,
  maxTotalBytes: 3 * 1000 * 1000,
};

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
  // P-3
  attachments?: readonly Pick<LoadedAttachment, "filename" | "mimeType" | "bytes">[];
}): JsonObject {
  return {
    message: {
      subject: oneLine(m.subject),
      body: { contentType: "Text", content: m.text },
      toRecipients: [{ emailAddress: { address: m.to } }],
      ...(m.replyTo ? { replyTo: [{ emailAddress: { address: m.replyTo } }] } : {}),
      internetMessageHeaders: [{ name: OUTLOOK_REF_HEADER, value: m.ref }],
      // P-3: Graph's file attachment: name, type and the bytes in base64.
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: oneLine(a.filename),
              contentType: a.mimeType,
              contentBytes: toBase64(a.bytes),
            })),
          }
        : {}),
    },
    saveToSentItems: true,
  };
}

export function createOutlookConnector(options: OutlookOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const signIn = microsoftSignIn(options, {
    provider: "Outlook",
    envNames: "OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET",
    graphScopes: ["Mail.Send"],
    missingMessage:
      "Microsoft didn't give us permission to send email. Connect again and allow it.",
  });
  const refresher = signIn.refresher;

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
    throw new MicrosoftApiError(
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
    isConfigured: () => signIn.configured,

    async authorize(req) {
      return { redirectUrl: signIn.authorizeUrl(req) };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Microsoft callback has no code");
      const { credentials, account } = await signIn.exchange(code, req.redirectUri);
      return {
        externalAccountId: account.address,
        credentials: credentials as unknown as JsonObject,
        config: { address: account.address, scopes: ["Mail.Send"] },
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
        // R5: a send can't be taken back.
        undo: { kind: "none" },
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
          const attachments = await describeOutbound(
            ctx,
            input.attachments,
            OUTLOOK_ATTACHMENT_LIMITS,
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
          // P-3: read from storage for this one send; refused before anything is started.
          const files = await loadOutbound(ctx, input.attachments, OUTLOOK_ATTACHMENT_LIMITS);
          const body = graphMessage({
            to: input.to,
            replyTo,
            subject: input.subject,
            text: input.text,
            ref,
            ...(files.length ? { attachments: files } : {}),
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
}
