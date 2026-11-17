// Where a state-changing request came from (docs/plan.md §1.35). The session cookie is
// `SameSite=Lax`, and every host under the same registrable domain counts as the same site for it,
// so the cookie alone doesn't show that a POST came from the app's own pages. Every request under
// /api other than GET, HEAD and OPTIONS must come from the app's own origin, as the browser
// reports it, unless it is one of the machine endpoints below or carries the phone app's session
// header. A route added later is checked by default; `request-origin.test.ts` holds the exempt
// list against the app's actual routes.

import { MOBILE_SESSION_HEADER } from "@countersign/core";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "./env";
import type { AppEnv } from "./http";
import { originOf } from "./notify/outbox";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths whose non-safe requests are not checked: endpoints that other services, phones and
 * outside web pages call, authenticated by a signature, a token in the path or the body, or not at
 * all, and never by the session cookie. Each entry is a whole path, or a prefix when it ends in `/`.
 */
export const ORIGIN_EXEMPT_PATHS: readonly string[] = [
  // Providers' webhooks, each checked by its signature or token.
  "/api/hooks/", // generic webhooks (token in the path), Zoho CRM, Google Chat, Teams, WhatsApp
  "/api/connections/qbo/webhook",
  "/api/connections/bankfeed/webhook/",
  "/api/billing/stripe/webhook",
  "/api/twilio/",
  "/api/voice/",
  "/api/elevenlabs/post-call",
  // A pack's inbound (a measured website's beacon, sent from that website's pages).
  "/api/in/",
  // Public pages opened from a link with a token: texting sign-up, forms.
  "/api/text-signup/",
  "/api/forms/",
  // The phone app trades its sign-in code and verifier for a session; it holds no cookie.
  "/api/mobile/session",
];

export function originExempt(path: string): boolean {
  return ORIGIN_EXEMPT_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

function originOfUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopback(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (
      protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** Whether a request's `Origin` is the app's own (APP_ORIGIN). */
function appOrigin(origin: string, env: Pick<Bindings, "APP_ORIGIN" | "ENVIRONMENT">): boolean {
  if (origin === originOfUrl(originOf(env))) return true;
  // DECISION: in local development the app is also served by Vite's dev server (`pnpm dev:web`,
  // :5173, proxying /api to :8787 with the browser's Origin unchanged) and may be opened as
  // 127.0.0.1, so any plain-http loopback origin counts there. Only there.
  return env.ENVIRONMENT?.trim().toLowerCase() === "development" && isLoopback(origin);
}

/**
 * Whether a non-safe request may go on: from the app's own pages, from no browser page at all, or
 * to an exempt path.
 */
// DECISION: a browser always sends `Origin` on a POST, PUT, PATCH or DELETE (as `null` when it
// won't say), and current browsers also send `Sec-Fetch-Site`; neither can be set by a page. Each
// header that is present must say the app's own origin. A request with neither did not come from a
// web page (a provider's server, a script, the phone app, the API's tests) and carries no
// browser's cookie on a page's behalf, so it goes on and its own authentication decides.
export function sameOriginRequest(
  request: Request,
  path: string,
  env: Pick<Bindings, "APP_ORIGIN" | "ENVIRONMENT">,
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  if (originExempt(path)) return true;
  // The phone app's session header: a page on another origin cannot add a header without the
  // browser asking first (CORS), which the API never allows, and the header replaces any cookie
  // (`withMobileSession`).
  if (request.headers.get(MOBILE_SESSION_HEADER) !== null) return true;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site.trim().toLowerCase() !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && !appOrigin(origin.trim(), env)) return false;
  return true;
}

export const requestOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (sameOriginRequest(c.req.raw, c.req.path, c.env ?? {})) return next();
  return c.json(
    {
      error: {
        code: "forbidden",
        message: "this request must come from the Mezonas app's own pages",
      },
    },
    403,
  );
});

/** Whether a request body's `Content-Type` is JSON (`application/json` or `+json`). */
export function isJsonContentType(value: string | null | undefined): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}
