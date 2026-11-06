// "ramp": Ramp, the corporate card and spend platform (ARCHITECTURE §6.11, order 3). The client's
// admin signs in to Ramp from the portal (OAuth, authorization code); tokens are encrypted on the
// connection. Reads: card transactions and users. One write: a stored document uploaded to a
// transaction as its receipt (`external`, behind approval, once per idempotency key). New
// transactions become `ramp.transaction.created` events through apps/api's poll every 15 minutes
// (`rampTransactionsSince`). No delete, no card or money movement. Unchecked facts: ./NOTES.md.

import { DecimalString, dec, type JsonObject, toNumeric } from "@countersign/core";
import { z } from "zod";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type ToolContext,
} from "../connector";
import { formEncode, type HttpResponseLike, parseUrl, timeoutSignal } from "../http";
import { runReadTool } from "../invoke";
import {
  OAuthTokens,
  ReconnectRequiredError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { sha256Bytes, toBase64, toHex, utf8 } from "../runtime";

export const RAMP_CONNECTOR_ID = "ramp";
export const RAMP_TOOLS = {
  transactions: "ramp.transaction.query",
  users: "ramp.user.query",
  receipt: "ramp.receipt.upload",
} as const;
export const RAMP_TRANSACTION_CREATED = "ramp.transaction.created";
/** The raw records the poll stores, one per transaction (version null: stored once). */
export const RAMP_TRANSACTION_ENTITY = "Transaction";

export const RAMP_AUTHORIZE_URL = "https://app.ramp.com/v1/authorize";
export const RAMP_API = "https://api.ramp.com";
const API_PATH = "/developer/v1";

// DECISION: the scopes the design's tools need and nothing more: read transactions and users,
// write receipts, and read the business (its id and name name the connection). No card, bill,
// reimbursement or transfer scope, so nothing here can move money or change a card.
export const RAMP_SCOPES: readonly string[] = [
  "transactions:read",
  "users:read",
  "receipts:write",
  "business:read",
];

/** Receipt files Ramp takes, as far as we know (NOTES.md). */
const RECEIPT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/heic"]);
const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;

/** fetch with a body that may be bytes (the receipt's multipart body). */
export interface RampRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}
export type RampFetch = (url: string, init?: RampRequestInit) => Promise<HttpResponseLike>;

function runtimeFetch(): RampFetch {
  const f = (globalThis as unknown as { fetch?: RampFetch }).fetch;
  if (!f) throw new Error("fetch is not available in this runtime");
  return (url, init) => f(url, init);
}

export const RampCredentials = OAuthTokens;
export type RampCredentials = z.infer<typeof RampCredentials>;

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export class RampApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 429 and 5xx: the step's retry with backoff may get through. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RampApiError";
  }
}

export class RampNotConfiguredError extends Error {
  constructor() {
    super("Ramp sign-in is not set up on this deployment (RAMP_CLIENT_ID, RAMP_CLIENT_SECRET)");
    this.name = "RampNotConfiguredError";
  }
}

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

/** Ramp's ids are UUID-shaped (NOTES.md); checked so nothing else reaches a URL path. */
const RampId = z.guid();

/**
 * A card transaction as tools return it. The merchant's name, the memo and the category are the
 * merchant's and the cardholder's words: data, never instructions (invariant 9).
 */
export const RampTransaction = z.object({
  id: z.string(),
  amount: z.object({ amount: DecimalString, currency: z.string() }),
  merchantName: z.string().nullable(),
  /** When the cardholder made the purchase (ISO). */
  transactionTime: z.string().nullable(),
  settlementDate: z.string().nullable(),
  state: z.string().nullable(),
  cardId: z.string().nullable(),
  cardholder: z
    .object({
      userId: z.string().nullable(),
      name: z.string().nullable(),
      department: z.string().nullable(),
    })
    .nullable(),
  memo: z.string().nullable(),
  category: z.string().nullable(),
  receiptIds: z.array(z.string()),
});
export type RampTransaction = z.infer<typeof RampTransaction>;

const RawTransaction = z.looseObject({
  id: z.string(),
  amount: z.union([z.number(), z.string()]),
  currency_code: z.string().nullable().optional(),
  merchant_name: z.string().nullable().optional(),
  user_transaction_time: z.string().nullable().optional(),
  settlement_date: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  card_id: z.string().nullable().optional(),
  card_holder: z
    .looseObject({
      user_id: z.string().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      department_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  memo: z.string().nullable().optional(),
  sk_category_name: z.string().nullable().optional(),
  receipts: z.array(z.string()).nullable().optional(),
});

/** Ramp's amounts are JSON numbers in the currency's major unit (NOTES.md): read as text, never as a float. */
function decimalAmount(v: number | string): string {
  return toNumeric(dec(String(v)));
}

/** Ramp's transaction JSON → RampTransaction. */
export function mapRampTransaction(raw: unknown): RampTransaction {
  const t = RawTransaction.parse(raw);
  const holder = t.card_holder;
  const name = holder
    ? [holder.first_name, holder.last_name].filter((p) => typeof p === "string" && p).join(" ")
    : "";
  return RampTransaction.parse({
    id: t.id,
    amount: { amount: decimalAmount(t.amount), currency: t.currency_code ?? "USD" },
    merchantName: t.merchant_name ?? null,
    transactionTime: t.user_transaction_time ?? null,
    settlementDate: t.settlement_date ?? null,
    state: t.state ?? null,
    cardId: t.card_id ?? null,
    cardholder: holder
      ? {
          userId: holder.user_id ?? null,
          name: name || null,
          department: holder.department_name ?? null,
        }
      : null,
    memo: t.memo ?? null,
    category: t.sk_category_name ?? null,
    receiptIds: t.receipts ?? [],
  });
}

export const RampUser = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string().nullable(),
  status: z.string().nullable(),
  departmentId: z.string().nullable(),
});
export type RampUser = z.infer<typeof RampUser>;

const RawUser = z.looseObject({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  department_id: z.string().nullable().optional(),
});

export function mapRampUser(raw: unknown): RampUser {
  const u = RawUser.parse(raw);
  return {
    id: u.id,
    firstName: u.first_name ?? null,
    lastName: u.last_name ?? null,
    email: u.email ?? null,
    role: u.role ?? null,
    status: u.status ?? null,
    departmentId: u.department_id ?? null,
  };
}

const Page = z.looseObject({
  data: z.array(z.unknown()),
  page: z.looseObject({ next: z.string().nullable().optional() }).nullable().optional(),
});

/**
 * The `start` cursor from Ramp's `page.next` link. The link is only read, never fetched, and only
 * when it is on Ramp's own API origin.
 */
export function rampNextCursor(
  next: string | null | undefined,
  apiOrigin = RAMP_API,
): string | null {
  if (!next) return null;
  const url = parseUrl(next);
  if (!url || url.origin !== apiOrigin) return null;
  const query = next.indexOf("?");
  if (query < 0) return null;
  for (const pair of next.slice(query + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === "start") {
      try {
        return decodeURIComponent(pair.slice(eq + 1)) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The payload of `ramp.transaction.created`. The merchant's text is data (invariant 9). */
export const RampTransactionCreatedPayload = z.strictObject({
  connectionId: z.uuid(),
  /** The raw record the transaction is stored as. */
  rawRecordId: z.uuid(),
  transaction: RampTransaction,
});
export type RampTransactionCreatedPayload = z.infer<typeof RampTransactionCreatedPayload>;

/** Ramp's idempotency key for a receipt (at most 64 characters, NOTES.md), from the action's key. */
export async function rampIdempotencyKey(idempotencyKey: string): Promise<string> {
  return `mezonas-${toHex(await sha256Bytes(utf8(`ramp:${idempotencyKey}`))).slice(0, 48)}`;
}

// ── The connector ────────────────────────────────────────────────────────────────────────────────

export interface RampOptions {
  /** The OAuth client of Mezonas' Ramp developer app. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: RampFetch;
}

export function createRampConnector(options: RampOptions = {}): Connector {
  const doFetch = (): RampFetch => options.fetch ?? runtimeFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function basicAuth(): string {
    if (!options.clientId || !options.clientSecret) throw new RampNotConfiguredError();
    return `Basic ${toBase64(utf8(`${options.clientId}:${options.clientSecret}`))}`;
  }

  async function readJson(res: HttpResponseLike): Promise<unknown> {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  function errorOf(status: number, body: unknown, what: string): RampApiError {
    const b = (body ?? {}) as {
      error?: unknown;
      error_v2?: { error_code?: unknown; message?: unknown };
      message?: unknown;
    };
    const code =
      typeof b.error_v2?.error_code === "string"
        ? b.error_v2.error_code
        : typeof b.error === "string"
          ? b.error
          : `HTTP_${status}`;
    const message =
      typeof b.error_v2?.message === "string"
        ? b.error_v2.message
        : typeof b.message === "string"
          ? b.message
          : `Ramp answered ${status} ${what}`;
    return new RampApiError(status, code, message, status === 429 || status >= 500);
  }

  async function tokenCall(
    fields: Record<string, string>,
  ): Promise<
    { ok: true; answer: z.infer<typeof TokenAnswer> } | { ok: false; status: number; error: string }
  > {
    const res = await doFetch()(`${RAMP_API}${API_PATH}/token`, {
      method: "POST",
      headers: {
        authorization: basicAuth(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const body = await readJson(res);
    if (!res.ok) {
      const e = (body ?? {}) as { error?: unknown };
      return {
        ok: false,
        status: res.status,
        error: typeof e.error === "string" ? e.error : `HTTP_${res.status}`,
      };
    }
    const parsed = TokenAnswer.safeParse(body);
    if (!parsed.success) {
      throw new RampApiError(
        res.status,
        "bad_token_response",
        "Ramp's token answer has an unexpected shape",
        false,
      );
    }
    return { ok: true, answer: parsed.data };
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const r = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
      if (!r.ok) {
        if (r.status === 400 || r.status === 401) {
          throw new ReconnectRequiredError(`Ramp refused the refresh: ${r.error}`);
        }
        throw new RampApiError(
          r.status,
          r.error,
          `Ramp's token endpoint answered ${r.status}`,
          r.status >= 500,
        );
      }
      return {
        ...tokens,
        accessToken: r.answer.access_token,
        expiresAt: expiresAt(now, r.answer.expires_in),
        ...(r.answer.refresh_token ? { refreshToken: r.answer.refresh_token } : {}),
        ...(r.answer.scope ? { scope: r.answer.scope } : {}),
      };
    },
  };

  async function api(
    ctx: ToolContext,
    method: "GET" | "POST",
    path: string,
    body?: { type: string; data: string | Uint8Array },
  ): Promise<unknown> {
    const stored = RampCredentials.safeParse(await ctx.credentials.get());
    if (!stored.success)
      throw new ReconnectRequiredError("the Ramp connection has no valid credentials");
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      (token) =>
        doFetch()(`${RAMP_API}${API_PATH}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body ? { "content-type": body.type } : {}),
          },
          ...(body ? { body: body.data } : {}),
          redirect: "manual",
          signal: timeoutSignal(30_000),
        }),
      (r) => r.status === 401,
    );
    const json = await readJson(res);
    if (res.status === 401) throw new ReconnectRequiredError("Ramp refused the access token");
    if (!res.ok) throw errorOf(res.status, json, `for ${path.split("?")[0]}`);
    return json;
  }

  async function getTransaction(ctx: ToolContext, id: string): Promise<RampTransaction | null> {
    try {
      return mapRampTransaction(await api(ctx, "GET", `/transactions/${encodeURIComponent(id)}`));
    } catch (error) {
      if (error instanceof RampApiError && error.status === 404) return null;
      throw error;
    }
  }

  const DateOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

  return defineConnector({
    id: RAMP_CONNECTOR_ID,
    name: "Ramp",
    description:
      "Card transactions, receipts and people in your Ramp. You sign in to Ramp yourself.",
    icon: "card",
    auth: "oauth2",
    entities: ["Transaction", "User", "Receipt"],
    // v0.12 W3-B: record types for the matrix (docs/plan.md §1.44, §1.52).
    permissionEntities: [
      { id: "transaction", label: "Transactions", verbs: ["read"] },
      { id: "user", label: "People", verbs: ["read"] },
      { id: "receipt", label: "Receipts", verbs: ["create"] },
    ],
    events: [
      {
        type: RAMP_TRANSACTION_CREATED,
        description: "A new card transaction appeared in Ramp (checked every 15 minutes).",
        subjectType: "raw_record",
        payload: z.toJSONSchema(RampTransactionCreatedPayload, { io: "input" }) as Record<
          string,
          unknown
        >,
        sample: {
          connectionId: "0192f7a0-0000-7000-8000-000000000001",
          rawRecordId: "0192f7a0-0000-7000-8000-000000000003",
          transaction: {
            id: "6f1c2d1e-8b3a-4c6f-9a51-2f0c7d9e1a01",
            amount: { amount: "412.5000", currency: "USD" },
            merchantName: "Rockler Woodworking",
            transactionTime: "2026-11-05T17:12:00+00:00",
            settlementDate: null,
            state: "PENDING",
            cardId: "1a7b3c55-0e2d-4f19-8b6a-3c2d1e0f9a77",
            cardholder: {
              userId: "9e8d7c6b-5a49-4f3e-8d2c-1b0a9f8e7d6c",
              name: "Pat Lee",
              department: "Shop",
            },
            memo: null,
            category: "Supplies",
            receiptIds: [],
          },
        },
      },
    ],
    isConfigured: () => configured,

    async authorize(req) {
      if (!options.clientId || !options.clientSecret) throw new RampNotConfiguredError();
      const query = formEncode({
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: req.redirectUri,
        scope: RAMP_SCOPES.join(" "),
        state: req.state,
      });
      return { redirectUrl: `${RAMP_AUTHORIZE_URL}?${query}` };
    },

    async handleCallback(params, req) {
      if (!params.code) throw new Error("the Ramp callback has no code");
      const r = await tokenCall({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: req.redirectUri,
      });
      if (!r.ok) throw new Error(`Ramp refused the sign-in: ${r.error}`);
      const now = new Date();
      const credentials = RampCredentials.parse({
        accessToken: r.answer.access_token,
        // UNCHECKED: whether Ramp always gives a refresh token (NOTES.md). Without one the client
        // signs in again when the access token expires.
        ...(r.answer.refresh_token ? { refreshToken: r.answer.refresh_token } : {}),
        expiresAt: expiresAt(now, r.answer.expires_in),
        tokenType: r.answer.token_type ?? "Bearer",
        ...(r.answer.scope ? { scope: r.answer.scope } : {}),
      });
      // The business names the connection (which Ramp it is); a failure here fails the sign-in.
      const res = await doFetch()(`${RAMP_API}${API_PATH}/business`, {
        headers: { authorization: `Bearer ${r.answer.access_token}`, accept: "application/json" },
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      const business = z
        .looseObject({
          id: z.string().min(1),
          business_name_legal: z.string().nullable().optional(),
          business_name_on_card: z.string().nullable().optional(),
        })
        .safeParse(await readJson(res));
      if (!res.ok || !business.success) throw new Error("could not read the Ramp business");
      const name = business.data.business_name_legal ?? business.data.business_name_on_card;
      return {
        externalAccountId: business.data.id,
        credentials: credentials as unknown as JsonObject,
        config: name ? { businessName: name } : {},
      };
    },

    tokens: refresher,

    async revoke(ctx: ConnectionContext) {
      const creds = RampCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success) return;
      await doFetch()(`${RAMP_API}${API_PATH}/token/revoke`, {
        method: "POST",
        headers: {
          authorization: basicAuth(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: formEncode({ token: creds.data.refreshToken ?? creds.data.accessToken }),
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
    },

    tools: [
      defineReadTool({
        id: RAMP_TOOLS.transactions,
        entity: "transaction",
        description:
          "Find Ramp card transactions by date, cardholder, card or state, newest first, a page at a time.",
        summary: "Found {{transactions.length}} transactions",
        input: z.object({
          /** On or after (the purchase's time). */
          fromDate: DateOrTime.optional(),
          /** Before. */
          toDate: DateOrTime.optional(),
          userId: RampId.optional(),
          cardId: RampId.optional(),
          state: z.enum(["PENDING", "CLEARED", "DECLINED", "ERROR", "COMPLETION"]).optional(),
          /** Only those with no receipt yet. */
          missingReceipt: z.boolean().optional(),
          pageSize: z.number().int().min(2).max(100).default(50),
          /** The `next` of the page before. */
          start: z.string().min(1).max(200).optional(),
        }),
        output: z.object({ transactions: z.array(RampTransaction), next: z.string().nullable() }),
        async run(input, ctx) {
          const q: Record<string, string> = { page_size: String(input.pageSize) };
          if (input.fromDate) q.from_date = input.fromDate;
          if (input.toDate) q.to_date = input.toDate;
          if (input.userId) q.user_id = input.userId;
          if (input.cardId) q.card_id = input.cardId;
          if (input.state) q.state = input.state;
          if (input.start) q.start = input.start;
          const page = Page.parse(await api(ctx, "GET", `/transactions?${formEncode(q)}`));
          const transactions = page.data.map(mapRampTransaction);
          return {
            // DECISION: "missing a receipt" is filtered here, on the page Ramp gave, rather than
            // trusting a query parameter we could not check (NOTES.md).
            transactions: input.missingReceipt
              ? transactions.filter((t) => t.receiptIds.length === 0)
              : transactions,
            next: rampNextCursor(page.page?.next),
          };
        },
      }),
      defineReadTool({
        id: RAMP_TOOLS.users,
        entity: "user",
        description: "Find the people in the client's Ramp (cardholders, admins), by email or all.",
        summary: "Found {{users.length}} people",
        input: z.object({
          email: z.string().min(3).max(200).optional(),
          departmentId: RampId.optional(),
          pageSize: z.number().int().min(2).max(100).default(50),
          start: z.string().min(1).max(200).optional(),
        }),
        output: z.object({ users: z.array(RampUser), next: z.string().nullable() }),
        async run(input, ctx) {
          const q: Record<string, string> = { page_size: String(input.pageSize) };
          if (input.email) q.email = input.email;
          if (input.departmentId) q.department_id = input.departmentId;
          if (input.start) q.start = input.start;
          const page = Page.parse(await api(ctx, "GET", `/users?${formEncode(q)}`));
          return { users: page.data.map(mapRampUser), next: rampNextCursor(page.page?.next) };
        },
      }),
      defineWriteTool({
        id: RAMP_TOOLS.receipt,
        entity: "receipt",
        description:
          "Upload a stored document (the receipt or invoice) to a Ramp card transaction as its receipt.",
        verb: "create",
        summary: "Added the receipt {{fileName}} to the transaction",
        input: z.object({ transactionId: RampId, documentId: z.uuid() }),
        output: z.object({
          receiptId: z.string(),
          transactionId: z.string(),
          fileName: z.string(),
        }),
        // What the approver sees: the transaction, the receipts it has now and the file it gets.
        beforeSchema: z.object({
          transactionId: z.string(),
          merchantName: z.string().nullable(),
          amount: z.object({ amount: DecimalString, currency: z.string() }),
          transactionTime: z.string().nullable(),
          cardholder: z.string().nullable(),
          receiptIds: z.array(z.string()),
          adding: z
            .object({ fileName: z.string(), size: z.number().int(), contentType: z.string() })
            .nullable(),
        }),
        async before(input, ctx) {
          const t = await getTransaction(ctx, input.transactionId);
          if (!t) return null;
          const file = await ctx.services?.documents?.read(input.documentId);
          return {
            transactionId: t.id,
            merchantName: t.merchantName,
            amount: t.amount,
            transactionTime: t.transactionTime,
            cardholder: t.cardholder?.name ?? null,
            receiptIds: t.receiptIds,
            adding: file
              ? { fileName: file.filename, size: file.bytes.length, contentType: file.mimeType }
              : null,
          };
        },
        async run(input, ctx, before) {
          const docs = ctx.services?.documents;
          if (!docs) throw new Error("documents are not available to this call");
          if (!before) {
            throw new RampApiError(
              404,
              "NOT_FOUND",
              `transaction ${input.transactionId} not found`,
              false,
            );
          }
          const file = await docs.read(input.documentId);
          if (!file)
            throw new RampApiError(404, "NOT_FOUND", "that document is not this client's", false);
          if (!RECEIPT_TYPES.has(file.mimeType)) {
            throw new RampApiError(
              415,
              "UNSUPPORTED_TYPE",
              `Ramp can't take a ${file.mimeType} as a receipt`,
              false,
            );
          }
          if (file.bytes.length > RECEIPT_MAX_BYTES) {
            throw new RampApiError(
              413,
              "TOO_LARGE",
              "the receipt is larger than Ramp takes",
              false,
            );
          }
          const t = await getTransaction(ctx, input.transactionId);
          const userId = t?.cardholder?.userId;
          if (!t || !userId) {
            throw new RampApiError(
              422,
              "NO_CARDHOLDER",
              "the transaction has no cardholder to file the receipt under",
              false,
            );
          }
          // DECISION: Ramp's receipt upload takes an idempotency key; ours comes from the external
          // action's, so a retry after a lost answer gets the first receipt back, not a second one.
          const key = await rampIdempotencyKey(ctx.idempotencyKey);
          const boundary = `mezonas-${key.slice(8, 40)}`;
          const field = (name: string, value: string) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
          const head = utf8(
            field("idempotency_key", key) +
              field("transaction_id", t.id) +
              field("user_id", userId) +
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="receipt"; filename="${file.filename.replace(/["\r\n\\]/g, "_")}"\r\n` +
              `Content-Type: ${file.mimeType}\r\n\r\n`,
          );
          const tail = utf8(`\r\n--${boundary}--\r\n`);
          const data = new Uint8Array(head.length + file.bytes.length + tail.length);
          data.set(head, 0);
          data.set(file.bytes, head.length);
          data.set(tail, head.length + file.bytes.length);
          ctx.logger.info("uploading ramp receipt", { transactionId: t.id });
          const out = z.looseObject({ id: z.string().min(1) }).parse(
            await api(ctx, "POST", "/receipts", {
              type: `multipart/form-data; boundary=${boundary}`,
              data,
            }),
          );
          return { receiptId: out.id, transactionId: t.id, fileName: file.filename };
        },
      }),
    ],
  });
}

/**
 * The transactions made since `since`, oldest pages last, read through `ramp.transaction.query`
 * (so the connection's matrix applies: read off refuses). At most `maxPages` pages; `more` says
 * whether Ramp had another.
 */
export async function rampTransactionsSince(
  connector: Connector,
  ctx: ToolContext,
  since: Date,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<{ transactions: RampTransaction[]; more: boolean }> {
  const out: RampTransaction[] = [];
  let start: string | null = null;
  const maxPages = options.maxPages ?? 10;
  for (let i = 0; i < maxPages; i++) {
    const page = (
      await runReadTool(
        connector,
        RAMP_TOOLS.transactions,
        {
          fromDate: since.toISOString(),
          pageSize: options.pageSize ?? 100,
          ...(start ? { start } : {}),
        },
        ctx,
      )
    ).output as { transactions: RampTransaction[]; next: string | null };
    out.push(...page.transactions);
    start = page.next;
    if (!start) return { transactions: out, more: false };
  }
  return { transactions: out, more: true };
}
