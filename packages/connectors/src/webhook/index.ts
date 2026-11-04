import { type JsonObject, uuidv7 } from "@countersign/core";
import { z } from "zod";
import { type Connector, defineConnector, defineWriteTool } from "../connector";
import {
  checkPublicHttpsUrl,
  constantTimeEqual,
  type FetchLike,
  formDecode,
  globalFetch,
  hmacSha256Hex,
  timeoutSignal,
} from "../http";
import { fromUtf8, randomBytes, sha256Bytes, toBase64Url, toHex } from "../runtime";

/**
 * "webhook": generic webhooks in and out, for Zapier, Make, n8n or anything that can POST
 * (ARCHITECTURE §6.6, owner 2026-11-04).
 *
 * - In: the client creates hooks on its connection in the portal. Each has a public id (kept in
 *   `connection.config.hooks`, so the operator can see hook names and filter triggers on them)
 *   and a secret token (kept in the encrypted credentials, shown only in the client's portal).
 *   apps/api's `POST /api/hooks/:clientId/:hookId` checks a delivery with `verifyDelivery`, parses
 *   it with `parseDelivery`, stores it as a raw record and emits `webhook.received`.
 * - Out: `webhook.event.send` POSTs JSON to the outbound URL the client pasted (also in the
 *   encrypted credentials), once per external action, with an Idempotency-Key and a signature.
 */
export const WEBHOOK_CONNECTOR_ID = "webhook";
export const WEBHOOK_SEND_TOOL = "webhook.event.send";
export const WEBHOOK_RECEIVED_EVENT = "webhook.received";
export const WEBHOOK_DELIVERY_ENTITY = "Delivery";

// DECISION: limits for inbound hooks: 64 KB a delivery, 60 deliveries a minute per hook, a five
// minute window for signed deliveries, at most 20 hooks per connection. Zap payloads are small;
// anything bigger belongs in a document upload.
export const MAX_DELIVERY_BYTES = 64 * 1024;
export const DELIVERIES_PER_MINUTE = 60;
export const SIGNATURE_WINDOW_S = 5 * 60;
export const MAX_HOOKS = 20;
const OUTBOUND_TIMEOUT_MS = 10_000;
const RESPONSE_KEEP_CHARS = 2048;

export const TOKEN_HEADER = "x-mezonas-token";
export const SIGNATURE_HEADER = "x-mezonas-signature";
export const TIMESTAMP_HEADER = "x-mezonas-timestamp";

// ── What is stored ───────────────────────────────────────────────────────────────────────────────

const HookName = z.string().trim().min(1).max(80);

/** One inbound hook as `connection.config` keeps it: no secret. */
export const WebhookHook = z.object({
  id: z.uuid(),
  name: HookName,
  createdAt: z.iso.datetime({ offset: true }),
});
export type WebhookHook = z.infer<typeof WebhookHook>;

/** `connection.config` of a webhook connection: visible to the operator, so never a secret. */
export const WebhookConfig = z.looseObject({
  hooks: z.array(WebhookHook).default([]),
  /** Where outbound events go, as the host only (the URL itself is a secret). */
  outbound: z
    .object({ host: z.string(), setAt: z.iso.datetime({ offset: true }) })
    .nullable()
    .default(null),
});
export type WebhookConfig = z.infer<typeof WebhookConfig>;

/** The encrypted credentials: hook tokens and the outbound URL with its signing secret. */
export const WebhookCredentials = z.looseObject({
  tokens: z.record(z.string(), z.string().min(32)).default({}),
  outbound: z
    .object({ url: z.string(), signingSecret: z.string().min(32) })
    .nullable()
    .default(null),
});
export type WebhookCredentials = z.infer<typeof WebhookCredentials>;

export function readWebhookConfig(config: unknown): WebhookConfig {
  const r = WebhookConfig.safeParse(config ?? {});
  return r.success ? r.data : { hooks: [], outbound: null };
}

export function readWebhookCredentials(credentials: unknown): WebhookCredentials {
  const r = WebhookCredentials.safeParse(credentials ?? {});
  return r.success ? r.data : { tokens: {}, outbound: null };
}

/** A fresh secret: 32 random bytes, base64url (43 characters). */
export function newSecret(): string {
  return toBase64Url(randomBytes(32));
}

/** Adds a hook: its config entry (public) and its token (secret). */
export function addHook(
  state: { config: WebhookConfig; credentials: WebhookCredentials },
  name: string,
  now: Date,
): { config: WebhookConfig; credentials: WebhookCredentials; hook: WebhookHook; token: string } {
  if (state.config.hooks.length >= MAX_HOOKS) {
    throw new WebhookSetupError("too_many_hooks", `a connection has at most ${MAX_HOOKS} hooks`);
  }
  const hook: WebhookHook = {
    id: uuidv7(now.getTime()),
    name: HookName.parse(name),
    createdAt: now.toISOString(),
  };
  const token = newSecret();
  return {
    hook,
    token,
    config: { ...state.config, hooks: [...state.config.hooks, hook] },
    credentials: {
      ...state.credentials,
      tokens: { ...state.credentials.tokens, [hook.id]: token },
    },
  };
}

/** Removes a hook: deliveries to it are refused from now on. */
export function removeHook(
  state: { config: WebhookConfig; credentials: WebhookCredentials },
  hookId: string,
): { config: WebhookConfig; credentials: WebhookCredentials; removed: WebhookHook | null } {
  const removed = state.config.hooks.find((h) => h.id === hookId) ?? null;
  const tokens = { ...state.credentials.tokens };
  delete tokens[hookId];
  return {
    removed,
    config: { ...state.config, hooks: state.config.hooks.filter((h) => h.id !== hookId) },
    credentials: { ...state.credentials, tokens },
  };
}

export class WebhookSetupError extends Error {
  constructor(
    readonly code: "too_many_hooks" | "invalid_url" | "no_outbound",
    message: string,
  ) {
    super(message);
    this.name = "WebhookSetupError";
  }
}

/**
 * Sets (or clears, with null) the outbound URL. Only https URLs to public hosts; a new signing
 * secret is made whenever the URL changes, so a leaked old one stops working.
 */
export function setOutbound(
  state: { config: WebhookConfig; credentials: WebhookCredentials },
  url: string | null,
  now: Date,
): { config: WebhookConfig; credentials: WebhookCredentials } {
  if (url === null) {
    return {
      config: { ...state.config, outbound: null },
      credentials: { ...state.credentials, outbound: null },
    };
  }
  const checked = checkPublicHttpsUrl(url.trim());
  if (!checked.ok) {
    const why = {
      invalid: "that is not a URL",
      not_https: "only https URLs are allowed",
      credentials: "the URL may not carry a user name or password",
      private_host: "the URL must point at a public host",
    }[checked.reason];
    throw new WebhookSetupError("invalid_url", why);
  }
  const href = checked.url.href;
  const same = state.credentials.outbound?.url === href;
  return {
    config: { ...state.config, outbound: { host: checked.url.host, setAt: now.toISOString() } },
    credentials: {
      ...state.credentials,
      outbound: {
        url: href,
        signingSecret:
          same && state.credentials.outbound
            ? state.credentials.outbound.signingSecret
            : newSecret(),
      },
    },
  };
}

/** The URL a client pastes into its Zap: the hook's endpoint with its token. */
export function hookUrl(origin: string, tenantId: string, hookId: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/api/hooks/${tenantId}/${hookId}?token=${encodeURIComponent(token)}`;
}

// ── Receiving ────────────────────────────────────────────────────────────────────────────────────

export type DeliveryRefusal =
  | { ok: false; status: 401; code: "unauthorized"; message: string }
  | { ok: false; status: 400; code: "invalid_body"; message: string }
  | { ok: false; status: 413; code: "too_large"; message: string }
  | { ok: false; status: 415; code: "unsupported_type"; message: string };

/**
 * Checks a delivery's secret: the hook's token (query `token` or the token header), or an
 * HMAC-SHA256 signature `sha256=<hex>` of `<timestamp>.<body>` under the token, with the timestamp
 * (unix seconds) within five minutes. Every comparison is constant-time. Senders that can't sign
 * (a plain Zap) use the token; signing also stops a captured delivery being replayed later.
 */
export async function verifyDelivery(input: {
  token: string | undefined;
  headers: Record<string, string | undefined>;
  queryToken: string | undefined;
  body: string;
  now: Date;
}): Promise<{ ok: true; signed: boolean } | DeliveryRefusal> {
  const refuse: DeliveryRefusal = {
    ok: false,
    status: 401,
    code: "unauthorized",
    message: "unknown hook or wrong token",
  };
  const { token } = input;
  if (!token) return refuse;
  const signature = input.headers[SIGNATURE_HEADER];
  if (signature !== undefined) {
    const ts = input.headers[TIMESTAMP_HEADER];
    if (!ts || !/^\d{1,12}$/.test(ts)) return refuse;
    if (Math.abs(input.now.getTime() / 1000 - Number(ts)) > SIGNATURE_WINDOW_S) {
      return { ...refuse, message: "the signature's timestamp is too old or in the future" };
    }
    const expected = `sha256=${await hmacSha256Hex(token, `${ts}.${input.body}`)}`;
    return constantTimeEqual(signature.trim().toLowerCase(), expected)
      ? { ok: true, signed: true }
      : refuse;
  }
  const given = input.headers[TOKEN_HEADER] ?? input.queryToken;
  if (given === undefined) return refuse;
  return constantTimeEqual(given, token) ? { ok: true, signed: false } : refuse;
}

/** A delivery's body as data: a JSON object (an array or value is wrapped) or a form. */
export function parseDelivery(
  contentType: string | undefined,
  body: string,
): { ok: true; format: "json" | "form"; data: JsonObject } | DeliveryRefusal {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    type === "application/json" ||
    type.endsWith("+json") ||
    (type === "" && body.trim().startsWith("{"))
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, code: "invalid_body", message: "the body is not JSON" };
    }
    const data =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : ({ value: parsed } as JsonObject);
    return { ok: true, format: "json", data };
  }
  if (type === "application/x-www-form-urlencoded") {
    try {
      return { ok: true, format: "form", data: formDecode(body) };
    } catch {
      return { ok: false, status: 400, code: "invalid_body", message: "the form is malformed" };
    }
  }
  return {
    ok: false,
    status: 415,
    code: "unsupported_type",
    message: "send JSON (application/json) or a form (application/x-www-form-urlencoded)",
  };
}

/** Bytes to UTF-8 text, refusing anything over the size limit or not UTF-8. */
export function deliveryText(bytes: Uint8Array): { ok: true; text: string } | DeliveryRefusal {
  if (bytes.length > MAX_DELIVERY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "too_large",
      message: `a delivery is at most ${MAX_DELIVERY_BYTES / 1024} KB`,
    };
  }
  try {
    return { ok: true, text: fromUtf8(bytes) };
  } catch {
    return { ok: false, status: 400, code: "invalid_body", message: "the body is not UTF-8" };
  }
}

/**
 * The key a delivery is stored once under: the sender's `Idempotency-Key` (or `X-Idempotency-Key`)
 * when it gives one, else the sha256 of the body.
 */
// DECISION: without a key, two identical bodies to the same hook count as one delivery sent twice
// (Zapier retries resend the same body). Senders that mean two events send two bodies, which in
// practice differ (ids, timestamps), or an Idempotency-Key.
// DECISION: a signed delivery's key is its signature, never the unsigned Idempotency-Key header:
// otherwise a captured delivery could be replayed inside the signature's window with a new key and
// start its workflows again (security review, 2026-11-04). The signature covers the timestamp and
// the body, so a real retry carries the same one.
export async function deliveryKey(
  headers: Record<string, string | undefined>,
  body: Uint8Array,
  options: { signed?: boolean } = {},
): Promise<string> {
  const signature = headers[SIGNATURE_HEADER]?.trim().toLowerCase();
  if (options.signed && signature) return `sig:${signature.replace(/^sha256=/, "")}`;
  const given = (headers["idempotency-key"] ?? headers["x-idempotency-key"])?.trim();
  if (given && given.length <= 200 && /^[\x21-\x7e]+$/.test(given)) return `key:${given}`;
  return `sha256:${toHex(await sha256Bytes(body))}`;
}

/** The payload of `webhook.received`. The data is the sender's: untrusted (invariant 9). */
export const WebhookReceivedPayload = z.strictObject({
  connectionId: z.uuid(),
  hookId: z.uuid(),
  hookName: z.string(),
  /** The raw record the delivery is stored as. */
  rawRecordId: z.uuid(),
  format: z.enum(["json", "form"]),
  signed: z.boolean(),
  receivedAt: z.iso.datetime({ offset: true }),
  /** The body: a JSON object, or a form's fields. */
  data: z.record(z.string(), z.unknown()),
});
export type WebhookReceivedPayload = z.infer<typeof WebhookReceivedPayload>;

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────

const SendInput = z.object({
  /** What happened, for the receiving Zap to branch on, e.g. `invoice.flagged`. */
  event: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "letters, digits and . _ : -")
    .max(100),
  /** The fields to send. */
  data: z.record(z.string(), z.unknown()).default({}),
});
const SendOutput = z.object({
  host: z.string(),
  status: z.number().int(),
  /** The first 2 KB of the receiver's answer: its text, never instructions. */
  response: z.string(),
});

export class WebhookDeliveryError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "WebhookDeliveryError";
  }
}

export interface WebhookConnectorOptions {
  fetch?: FetchLike;
}

/** The webhook connector. `fetch` is injected (tests answer from fixtures). */
export function createWebhookConnector(options: WebhookConnectorOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  return defineConnector({
    id: WEBHOOK_CONNECTOR_ID,
    name: "Webhooks",
    description: "Send events to Zapier, Make or n8n, and start work from the events they send.",
    icon: "webhook",
    auth: "none",
    entities: [WEBHOOK_DELIVERY_ENTITY],
    events: [
      {
        type: WEBHOOK_RECEIVED_EVENT,
        description: "A Zap (or another tool) sent data to one of your hooks.",
        subjectType: "raw_record",
        payload: z.toJSONSchema(WebhookReceivedPayload, { io: "input" }) as Record<string, unknown>,
        sample: {
          connectionId: "0192f7a0-0000-7000-8000-000000000001",
          hookId: "0192f7a0-0000-7000-8000-000000000002",
          hookName: "New form entries",
          rawRecordId: "0192f7a0-0000-7000-8000-000000000003",
          format: "json",
          signed: false,
          receivedAt: "2026-11-04T15:00:00.000Z",
          data: { email: "pat@example.com", name: "Pat Lee", source: "website form" },
        },
      },
    ],
    tools: [
      defineWriteTool({
        id: WEBHOOK_SEND_TOOL,
        description:
          "Send an event with data to the client's outbound webhook (e.g. their Zap's catch hook).",
        verb: "create",
        summary: "Sent the event to {{host}}",
        input: SendInput,
        output: SendOutput,
        beforeSchema: z.object({}),
        // A new event: nothing there before it.
        async before() {
          return null;
        },
        async run(input, ctx) {
          const creds = readWebhookCredentials(await ctx.credentials.get());
          if (!creds.outbound) {
            throw new WebhookSetupError("no_outbound", "no outbound URL is set on this connection");
          }
          // Checked again at send time: a URL stored before a rule change is not trusted.
          const checked = checkPublicHttpsUrl(creds.outbound.url);
          if (!checked.ok)
            throw new WebhookSetupError("invalid_url", "the outbound URL is not allowed");
          const body = JSON.stringify({
            id: ctx.idempotencyKey,
            event: input.event,
            data: input.data,
            sentAt: ctx.now().toISOString(),
            source: "mezonas",
          });
          const ts = String(Math.floor(ctx.now().getTime() / 1000));
          const signature = await hmacSha256Hex(creds.outbound.signingSecret, `${ts}.${body}`);
          ctx.logger.info("sending webhook", { host: checked.url.host });
          let res: Awaited<ReturnType<FetchLike>>;
          try {
            res = await doFetch()(checked.url.href, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "user-agent": "Mezonas-Webhooks/1",
                "idempotency-key": ctx.idempotencyKey,
                [TIMESTAMP_HEADER]: ts,
                [SIGNATURE_HEADER]: `sha256=${signature}`,
              },
              body,
              // Never follow a redirect: it could point anywhere, including inside a network.
              redirect: "manual",
              signal: timeoutSignal(OUTBOUND_TIMEOUT_MS),
            });
          } catch (error) {
            throw new WebhookDeliveryError(
              null,
              `could not reach ${checked.url.host}: ${(error as Error).message}`,
            );
          }
          const text = (await res.text().catch(() => "")).slice(0, RESPONSE_KEEP_CHARS);
          if (!res.ok || res.status >= 300) {
            throw new WebhookDeliveryError(
              res.status,
              `${checked.url.host} answered ${res.status}`,
            );
          }
          return { host: checked.url.host, status: res.status, response: text };
        },
      }),
    ],
  });
}
