// The app's way to the Mezonas API (docs/plan.md §1.151). Two kinds of request:
// - as the person: the sealed session from sign-in, in MOBILE_SESSION_HEADER, as the phone app
//   sends it (the API answers a refreshed session in the same header, or an empty one when it
//   ended); routes from core's contract, bodies and answers checked with its schemas;
// - as this computer: signed with its own key (keys.ts), for jobs, results and files. These work
//   while nobody is signed in, and only for this computer's own jobs.
// A port of apps/mobile's client, narrowed to what the desktop needs (apps import no app).

import {
  buildPath,
  MOBILE_SESSION_HEADER,
  type RouteSpec,
  SESSION_ACTIVITY_HEADER,
  trimTrailingSlashes,
} from "@countersign/core";
import type { z } from "zod";
import { signedHeaders } from "./keys";

/** The dev adapter's header (packages/auth DEV_USER_HEADER): local `wrangler dev` only. */
export const DEV_USER_HEADER = "x-countersign-dev-user";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Credentials =
  | { kind: "session"; session: string }
  | { kind: "dev"; email: string }
  | { kind: "none" };

export interface ApiOptions {
  origin: string;
  fetch?: Fetch;
  now?: () => Date;
  credentials(): Credentials;
  /** The API sealed the session again: keep it. */
  renewed(session: string): void;
  /** The session ended (empty header or a 401). */
  ended(): void;
  /** This computer's id and key, once paired. */
  device(): { deviceId: string; privatePem: string } | null;
}

type Parts<R> =
  R extends RouteSpec<infer P, infer Q, infer B, infer Res>
    ? { params: P; query: Q; body: B; response: Res }
    : never;
type Declared<S, Else> = z.ZodType extends S ? Else : S extends z.ZodType ? z.input<S> : Else;

export interface CallOptions<R extends RouteSpec> {
  params?: Declared<Parts<R>["params"], Record<string, string | number>>;
  query?: Declared<Parts<R>["query"], Record<string, string | number | boolean | undefined>>;
  body?: Declared<Parts<R>["body"], never>;
  byPerson?: boolean;
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function errorOf(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `Mezonas answered ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // No JSON: the status says enough.
  }
  return new ApiError(res.status, code, message);
}

export class Api {
  private readonly doFetch: Fetch;
  readonly origin: string;

  constructor(private readonly options: ApiOptions) {
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.origin = trimTrailingSlashes(options.origin);
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, init);
    } catch {
      throw new ApiError(0, "network", "We couldn't reach Mezonas. Check the connection.");
    }
  }

  /** As the person, a route of core's contract. */
  async call<R extends RouteSpec>(
    route: R,
    opts: CallOptions<R> = {},
  ): Promise<z.output<Parts<R>["response"]>> {
    const params = route.params ? route.params.parse(opts.params ?? {}) : undefined;
    const path = buildPath(route.path, params as Record<string, string | number> | undefined);
    if (opts.body !== undefined && route.body) route.body.parse(opts.body);
    const res = await this.asPerson(
      route.method,
      `${path}${queryString(opts.query as Record<string, unknown> | undefined)}`,
      opts.body,
      opts.byPerson ?? false,
      route.auth !== "public",
    );
    const parsed = route.response.safeParse(await res.json());
    if (!parsed.success)
      throw new ApiError(res.status, "invalid_response", "Mezonas's answer wasn't readable.");
    return parsed.data as z.output<Parts<R>["response"]>;
  }

  /** As the person, any path (the desktop's own routes); throws ApiError unless 2xx. */
  async asPerson(
    method: string,
    path: string,
    body?: unknown,
    byPerson = true,
    needsSession = true,
  ): Promise<Response> {
    const who = this.options.credentials();
    if (who.kind === "none" && needsSession) {
      throw new ApiError(401, "signed_out", "Sign in to Mezonas first.");
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (who.kind === "session") headers[MOBILE_SESSION_HEADER] = who.session;
    if (who.kind === "dev") headers[DEV_USER_HEADER] = who.email;
    if (byPerson) headers[SESSION_ACTIVITY_HEADER] = "1";
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.send(`${this.origin}${path}`, init);
    const renewed = res.headers.get(MOBILE_SESSION_HEADER);
    if (renewed !== null && who.kind === "session") {
      if (renewed === "") this.options.ended();
      else if (renewed !== who.session) this.options.renewed(renewed);
    }
    if (res.status === 401 && needsSession) this.options.ended();
    if (!res.ok) throw await errorOf(res);
    return res;
  }

  /** As this computer, signed with its key. Answers the response whatever its status. */
  async asDevice(
    method: string,
    path: string,
    body: Uint8Array | string = "",
    contentType = "application/json",
  ): Promise<Response> {
    const device = this.options.device();
    if (!device) throw new ApiError(401, "not_paired", "This computer isn't paired with Mezonas.");
    // The signature covers the path without the query: the API checks the same.
    const signedPath = path.split("?")[0] ?? path;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...signedHeaders({
        ...device,
        method,
        path: signedPath,
        body,
        at: (this.options.now ?? (() => new Date()))(),
      }),
    };
    const init: RequestInit = { method, headers };
    if (method !== "GET") {
      headers["content-type"] = contentType;
      init.body = typeof body === "string" ? body : new Blob([body as Uint8Array<ArrayBuffer>]);
    }
    return this.send(`${this.origin}${path}`, init);
  }
}
