// Error tracking (Sentry; owner, 2026-11-04): every exception the Worker does not handle, from API
// routes, the cron and RunWorkflow, grouped and counted in the Mezonas Sentry projects. Pattern
// copied from Plenary Labs; nothing is shared with it (its own projects, keys and DSNs).
//
// Off until `SENTRY_DSN` is set for the environment (the deploy passes it with `--var`): with no
// DSN the SDK never starts, so local development and the tests send nothing. The DSN is not a
// secret: it only lets a client send events.
//
// Mezonas holds clients' business data, so what leaves the Worker is held to what debugging
// needs (CLAUDE.md invariants 1 and 9): no request bodies, no cookies or headers but the user
// agent, no query strings (sign-in codes and webhook tokens ride in them), no IP or email, no
// model inputs or outputs, no database query data, no local variables, no performance traces;
// exception messages are cut short and stripped of query parameters and anything shaped like a
// key or token. Set in `DATA_COLLECTION`, and again in `scrubEvent`.

import type { Breadcrumb, ErrorEvent } from "@sentry/cloudflare";

const MAX_MESSAGE = 500;

/** A URL without its query string or fragment. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * A message without the bound values Drizzle appends to a failed query (`Failed query: …\nparams:
 * a,b,c`): those are the client's row being written. The statement itself stays.
 */
export function withoutQueryParams(message: string): string {
  const cut = message.search(/\nparams:/);
  return cut === -1 ? message : `${message.slice(0, cut)}\nparams: (removed)`;
}

/**
 * Anything shaped like a credential: API keys (`sk-…`, `sk_test_…`, `sk-ant-…`), bearer tokens,
 * JWTs and connection strings with a password.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(sk|rk|pk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@/gi,
];

export function withoutSecrets(text: string): string {
  return SECRET_SHAPES.reduce((s, re) => s.replace(re, "(removed)"), text);
}

const cap = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);
const clean = (s: string) => cap(withoutSecrets(withoutQueryParams(s)));

/** What the SDK may collect at all: the user agent, and nothing of the request's content. */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ["user-agent"] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

/** `beforeSend`: strip an event down to what debugging needs (the header comment says what). */
export function scrubEvent<E extends ErrorEvent>(event: E): E {
  if (event.request) {
    const userAgent = event.request.headers?.["user-agent"];
    event.request.headers = userAgent ? { "user-agent": userAgent } : {};
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (event.message) event.message = clean(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = clean(ex.value);
    // A multi-line message comes back from the SDK's stack parser as "frames" with no line
    // number, carrying its text; a real frame always has a line.
    const frames = ex.stacktrace?.frames;
    if (frames) {
      ex.stacktrace = { ...ex.stacktrace, frames: frames.filter((f) => f.lineno !== undefined) };
    }
  }
  return event;
}

/** `beforeBreadcrumb`: no console lines (they can carry content); URLs without queries. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "console") return null;
  if (crumb.message) crumb.message = clean(crumb.message);
  if (crumb.data && typeof crumb.data.url === "string") {
    crumb.data = { ...crumb.data, url: withoutQuery(crumb.data.url) };
  }
  return crumb;
}

interface SentryEnv {
  readonly SENTRY_DSN?: string;
  readonly ENVIRONMENT?: string;
  readonly DEPLOYED_SHA?: string;
}

/** The SDK's options for this environment; no DSN means Sentry stays off. */
export function sentryOptions(env: SentryEnv) {
  const dsn = env.SENTRY_DSN?.trim();
  const release = env.DEPLOYED_SHA?.trim();
  return {
    ...(dsn ? { dsn } : {}),
    environment: env.ENVIRONMENT?.trim() || "development",
    ...(release ? { release } : {}),
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
