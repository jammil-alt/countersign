import { buildPath, type RouteSpec } from "@countersign/core";
import type { z } from "zod";

/**
 * The typed API client. Paths, methods and shapes come from the route contract (packages/core,
 * plus ./routes.ts until those routes move there): a call names a route and gets back that
 * route's parsed response. Request bodies are checked before they leave and responses are
 * parsed with the route's schema, so a contract break shows up as an `invalid_response` error
 * here instead of as a screen quietly rendering the wrong thing.
 */

type Parts<R> =
  R extends RouteSpec<infer P, infer Q, infer B, infer Res>
    ? { params: P; query: Q; body: B; response: Res }
    : never;

/** A route that does not declare a part is left at the default `z.ZodType`. */
type Declared<S, Else> = z.ZodType extends S ? Else : S extends z.ZodType ? z.input<S> : Else;

export type ParamsOf<R extends RouteSpec> = Declared<
  Parts<R>["params"],
  Record<string, string | number>
>;
export type QueryOf<R extends RouteSpec> = Declared<
  Parts<R>["query"],
  Record<string, string | number | boolean | null | undefined>
>;
export type BodyOf<R extends RouteSpec> = Declared<Parts<R>["body"], never>;
export type ResponseOf<R extends RouteSpec> = z.output<Parts<R>["response"]>;

export interface CallOptions<R extends RouteSpec> {
  params?: ParamsOf<R>;
  query?: QueryOf<R>;
  body?: BodyOf<R>;
  signal?: AbortSignal;
}

/**
 * Why a call failed.
 * - `network`: no response at all (offline, the Worker is not running).
 * - `invalid_request`: the body failed the route's schema, so nothing was sent.
 * - `invalid_response`: a 2xx whose body is not JSON or does not match the route's schema.
 * - otherwise the server's own code (`unauthenticated`, `forbidden`, …) or `http_<status>`.
 */
export class ApiError extends Error {
  override name = "ApiError";
  /** HTTP status; 0 when there was no response. */
  readonly status: number;
  readonly code: string;
  /** `GET /api/ops/clients`: which call failed. */
  readonly route: string;
  /** The parsed error body, when the server sent JSON. */
  readonly body: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    route: string;
    body?: unknown;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.route = init.route;
    this.body = init.body;
  }

  /** Not signed in, or the session is gone: the app shows sign-in. */
  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export interface ApiClient {
  call<R extends RouteSpec>(route: R, options?: CallOptions<R>): Promise<ResponseOf<R>>;
}

export interface ClientOptions {
  /** Same-origin by default: the Worker serves the app and the API. */
  baseUrl?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export function createApiClient(options: ClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async call(route, opts = {}) {
      const name = `${route.method} ${route.path}`;
      const fail = (init: Omit<ConstructorParameters<typeof ApiError>[0], "route">) =>
        new ApiError({ ...init, route: name });

      let params = opts.params as Record<string, string | number> | undefined;
      if (route.params) {
        const parsed = route.params.safeParse(params ?? {});
        if (!parsed.success) {
          throw fail({ status: 0, code: "invalid_request", message: issues(parsed.error) });
        }
        params = parsed.data as Record<string, string | number>;
      }
      let path: string;
      try {
        path = buildPath(route.path, params);
      } catch (e) {
        throw fail({ status: 0, code: "invalid_request", message: (e as Error).message });
      }

      let body: string | undefined;
      if (opts.body !== undefined) {
        if (route.body) {
          const parsed = route.body.safeParse(opts.body);
          if (!parsed.success) {
            throw fail({ status: 0, code: "invalid_request", message: issues(parsed.error) });
          }
        }
        body = JSON.stringify(opts.body);
      }

      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      const init: RequestInit = { method: route.method, headers, credentials: "same-origin" };
      if (body !== undefined) init.body = body;
      if (opts.signal) init.signal = opts.signal;

      let res: Response;
      try {
        const query = opts.query as Record<string, unknown> | undefined;
        res = await doFetch(`${baseUrl}${path}${queryString(query)}`, init);
      } catch (e) {
        // An abort is the caller's choice, not a failure to report.
        if (isAbort(e)) throw e;
        throw fail({
          status: 0,
          code: "network",
          message: "The API could not be reached.",
          cause: e,
        });
      }

      const text = await res.text();
      let json: unknown;
      let isJson = false;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
          isJson = true;
        } catch {
          // Left undefined: a proxy error page or a plain-text body.
        }
      }

      if (!res.ok) {
        const { code, message } = describeError(json);
        throw fail({
          status: res.status,
          code: code ?? defaultCode(res.status),
          message: message ?? code ?? (res.statusText || `The API answered ${res.status}.`),
          body: isJson ? json : text,
        });
      }

      if (!isJson && text.length > 0) {
        throw fail({
          status: res.status,
          code: "invalid_response",
          message: "The API answered with something that is not JSON.",
          body: text,
        });
      }
      const parsed = route.response.safeParse(json);
      if (!parsed.success) {
        throw fail({
          status: res.status,
          code: "invalid_response",
          message: `The response does not match the contract: ${issues(parsed.error)}`,
          body: json,
        });
      }
      return parsed.data as ResponseOf<typeof route>;
    },
  };
}

/** The app's client, same-origin. */
export const api = createApiClient();

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/**
 * Error bodies seen so far: `{ error: "code", message }` and `{ error: { code, message } }`,
 * and the auth refusals' `{ code, message }`. Read leniently: the code is what screens act on.
 */
function describeError(json: unknown): { code?: string; message?: string } {
  if (typeof json !== "object" || json === null) return {};
  const r = json as Record<string, unknown>;
  const inner =
    typeof r.error === "object" && r.error !== null ? (r.error as Record<string, unknown>) : r;
  const code =
    typeof r.error === "string" ? r.error : typeof inner.code === "string" ? inner.code : undefined;
  const message = typeof inner.message === "string" ? inner.message : undefined;
  const out: { code?: string; message?: string } = {};
  if (code !== undefined) out.code = code;
  if (message !== undefined) out.message = message;
  return out;
}

function defaultCode(status: number): string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return `http_${status}`;
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}
