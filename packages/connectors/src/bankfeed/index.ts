// "bankfeed": bank and card feeds through Plaid (ARCHITECTURE §6.11, order 5; the owner chose
// Plaid on 2026-11-06, docs/plan.md §1.52). The client admin connects their own bank or card in
// Plaid Link, opened from the portal (the operator never sees a login); the server exchanges Link's
// public token for an access token, kept encrypted with the client's own key on the connection and
// never shown, logged or given to a model. Reads only: transactions and accounts. Only Plaid's
// `transactions` product is ever requested, so nothing here can move money (no auth, transfer or
// payment products); an item that carries one is refused at sign-in. New transactions arrive
// through `/transactions/sync` (apps/api/src/bankfeed/sync.ts: Plaid's webhook, the cron as a
// backstop) and become `card.charge.created` or `bank.transaction.created`. Agents never sign in
// to a bank's website (§6.10). Unchecked facts about Plaid: ./NOTES.md.

import { DecimalString, dec, type JsonObject, toNumeric } from "@countersign/core";
import { z } from "zod";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineReadTool,
  type LinkRequest,
} from "../connector";
import { type FetchLike, globalFetch, type HttpResponseLike, timeoutSignal } from "../http";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionLevel } from "../permissions";
import { sha256Bytes, toHex, utf8 } from "../runtime";
import {
  PLAID_VERIFICATION_HEADER,
  PlaidKeyCache,
  PlaidVerificationKey,
  verifyPlaidWebhook,
} from "./webhook";

export * from "./webhook";

export const BANKFEED_CONNECTOR_ID = "bankfeed";
export const BANKFEED_TOOLS = {
  transactions: "bankfeed.transaction.query",
  accounts: "bankfeed.account.query",
} as const;
/** A new transaction on a credit account (a card). */
export const CARD_CHARGE_CREATED = "card.charge.created";
/** A new transaction on a depository account (checking, savings). */
export const BANK_TRANSACTION_CREATED = "bank.transaction.created";
/** The raw records sync stores, one per version of a transaction. */
export const BANKFEED_TRANSACTION_ENTITY = "Transaction";

export const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
} as const;
export type PlaidEnvironment = keyof typeof PLAID_HOSTS;
/** Plaid Link's script, loaded by the portal (apps/web/public/_headers allows it). */
export const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
/** The API version every request names (Plaid-Version). */
export const PLAID_API_VERSION = "2020-09-14";

// DECISION: the only Plaid product requested is `transactions` (read-only). No `auth` (account and
// routing numbers), `transfer`, `payment_initiation` or `signal`: nothing reached through this
// connector can move money, and an item that somehow carries one of them is removed and refused.
export const PLAID_PRODUCTS: readonly string[] = ["transactions"];
const MONEY_MOVEMENT_PRODUCTS = new Set(["auth", "transfer", "payment_initiation", "signal"]);

// DECISION: 90 days of history at connection (Plaid's default, stated so it can't drift); the
// first sync stores it and announces none of it.
export const PLAID_DAYS_REQUESTED = 90;

/** PLAID_ENV, read leniently: anything but `production` is the sandbox. */
export function plaidEnvironment(raw: string | null | undefined): PlaidEnvironment {
  return raw?.trim().toLowerCase() === "production" ? "production" : "sandbox";
}

// DECISION: Link's language is Spanish for a Spanish-speaking reader and English otherwise; the
// portal's other languages wait until we confirm Plaid supports them for US institutions (NOTES).
export function plaidLanguage(locale: string | undefined): "en" | "es" {
  return locale?.toLowerCase().startsWith("es") ? "es" : "en";
}

/**
 * Plaid's `client_user_id` for a client: opaque and stable, never an email or a name.
 */
// DECISION: one per client (the business is Plaid's "end user"), a SHA-256 of the client id under
// a fixed label, so Plaid learns nothing about who the client is or how we name it.
export async function plaidClientUserId(tenantId: string): Promise<string> {
  return toHex(await sha256Bytes(utf8(`mezonas/bankfeed/user:${tenantId}`))).slice(0, 40);
}

/** What the connection keeps, encrypted with the client's key. Never in a response or a log. */
export const BankfeedCredentials = z.object({
  accessToken: z.string().min(1).max(500),
  itemId: z.string().min(1).max(200),
});
export type BankfeedCredentials = z.infer<typeof BankfeedCredentials>;

export class PlaidApiError extends Error {
  constructor(
    readonly status: number,
    /** Plaid's `error_code` (e.g. ITEM_LOGIN_REQUIRED), or HTTP_<status>. */
    readonly code: string,
    readonly errorType: string | null,
    /** 429 and 5xx: a later try may get through. */
    readonly retryable: boolean,
  ) {
    // Plaid's own error_message is left out: only its code, so nothing a request carried can echo.
    super(`Plaid answered ${status} ${code}`);
    this.name = "PlaidApiError";
  }
}

export class PlaidNotConfiguredError extends Error {
  constructor() {
    super("bank and card feeds are not set up on this deployment (PLAID_CLIENT_ID, PLAID_SECRET)");
    this.name = "PlaidNotConfiguredError";
  }
}

// DECISION: these codes mean the client has to act in Plaid Link (sign in again, grant access
// again, or connect afresh); the connection goes to `error` (connection attention) until they do.
const RECONNECT_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "NO_ACCOUNTS",
  "ITEM_LOCKED",
  "USER_SETUP_REQUIRED",
  "ITEM_NOT_FOUND",
  "INVALID_ACCESS_TOKEN",
  "USER_PERMISSION_REVOKED",
]);
/** The item is gone at Plaid: a reconnect starts a new one rather than update mode. */
const ITEM_GONE_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

export function isReconnectCode(code: string): boolean {
  return RECONNECT_CODES.has(code);
}

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

/** Plaid's ids are short opaque strings; checked so nothing else reaches a request. */
const PlaidId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "not a Plaid id");

const Text = (max: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((v) => (typeof v === "string" ? v.slice(0, max) : null));

const RawAccount = z.looseObject({
  account_id: z.string().min(1).max(200),
  name: Text(200),
  official_name: Text(200),
  mask: Text(8),
  type: Text(40),
  subtype: Text(60),
  balances: z
    .looseObject({
      available: z.union([z.number(), z.string()]).nullable().optional(),
      current: z.union([z.number(), z.string()]).nullable().optional(),
      limit: z.union([z.number(), z.string()]).nullable().optional(),
      iso_currency_code: z.string().nullable().optional(),
      unofficial_currency_code: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
type RawAccount = z.infer<typeof RawAccount>;

const RawTransaction = z.looseObject({
  transaction_id: z.string().min(1).max(200),
  account_id: z.string().min(1).max(200),
  amount: z.union([z.number(), z.string()]),
  iso_currency_code: z.string().nullable().optional(),
  unofficial_currency_code: z.string().nullable().optional(),
  date: z.string().max(10),
  authorized_date: z.string().max(10).nullable().optional(),
  pending: z.boolean().optional(),
  pending_transaction_id: z.string().max(200).nullable().optional(),
  merchant_name: Text(300),
  name: Text(300),
  payment_channel: Text(40),
  personal_finance_category: z
    .looseObject({ primary: Text(80), detailed: Text(120) })
    .nullable()
    .optional(),
});

/** An account as tools and events show it. The bank's names are data (invariant 9). */
export const BankfeedAccountRef = z.object({
  id: z.string(),
  name: z.string().nullable(),
  mask: z.string().nullable(),
  /** Plaid's type: `depository`, `credit`, `loan`, `investment`, `other`. */
  type: z.string().nullable(),
  subtype: z.string().nullable(),
});
export type BankfeedAccountRef = z.infer<typeof BankfeedAccountRef>;

const MaybeDecimal = DecimalString.nullable();

export const BankfeedAccount = BankfeedAccountRef.extend({
  officialName: z.string().nullable(),
  balances: z.object({
    available: MaybeDecimal,
    current: MaybeDecimal,
    limit: MaybeDecimal,
    currency: z.string(),
  }),
});
export type BankfeedAccount = z.infer<typeof BankfeedAccount>;

/**
 * A bank or card transaction as tools return it and events carry it. The amount is always
 * positive; `direction` says which way the money went.
 */
// DECISION: Plaid's sign (positive = money out of the account: a purchase, a debit; negative =
// money in: a deposit, a refund, a card payment) becomes an absolute decimal amount and a
// `direction` of "out" or "in", so no reader has to remember a sign convention.
export const BankfeedTransaction = z.object({
  id: z.string(),
  account: BankfeedAccountRef,
  amount: z.object({ amount: DecimalString, currency: z.string() }),
  direction: z.enum(["out", "in"]),
  /** The day it posted (or, pending, the day Plaid expects). ISO date. */
  date: z.string(),
  authorizedDate: z.string().nullable(),
  pending: z.boolean(),
  /** For a posted transaction, the pending one it replaced. */
  pendingTransactionId: z.string().nullable(),
  merchantName: z.string().nullable(),
  /** The bank's description of it. */
  description: z.string().nullable(),
  category: z.string().nullable(),
  paymentChannel: z.string().nullable(),
});
export type BankfeedTransaction = z.infer<typeof BankfeedTransaction>;

const CURRENCY = /^[A-Z]{3}$/;

// DECISION: the ISO code when Plaid gives one, else its unofficial code if it is three capital
// letters, else "XXX" (ISO's "no currency"): never a guessed USD.
function currencyOf(iso: string | null | undefined, unofficial: string | null | undefined): string {
  if (iso && CURRENCY.test(iso)) return iso;
  if (unofficial && CURRENCY.test(unofficial)) return unofficial;
  return "XXX";
}

/**
 * Plaid's amounts are JSON numbers in the currency's major unit (NOTES.md). They are read as the
 * shortest decimal text of the number, never computed with, and rounded to `numeric(14,4)`.
 */
function decimalOf(v: number | string): string {
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("not a finite amount");
  return toNumeric(dec(String(v)));
}

function maybeDecimal(v: number | string | null | undefined): string | null {
  return v === null || v === undefined ? null : decimalOf(v);
}

function accountRef(raw: RawAccount | undefined, id: string): BankfeedAccountRef {
  return {
    id,
    name: raw?.name ?? null,
    mask: raw?.mask ?? null,
    type: raw?.type ?? null,
    subtype: raw?.subtype ?? null,
  };
}

export function mapPlaidAccount(raw: unknown): BankfeedAccount {
  const a = RawAccount.parse(raw);
  const b = a.balances;
  return BankfeedAccount.parse({
    ...accountRef(a, a.account_id),
    officialName: a.official_name ?? null,
    balances: {
      available: maybeDecimal(b?.available),
      current: maybeDecimal(b?.current),
      limit: maybeDecimal(b?.limit),
      currency: currencyOf(b?.iso_currency_code, b?.unofficial_currency_code),
    },
  });
}

/** Plaid's transaction JSON (with the accounts of its answer) → BankfeedTransaction. */
export function mapPlaidTransaction(
  raw: unknown,
  accounts: ReadonlyMap<string, RawAccount>,
): BankfeedTransaction {
  const t = RawTransaction.parse(raw);
  const signed = dec(decimalOf(t.amount));
  return BankfeedTransaction.parse({
    id: t.transaction_id,
    account: accountRef(accounts.get(t.account_id), t.account_id),
    amount: {
      amount: toNumeric(signed.abs()),
      currency: currencyOf(t.iso_currency_code, t.unofficial_currency_code),
    },
    direction: signed.isNegative() ? "in" : "out",
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    pending: t.pending === true,
    pendingTransactionId: t.pending_transaction_id ?? null,
    merchantName: t.merchant_name ?? null,
    description: t.name ?? null,
    category: t.personal_finance_category?.detailed ?? t.personal_finance_category?.primary ?? null,
    paymentChannel: t.payment_channel ?? null,
  });
}

/** Which event a new transaction raises, by its account's type; none for loans and the rest. */
export function bankfeedEventFor(
  t: BankfeedTransaction,
): typeof CARD_CHARGE_CREATED | typeof BANK_TRANSACTION_CREATED | null {
  if (t.account.type === "credit") return CARD_CHARGE_CREATED;
  if (t.account.type === "depository") return BANK_TRANSACTION_CREATED;
  return null;
}

/**
 * A transaction version's key in `raw_record.external_version`: a hash of what we store, so the
 * same content is stored once and each change Plaid reports is a new row (invariant 3).
 */
export async function bankfeedVersion(t: BankfeedTransaction): Promise<string> {
  return `v1:${toHex(await sha256Bytes(utf8(JSON.stringify(t)))).slice(0, 40)}`;
}
/** The version of the row that records a transaction Plaid removed. */
export const BANKFEED_REMOVED_VERSION = "removed";

/** The payload of both events. The bank's and merchant's text is data (invariant 9). */
export const BankfeedTransactionCreatedPayload = z.strictObject({
  connectionId: z.uuid(),
  /** The raw record the transaction is stored as. */
  rawRecordId: z.uuid(),
  transaction: BankfeedTransaction,
});
export type BankfeedTransactionCreatedPayload = z.infer<typeof BankfeedTransactionCreatedPayload>;

const SAMPLE_ACCOUNT = {
  id: "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp",
  name: "Business Card",
  mask: "3333",
  type: "credit",
  subtype: "credit card",
};

/** One sync pass's result, for apps/api to store. */
export interface BankfeedSyncResult {
  added: BankfeedTransaction[];
  modified: BankfeedTransaction[];
  removed: { id: string; accountId: string | null }[];
  /** The cursor to keep; null when Plaid has none yet (its first pull isn't ready). */
  nextCursor: string | null;
  /** Plaid had more than this pass read; the next pass continues from `nextCursor`. */
  more: boolean;
  /** Plaid's `transactions_update_status` (e.g. HISTORICAL_UPDATE_COMPLETE), when given. */
  updateStatus: string | null;
}

/** The connector, with the sync apps/api runs (it isn't a tool: agents don't call it). */
export interface BankfeedConnector extends Connector {
  transactionsSync(
    ctx: ConnectionContext,
    cursor: string | null,
    options?: { maxPages?: number; count?: number },
  ): Promise<BankfeedSyncResult | { skipped: "permission_off" }>;
}

export function isBankfeedConnector(c: Connector | undefined): c is BankfeedConnector {
  return (
    c?.manifest.id === BANKFEED_CONNECTOR_ID &&
    typeof (c as Partial<BankfeedConnector>).transactionsSync === "function"
  );
}

// ── The connector ────────────────────────────────────────────────────────────────────────────────

export interface BankfeedOptions {
  /** Mezonas' Plaid client id and the secret of `environment`. */
  clientId?: string | undefined;
  secret?: string | undefined;
  environment?: PlaidEnvironment;
  fetch?: FetchLike;
  /** The clock for webhook checks (tests). */
  now?: () => Date;
}

const ItemAnswer = z.looseObject({
  item: z.looseObject({
    item_id: z.string().min(1).max(200),
    institution_id: z.string().max(100).nullable().optional(),
    products: z.array(z.string()).optional(),
    billed_products: z.array(z.string()).optional(),
    error: z.looseObject({ error_code: z.string().optional() }).nullable().optional(),
  }),
});
type ItemAnswer = z.infer<typeof ItemAnswer>;

const SyncAnswer = z.looseObject({
  added: z.array(z.unknown()),
  modified: z.array(z.unknown()),
  removed: z.array(
    z.looseObject({
      transaction_id: z.string().min(1).max(200),
      account_id: z.string().max(200).nullable().optional(),
    }),
  ),
  next_cursor: z.string().max(4096),
  has_more: z.boolean(),
  accounts: z.array(z.unknown()).optional(),
  transactions_update_status: z.string().max(64).optional(),
});

/** Restarts a pass after Plaid reports the data changed mid-pagination (Plaid's guidance). */
const MUTATION_RETRIES = 3;

export function createBankfeedConnector(options: BankfeedOptions = {}): BankfeedConnector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.secret);
  const base = PLAID_HOSTS[options.environment ?? "sandbox"];
  const now = options.now ?? (() => new Date());

  async function readJson(res: HttpResponseLike): Promise<unknown> {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  /**
   * One Plaid call. The client id and secret go in Plaid's headers, the access token (when there
   * is one) in the JSON body; neither ever reaches an error message or a log.
   */
  async function plaid(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!options.clientId || !options.secret) throw new PlaidNotConfiguredError();
    const res = await doFetch()(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "plaid-client-id": options.clientId,
        "plaid-secret": options.secret,
        "plaid-version": PLAID_API_VERSION,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: timeoutSignal(30_000),
    });
    const json = await readJson(res);
    if (!res.ok) {
      const e = (json ?? {}) as { error_code?: unknown; error_type?: unknown };
      throw new PlaidApiError(
        res.status,
        typeof e.error_code === "string" ? e.error_code.slice(0, 64) : `HTTP_${res.status}`,
        typeof e.error_type === "string" ? e.error_type.slice(0, 64) : null,
        res.status === 429 || res.status >= 500,
      );
    }
    return json;
  }

  /** A call on an item: an error that needs the client becomes ReconnectRequiredError. */
  async function onItem(path: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      return await plaid(path, body);
    } catch (error) {
      if (error instanceof PlaidApiError && isReconnectCode(error.code)) {
        throw new ReconnectRequiredError(`Plaid: ${error.code}`);
      }
      throw error;
    }
  }

  async function credentialsOf(ctx: ConnectionContext): Promise<BankfeedCredentials> {
    const stored = BankfeedCredentials.safeParse(await ctx.credentials.get());
    if (!stored.success) {
      throw new ReconnectRequiredError("the bank feed connection has no valid credentials");
    }
    return stored.data;
  }

  async function linkTokenCreate(body: Record<string, unknown>) {
    const answer = z
      .looseObject({ link_token: z.string().min(1).max(500), expiration: z.string().optional() })
      .parse(await plaid("/link/token/create", body));
    return {
      provider: "plaid" as const,
      token: answer.link_token,
      expiresAt: answer.expiration ?? null,
    };
  }

  async function itemGet(accessToken: string): Promise<ItemAnswer["item"]> {
    return ItemAnswer.parse(await plaid("/item/get", { access_token: accessToken })).item;
  }

  async function institutionName(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    try {
      const answer = z
        .looseObject({ institution: z.looseObject({ name: z.string().min(1).max(200) }) })
        .parse(
          await plaid("/institutions/get_by_id", { institution_id: id, country_codes: ["US"] }),
        );
      return answer.institution.name;
    } catch {
      // The name only labels the connection; a failure here doesn't fail the sign-in.
      return null;
    }
  }

  /** The grant for a working item: the token (encrypted by the platform), the item, its labels. */
  async function grantFor(creds: BankfeedCredentials, item: ItemAnswer["item"]) {
    const accounts = z
      .looseObject({ accounts: z.array(z.unknown()) })
      .parse(await plaid("/accounts/get", { access_token: creds.accessToken }))
      .accounts.slice(0, 50)
      .map(mapPlaidAccount)
      .map(({ id, name, mask, type, subtype }) => ({ id, name, mask, type, subtype }));
    const name = await institutionName(item.institution_id);
    const config: JsonObject = {
      institutionId: item.institution_id ?? null,
      accounts,
      ...(name ? { accountName: name } : {}),
    };
    return {
      externalAccountId: creds.itemId,
      credentials: BankfeedCredentials.parse(creds) as unknown as JsonObject,
      config,
    };
  }

  const keyCache = new PlaidKeyCache(async (kid) => {
    try {
      const answer = z
        .looseObject({ key: z.unknown() })
        .parse(await plaid("/webhook_verification_key/get", { key_id: kid }));
      const key = PlaidVerificationKey.safeParse(answer.key);
      return key.success ? key.data : null;
    } catch (error) {
      // Plaid doesn't know the id: refused. Anything else (Plaid down) is thrown: a 5xx, so Plaid
      // sends the webhook again later.
      if (error instanceof PlaidApiError && !error.retryable) return null;
      throw error;
    }
  });

  const transactionSpecInput = z.object({
    /** On or after (ISO date). Default: 30 days before `toDate`. */
    fromDate: z.iso.date().optional(),
    /** On or before (ISO date). Default: today. */
    toDate: z.iso.date().optional(),
    accountId: PlaidId.optional(),
    pageSize: z.number().int().min(1).max(500).default(100),
    /** How many to skip (the `nextOffset` of the page before). */
    offset: z.number().int().min(0).max(100_000).default(0),
  });

  const connector = defineConnector({
    id: BANKFEED_CONNECTOR_ID,
    name: "Bank and card feeds",
    description:
      "Read the transactions of your bank accounts and cards, through Plaid. You connect them yourself. Nothing here can move money.",
    icon: "bank",
    // DECISION: Plaid Link is a hosted sign-in like OAuth's (the client signs in at their bank,
    // inside Plaid's widget), so the connector is `oauth2` and uses the same begin and callback
    // routes; `beginLink` answers a Link token where `authorize` would answer a URL.
    auth: "oauth2",
    entities: [BANKFEED_TRANSACTION_ENTITY, "Account"],
    // Card charges and bank transactions are named as the design names them (ARCHITECTURE §6.11),
    // so another feed provider can raise the same events later.
    sharedNamespaces: ["card", "bank"],
    permissionEntities: [
      { id: "transaction", label: "Transactions", verbs: ["read"] },
      { id: "account", label: "Accounts", verbs: ["read"] },
    ],
    events: [
      {
        type: CARD_CHARGE_CREATED,
        description: "A new transaction on a connected card (from the bank feed).",
        subjectType: "raw_record",
        payload: z.toJSONSchema(BankfeedTransactionCreatedPayload, { io: "input" }) as Record<
          string,
          unknown
        >,
        sample: {
          connectionId: "0192f7a0-0000-7000-8000-000000000001",
          rawRecordId: "0192f7a0-0000-7000-8000-000000000003",
          transaction: {
            id: "lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje",
            account: SAMPLE_ACCOUNT,
            amount: { amount: "412.5000", currency: "USD" },
            direction: "out",
            date: "2026-11-05",
            authorizedDate: "2026-11-04",
            pending: false,
            pendingTransactionId: null,
            merchantName: "Rockler Woodworking",
            description: "ROCKLER WOODWORKING 1042",
            category: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
            paymentChannel: "in store",
          },
        },
      },
      {
        type: BANK_TRANSACTION_CREATED,
        description: "A new transaction in a connected bank account (from the bank feed).",
        subjectType: "raw_record",
        payload: z.toJSONSchema(BankfeedTransactionCreatedPayload, { io: "input" }) as Record<
          string,
          unknown
        >,
        sample: {
          connectionId: "0192f7a0-0000-7000-8000-000000000001",
          rawRecordId: "0192f7a0-0000-7000-8000-000000000004",
          transaction: {
            id: "x4qbLgYXdBFjrWm9BLNmUNqZ3Lk6EVcJNMxyv",
            account: {
              id: "vzeNDwK7KQIm4yEog683uElbp9GRLEFXGK98D",
              name: "Business Checking",
              mask: "0000",
              type: "depository",
              subtype: "checking",
            },
            amount: { amount: "1250.0000", currency: "USD" },
            direction: "in",
            date: "2026-11-05",
            authorizedDate: null,
            pending: false,
            pendingTransactionId: null,
            merchantName: null,
            description: "DEPOSIT ACME MILLWORK CUSTOMER",
            category: "INCOME_OTHER_INCOME",
            paymentChannel: "other",
          },
        },
      },
    ],
    isConfigured: () => configured,

    async beginLink(req: LinkRequest) {
      if (!configured) throw new PlaidNotConfiguredError();
      const common = {
        client_name: "Mezonas",
        language: plaidLanguage(req.language),
        country_codes: ["US"],
        user: { client_user_id: await plaidClientUserId(req.tenantId) },
        webhook: req.webhookUrl,
        redirect_uri: req.redirectUri,
      };
      if (req.reconnect) {
        const stored = BankfeedCredentials.safeParse(await req.reconnect.credentials.get());
        if (stored.success) {
          try {
            // Update mode: the same item signs in again; no products are named (Plaid's rule).
            return await linkTokenCreate({ ...common, access_token: stored.data.accessToken });
          } catch (error) {
            // The item is gone at Plaid: a new connection, below. Anything else stops here.
            if (!(error instanceof PlaidApiError && ITEM_GONE_CODES.has(error.code))) throw error;
          }
        }
      }
      return linkTokenCreate({
        ...common,
        products: [...PLAID_PRODUCTS],
        transactions: { days_requested: PLAID_DAYS_REQUESTED },
      });
    },

    async handleCallback(params, req) {
      if (!configured) throw new PlaidNotConfiguredError();
      // Reconnecting (update mode): the item and its access token stay as they were.
      if (req.existing) {
        const stored = BankfeedCredentials.safeParse(await req.existing.credentials.get());
        if (stored.success) {
          try {
            const item = await itemGet(stored.data.accessToken);
            return await grantFor(stored.data, item);
          } catch (error) {
            if (!(error instanceof PlaidApiError && ITEM_GONE_CODES.has(error.code))) throw error;
          }
        }
      }
      const publicToken = params.public_token ?? "";
      if (!publicToken.startsWith("public-") || publicToken.length > 500) {
        throw new Error("the bank sign-in returned no public token");
      }
      const exchanged = z
        .looseObject({
          access_token: z.string().min(1).max(500),
          item_id: z.string().min(1).max(200),
        })
        .parse(await plaid("/item/public_token/exchange", { public_token: publicToken }));
      const creds: BankfeedCredentials = {
        accessToken: exchanged.access_token,
        itemId: exchanged.item_id,
      };
      const item = await itemGet(creds.accessToken);
      const products = [...(item.products ?? []), ...(item.billed_products ?? [])];
      if (products.some((p) => MONEY_MOVEMENT_PRODUCTS.has(p))) {
        await plaid("/item/remove", { access_token: creds.accessToken }).catch(() => undefined);
        throw new SignInRefusedError(
          "This bank connection can move money, so we removed it. Connect it again from here.",
        );
      }
      return grantFor(creds, item);
    },

    // Disconnect: Plaid stops reading the account and the token stops working; the platform drops
    // the stored token either way.
    async revoke(ctx: ConnectionContext) {
      const creds = BankfeedCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success) return;
      await plaid("/item/remove", { access_token: creds.data.accessToken });
    },

    async verifyWebhook(headers, body) {
      if (!configured) return false;
      const check = await verifyPlaidWebhook({
        jwt: headers[PLAID_VERIFICATION_HEADER],
        body,
        keys: keyCache,
        now: now(),
      });
      return check.ok;
    },

    tools: [
      defineReadTool({
        id: BANKFEED_TOOLS.transactions,
        entity: "transaction",
        description:
          "Find bank and card transactions by date and account, newest first, a page at a time. Amounts are positive; direction says money out or in.",
        summary: "Found {{transactions.length}} transactions",
        input: transactionSpecInput,
        output: z.object({
          transactions: z.array(BankfeedTransaction),
          total: z.number().int().nonnegative(),
          nextOffset: z.number().int().nullable(),
        }),
        async run(input, ctx) {
          const creds = await credentialsOf(ctx);
          const today = ctx.now().toISOString().slice(0, 10);
          const toDate = input.toDate ?? today;
          const fromDate =
            input.fromDate ??
            new Date(Date.parse(`${toDate}T00:00:00Z`) - 30 * 86_400_000)
              .toISOString()
              .slice(0, 10);
          if (fromDate > toDate) throw new Error("fromDate is after toDate");
          const answer = z
            .looseObject({
              accounts: z.array(z.unknown()),
              transactions: z.array(z.unknown()),
              total_transactions: z.number().int().nonnegative(),
            })
            .parse(
              await onItem("/transactions/get", {
                access_token: creds.accessToken,
                start_date: fromDate,
                end_date: toDate,
                options: {
                  count: input.pageSize,
                  offset: input.offset,
                  ...(input.accountId ? { account_ids: [input.accountId] } : {}),
                },
              }),
            );
          const accounts = new Map(
            answer.accounts.map((a) => RawAccount.parse(a)).map((a) => [a.account_id, a] as const),
          );
          const transactions = answer.transactions.map((t) => mapPlaidTransaction(t, accounts));
          const next = input.offset + transactions.length;
          return {
            transactions,
            total: answer.total_transactions,
            nextOffset: transactions.length > 0 && next < answer.total_transactions ? next : null,
          };
        },
      }),
      defineReadTool({
        id: BANKFEED_TOOLS.accounts,
        entity: "account",
        description:
          "List the connected bank accounts and cards, with their type, last four digits and balances.",
        summary: "Found {{accounts.length}} accounts",
        input: z.object({ accountIds: z.array(PlaidId).max(50).optional() }),
        output: z.object({ accounts: z.array(BankfeedAccount) }),
        async run(input, ctx) {
          const creds = await credentialsOf(ctx);
          const answer = z.looseObject({ accounts: z.array(z.unknown()) }).parse(
            await onItem("/accounts/get", {
              access_token: creds.accessToken,
              ...(input.accountIds?.length ? { options: { account_ids: input.accountIds } } : {}),
            }),
          );
          return { accounts: answer.accounts.slice(0, 100).map(mapPlaidAccount) };
        },
      }),
    ],
  });

  const transactionsSpec = connector.manifest.tools.find(
    (t) => t.id === BANKFEED_TOOLS.transactions,
  );

  async function transactionsSync(
    ctx: ConnectionContext,
    cursor: string | null,
    opts: { maxPages?: number; count?: number } = {},
  ): Promise<BankfeedSyncResult | { skipped: "permission_off" }> {
    // The client's matrix applies to the feed as to the tool: transactions' read off reads nothing.
    if (
      !transactionsSpec ||
      connectionLevel(connector.manifest, transactionsSpec, ctx.connection.permissions, {}) ===
        "off"
    ) {
      return { skipped: "permission_off" };
    }
    const creds = await credentialsOf(ctx);
    const maxPages = Math.min(Math.max(opts.maxPages ?? 20, 1), 50);
    const count = Math.min(Math.max(opts.count ?? 500, 1), 500);
    for (let attempt = 0; ; attempt++) {
      try {
        return await onePass(creds, cursor, maxPages, count);
      } catch (error) {
        const mutated =
          error instanceof PlaidApiError &&
          error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
        if (!mutated || attempt + 1 >= MUTATION_RETRIES) throw error;
      }
    }
  }

  /** Pages from `cursor` until Plaid has no more or `maxPages` were read. */
  async function onePass(
    creds: BankfeedCredentials,
    cursor: string | null,
    maxPages: number,
    count: number,
  ): Promise<BankfeedSyncResult> {
    const accounts = new Map<string, RawAccount>();
    const rawAdded: unknown[] = [];
    const rawModified: unknown[] = [];
    const removed: BankfeedSyncResult["removed"] = [];
    let next = cursor;
    let more = true;
    let updateStatus: string | null = null;
    for (let page = 0; page < maxPages && more; page++) {
      const answer = SyncAnswer.parse(
        await onItem("/transactions/sync", {
          access_token: creds.accessToken,
          count,
          ...(next ? { cursor: next } : {}),
        }),
      );
      for (const a of answer.accounts ?? []) {
        const parsed = RawAccount.parse(a);
        accounts.set(parsed.account_id, parsed);
      }
      rawAdded.push(...answer.added);
      rawModified.push(...answer.modified);
      for (const r of answer.removed) {
        removed.push({ id: r.transaction_id, accountId: r.account_id ?? null });
      }
      // An empty cursor: Plaid's first pull isn't ready; keep what we had.
      if (answer.next_cursor) next = answer.next_cursor;
      more = answer.has_more;
      updateStatus = answer.transactions_update_status ?? null;
    }
    return {
      added: rawAdded.map((t) => mapPlaidTransaction(t, accounts)),
      modified: rawModified.map((t) => mapPlaidTransaction(t, accounts)),
      removed,
      nextCursor: next,
      more,
      updateStatus,
    };
  }

  return Object.assign(connector, { transactionsSync });
}
