// Lockdown (docs/plan.md §1.243, docs/lockdown-plan.md §2): what comes in from a provider for a
// locked client is answered as usual, so the provider neither retries nor switches our hook off,
// then dropped. Only the count per kind is kept, on the lock. The handlers don't change: the
// database refuses their client's scope, `errorResponse` answers 423 and notes the client, and the
// middleware here turns that 423 into the provider's usual answer.
//
// People's pages (forms, interviews, text sign-up) keep the 423: a person is told the account is
// locked. So does the desktop app, which shows its locked page.

import { type RouteSpec, allRoutes as routes } from "@countersign/core";
import { countLockedInbound, isClientLocked, withOperator } from "@countersign/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../http";
import { reportHandled } from "../observability/report";

/** The clients a request's refused scope named, noted by `errorResponse`. */
const lockedClients = new WeakMap<object, readonly string[]>();

/** Notes the client a lockdown refusal named, for the inbound middleware to count. */
export function noteLockedClients(c: Context, error: unknown): void {
  if (!isClientLocked(error)) return;
  const ids = (error as { tenantIds?: unknown }).tenantIds;
  if (Array.isArray(ids))
    lockedClients.set(
      c,
      ids.filter((id) => typeof id === "string"),
    );
}

type Answer = "json" | "twiml" | "empty";

/** Each provider's inbound route, the kind it is counted as, and the answer it expects. */
export const LOCKED_INBOUND: readonly { route: RouteSpec; kind: string; answer: Answer }[] = [
  { route: routes.inboundHook, kind: "webhook", answer: "json" },
  { route: routes.twilioInboundMessage, kind: "text", answer: "twiml" },
  { route: routes.twilioMessageStatus, kind: "text_status", answer: "twiml" },
  { route: routes.twilioVoiceInbound, kind: "call", answer: "twiml" },
  { route: routes.twilioVoiceAnswer, kind: "call", answer: "twiml" },
  { route: routes.twilioVoiceStatus, kind: "call_status", answer: "twiml" },
  { route: routes.voiceTool, kind: "voice_agent", answer: "json" },
  { route: routes.elevenlabsPostCall, kind: "voice_agent", answer: "json" },
  { route: routes.qboWebhook, kind: "quickbooks", answer: "json" },
  { route: routes.zohoNotify, kind: "zoho_crm", answer: "json" },
  { route: routes.bankfeedWebhook, kind: "bank_feed", answer: "json" },
  { route: routes.gchatEvents, kind: "google_chat", answer: "json" },
  { route: routes.teamsEvents, kind: "teams", answer: "json" },
  { route: routes.metaWebhook, kind: "whatsapp", answer: "json" },
  { route: routes.packInbound, kind: "beacon", answer: "empty" },
  { route: routes.resendEvents, kind: "email_event", answer: "json" },
];

/** Twilio's empty answer: no reply to a text, and a call ends. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function usualAnswer(answer: Answer): Response {
  if (answer === "twiml") {
    return new Response(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
  }
  if (answer === "empty") return new Response(null, { status: 204 });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * After the handler: a 423 (its client is locked) becomes the provider's usual answer, and the
 * client's lock counts one more of this kind. Any other answer passes through.
 */
export function answerWhileLocked(kind: string, answer: Answer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.res.status !== 423) return;
    const ids = lockedClients.get(c) ?? [];
    if (ids.length > 0) {
      try {
        const { db } = c.get("req").services();
        // `tenant` has no row-level security: the count is written whatever the scope.
        await withOperator(db, [], async (tx) => {
          for (const id of ids) await countLockedInbound(tx, id, kind);
        });
      } catch (error) {
        reportHandled("counting what came in for a locked client failed", error, {
          kind: "lockdown",
        });
      }
    }
    c.res = usualAnswer(answer);
  };
}

/** Mounted before the routes, on each provider's inbound path. */
export function lockedInboundMiddleware(app: Hono<AppEnv>): void {
  // Under the route's own method, not `use` (ALL): the same middleware, and the app's list of
  // routes keeps one method per path (request-origin.test.ts).
  for (const { route, kind, answer } of LOCKED_INBOUND) {
    app.on(route.method, route.path, answerWhileLocked(kind, answer));
  }
}
