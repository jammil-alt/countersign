// The back office's email (docs/plan.md §1.123.4; docs/cases-plan.md W1): the tagged reply
// addresses that thread an answer back to its issue, ask or deal, and what we send. Mail goes over
// Mezonas' own Resend sender (notify/mailer.ts) as "<lead> via Mezonas", with `reply_to` set to the
// item's tagged address on EMAIL_FORWARDING_DOMAIN and the message id as its idempotency key. A
// held agent never stops these: they are ours, not the agent's.

import { base32, bytesUuid, unbase32, uuidBytes } from "@countersign/connectors";
import {
  BACKOFFICE_EMAIL_FEATURE,
  complianceOf,
  type Processor,
  processingRefusal,
} from "@countersign/core";
import {
  type Db,
  issue,
  issueEvent,
  membership,
  message,
  type Tx,
  tenant,
  withOperator,
} from "@countersign/db";
import { leadDisplayName, leadOf } from "@countersign/threads";
import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Mailer } from "../notify/mailer";
import { reportHandled } from "../observability/report";

/** The local parts the back office answers on (BACKOFFICE_INBOUND), default support and hello. */
export function backOfficeLocals(env: Pick<Bindings, "BACKOFFICE_INBOUND">): string[] {
  const raw = env.BACKOFFICE_INBOUND?.trim() || "support,hello";
  const out = raw
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^[a-z0-9][a-z0-9._-]{0,40}$/.test(l));
  return out.length > 0 ? out : ["support", "hello"];
}

/** Where clients write (issues and asks), and where leads write (deals). */
export const SUPPORT_LOCAL = "support";
export const HELLO_LOCAL = "hello";

function randomTag(n: number): string {
  const bytes = new Uint8Array(Math.ceil((n * 5) / 8));
  crypto.getRandomValues(bytes);
  return base32(bytes).slice(0, n);
}

/**
 * An issue's or ask's tag: the client's id (26 base32 characters, so the reply opens that client's
 * transaction without a lookup across clients) and 10 random ones nobody can guess.
 */
export function clientItemTag(tenantId: string): string {
  return `${base32(uuidBytes(tenantId))}.${randomTag(10)}`;
}

/** A deal's tag: `d` and 16 random characters (a lead has no client yet). */
export function dealTag(): string {
  return `d${randomTag(16)}`;
}

const CLIENT_TAG = /^([a-z2-7]{26})\.([a-z2-7]{10})$/;
const DEAL_TAG = /^d[a-z2-7]{16}$/;

export type ParsedTag =
  | { kind: "client"; tenantId: string; tag: string }
  | { kind: "deal"; tag: string }
  | { kind: "unknown"; tag: string };

export function parseTag(tag: string): ParsedTag {
  const t = tag.toLowerCase();
  const m = CLIENT_TAG.exec(t);
  if (m) {
    const bytes = unbase32(m[1] as string);
    if (bytes?.length === 16) return { kind: "client", tenantId: bytesUuid(bytes), tag: t };
  }
  if (DEAL_TAG.test(t)) return { kind: "deal", tag: t };
  return { kind: "unknown", tag: t };
}

/** `support+<tag>@<domain>`. */
export function taggedAddress(local: string, tag: string, domain: string): string {
  return `${local}+${tag}@${domain.trim().toLowerCase()}`;
}

/** The back office address mail came to: its local part and tag, or null when it isn't one. */
export function backOfficeAddress(
  address: string,
  domain: string,
  locals: readonly string[],
): { local: string; tag: string | null } | null {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0 || a.slice(at + 1) !== domain.trim().toLowerCase()) return null;
  const [local = "", ...rest] = a.slice(0, at).split("+");
  if (!locals.includes(local)) return null;
  const tag = rest.join("+");
  return { local, tag: tag || null };
}

/** Gives the issue a reply tag when it has none; returns it. */
export async function ensureIssueTag(
  tx: Tx,
  row: { id: string; tenantId: string; replyTag: string | null },
) {
  if (row.replyTag) return row.replyTag;
  const tag = clientItemTag(row.tenantId);
  await tx
    .update(issue)
    .set({ replyTag: tag })
    .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
  return tag;
}

const subjectOf = (title: string, number: number) =>
  `Re: ${title.replace(/[\r\n]+/g, " ").slice(0, 150)} [Request #${number}]`;

/**
 * Emails our client-audience replies on issues that came by email (each has a reply tag and the
 * sender's address), once each: an `issue_event` `reply` with `emailedMessageId` marks it sent.
 * The every-minute cron; without a mail sender or domain nothing is sent.
 */
export async function sendIssueEmails(
  db: Db,
  mailer: Mailer,
  domain: string | null | undefined,
  now = new Date(),
  covered: ReadonlySet<Processor> = new Set(),
): Promise<number> {
  if (!mailer.isConfigured || !domain?.trim()) return 0;
  const clients = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  if (clients.length === 0) return 0;
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pending = await withOperator(
    db,
    clients.map((c) => c.id),
    async (tx) => {
      const rows = await tx
        .select({
          issueId: issue.id,
          tenantId: issue.tenantId,
          number: issue.number,
          title: issue.title,
          to: issue.raisedByEmail,
          raisedBy: issue.raisedBy,
          tag: issue.replyTag,
          messageId: message.id,
          senderType: message.senderType,
          senderId: message.senderId,
          text: sql<string>`${message.body}->>'text'`,
        })
        .from(message)
        .innerJoin(
          issue,
          and(eq(issue.threadId, message.threadId), eq(issue.tenantId, message.tenantId)),
        )
        .where(
          and(
            eq(issue.source, "email"),
            isNotNull(issue.replyTag),
            isNotNull(issue.raisedByEmail),
            eq(message.audience, "client"),
            inArray(message.senderType, ["user", "agent"]),
            gte(message.createdAt, since),
            sql`not exists (select 1 from issue_event e where e.tenant_id = ${issue.tenantId} and e.issue_id = ${issue.id} and e.kind = 'reply' and e.payload->>'emailedMessageId' = ${message.id}::text)`,
          ),
        )
        .orderBy(message.createdAt)
        .limit(50);
      // Only ours: not the raiser's own words (a member writing in the portal).
      const ours = rows.filter(
        (r) => !(r.senderType === "user" && r.senderId && r.senderId === r.raisedBy),
      );
      const clientMembers = ours.length
        ? await tx
            .select({ tenantId: membership.tenantId, userId: membership.userId })
            .from(membership)
            .where(
              and(
                inArray(membership.tenantId, [...new Set(ours.map((r) => r.tenantId))]),
                ne(membership.role, "operator"),
              ),
            )
        : [];
      const member = new Set(clientMembers.map((m) => `${m.tenantId}:${m.userId}`));
      return ours.filter(
        (r) =>
          !(r.senderType === "user" && r.senderId && member.has(`${r.tenantId}:${r.senderId}`)),
      );
    },
  );
  let sent = 0;
  for (const p of pending) {
    try {
      const [t] = await db
        .select({ settings: tenant.settings })
        .from(tenant)
        .where(eq(tenant.id, p.tenantId));
      // HIPAA mode (§1.35): answered in the portal only until Resend is covered; marked so it
      // isn't tried again.
      const refusal = processingRefusal(
        complianceOf(t?.settings as Record<string, unknown> | null),
        covered,
        BACKOFFICE_EMAIL_FEATURE.processors,
        BACKOFFICE_EMAIL_FEATURE.what,
      );
      if (refusal) {
        await withOperator(db, [p.tenantId], (tx) =>
          tx.insert(issueEvent).values({
            tenantId: p.tenantId,
            issueId: p.issueId,
            kind: "reply",
            actor: "system",
            payload: { emailedMessageId: p.messageId, refused: "hipaa" },
          }),
        );
        continue;
      }
      const lead = await withOperator(db, [p.tenantId], (tx) => leadOf(tx, p.tenantId));
      await mailer.send({
        to: p.to as string,
        subject: subjectOf(p.title, p.number),
        text: p.text ?? "",
        idempotencyKey: `issue-${p.messageId}`,
        onBehalfOf: lead ? leadDisplayName(lead) : "Your Mezonas lead",
        replyTo: taggedAddress(SUPPORT_LOCAL, p.tag as string, domain),
      });
      await withOperator(db, [p.tenantId], (tx) =>
        tx.insert(issueEvent).values({
          tenantId: p.tenantId,
          issueId: p.issueId,
          kind: "reply",
          actor: "system",
          payload: { emailedMessageId: p.messageId, to: p.to },
        }),
      );
      sent += 1;
    } catch (error) {
      reportHandled("an issue's email reply failed", error, {
        job: "backoffice_email",
        tenant: p.tenantId,
      });
    }
  }
  return sent;
}

/**
 * Sends one email for a deal (or a reminder) as the operator, with replies threaded back by tag.
 * Throws when the mail can't go: the caller's transaction rolls back with it.
 */
export async function sendTaggedEmail(
  mailer: Mailer,
  input: {
    to: string;
    subject: string;
    text: string;
    from: string;
    replyTo: string | null;
    idempotencyKey: string;
  },
): Promise<string> {
  return mailer.send({
    to: input.to,
    subject: input.subject.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    onBehalfOf: input.from,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  });
}
