// What every provider other than Anthropic shares: a JSON POST per call with a key, retries after
// a rate limit, overload, server error or dropped connection, a time limit per attempt, and
// errors worded the same way, so a run's error key (core's `runErrorCode`) reads the same
// whichever provider failed. Each provider's module supplies only its URL, headers and the two
// translations (./openai.ts and ./xai.ts on the Responses API, ./gemini.ts on generateContent).
//
// Plain fetch, no SDK: the Worker stays light and a test can pass its own fetch.

import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** What went wrong, for callers that act on it; the message says the same in words. */
export type ProviderErrorKind =
  | "rate_limited"
  | "overloaded"
  | "unauthorized"
  | "bad_request"
  | "timeout"
  | "server"
  | "failed";

export function errorKind(status: number | null, code: string | null = null): ProviderErrorKind {
  if (status === 429 || code === "RESOURCE_EXHAUSTED" || code === "rate_limit_exceeded") {
    return "rate_limited";
  }
  if (status === 503 || status === 529 || code === "UNAVAILABLE" || code === "overloaded") {
    return "overloaded";
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 408 || status === 504 || code === "DEADLINE_EXCEEDED") return "timeout";
  if (status !== null && status >= 500) return "server";
  if (status !== null && status >= 400) return "bad_request";
  return "failed";
}

/**
 * A provider answered with an error, its answer was a failed response, or it did not answer in
 * time. The message starts with the provider and the status (`xAI 429: …`); an overload says so
 * (`Google 503 (overloaded): …`), so a run's error key is `rate_limited` or `overloaded` as with
 * Anthropic's own errors.
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  readonly status: number | null;
  readonly code: string | null;
  readonly kind: ProviderErrorKind;
  constructor(
    message: string,
    status: number | null,
    code: string | null = null,
    kind: ProviderErrorKind = errorKind(status, code),
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

/** A request the translation can't express. A programming error, not a model failure. */
export class ProviderRequestError extends Error {
  override name = "ProviderRequestError";
}

/** A provider's own error class, made the same way as `ProviderError`. */
export type ProviderErrorClass = new (
  message: string,
  status: number | null,
  code?: string | null,
  kind?: ProviderErrorKind,
) => ProviderError;

/** The message and code in an error body: OpenAI's, xAI's and Google's shapes. */
export function errorDetail(text: string): { message: string; code: string | null } {
  let message = text.slice(0, 500);
  let code: string | null = null;
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: string | { message?: unknown; code?: unknown; status?: unknown };
    };
    const e = parsed.error;
    if (typeof e === "string") {
      // xAI: {"code": "...", "error": "..."}.
      message = e;
      code = typeof parsed.code === "string" ? parsed.code : null;
    } else if (e && typeof e === "object") {
      if (typeof e.message === "string") message = e.message;
      // OpenAI's code is a string; Google's is the HTTP status, with its name in `status`.
      code = typeof e.code === "string" ? e.code : typeof e.status === "string" ? e.status : null;
    }
  } catch {
    // Not JSON; keep the start of the body.
  }
  return { message, code };
}

/** `<vendor> <status>: <message>`, with "(overloaded)" when it was. */
// DECISION (Models: xAI and Gemini): the error kind is said in the message as well as in `kind`,
// since a step reports its error as text and the run's error key is read from that text.
export function providerError(
  Class: ProviderErrorClass,
  vendor: string,
  status: number,
  text: string,
): ProviderError {
  const { message, code } = errorDetail(text);
  const kind = errorKind(status, code);
  const tag = kind === "overloaded" ? " (overloaded)" : "";
  return new Class(`${vendor} ${status}${tag}: ${message}`, status, code, kind);
}

export interface HttpTransportOptions {
  readonly apiKey: string;
  /** Injected so a Worker, a test or a proxy decides how requests leave. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** Defaults to the provider's own API. */
  readonly baseURL?: string;
  /** Per attempt. Defaults to 10 minutes: agent calls with reasoning can run long. */
  readonly timeoutMs?: number;
  /** Retries after a rate limit, overload, server error or dropped connection. Defaults to 2. */
  readonly maxRetries?: number;
  /** Waits between retries; tests pass one that doesn't. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One provider's wire format. */
export interface ProviderWire {
  /** As people see it, in messages: `OpenAI`, `xAI`, `Google`. */
  readonly vendor: string;
  readonly defaultBaseURL: string;
  /** The provider's error class (so `instanceof OpenAIError` and the like keep working). */
  readonly errorClass: ProviderErrorClass;
  url(baseURL: string, request: LlmRequest): string;
  headers(apiKey: string): Record<string, string>;
  body(request: LlmRequest): unknown;
  answer(json: unknown, request: LlmRequest): LlmMessage;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * The transport for one provider. Nothing is kept at the provider between calls: every request
 * carries its whole transcript, as with Anthropic.
 */
export function httpTransport(wire: ProviderWire, options: HttpTransportOptions): LlmTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let base = options.baseURL ?? wire.defaultBaseURL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async create(request, opts) {
      const url = wire.url(base, request);
      const body = JSON.stringify(wire.body(request));
      for (let attempt = 0; ; attempt += 1) {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (opts?.signal) signals.push(opts.signal);
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: { ...wire.headers(options.apiKey), "content-type": "application/json" },
            body,
            signal: AbortSignal.any(signals),
          });
        } catch (error) {
          if (opts?.signal?.aborted) throw error;
          if (attempt < maxRetries) {
            await sleep(retryDelayMs(attempt, null));
            continue;
          }
          if (isTimeout(error)) {
            throw new wire.errorClass(
              `${wire.vendor} timed out after ${Math.round(timeoutMs / 1000)} s`,
              null,
              null,
              "timeout",
            );
          }
          throw error;
        }
        if (res.ok) return wire.answer(await res.json(), request);
        if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw providerError(wire.errorClass, wire.vendor, res.status, await res.text());
      }
    },
  };
}
