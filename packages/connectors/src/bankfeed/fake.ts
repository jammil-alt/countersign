// A fake Plaid for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker). It answers the endpoints the bankfeed connector calls, shaped like Plaid's answers as
// far as we know them (NOTES.md): Link tokens (new and update mode), the public token exchange,
// items, institutions, accounts, `/transactions/sync` over a per-item change log with opaque
// cursors, `/transactions/get`, item removal, item errors, and webhook verification keys. It signs
// webhooks with a P-256 key of its own, as Plaid does, so the connector's check runs for real.

import { type FetchLike, type HttpRequestInit, type HttpResponseLike, parseUrl } from "../http";
import { sha256Bytes, toBase64Url, toHex, utf8 } from "../runtime";
import { PLAID_HOSTS, type PlaidEnvironment } from "./index";

export const FAKE_PLAID = {
  clientId: "6512f0e0fake0000mezonas0",
  secret: "fake-plaid-sandbox-secret-0000",
} as const;

export interface FakePlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string;
  type: "depository" | "credit" | "loan" | "investment" | "other";
  subtype: string;
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
  };
}

/** A transaction as Plaid's JSON has it (amount a number: positive = money out). */
export interface FakePlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  merchant_name: string | null;
  name: string;
  payment_channel: string;
  personal_finance_category: { primary: string; detailed: string } | null;
}

type Change =
  | { kind: "added" | "modified"; txn: FakePlaidTransaction }
  | { kind: "removed"; transaction_id: string; account_id: string };

export interface FakePlaidItem {
  itemId: string;
  accessToken: string;
  institutionId: string;
  products: string[];
  accounts: FakePlaidAccount[];
  /** Plaid's error_code while the item needs the client (ITEM_LOGIN_REQUIRED). */
  error: string | null;
  removed: boolean;
  /** Every change, in order; cursors are positions in it. */
  log: Change[];
  /** NOT_READY answers an empty first page with an empty cursor. */
  updateStatus: "NOT_READY" | "INITIAL_UPDATE_COMPLETE" | "HISTORICAL_UPDATE_COMPLETE";
  webhook: string | null;
}

export interface FakePlaidRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FakePlaid {
  fetch: FetchLike;
  environment: PlaidEnvironment;
  requests: FakePlaidRequest[];
  /** Link tokens made, with the body that made each. */
  linkTokens: Map<string, Record<string, unknown>>;
  items: Map<string, FakePlaidItem>;
  /** A public token, as Link's onSuccess gives it; exchanging it makes the item. */
  issuePublicToken(opts?: { products?: string[]; accounts?: FakePlaidAccount[] }): string;
  /** The item a public token became, after the exchange. */
  itemOf(publicToken: string): FakePlaidItem | undefined;
  add(itemId: string, ...txns: FakePlaidTransaction[]): void;
  modify(itemId: string, txn: FakePlaidTransaction): void;
  remove(itemId: string, transactionId: string): void;
  setError(itemId: string, code: string | null): void;
  /** The next `/transactions/sync` with a cursor answers Plaid's mid-pagination mutation error. */
  mutateDuringNextPage(): void;
  /** A webhook body and its `Plaid-Verification` JWT, signed by the fake's key. */
  signWebhook(
    body: string,
    opts?: { iat?: number; kid?: string; bodyHash?: string },
  ): Promise<{ jwt: string; body: Uint8Array }>;
  keyId: string;
  /** How many times the verification key was asked for. */
  keyLookups(): number;
  /** Every access token issued (to look for one where it must never be). */
  accessTokens(): string[];
}

export const FAKE_INSTITUTION = { id: "ins_109508", name: "First Platypus Bank" } as const;

export function fakePlaidAccounts(): FakePlaidAccount[] {
  return [
    {
      account_id: "vzeNDwK7KQIm4yEog683uElbp9GRLEFXGK98D",
      name: "Business Checking",
      official_name: "Platypus Business Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      balances: {
        available: 10250.5,
        current: 10310.55,
        limit: null,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    },
    {
      account_id: "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp",
      name: "Business Card",
      official_name: "Platypus Business Rewards Card",
      mask: "3333",
      type: "credit",
      subtype: "credit card",
      balances: {
        available: null,
        current: 412.5,
        limit: 5000,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    },
  ];
}

export const FAKE_CHECKING = "vzeNDwK7KQIm4yEog683uElbp9GRLEFXGK98D";
export const FAKE_CARD = "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp";

/** A Plaid-shaped transaction; `amount` positive = money out, as Plaid's. */
export function fakePlaidTransaction(
  id: string,
  over: Partial<FakePlaidTransaction> = {},
): FakePlaidTransaction {
  return {
    transaction_id: id,
    account_id: FAKE_CARD,
    amount: 12.34,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-11-05",
    authorized_date: "2026-11-04",
    pending: false,
    pending_transaction_id: null,
    merchant_name: "Rockler Woodworking",
    name: "ROCKLER WOODWORKING 1042",
    payment_channel: "in store",
    personal_finance_category: {
      primary: "GENERAL_MERCHANDISE",
      detailed: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
    },
    ...over,
  };
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

const plaidError = (status: number, type: string, code: string) =>
  respond(status, {
    error_type: type,
    error_code: code,
    error_message: `fake: ${code}`,
    display_message: null,
    request_id: "fake-request",
  });

interface WebCryptoForFake {
  generateKey(
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    usages: ("sign" | "verify")[],
  ): Promise<{ privateKey: unknown; publicKey: unknown }>;
  exportKey(format: "jwk", key: unknown): Promise<{ x?: string; y?: string }>;
  sign(
    algorithm: { name: "ECDSA"; hash: "SHA-256" },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
}

function webCrypto(): WebCryptoForFake {
  const c = (globalThis as unknown as { crypto?: { subtle?: WebCryptoForFake } }).crypto?.subtle;
  if (!c) throw new Error("Web Crypto is not available");
  return c;
}

export function fakePlaid(environment: PlaidEnvironment = "sandbox"): FakePlaid {
  const host = PLAID_HOSTS[environment];
  const requests: FakePlaidRequest[] = [];
  const linkTokens = new Map<string, Record<string, unknown>>();
  const items = new Map<string, FakePlaidItem>();
  const byToken = new Map<string, FakePlaidItem>();
  const pending = new Map<string, { products: string[]; accounts: FakePlaidAccount[] }>();
  const exchanged = new Map<string, FakePlaidItem>();
  let seq = 0;
  let mutateNext = false;
  let lookups = 0;
  const keyId = "6c5516e1-92dc-479e-a8ff-5a51992e0001";
  let keys: Promise<{ privateKey: unknown; jwk: { x: string; y: string } }> | null = null;

  function keyPair() {
    keys ??= (async () => {
      const pair = await webCrypto().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const jwk = await webCrypto().exportKey("jwk", pair.publicKey);
      return { privateKey: pair.privateKey, jwk: { x: jwk.x ?? "", y: jwk.y ?? "" } };
    })();
    return keys;
  }

  const next = (prefix: string) => {
    seq += 1;
    return `${prefix}${String(seq).padStart(6, "0")}`;
  };

  /** The latest state of each transaction (removed ones left out), newest first. */
  function current(item: FakePlaidItem): FakePlaidTransaction[] {
    const out = new Map<string, FakePlaidTransaction>();
    for (const c of item.log) {
      if (c.kind === "removed") out.delete(c.transaction_id);
      else out.set(c.txn.transaction_id, c.txn);
    }
    return [...out.values()].sort((a, b) =>
      a.date === b.date
        ? a.transaction_id.localeCompare(b.transaction_id)
        : b.date.localeCompare(a.date),
    );
  }

  function itemFor(body: Record<string, unknown>): FakePlaidItem | HttpResponseLike {
    const token = typeof body.access_token === "string" ? body.access_token : "";
    const item = byToken.get(token);
    if (!item) return plaidError(400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN");
    if (item.removed) return plaidError(400, "ITEM_ERROR", "ITEM_NOT_FOUND");
    return item;
  }

  const handlers = new Map<string, (body: Record<string, unknown>) => Promise<HttpResponseLike>>([
    [
      "/link/token/create",
      async (body) => {
        const user = body.user as { client_user_id?: unknown } | undefined;
        if (typeof user?.client_user_id !== "string" || user.client_user_id.includes("@")) {
          return plaidError(400, "INVALID_FIELD", "INVALID_FIELD");
        }
        if (body.access_token !== undefined) {
          if (body.products !== undefined) return plaidError(400, "INVALID_FIELD", "INVALID_FIELD");
          const item = itemFor(body);
          if ("status" in item) return item;
        } else if (!Array.isArray(body.products) || body.products.length === 0) {
          return plaidError(400, "INVALID_FIELD", "INVALID_FIELD");
        }
        const token = next(`link-${environment}-`);
        linkTokens.set(token, body);
        return respond(200, {
          link_token: token,
          expiration: "2026-11-06T19:00:00Z",
          request_id: "r",
        });
      },
    ],
    [
      "/item/public_token/exchange",
      async (body) => {
        const pt = typeof body.public_token === "string" ? body.public_token : "";
        const p = pending.get(pt);
        if (!p) return plaidError(400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN");
        pending.delete(pt);
        const item: FakePlaidItem = {
          itemId: next("item-"),
          accessToken: next(`access-${environment}-`),
          institutionId: FAKE_INSTITUTION.id,
          products: p.products,
          accounts: p.accounts,
          error: null,
          removed: false,
          log: [],
          updateStatus: "HISTORICAL_UPDATE_COMPLETE",
          webhook: null,
        };
        items.set(item.itemId, item);
        byToken.set(item.accessToken, item);
        exchanged.set(pt, item);
        return respond(200, {
          access_token: item.accessToken,
          item_id: item.itemId,
          request_id: "r",
        });
      },
    ],
    [
      "/item/get",
      async (body) => {
        const item = itemFor(body);
        if ("status" in item) return item;
        return respond(200, {
          item: {
            item_id: item.itemId,
            institution_id: item.institutionId,
            products: item.products,
            billed_products: item.products,
            available_products: ["balance", "auth"],
            error: item.error ? { error_type: "ITEM_ERROR", error_code: item.error } : null,
            webhook: item.webhook,
          },
          status: null,
          request_id: "r",
        });
      },
    ],
    [
      "/institutions/get_by_id",
      async (body) =>
        body.institution_id === FAKE_INSTITUTION.id
          ? respond(200, {
              institution: { institution_id: FAKE_INSTITUTION.id, name: FAKE_INSTITUTION.name },
            })
          : plaidError(400, "INVALID_INPUT", "INVALID_INSTITUTION"),
    ],
    [
      "/accounts/get",
      async (body) => {
        const item = itemFor(body);
        if ("status" in item) return item;
        if (item.error) return plaidError(400, "ITEM_ERROR", item.error);
        const ids = (body.options as { account_ids?: string[] } | undefined)?.account_ids;
        return respond(200, {
          accounts: item.accounts.filter((a) => !ids || ids.includes(a.account_id)),
          item: { item_id: item.itemId },
        });
      },
    ],
    [
      "/transactions/sync",
      async (body) => {
        const item = itemFor(body);
        if ("status" in item) return item;
        if (item.error) return plaidError(400, "ITEM_ERROR", item.error);
        const cursor = typeof body.cursor === "string" ? body.cursor : "";
        if (cursor && mutateNext) {
          mutateNext = false;
          return plaidError(
            400,
            "TRANSACTIONS_ERROR",
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          );
        }
        if (item.updateStatus === "NOT_READY" && !cursor) {
          return respond(200, {
            added: [],
            modified: [],
            removed: [],
            next_cursor: "",
            has_more: false,
            accounts: item.accounts,
            transactions_update_status: "NOT_READY",
          });
        }
        let from = 0;
        if (cursor) {
          const prefix = `cur:${item.itemId}:`;
          if (!cursor.startsWith(prefix)) return plaidError(400, "INVALID_INPUT", "INVALID_CURSOR");
          from = Number(cursor.slice(prefix.length));
        }
        const count = typeof body.count === "number" ? body.count : 100;
        const slice = item.log.slice(from, from + count);
        const to = from + slice.length;
        return respond(200, {
          added: slice.flatMap((c) => (c.kind === "added" ? [c.txn] : [])),
          modified: slice.flatMap((c) => (c.kind === "modified" ? [c.txn] : [])),
          removed: slice.flatMap((c) =>
            c.kind === "removed"
              ? [{ transaction_id: c.transaction_id, account_id: c.account_id }]
              : [],
          ),
          next_cursor: `cur:${item.itemId}:${to}`,
          has_more: to < item.log.length,
          accounts: item.accounts,
          transactions_update_status: item.updateStatus,
          request_id: "r",
        });
      },
    ],
    [
      "/transactions/get",
      async (body) => {
        const item = itemFor(body);
        if ("status" in item) return item;
        if (item.error) return plaidError(400, "ITEM_ERROR", item.error);
        const start = String(body.start_date ?? "");
        const end = String(body.end_date ?? "");
        const opts = (body.options ?? {}) as {
          count?: number;
          offset?: number;
          account_ids?: string[];
        };
        const all = current(item).filter(
          (t) =>
            t.date >= start &&
            t.date <= end &&
            (!opts.account_ids || opts.account_ids.includes(t.account_id)),
        );
        const offset = opts.offset ?? 0;
        return respond(200, {
          accounts: item.accounts,
          transactions: all.slice(offset, offset + (opts.count ?? 100)),
          total_transactions: all.length,
          item: { item_id: item.itemId },
        });
      },
    ],
    [
      "/item/remove",
      async (body) => {
        const item = itemFor(body);
        if ("status" in item) return item;
        item.removed = true;
        return respond(200, { request_id: "r" });
      },
    ],
    [
      "/webhook_verification_key/get",
      async (body) => {
        lookups += 1;
        if (body.key_id !== keyId) {
          return plaidError(400, "INVALID_INPUT", "INVALID_WEBHOOK_VERIFICATION_KEY_ID");
        }
        const { jwk } = await keyPair();
        return respond(200, {
          key: {
            alg: "ES256",
            created_at: 1_700_000_000,
            crv: "P-256",
            expired_at: null,
            kid: keyId,
            kty: "EC",
            use: "sig",
            x: jwk.x,
            y: jwk.y,
          },
          request_id: "r",
        });
      },
    ],
  ]);

  const fetch: FetchLike = async (url: string, init?: HttpRequestInit) => {
    const parsed = parseUrl(url);
    if (!parsed || parsed.origin !== host) {
      return plaidError(404, "INVALID_REQUEST", "WRONG_ENVIRONMENT");
    }
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    } catch {
      return plaidError(400, "INVALID_REQUEST", "INVALID_BODY");
    }
    requests.push({ path: parsed.pathname, headers, body });
    if (
      headers["plaid-client-id"] !== FAKE_PLAID.clientId ||
      headers["plaid-secret"] !== FAKE_PLAID.secret
    ) {
      return plaidError(400, "INVALID_INPUT", "INVALID_API_KEYS");
    }
    const handler = handlers.get(parsed.pathname);
    if (!handler) return plaidError(404, "INVALID_REQUEST", "UNKNOWN_FIELDS");
    return handler(body);
  };

  return {
    fetch,
    environment,
    requests,
    linkTokens,
    items,
    keyId,
    issuePublicToken(opts = {}) {
      const token = next(`public-${environment}-`);
      pending.set(token, {
        products: opts.products ?? ["transactions"],
        accounts: opts.accounts ?? fakePlaidAccounts(),
      });
      return token;
    },
    itemOf: (pt) => exchanged.get(pt),
    add(itemId, ...txns) {
      const item = items.get(itemId);
      if (!item) throw new Error(`no item ${itemId}`);
      for (const txn of txns) item.log.push({ kind: "added", txn });
    },
    modify(itemId, txn) {
      items.get(itemId)?.log.push({ kind: "modified", txn });
    },
    remove(itemId, transactionId) {
      const item = items.get(itemId);
      const known = item ? current(item).find((t) => t.transaction_id === transactionId) : null;
      item?.log.push({
        kind: "removed",
        transaction_id: transactionId,
        account_id: known?.account_id ?? FAKE_CARD,
      });
    },
    setError(itemId, code) {
      const item = items.get(itemId);
      if (item) item.error = code;
    },
    mutateDuringNextPage() {
      mutateNext = true;
    },
    async signWebhook(body, opts = {}) {
      const { privateKey } = await keyPair();
      const bytes = utf8(body);
      const header = { alg: "ES256", kid: opts.kid ?? keyId, typ: "JWT" };
      const claims = {
        iat: opts.iat ?? Math.floor(Date.now() / 1000),
        request_body_sha256: opts.bodyHash ?? toHex(await sha256Bytes(bytes)),
      };
      const h = toBase64Url(utf8(JSON.stringify(header)));
      const p = toBase64Url(utf8(JSON.stringify(claims)));
      const sig = await webCrypto().sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        utf8(`${h}.${p}`),
      );
      return { jwt: `${h}.${p}.${toBase64Url(new Uint8Array(sig))}`, body: bytes };
    },
    keyLookups: () => lookups,
    accessTokens: () => [...items.values()].map((i) => i.accessToken),
  };
}
