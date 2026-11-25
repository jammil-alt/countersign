import {
  AUDIT_REFRESH_HEADER,
  buildPath,
  type RouteSpec,
  SESSION_ACTIVITY_HEADER,
} from "@countersign/core";
import type { z } from "zod";
import { noteLockedFailure } from "../lockdown/locked";
import { reportApiFailure } from "../observability";
import { recentlyActive } from "../session/activity";

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
  /**
   * A read that refreshes what is already on screen (a poll, a reload): sent with
   * AUDIT_REFRESH_HEADER, so its audit row isn't counted as the person opening the page (S6.9).
   */
  refresh?: boolean;
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
  /** The call as made, without its query: `GET /api/runs/not-a-uuid`; null when it wasn't built. */
  readonly request: string | null;
  /**
   * A path parameter of the route was refused (`/runs/not-a-uuid`): here, before anything was
   * sent, or by the server's 400. To the person it is a page that doesn't exist, not a failure.
   */
  readonly badParam: boolean;
  /** Sentry's event for this failure, when it was reported there (5xx, network). */
  sentryEventId: string | null = null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    route: string;
    body?: unknown;
    cause?: unknown;
    request?: string | null;
    badParam?: boolean;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.route = init.route;
    this.body = init.body;
    this.request = init.request ?? null;
    this.badParam = init.badParam ?? false;
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
  /** Told about every failed call (the app's error tracking decides which are worth reporting). */
  onFailure?: (error: ApiError) => void;
}

export function createApiClient(options: ClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async call(route, opts = {}) {
      const name = `${route.method} ${route.path}`;
      let request: string | null = null;
      const fail = (init: Omit<ConstructorParameters<typeof ApiError>[0], "route">) => {
        const error = new ApiError({ request, ...init, route: name });
        // §1.243: a locked account shows the portal's locked page, whichever screen asked.
        noteLockedFailure(error);
        options.onFailure?.(error);
        return error;
      };

      let params = opts.params as Record<string, string | number> | undefined;
      if (route.params) {
        const parsed = route.params.safeParse(params ?? {});
        if (!parsed.success) {
          // The call as it would have been, so a report says which address was refused.
          request = `${route.method} ${rawPath(route.path, params)}`;
          throw fail({
            status: 0,
            code: "invalid_request",
            message: issues(parsed.error),
            badParam: true,
          });
        }
        params = parsed.data as Record<string, string | number>;
      }
      let path: string;
      try {
        path = buildPath(route.path, params);
      } catch (e) {
        throw fail({ status: 0, code: "invalid_request", message: (e as Error).message });
      }
      request = `${route.method} ${path}`;

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
      // Only the person's own requests keep the session alive (docs/plan.md §1.35).
      if (recentlyActive()) headers[SESSION_ACTIVITY_HEADER] = "1";
      if (body !== undefined) headers["content-type"] = "application/json";
      if (opts.refresh && route.method === "GET") headers[AUDIT_REFRESH_HEADER] = "1";
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
          badParam: res.status === 400 && refusesParam(route.path, json),
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

/** The app's client, same-origin; failures go to error tracking (a no-op where it is off). */
export const api = createApiClient({ onFailure: reportApiFailure });

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

/** The route's path with its parameters filled in as given, unchecked (`/api/runs/not-a-uuid`). */
function rawPath(pattern: string, params: Record<string, string | number> | undefined): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k: string) =>
    encodeURIComponent(String(params?.[k] ?? `:${k}`)),
  );
}

/** Whether a server's 400 names one of the route's path parameters (its first issue's field). */
function refusesParam(pattern: string, json: unknown): boolean {
  const names = [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  if (names.length === 0 || typeof json !== "object" || json === null) return false;
  const inner = (json as { error?: unknown }).error;
  const details =
    typeof inner === "object" && inner !== null ? (inner as { details?: unknown }).details : null;
  if (!Array.isArray(details)) return false;
  const field = (details[0] as { path?: unknown[] } | undefined)?.path?.[0];
  return typeof field === "string" && names.includes(field);
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
