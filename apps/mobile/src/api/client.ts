// The app's typed API client: paths, methods and shapes from the route contract (packages/core),
// bodies checked before they leave and responses parsed with the route's schema, as apps/web's
// client does. What differs on a phone (docs/plan.md §1.97):
// - the session travels in MOBILE_SESSION_HEADER, not a cookie; a response that carries the header
//   hands back the session sealed again (a WorkOS refresh), or an empty value when it ended;
// - SESSION_ACTIVITY_HEADER marks the requests the person made, so background refreshes never
//   keep an unattended session alive;
// - a 401 signs the app out.
import {
  buildPath,
  MOBILE_SESSION_HEADER,
  type RouteSpec,
  SESSION_ACTIVITY_HEADER,
} from "@countersign/core";
import type { z } from "zod";

/** The dev adapter's header (packages/auth DEV_USER_HEADER): local `wrangler dev` only. */
export const DEV_USER_HEADER = "x-countersign-dev-user";

type Parts<R> =
  R extends RouteSpec<infer P, infer Q, infer B, infer Res>
    ? { params: P; query: Q; body: B; response: Res }
    : never;
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
  /** The person asked for this (a tap, a pull to refresh): it counts as activity. */
  byPerson?: boolean;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly route: string;
  constructor(init: { status: number; code: string; message: string; route: string }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.route = init.route;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** Who the app is signed in as: a sealed session, or (dev only) the dev adapter's email. */
export type Credentials =
  | { kind: "session"; session: string }
  | { kind: "dev"; email: string }
  | { kind: "none" };

export interface SessionHooks {
  credentials(): Credentials;
  /** The API sealed the session again: keep the new one. */
  renewed(session: string): void;
  /** The session ended (an empty header, or a 401): back to sign-in. */
  ended(): void;
}

export interface ApiClient {
  call<R extends RouteSpec>(route: R, options?: CallOptions<R>): Promise<ResponseOf<R>>;
}

export function createApiClient(options: {
  origin: string;
  session: SessionHooks;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): ApiClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const origin = options.origin.replace(/\/+$/, "");

  return {
    async call(route, opts = {}) {
      const name = `${route.method} ${route.path}`;
      const fail = (status: number, code: string, message: string) =>
        new ApiError({ status, code, message, route: name });

      let params = opts.params as Record<string, string | number> | undefined;
      if (route.params) {
        const parsed = route.params.safeParse(params ?? {});
        if (!parsed.success) throw fail(0, "invalid_request", parsed.error.message);
        params = parsed.data as Record<string, string | number>;
      }
      const path = buildPath(route.path, params);

      let body: string | undefined;
      if (opts.body !== undefined) {
        if (route.body) {
          const parsed = route.body.safeParse(opts.body);
          if (!parsed.success) throw fail(0, "invalid_request", parsed.error.message);
        }
        body = JSON.stringify(opts.body);
      }

      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (opts.byPerson) headers[SESSION_ACTIVITY_HEADER] = "1";
      const who = options.session.credentials();
      if (who.kind === "session") headers[MOBILE_SESSION_HEADER] = who.session;
      if (who.kind === "dev") headers[DEV_USER_HEADER] = who.email;

      const init: RequestInit = { method: route.method, headers };
      if (body !== undefined) init.body = body;
      if (opts.signal) init.signal = opts.signal;

      let res: Response;
      try {
        res = await doFetch(`${origin}${path}${queryString(opts.query)}`, init);
      } catch {
        throw fail(0, "network", "We could not reach Mezonas. Check your connection.");
      }

      // The session, sealed again or ended, whatever the status.
      const renewed = res.headers.get(MOBILE_SESSION_HEADER);
      if (renewed !== null && who.kind === "session") {
        if (renewed === "") options.session.ended();
        else if (renewed !== who.session) options.session.renewed(renewed);
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        if (res.status === 401 && who.kind !== "none") options.session.ended();
        const { code, message } = describeError(json);
        throw fail(
          res.status,
          code ?? `http_${res.status}`,
          message ?? `The API answered ${res.status}.`,
        );
      }
      const parsed = route.response.safeParse(json);
      if (!parsed.success) {
        throw fail(res.status, "invalid_response", "The response does not match the contract.");
      }
      return parsed.data as ResponseOf<typeof route>;
    },
  };
}

function queryString(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

function describeError(json: unknown): { code?: string; message?: string } {
  if (typeof json !== "object" || json === null) return {};
  const r = json as Record<string, unknown>;
  const inner =
    typeof r.error === "object" && r.error !== null ? (r.error as Record<string, unknown>) : r;
  const out: { code?: string; message?: string } = {};
  if (typeof r.error === "string") out.code = r.error;
  else if (typeof inner.code === "string") out.code = inner.code;
  if (typeof inner.message === "string") out.message = inner.message;
  return out;
}
