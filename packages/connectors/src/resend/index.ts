// Mezonas' email sending (docs/plan.md §1.25): the `resend` connector. It is our infrastructure, like
// a client's Twilio subaccount, not the client's own tool: the operator sets it up per client from
// the back office. Agents send from an address on the client's domain once Resend has verified its
// DNS records (shown in the back office), and from our own domain until then. Replies come back to
// the client's forwarding address (stream D's email forwarding), tagged so the Worker can match them
// to the reach-out that asked. Each connection holds a sending-only API key restricted to the domain
// it sends from; Mezonas' full key (RESEND_API_KEY) only makes domains and those keys.
//
// `resend.send` is this connector's own send tool. The provider-neutral one is the merged Email
// action `email.send` (packages/core `steps.MERGED_CONNECTORS`), which runs on this tool, Gmail's
// `gmail.send` or Outlook's `outlook.send`, whichever the client has connected; they take the same
// input. Until 2026-11-25 this tool was itself called `email.send`; rows written then keep that id
// (`LEGACY_TOOL_IDS` in packages/core `reach/rules.ts`). Facts about Resend we couldn't check are in NOTES.md.

import { AttachmentSummary, EMAIL_SENDABLE_TYPES, OutboundAttachments } from "@countersign/core";
import { z } from "zod";
// P-3: attachments both ways
import { type AttachmentLimits, describeOutbound, loadOutbound, summaries } from "../attachments";
import { type Connector, defineConnector, defineWriteTool, type ToolContext } from "../connector";
import { requireCredentials } from "../credentials-accessor";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";
import { toBase64 } from "../runtime";
import { reachReplyTo } from "../upload/forwarding";

export const RESEND_CONNECTOR_ID = "resend";
export const RESEND_API = "https://api.resend.com";
export const EMAIL_SEND_TOOL = "resend.send";
/** Namespaces the email channel's tools share. */
export const EMAIL_NAMESPACES = ["email"] as const;

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_TEXT_MAX = 10_000;
/** A reply tag: lowercase letters and digits, carried in the reply-to address after a `+`. */
export const ReplyTag = z.string().regex(/^[a-z0-9]{6,40}$/);

const Address = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/, "an email address");

export const EmailSendInput = z.object({
  /** The contact's email. It must be a contact of this client who agreed to email. */
  to: Address,
  subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX),
  /** Plain text: agents never send HTML. */
  text: z.string().trim().min(1).max(EMAIL_TEXT_MAX),
  /** Tags the reply-to address so a reply finds what it answers. */
  replyTag: ReplyTag.optional(),
  // P-3: attachments both ways (docs/plan.md §1.65)
  /** Stored documents of this client (PDFs, images, .csv and .xlsx), at most five; names from the records. */
  attachments: OutboundAttachments.optional(),
});
export type EmailSendInput = z.infer<typeof EmailSendInput>;

export const EmailSendOutput = z.object({
  /** The provider's id. */
  id: z.string(),
  to: z.string(),
  from: z.string(),
  replyTo: z.string().nullable(),
  contactName: z.string(),
  messageId: z.string(),
  // P-3
  /** What went with it: names and sizes (recorded on the external action). */
  attachments: z.array(AttachmentSummary).optional(),
});

export const EmailSendBefore = z.object({
  contact: z.object({ id: z.string(), name: z.string() }),
  to: z.string(),
  from: z.string(),
  // P-3
  /** The attachments by name and size, as the approval card lists them. */
  attachments: z.array(AttachmentSummary).optional(),
});

// P-3: Resend takes at most 40 MB per email after base64 encoding (NOTES.md): 29 MB of files,
// leaving room for the encoding and the text.
export const RESEND_ATTACHMENT_LIMITS: AttachmentLimits = {
  provider: "Mezonas' email sending",
  maxCount: 5,
  maxTotalBytes: 29 * 1024 * 1024,
  types: EMAIL_SENDABLE_TYPES,
};

/** What the connection keeps in `connection.config`. */
export const ResendConfig = z.object({
  /** The client's domain, once added (null: sending from ours). */
  domain: z.string().nullable().default(null),
  domainId: z.string().nullable().default(null),
  domainStatus: z.string().nullable().default(null),
  records: z.array(z.record(z.string(), z.unknown())).default([]),
  /** The domain agents send from now: the client's once verified, else ours. */
  sendingDomain: z.string(),
  localPart: z.string().default("assistant"),
  fromName: z.string().nullable().default(null),
  /** The client's forwarding address, where replies come back; null: replies aren't read. */
  replyTo: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
});
export type ResendConfig = z.infer<typeof ResendConfig>;

export const ResendCredentials = z.object({ apiKey: z.string().min(8) });

export class ResendError extends Error {
  /** Resend answered and took nothing (`sendRefusedStatus`): nothing was sent or made. */
  readonly notWritten: boolean;
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ResendError";
    this.notWritten = status !== null && sendRefusedStatus(status);
  }
}

/** Waits before retrying a 429 when Resend sends no Retry-After; then the call fails. */
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000];
/** The longest Retry-After we wait for; a longer one fails the call (the step's retry). */
const RETRY_AFTER_MAX_MS = 5000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const st = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown })
      .setTimeout;
    st(resolve, ms);
  });

export interface ResendRequestOptions {
  /** Waits between 429 retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * One call to Resend's API: a timeout, no redirects followed, and a 429 (every client shares one
 * Resend team and its rate limit) retried a few times after Retry-After. Resend did nothing with a
 * request it answered 429, and a send carries its Idempotency-Key, so the retry is safe.
 */
export async function resendRequest(
  fetch: FetchLike,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  opts: ResendRequestOptions = {},
): Promise<unknown> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${RESEND_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: timeoutSignal(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
      const after = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(after) && after > 0
          ? after * 1000
          : (RATE_LIMIT_BACKOFF_MS[attempt] as number);
      if (wait <= RETRY_AFTER_MAX_MS) {
        await sleep(wait);
        continue;
      }
    }
    if (!res.ok) {
      const msg = (parsed as { message?: unknown } | null)?.message;
      throw new ResendError(res.status, `Resend answered ${res.status}: ${String(msg ?? "error")}`);
    }
    return parsed;
  }
}

// ── Provisioning (the operator, with Mezonas' key) ──────────────────────────────────────────────

export const ResendDnsRecord = z.object({
  record: z.string().default(""),
  name: z.string(),
  type: z.string(),
  value: z.string(),
  ttl: z.union([z.string(), z.number()]).nullable().optional(),
  priority: z.number().nullable().optional(),
  status: z.string().default("not_started"),
});
export const ResendDomain = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  records: z.array(ResendDnsRecord).default([]),
});
export type ResendDomain = z.infer<typeof ResendDomain>;

export async function createDomain(fetch: FetchLike, apiKey: string, name: string) {
  return ResendDomain.parse(await resendRequest(fetch, apiKey, "POST", "/domains", { name }));
}
export async function getDomain(fetch: FetchLike, apiKey: string, id: string) {
  return ResendDomain.parse(await resendRequest(fetch, apiKey, "GET", `/domains/${id}`));
}
export async function verifyDomain(fetch: FetchLike, apiKey: string, id: string) {
  await resendRequest(fetch, apiKey, "POST", `/domains/${id}/verify`);
}
/** A sending-only key for one domain: what a client's connection holds. */
export async function createSendingKey(
  fetch: FetchLike,
  apiKey: string,
  input: { name: string; domainId: string | null },
): Promise<string> {
  const r = z.object({ id: z.string(), token: z.string().min(8) }).parse(
    await resendRequest(fetch, apiKey, "POST", "/api-keys", {
      name: input.name,
      permission: "sending_access",
      ...(input.domainId ? { domain_id: input.domainId } : {}),
    }),
  );
  return r.token;
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────

/** What a send asks of the platform: consent and contact checks, and the thread record. */
export interface EmailSendCheck {
  ok: boolean;
  contact?: { id: string; name: string };
  message?: string;
}
/**
 * An email send that was started, recorded before the provider is called. Gmail takes no
 * idempotency key and `gmail.send` can't read the Sent folder, so a re-run that finds one of these
 * and no sent record stops for a person instead of sending again (gmail/index.ts).
 */
export interface EmailSendAttempt {
  idempotencyKey: string;
  connectionId: string;
  contactId: string;
  contactName: string;
  to: string;
  from: string;
  subject: string;
  startedAt: Date;
  /**
   * 1 for the first try. A try the provider refused (it answered, and sent nothing) may be
   * followed by the next under the same key; the newest one is what a re-run looks at.
   */
  attempt?: number;
  /** From `attemptFor`: the provider refused this try, so nothing was sent. */
  refused?: boolean;
}

/**
 * A send's HTTP answer that says the provider sent nothing: any 4xx but 408 and 409 (bad request,
 * the token refused, not allowed, too large, a rate limit). A 409 is a clash with another request
 * (Resend: one with the same Idempotency-Key still running), and a timeout or a 5xx after the
 * request left may have been sent.
 */
export function sendRefusedStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 409;
}

/** A short reason for a refused send's record: the HTTP status, or the error's kind. */
export function refusalReason(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return `HTTP_${status}`;
  return error instanceof Error ? error.name : "refused";
}

export interface EmailServices {
  /** The contact with this address, with email consent, not opted out. */
  checkSend(input: { to: string; now: Date }): Promise<EmailSendCheck>;
  /** Records that a send is starting, before the provider is called; the first per key stands. */
  startAttempt?(attempt: EmailSendAttempt): Promise<void>;
  /** The newest send started under this key, if any, with `attempt` and `refused`. */
  attemptFor?(idempotencyKey: string): Promise<EmailSendAttempt | null>;
  /**
   * Records that the provider refused try `attempt` (it answered and sent nothing), so a re-run
   * may try again instead of stopping for a person. Without it, every started try stands.
   */
  refuseAttempt?(input: {
    idempotencyKey: string;
    attempt: number;
    reason: string;
    at: Date;
  }): Promise<void>;
  /** The client's forwarding address, where replies come back; null when it has none. */
  replyAddress?(): Promise<string | null>;
  /** The email already sent under this key, if any (a re-run after a crash). */
  sentFor(idempotencyKey: string): Promise<z.infer<typeof EmailSendOutput> | null>;
  /** Stores the sent email once in the contact's thread. */
  recordOutbound(input: {
    connectionId: string;
    contactId: string;
    output: z.infer<typeof EmailSendOutput>;
    subject: string;
    text: string;
    idempotencyKey: string;
    sentAt: Date;
  }): Promise<void>;
}

export class EmailBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailBlockedError";
  }
}

function configOf(ctx: ToolContext): ResendConfig {
  const r = ResendConfig.safeParse(ctx.connection.config);
  if (!r.success) throw new ResendError(null, "the email connection isn't set up");
  return r.data;
}

/** `assistant@shop.com`, with the display name when there is one. */
export function fromAddress(config: ResendConfig): { address: string; header: string } {
  const address = `${config.localPart}@${config.sendingDomain}`;
  const name = config.fromName?.replace(/["<>]/g, "").trim();
  return { address, header: name ? `${name} <${address}>` : address };
}

/** An address with `+<tag>` before the @ (release emails to the client's own people). */
export function taggedReplyTo(replyTo: string | null, tag: string | undefined): string | null {
  if (!replyTo) return null;
  if (!tag) return replyTo;
  const at = replyTo.lastIndexOf("@");
  return `${replyTo.slice(0, at)}+${tag}${replyTo.slice(at)}`;
}

function emailServices(ctx: ToolContext): EmailServices {
  const s = ctx.services?.email;
  if (!s) throw new EmailBlockedError("email sends need the platform's contact checks");
  return s;
}

export interface ResendConnectorOptions {
  fetch?: FetchLike;
  /** Waits between 429 retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
}

export function createResendConnector(options: ResendConnectorOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  return defineConnector({
    id: RESEND_CONNECTOR_ID,
    // Connectors C2 (docs/connectors-plan.md §5.1): writes a new connection starts asking first.
    askFirst: [{ verb: "create", entity: "message" }],
    name: "Email sending",
    vendor: "Resend",
    description: "Email your contacts from an address on your domain, through Mezonas.",
    icon: "mail",
    auth: "api_key",
    entities: [],
    // v0.12 W2-A: record types for the matrix (docs/plan.md §1.44).
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    sharedNamespaces: [...EMAIL_NAMESPACES],
    tools: [
      defineWriteTool({
        id: EMAIL_SEND_TOOL,
        entity: "message",
        description:
          "Email a contact from the client's address. Only contacts who agreed to email; plain text.",
        verb: "create",
        // R5: a send can't be taken back.
        undo: { kind: "none" },
        summary: "Emailed {{contactName}}",
        recipient: { path: "to", channel: "email" },
        input: EmailSendInput,
        output: EmailSendOutput,
        beforeSchema: EmailSendBefore,
        async before(input, ctx) {
          const config = configOf(ctx);
          const check = await emailServices(ctx).checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          const attachments = await describeOutbound(
            ctx,
            input.attachments,
            RESEND_ATTACHMENT_LIMITS,
          );
          return {
            contact: check.contact,
            to: input.to,
            from: fromAddress(config).address,
            ...(attachments.length ? { attachments } : {}),
          };
        },
        async run(input, ctx) {
          const services = emailServices(ctx);
          // A re-run after a crash returns what was sent, before any check.
          const sent = await services.sentFor(ctx.idempotencyKey);
          if (sent) return sent;
          const check = await services.checkSend({ to: input.to, now: ctx.now() });
          if (!check.ok || !check.contact) {
            throw new EmailBlockedError(check.message ?? "this contact can't be emailed");
          }
          const config = configOf(ctx);
          // P-3: read from storage for this one send; refused before anything goes out.
          const files = await loadOutbound(ctx, input.attachments, RESEND_ATTACHMENT_LIMITS);
          const creds = ResendCredentials.parse(await requireCredentials(ctx.credentials));
          const from = fromAddress(config);
          // The reply address, never the forwarding address itself (upload/forwarding.ts).
          const replyTo = reachReplyTo(config.replyTo, input.replyTag);
          // Our own Message-ID, so a reply's In-Reply-To names this send (NOTES.md).
          const messageId = `<${ctx.idempotencyKey.replace(/[^A-Za-z0-9.-]/g, ".")}@${config.sendingDomain}>`;
          const res = z.object({ id: z.string() }).parse(
            await resendRequest(
              doFetch(),
              creds.apiKey,
              "POST",
              "/emails",
              {
                from: from.header,
                to: [input.to],
                subject: input.subject,
                text: input.text,
                ...(replyTo ? { reply_to: replyTo } : {}),
                headers: { "Message-ID": messageId },
                // P-3: base64 content with the record's name and type (NOTES.md: `content_type`).
                ...(files.length
                  ? {
                      attachments: files.map((f) => ({
                        filename: f.filename,
                        content: toBase64(f.bytes),
                        content_type: f.mimeType,
                      })),
                    }
                  : {}),
              },
              // DECISION: Resend's idempotency key is the external action's key, so a retried send
              // inside Resend's window is not sent twice (NOTES.md: the header's name and window).
              { "Idempotency-Key": ctx.idempotencyKey },
              options.sleep ? { sleep: options.sleep } : {},
            ),
          );
          const output = {
            id: res.id,
            to: input.to,
            from: from.address,
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
}
