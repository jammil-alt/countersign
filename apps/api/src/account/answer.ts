// Sloan's answer goes back the way the person wrote (docs/plan.md §1.150). After Sloan posts in an
// account thread for the client (its own answer, or an area owner's through `account.reply_as`),
// the person's latest message there says how it came: by email, the answer is emailed to their
// sign-in address with Sloan's address to reply to; by text, it is texted from the number they
// wrote to. A message from the portal gets nothing more: the portal is where they are.
//
// DECISION: sent once, best effort, right after the post commits (as §1.48's fixed replies are): a
// failure is logged and audited, never retried, and never fails Sloan's run. The answer is always
// in the portal, which the email and the text link to.

import type { ThreadsPort } from "@countersign/agents";
import {
  clientLanguage,
  complianceOf,
  type Locale,
  type Processor,
  processingRefusal,
  SLOAN_EMAIL_FEATURE,
  type SloanChannel,
  sloanAddress,
  sloanReplySubject,
  sloanTextBody,
  trimTrailingSlashes,
  userLanguage,
} from "@countersign/core";
import { appUser, type Db, message, type Tx, tenant, thread, withTenant } from "@countersign/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { auditInTx } from "../audit";
import { meter } from "../metering";
import type { Mailer, Texter } from "../notify/mailer";
import { reportHandled } from "../observability/report";
import { contactByEmail } from "../triggers/senders";
import { clientPersonByEmail, type SloanPerson, sloanTextSender } from "./reach";

export interface SloanAnswerDeps {
  db: Db;
  mailer: Mailer;
  texter: Texter;
  /** APP_ORIGIN: the conversation's link in the portal. */
  origin: string;
  /** EMAIL_FORWARDING_DOMAIN: Sloan's address to reply to; null: email answers aren't sent. */
  domain: string | null;
  /** `BAA_PROCESSORS`: a client in HIPAA mode gets email answers only once Resend is covered. */
  covered?: ReadonlySet<Processor>;
}

export type SloanAnswerOutcome =
  | { status: "sent"; channel: SloanChannel; providerId: string }
  | { status: "skipped"; channel: SloanChannel | null; reason: string }
  | { status: "failed"; channel: SloanChannel; reason: string };

function bodyOf(row: { body: unknown }): Record<string, unknown> {
  return (row.body ?? {}) as Record<string, unknown>;
}

function textOf(row: { body: unknown }): string {
  const t = bodyOf(row).text;
  return typeof t === "string" ? t : "";
}

function viaOf(row: { body: unknown }): SloanChannel | null {
  const via = bodyOf(row).via;
  return via === "email" || via === "sms" ? via : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The person's portal link to this conversation with Sloan. */
export function sloanThreadLink(origin: string, threadId: string): string {
  return `${trimTrailingSlashes(origin)}/sloan/${threadId}`;
}

/** Sends Sloan's answer `messageId` (in `threadId`) back by email or text, when it came that way. */
export async function deliverSloanAnswer(
  deps: SloanAnswerDeps,
  tenantId: string,
  posted: { threadId: string; messageId: string },
): Promise<SloanAnswerOutcome> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const out = await deliverIn(tx, deps, tenantId, posted);
    if (out.channel) {
      await auditInTx(tx, null, {
        tenantId,
        actorKind: "system",
        action: "sloan.answer_sent",
        outcome: out.status === "sent" ? "ok" : out.status === "failed" ? "error" : "refused",
        target: {
          thread: posted.threadId,
          message: posted.messageId,
          channel: out.channel,
          ...(out.status === "sent" ? {} : { reason: out.reason.slice(0, 200) }),
        },
      });
    }
    return out;
  });
}

async function deliverIn(
  tx: Tx,
  deps: SloanAnswerDeps,
  tenantId: string,
  posted: { threadId: string; messageId: string },
): Promise<SloanAnswerOutcome> {
  const skip = (channel: SloanChannel | null, reason: string): SloanAnswerOutcome => ({
    status: "skipped",
    channel,
    reason,
  });
  const [t] = await tx
    .select()
    .from(thread)
    .where(and(eq(thread.id, posted.threadId), eq(thread.tenantId, tenantId)));
  if (t?.subjectType !== "account" || !t.createdBy) return skip(null, "not_an_account_thread");
  const [answer] = await tx
    .select()
    .from(message)
    .where(and(eq(message.id, posted.messageId), eq(message.tenantId, tenantId)));
  if (!answer || answer.threadId !== t.id || answer.senderType !== "agent") {
    return skip(null, "not_an_answer");
  }
  if (answer.audience !== "client") return skip(null, "not_for_the_client");
  // The person's latest message before the answer says how they wrote.
  const [asked] = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.tenantId, tenantId),
        eq(message.threadId, t.id),
        eq(message.senderType, "user"),
        eq(message.senderId, t.createdBy),
        lt(message.createdAt, answer.createdAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  const via = asked ? viaOf(asked) : null;
  if (!asked || !via) return skip(null, "asked_in_the_portal");
  const [client] = await tx
    .select({ name: tenant.name, settings: tenant.settings, retiredAt: tenant.retiredAt })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!client || client.retiredAt) return skip(via, "client_retired");
  // Still one of the client's people, as when they wrote.
  const [u] = await tx
    .select({ email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, t.createdBy));
  const person: SloanPerson | null = u ? await clientPersonByEmail(tx, tenantId, u.email) : null;
  if (!person) return skip(via, "not_a_client_person");
  const settings = (client.settings ?? {}) as Record<string, unknown>;
  const locale: Locale = userLanguage(settings, person.userId) ?? clientLanguage(settings) ?? "en";
  const link = sloanThreadLink(deps.origin, t.id);
  const text = textOf(answer).trim();
  if (!text) return skip(via, "empty");

  if (via === "email") {
    if (!deps.domain) return skip(via, "not_configured");
    if (!deps.mailer.isConfigured) return skip(via, "not_configured");
    const refusal = processingRefusal(
      complianceOf(settings),
      deps.covered ?? new Set(),
      SLOAN_EMAIL_FEATURE.processors,
      SLOAN_EMAIL_FEATURE.what,
    );
    if (refusal) return skip(via, "hipaa");
    const email = (bodyOf(asked).email ?? {}) as Record<string, unknown>;
    const messageId = str(email.messageId);
    try {
      const providerId = await deps.mailer.send({
        to: person.email,
        subject: sloanReplySubject(str(email.subject)),
        text: `${text}\n\n--\nSloan, ${client.name}'s account agent at Mezonas\n${link}`,
        idempotencyKey: `sloan-${answer.id}`,
        onBehalfOf: "Sloan",
        replyTo: sloanAddress({ clientName: client.name, tenantId, domain: deps.domain }),
        ...(messageId
          ? { inReplyTo: messageId.startsWith("<") ? messageId : `<${messageId}>` }
          : {}),
      });
      // §1.210: Sloan's answer by email is the client's own usage.
      await meter(tx, {
        tenantId,
        measure: "emails",
        source: "account",
        key: `notify:sloan-${answer.id}`,
      });
      return { status: "sent", channel: via, providerId };
    } catch (error) {
      return { status: "failed", channel: via, reason: errorText(error) };
    }
  }

  // By text: from the number they wrote to, to their signed-up number, while they haven't said STOP.
  const sms = (bodyOf(asked).sms ?? {}) as Record<string, unknown>;
  const connectionId = str(sms.connectionId);
  const from = str(sms.to);
  if (!connectionId || !from) return skip(via, "no_number");
  if (!deps.texter.sendFrom) return skip(via, "not_configured");
  const entry = await contactByEmail(tx, tenantId, person.email);
  const textable = entry ? await sloanTextSender(tx, tenantId, entry) : null;
  if (!entry?.phone || !textable) return skip(via, "cannot_text");
  try {
    const providerId = await deps.texter.sendFrom(tx, tenantId, {
      connectionId,
      from,
      to: entry.phone,
      body: sloanTextBody(text, link, locale),
    });
    // §1.210: Sloan's answer by text is the client's own usage.
    await meter(tx, {
      tenantId,
      measure: "messages",
      source: "account",
      key: `twilio:${providerId}`,
    });
    return { status: "sent", channel: via, providerId };
  } catch (error) {
    return { status: "failed", channel: via, reason: errorText(error) };
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * The runtime's threads port with Sloan's answers delivered: after a live post for the client
 * commits, `deliverSloanAnswer` runs; whatever happens to it, the post's result is returned.
 */
export function deliveringThreads(inner: ThreadsPort, deps: SloanAnswerDeps): ThreadsPort {
  return {
    read: (tenantId, input) => inner.read(tenantId, input),
    async post(tenantId, input) {
      const out = await inner.post(tenantId, input);
      if (input.audience === "client" && input.mode !== "test") {
        try {
          const done = await deliverSloanAnswer(deps, tenantId, out);
          if (done.status === "failed") {
            console.warn(`sloan answer by ${done.channel} not sent: ${done.reason}`, { tenantId });
          }
        } catch (error) {
          reportHandled("sending Sloan's answer failed", error, { client: tenantId });
        }
      }
      return out;
    },
  };
}
