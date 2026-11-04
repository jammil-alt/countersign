// Error tracking in the browser (Sentry; owner, 2026-11-04): a screen that crashes, a request that
// never reached the API, a 5xx, or an answer that broke its contract reaches the mezonas-web
// Sentry project, with the route and the release. Pattern copied from Plenary Labs; nothing is
// shared with it.
//
// Off unless the build was given a DSN (`VITE_SENTRY_DSN`, from the deploy; not a secret) and the
// page is on a deployed host: local development and the tests never start it.
//
// What leaves the browser is held to what debugging needs, the same rules as the Worker's
// (apps/api/src/observability/sentry.ts): no request or response bodies, no cookies, no headers
// but the user agent, no query strings or fragments, no console lines, no IP or email (the user
// is their id), exception messages cut short, no session replay and no performance traces.

import * as Sentry from "@sentry/react";
import type { ApiError } from "./api/client";

const MAX_MESSAGE = 500;

/** A URL without its query string or fragment. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

const cap = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** `beforeSend`: strip an event down to what debugging needs (the header comment says what). */
export function scrubEvent<E extends Sentry.ErrorEvent>(event: E): E {
  if (event.request) {
    const userAgent =
      event.request.headers?.["User-Agent"] ?? event.request.headers?.["user-agent"];
    event.request.headers = userAgent ? { "user-agent": userAgent } : {};
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (event.message) event.message = cap(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = cap(ex.value);
  return event;
}

/** `beforeBreadcrumb`: no console lines (they can carry content); URLs without queries. */
export function scrubBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (crumb.category === "console") return null;
  if (crumb.data) {
    const data = { ...crumb.data };
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = withoutQuery(data[key] as string);
    }
    crumb.data = data;
  }
  return crumb;
}

/** Which environment a page is in, by its host; null where Sentry stays off. */
export function environmentOf(hostname: string): "staging" | "production" | null {
  if (hostname === "staging.mezonas.com") return "staging";
  if (hostname === "app.mezonas.com") return "production";
  return null;
}

let started = false;

/**
 * Whether this page is being left. A navigation, a reload or a redirect to sign-in cancels the
 * requests still in flight, and the browser rejects them like an API that is down; those are not
 * reported (Plenary Labs learned this the noisy way).
 */
let leaving = false;
/** A test harness drives this browser (Playwright): its cut-off requests are not news either. */
let automated = false;

/** Start Sentry, once, when the build has a DSN and the page is on a deployed host. */
export function startErrorTracking(): void {
  const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim();
  const environment = typeof window === "undefined" ? null : environmentOf(location.hostname);
  if (started || !dsn || environment === null) return;
  started = true;
  automated = navigator.webdriver === true;
  addEventListener("pagehide", () => {
    leaving = true;
  });
  addEventListener("pageshow", () => {
    leaving = false;
  });
  const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined)?.trim();
  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["user-agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  Sentry.setTag("surface", location.pathname.startsWith("/ops") ? "ops" : "portal");
  if (automated) Sentry.setTag("automated", "true");
}

/** Who saw it: their id and whether they are the operator, never their email. Null: signed out. */
export function identifyForErrors(who: { id: string; operator: boolean } | null): void {
  if (!started) return;
  Sentry.setUser(who ? { id: who.id } : null);
  Sentry.setTag("operator", who ? String(who.operator) : "signed_out");
}

/** A screen that crashed (React's root error handlers). */
export function reportScreenCrash(error: unknown, componentStack: string | undefined): void {
  if (!started) return;
  Sentry.captureException(error, {
    tags: { kind: "screen_crash" },
    ...(componentStack ? { contexts: { react: { componentStack } } } : {}),
  });
}

/**
 * Which kind of failure a call is; null for one not worth reporting: a refusal or a validation
 * error (4xx, the API working), a body we refused to send, or a request that never got an answer
 * while that is no news (the page was being left, or a test harness drives the browser).
 */
export function apiFailureKind(
  error: Pick<ApiError, "status" | "code">,
  unreachableIsNoise: boolean,
): "api_unreachable" | "api_contract" | "api_5xx" | null {
  if (error.code === "network") return unreachableIsNoise ? null : "api_unreachable";
  if (error.code === "invalid_response") return "api_contract";
  return error.status >= 500 ? "api_5xx" : null;
}

/** A call that failed in a way no user can fix (the API client's `onFailure`). */
export function reportApiFailure(error: ApiError): void {
  if (!started) return;
  const kind = apiFailureKind(error, leaving || automated);
  if (kind === null) return;
  Sentry.captureException(error, {
    tags: { kind, route: error.route, status: String(error.status) },
    fingerprint: [kind, error.route, String(error.status)],
  });
}
