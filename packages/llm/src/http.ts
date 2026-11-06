// What every plain-fetch model transport shares (OpenAI, xAI, Gemini): one JSON POST with a time
// limit per attempt, retried after a rate limit, overload, server error or dropped connection.

export interface HttpTransportOptions {
  readonly apiKey: string;
  /** Injected so a Worker, a test or a proxy decides how requests leave. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** The provider's API root; each transport has its own default. */
  readonly baseURL?: string;
  /** Per attempt. Defaults to 10 minutes: agent calls with reasoning can run long. */
  readonly timeoutMs?: number;
  /** Retries after a rate limit, overload, server error or dropped connection. Defaults to 2. */
  readonly maxRetries?: number;
  /** Waits between retries; tests pass one that doesn't. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * Posts `body` to `url` and answers the first response that is ok or not worth retrying (or the
 * last one once retries run out). A network failure is retried too, then thrown.
 */
export async function postJson(
  options: HttpTransportOptions,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries) throw error;
      await sleep(retryDelayMs(attempt, null));
      continue;
    }
    if (!res.ok && RETRY_STATUS.has(res.status) && attempt < maxRetries) {
      await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    return res;
  }
}

/** The error message and code of a failed response, from its JSON body when it has one. */
export async function errorDetail(
  res: Response,
): Promise<{ message: string; code: string | null }> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string | number; status?: string };
    };
    // Gemini names the kind in `status` (its `code` is the HTTP status); OpenAI and xAI in `code`.
    const code = parsed.error?.status ?? parsed.error?.code ?? null;
    return {
      message: parsed.error?.message ?? text.slice(0, 500),
      code: code === null ? null : String(code),
    };
  } catch {
    return { message: text.slice(0, 500), code: null };
  }
}

/** `base` without trailing slashes. */
export function apiRoot(base: string): string {
  return base.replace(/\/+$/, "");
}
