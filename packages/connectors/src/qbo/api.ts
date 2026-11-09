// The QuickBooks Online API v3 as the qbo connector calls it (ARCHITECTURE §6.2): Intuit's OAuth
// endpoints, the company's API base per environment, the minor version, Intuit's error shape,
// refresh on 401, a throttle per company (realm) with backoff on 429, query, read, sparse update,
// change data capture, and attachment upload and download. Nothing here is checked against a live
// company yet: ./NOTES.md lists each fact and its status.

import { z } from "zod";
import type { ToolContext } from "../connector";
import { checkPublicHttpsUrl, formEncode, type HttpResponseLike, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { sha256Bytes, toBase64, toHex, utf8 } from "../runtime";
import { qboJson } from "./records";

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_API_BASE = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
} as const;
// UNCHECKED (NOTES.md): Intuit made 75 the base minor version in 2025; earlier ones are retired.
export const QBO_MINOR_VERSION = "75";

export const QboEnvironment = z.enum(["sandbox", "production"]);
export type QboEnvironment = z.infer<typeof QboEnvironment>;

/** A QBO company id (realmId): digits. */
export const RealmId = z.string().regex(/^\d{1,32}$/, "a QuickBooks company id (digits)");

/** The encrypted credentials: the shared token fields, plus which company and environment. */
export const QboCredentials = OAuthTokens.extend({
  realmId: RealmId,
  environment: QboEnvironment,
});
export type QboCredentials = z.infer<typeof QboCredentials>;

/** Intuit's token endpoint answer (authorization code and refresh grants). */
export const QboTokenResponse = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().int().positive(),
    x_refresh_token_expires_in: z.number().int().positive().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

/** fetch, with a body that may be bytes (the upload's multipart body). */
export interface QboRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}
export type QboFetch = (url: string, init?: QboRequestInit) => Promise<HttpResponseLike>;

export class QboApiError extends Error {
  constructor(
    readonly status: number,
    /** Intuit's error code (e.g. `5010` stale object, `6000` business validation), or `HTTP_<n>`. */
    readonly code: string,
    message: string,
    /** 429 and 5xx: a later try may get through (the step's retry). */
    readonly retryable: boolean,
    /**
     * Intuit's id for the request (the `intuit_tid` response header), which Intuit asks for when a
     * failure is reported to them. Kept on the error and in its message, so it reaches the step's
     * error and the logs. Null when Intuit sent none.
     */
    readonly intuitTid: string | null = null,
  ) {
    super(intuitTid ? `${message} (intuit_tid ${intuitTid})` : message);
    this.name = "QboApiError";
  }
}

/** Intuit's request id from a response, when it sent one (a short token; anything else is dropped). */
export function intuitTidOf(res: { headers: { get(name: string): string | null } }): string | null {
  const tid = res.headers.get("intuit_tid")?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,100}$/.test(tid) ? tid : null;
}

/** The record changed since it was read: its SyncToken moved on (QBO error 5010, or our check). */
export class QboStaleObjectError extends QboApiError {
  constructor(message: string, intuitTid: string | null = null) {
    super(409, "5010", message, false, intuitTid);
    this.name = "QboStaleObjectError";
  }
}

export class QboNotConfiguredError extends Error {
  constructor() {
    super("QuickBooks sign-in is not set up on this deployment (QBO_CLIENT_ID, QBO_CLIENT_SECRET)");
    this.name = "QboNotConfiguredError";
  }
}

const Fault = z.looseObject({
  type: z.string().optional(),
  Error: z
    .array(
      z.looseObject({
        Message: z.string().optional(),
        Detail: z.string().optional(),
        code: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
});

/** Intuit's error body (`Fault`, or `fault` with lower-case keys on auth errors) → code and text. */
export function readFault(body: unknown): { code: string; message: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw = (b.Fault ?? b.fault) as Record<string, unknown> | undefined;
  if (!raw) return null;
  // Auth faults come with lower-case keys (`error`, `message`, `detail`).
  const lower = raw.error as Record<string, unknown>[] | undefined;
  const normal = Fault.safeParse(raw);
  const first = normal.success ? normal.data.Error?.[0] : undefined;
  const alt = Array.isArray(lower) ? lower[0] : undefined;
  const code = String(first?.code ?? alt?.code ?? "UNKNOWN");
  const message = String(
    first?.Detail ?? first?.Message ?? alt?.detail ?? alt?.message ?? "QuickBooks refused",
  );
  return { code, message };
}

// ── Throttle ────────────────────────────────────────────────────────────────────────────────────

/**
 * Intuit's limits per company: about 500 requests a minute and 10 at once (NOTES.md). One throttle
 * per realm in each isolate keeps a sync and an agent's calls under them; 429s that still happen
 * (another isolate, another app on the same company) back off and retry.
 */
// DECISION: the throttle is per isolate, not shared through a Durable Object: one client's sync
// runs one Workflow step at a time, so isolates rarely share a realm, and a 429 is retried with
// backoff anyway. A Durable Object per realm is the follow-up if 429s show up in the logs.
export class RealmThrottle {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly recent: number[] = [];

  constructor(
    private readonly opts: {
      concurrency: number;
      perMinute: number;
      now: () => number;
      sleep: (ms: number) => Promise<void>;
    },
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      for (;;) {
        const now = this.opts.now();
        while (this.recent.length > 0 && (this.recent[0] as number) <= now - 60_000) {
          this.recent.shift();
        }
        if (this.recent.length < this.opts.perMinute) break;
        await this.opts.sleep((this.recent[0] as number) + 60_000 - now);
      }
      this.recent.push(this.opts.now());
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const throttles = new Map<string, RealmThrottle>();

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const st = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown })
      .setTimeout;
    st(resolve, ms);
  });

function throttleFor(realmId: string, sleep: (ms: number) => Promise<void>): RealmThrottle {
  let t = throttles.get(realmId);
  if (!t) {
    // UNCHECKED: 500 a minute and 10 at once per realm; 450 leaves room for the client's other apps.
    t = new RealmThrottle({ concurrency: 10, perMinute: 450, now: () => Date.now(), sleep });
    throttles.set(realmId, t);
  }
  return t;
}

// ── OAuth ───────────────────────────────────────────────────────────────────────────────────────

export interface QboAppKeys {
  clientId: string;
  clientSecret: string;
}

export function basicAuth(keys: QboAppKeys): string {
  return `Basic ${toBase64(utf8(`${keys.clientId}:${keys.clientSecret}`))}`;
}

export async function qboTokenCall(
  doFetch: QboFetch,
  keys: QboAppKeys,
  fields: Record<string, string>,
): Promise<z.infer<typeof QboTokenResponse>> {
  const res = await doFetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuth(keys),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: formEncode(fields),
    redirect: "manual",
    signal: timeoutSignal(15_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QboApiError(
      res.status,
      "BAD_TOKEN_RESPONSE",
      "Intuit's token endpoint did not answer JSON",
      res.status >= 500,
      intuitTidOf(res),
    );
  }
  const parsed = QboTokenResponse.safeParse(body);
  if (!parsed.success) {
    throw new QboApiError(
      res.status,
      "BAD_TOKEN_RESPONSE",
      "Intuit's token answer has an unexpected shape",
      false,
      intuitTidOf(res),
    );
  }
  return parsed.data;
}

const expiresAt = (now: Date, seconds: number) =>
  new Date(now.getTime() + seconds * 1000).toISOString();

/** The token fields of a successful token answer, for the stored credentials. */
export function tokensFrom(
  answer: { access_token: string; refresh_token: string; expires_in: number } & {
    x_refresh_token_expires_in?: number | undefined;
    token_type?: string | undefined;
  },
  now: Date,
): OAuthTokens {
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    expiresAt: expiresAt(now, answer.expires_in),
    ...(answer.x_refresh_token_expires_in
      ? { refreshTokenExpiresAt: expiresAt(now, answer.x_refresh_token_expires_in) }
      : {}),
    tokenType: answer.token_type ?? "bearer",
    scope: QBO_SCOPE,
  };
}

/**
 * Intuit's refresh: every answer carries a refresh token, which may be new, and tokenManager stores
 * it every time (ARCHITECTURE §6.2: persist the new refresh token every time).
 */
// DECISION: refreshes are shared per refresh token within an isolate, and an answer is reused for
// a minute: Intuit rotates refresh tokens, so two calls that read the same stored token at once
// (a sync and an agent's tool call) must not both spend it; the second gets the first's answer.
// The map lives with the connector, which apps/api builds once per isolate.
const REUSE_MS = 60_000;

export function qboRefresher(doFetch: () => QboFetch, keys: () => QboAppKeys): TokenRefresher {
  const inner = qboRefreshOnce(doFetch, keys);
  const refreshing = new Map<string, { at: number; answer: Promise<OAuthTokens> }>();
  return {
    refresh(tokens, opts) {
      const key = tokens.refreshToken ?? "";
      const now = Date.now();
      for (const [k, v] of refreshing) if (now - v.at > REUSE_MS) refreshing.delete(k);
      const hit = refreshing.get(key);
      if (hit) return hit.answer;
      const answer = inner.refresh(tokens, opts);
      refreshing.set(key, { at: now, answer });
      // A refused refresh is not reused: the next call asks Intuit again.
      answer.catch(() => refreshing.delete(key));
      return answer;
    },
  };
}

function qboRefreshOnce(doFetch: () => QboFetch, keys: () => QboAppKeys): TokenRefresher {
  return {
    async refresh(tokens, { now }) {
      const creds = QboCredentials.safeParse(tokens);
      if (!creds.success) {
        throw new ReconnectRequiredError("the stored QuickBooks credentials are not valid");
      }
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const answer = await qboTokenCall(doFetch(), keys(), {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
      if ("error" in answer) {
        // invalid_grant: revoked, expired (100 days unused), or an older refresh token.
        throw new ReconnectRequiredError(`Intuit refused the refresh: ${answer.error}`);
      }
      return { ...creds.data, ...tokensFrom(answer, now) };
    },
  };
}

// ── The company API ─────────────────────────────────────────────────────────────────────────────

export interface QboClientOptions {
  fetch: QboFetch;
  environment: QboEnvironment;
  refresher: TokenRefresher;
  minorVersion?: string;
  /** Waits between 429 retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
}

export interface QboClient {
  realmId: string;
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body: unknown, query?: Record<string, string>): Promise<unknown>;
  /** `select … from …` → the rows of `QueryResponse[entity]`. */
  query(sql: string, entity: string): Promise<{ rows: unknown[] }>;
  read(entity: string, id: string): Promise<Record<string, unknown> | null>;
  upload(file: {
    metadata: unknown;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    requestId: string;
  }): Promise<unknown>;
  download(attachableId: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

/** Retries after a 429: 1 s, 2 s, 4 s (or Retry-After), then the step's own retry takes over. */
const BACKOFF_MS = [1000, 2000, 4000];

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Single quotes in a QBO query literal are escaped with a backslash. */
export function qboLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * A client over one connection's company: the realm from the stored credentials (it must be the
 * connection's account), tokens refreshed before expiry and once on a 401, every call through the
 * realm's throttle.
 */
export async function qboClient(ctx: ToolContext, opts: QboClientOptions): Promise<QboClient> {
  const stored = QboCredentials.safeParse(await ctx.credentials.get());
  if (!stored.success) {
    throw new ReconnectRequiredError("the QuickBooks connection has no valid credentials");
  }
  const { realmId, environment } = stored.data;
  if (ctx.connection.externalAccountId && ctx.connection.externalAccountId !== realmId) {
    throw new ReconnectRequiredError("the stored QuickBooks company is not this connection's");
  }
  // A sandbox connection never reaches production, nor the other way round.
  if (environment !== opts.environment) {
    throw new ReconnectRequiredError(
      `this connection was made with QuickBooks ${environment}; this deployment uses ${opts.environment}`,
    );
  }
  const sleep = opts.sleep ?? defaultSleep;
  const base = `${QBO_API_BASE[environment]}/v3/company/${realmId}`;
  const minor = opts.minorVersion ?? QBO_MINOR_VERSION;
  const tokens = tokenManager({
    credentials: ctx.credentials,
    refresher: opts.refresher,
    now: ctx.now,
  });
  const throttle = throttleFor(realmId, sleep);

  async function send(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string>,
    body: { type: string; data: string | Uint8Array } | null,
    accept = "application/json",
  ): Promise<HttpResponseLike> {
    const url = `${base}${path}?${formEncode({ ...query, minorversion: minor })}`;
    for (let attempt = 0; ; attempt++) {
      const res = await throttle.run(() =>
        tokens.withAccessToken(
          (token) =>
            opts.fetch(url, {
              method,
              headers: {
                authorization: `Bearer ${token}`,
                accept,
                ...(body ? { "content-type": body.type } : {}),
              },
              ...(body ? { body: body.data } : {}),
              redirect: "manual",
              signal: timeoutSignal(30_000),
            }),
          (r) => r.status === 401,
        ),
      );
      if (res.status === 429 && attempt < BACKOFF_MS.length) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(after) && after > 0
            ? Math.min(after * 1000, 30_000)
            : (BACKOFF_MS[attempt] as number),
        );
        continue;
      }
      return res;
    }
  }

  async function json(res: HttpResponseLike): Promise<unknown> {
    const text = await res.text();
    const parsed = parseJson(text);
    if (res.status === 401) {
      throw new ReconnectRequiredError("QuickBooks refused the access token after a refresh");
    }
    const fault = readFault(parsed);
    const tid = intuitTidOf(res);
    if (!res.ok || fault) {
      const code = fault?.code ?? `HTTP_${res.status}`;
      const message = fault?.message ?? `QuickBooks answered ${res.status}`;
      if (code === "5010") throw new QboStaleObjectError(message, tid);
      throw new QboApiError(
        res.status,
        code,
        message,
        res.status === 429 || res.status >= 500,
        tid,
      );
    }
    if (parsed === null)
      throw new QboApiError(res.status, "NOT_JSON", "QuickBooks answered no JSON", true, tid);
    return parsed;
  }

  const client: QboClient = {
    realmId,
    async get(path, query = {}) {
      return json(await send("GET", path, query, null));
    },
    async post(path, data, query = {}) {
      return json(
        await send("POST", path, query, { type: "application/json", data: qboJson(data) }),
      );
    },
    async query(sql, entity) {
      const body = (await client.get("/query", { query: sql })) as {
        QueryResponse?: Record<string, unknown>;
      };
      const rows = body?.QueryResponse?.[entity];
      return { rows: Array.isArray(rows) ? rows : [] };
    },
    async read(entity, id) {
      try {
        const body = (await client.get(
          `/${entity.toLowerCase()}/${encodeURIComponent(id)}`,
        )) as Record<string, unknown> | null;
        const row = body?.[entity];
        return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
      } catch (error) {
        // An id QBO doesn't know: 400 with "Object Not Found" (code 610).
        if (error instanceof QboApiError && (error.code === "610" || error.status === 404)) {
          return null;
        }
        throw error;
      }
    },
    async upload(file) {
      const boundary = `mezonas-${file.requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
      const head = utf8(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file_metadata_0"\r\n' +
          "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
          `${JSON.stringify(file.metadata)}\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file_content_0"; filename="${file.filename.replace(/["\r\n]/g, "_")}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      );
      const tail = utf8(`\r\n--${boundary}--\r\n`);
      const data = new Uint8Array(head.length + file.bytes.length + tail.length);
      data.set(head, 0);
      data.set(file.bytes, head.length);
      data.set(tail, head.length + file.bytes.length);
      return json(
        await send(
          "POST",
          "/upload",
          { requestid: file.requestId },
          { type: `multipart/form-data; boundary=${boundary}`, data },
        ),
      );
    },
    async download(attachableId) {
      // The download endpoint answers a short-lived link to the file, as text.
      const res = await send(
        "GET",
        `/download/${encodeURIComponent(attachableId)}`,
        {},
        null,
        "text/plain, application/json",
      );
      const text = (await res.text()).trim();
      if (!res.ok) {
        const fault = readFault(parseJson(text));
        throw new QboApiError(
          res.status,
          fault?.code ?? `HTTP_${res.status}`,
          fault?.message ?? `QuickBooks answered ${res.status} for the download`,
          res.status === 429 || res.status >= 500,
          intuitTidOf(res),
        );
      }
      const link = checkPublicHttpsUrl(text);
      if (!link.ok) {
        throw new QboApiError(
          502,
          "BAD_DOWNLOAD_LINK",
          "QuickBooks gave no usable download link",
          false,
        );
      }
      // The link is presigned: no token goes with it.
      const file = await opts.fetch(link.url.href, {
        method: "GET",
        redirect: "manual",
        signal: timeoutSignal(60_000),
      });
      if (!file.ok || !file.arrayBuffer) {
        throw new QboApiError(
          file.status,
          "DOWNLOAD_FAILED",
          "the attachment could not be downloaded",
          file.status >= 500,
        );
      }
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.headers.get("content-type"),
      };
    },
  };
  return client;
}

/**
 * QBO's `requestid` (its idempotency key, at most 50 characters as far as we know) from an
 * external action's idempotency key: the same action always sends the same id.
 */
export async function qboRequestId(idempotencyKey: string): Promise<string> {
  return toHex(await sha256Bytes(utf8(`qbo:${idempotencyKey}`))).slice(0, 36);
}
