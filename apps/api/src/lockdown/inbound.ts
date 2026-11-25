// Lockdown (docs/plan.md §1.243, docs/lockdown-plan.md §2): what comes in from a provider for a
// locked client is answered as usual, so the provider neither retries nor switches our hook off,
// then dropped. Only the count per kind is kept, on the lock. The handlers don't change: the
// database refuses their client's scope, `errorResponse` answers 423 and notes the client, and the
// middleware here turns that 423 into the provider's usual answer.
//
// People's pages (forms, interviews, text sign-up) keep the 423: a person is told the account is
// locked. So does the desktop app, which shows its locked page.

import { allRoutes as routes } from "@countersign/core";
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
export const LOCKED_INBOUND: readonly { path: string; kind: string; answer: Answer }[] = [
  { path: routes.inboundHook.path, kind: "webhook", answer: "json" },
  { path: routes.twilioInboundMessage.path, kind: "text", answer: "twiml" },
  { path: routes.twilioMessageStatus.path, kind: "text_status", answer: "twiml" },
  { path: routes.twilioVoiceInbound.path, kind: "call", answer: "twiml" },
  { path: routes.twilioVoiceAnswer.path, kind: "call", answer: "twiml" },
  { path: routes.twilioVoiceStatus.path, kind: "call_status", answer: "twiml" },
  { path: routes.voiceTool.path, kind: "voice_agent", answer: "json" },
  { path: routes.elevenlabsPostCall.path, kind: "voice_agent", answer: "json" },
  { path: routes.qboWebhook.path, kind: "quickbooks", answer: "json" },
  { path: routes.zohoNotify.path, kind: "zoho_crm", answer: "json" },
  { path: routes.bankfeedWebhook.path, kind: "bank_feed", answer: "json" },
  { path: routes.gchatEvents.path, kind: "google_chat", answer: "json" },
  { path: routes.teamsEvents.path, kind: "teams", answer: "json" },
  { path: routes.metaWebhook.path, kind: "whatsapp", answer: "json" },
  { path: routes.packInbound.path, kind: "beacon", answer: "empty" },
  { path: routes.resendEvents.path, kind: "email_event", answer: "json" },
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
  for (const route of LOCKED_INBOUND) {
    app.use(route.path, answerWhileLocked(route.kind, route.answer));
  }
}
