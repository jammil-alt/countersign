// Mail to the back office (docs/plan.md §1.123.4; docs/cases-plan.md W1): `support@` and `hello@`
// on EMAIL_FORWARDING_DOMAIN (BACKOFFICE_INBOUND), and their `+tag` reply addresses.
//
// - A reply to a tagged issue or ask lands on it, from the person it emailed or a member of that
//   client only; a reply to a deal lands on its timeline, from the deal's people only.
// - Untagged, from a member of exactly one client: a new issue (source email); Reggie's pass reads
//   it. To `hello@` from anyone else: a new lead deal and its person. Anything else: "Sort this", a
//   to-do for the operator.
//
// The sender is the envelope's, or the From header's when that domain passed DMARC. The text is
// the reply's own words (quoted history cut), kept as untrusted data (invariants 9 and 12).
// Nothing is bounced.

import {
  type ContentStore,
  parseForwardedEmail,
  parseReplyEmail,
  type ReplyEmail,
  trustedFromHeader,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { bytesMatchType, REPLY_DOCUMENTS_MAX, redactCardNumbers } from "@countersign/core";
import {
  appUser,
  clientAsk,
  connection,
  type Db,
  deal,
  dealPerson,
  issue,
  membership,
  type Tx,
  tenant,
  thread,
  withOperator,
} from "@countersign/db";
import { DocumentError, storeDocument } from "@countersign/documents";
import type { EventRow } from "@countersign/senses";
import { postMessage } from "@countersign/threads";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { addActivity } from "../work/deals";
import { createIssue, issueTitle } from "../work/issues";
import { addTodo } from "../work/todos-store";
import { backOfficeAddress, clientItemTag, dealTag, HELLO_LOCAL, parseTag } from "./outbound-email";
import { needsRead } from "./reggie-pass";

export interface InboundMail {
  from: string;
  to: string;
  raw: Uint8Array;
}

export type BackOfficeOutcome =
  | { handled: false }
  | {
      handled: true;
      kind: "issue_reply" | "ask_reply" | "deal_reply" | "issue" | "lead" | "sort";
      tenantId: string | null;
      id: string | null;
      /** Documents made from a client member's attachments, to dispatch and read. */
      events: EventRow[];
      fresh: string[];
    };

const TEXT_MAX = 4000;

const done = (
  kind: Extract<BackOfficeOutcome, { handled: true }>["kind"],
  tenantId: string | null,
  id: string | null,
  docs: { events: EventRow[]; fresh: string[] } = { events: [], fresh: [] },
): BackOfficeOutcome => ({ handled: true, kind, tenantId, id, ...docs });

/** The addresses the mail may count as from: the envelope, and From when DMARC passed for it. */
function senders(mail: InboundMail, parsed: ReplyEmail): string[] {
  const out = [mail.from.trim().toLowerCase()];
  if (parsed.from && trustedFromHeader(parsed.from, parsed.dmarcPassFrom)) {
    out.push(parsed.from.toLowerCase());
  }
  return [...new Set(out.filter((s) => s.includes("@")))];
}

async function liveClientIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  return rows.map((r) => r.id);
}

/** The client people with one of these addresses: `{tenantId, userId, email}` per membership. */
async function clientMembers(tx: Tx, emails: readonly string[]) {
  if (emails.length === 0) return [];
  return tx
    .select({
      tenantId: membership.tenantId,
      userId: appUser.id,
      email: appUser.email,
      name: appUser.name,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(inArray(sql`lower(${appUser.email})`, [...emails]), ne(membership.role, "operator")),
    );
}

/**
 * "Sort this": mail nobody could place, for the operator, with its text as data. When the mail
 * is about one of a few clients (a sender who is a member of more than one, a reply on a client's
 * deal from someone not on it), each of those clients gets its own to-do with `client_id` set, so
 * only the operators who serve that client read it (invariant 1). Only mail tied to no client at
 * all is a to-do with no client.
 */
async function sortThis(
  db: Db,
  input: {
    clientIds: string[];
    from: string;
    to: string;
    parsed: ReplyEmail;
    why: string;
  },
): Promise<BackOfficeOutcome> {
  const key = `email:${input.parsed.messageId ?? `${input.from}:${input.parsed.subject ?? ""}:${input.parsed.text.slice(0, 80)}`}`;
  const detail = [
    `To: ${input.to}`,
    `Subject: ${input.parsed.subject ?? "(none)"}`,
    "",
    input.parsed.text,
  ]
    .join("\n")
    .slice(0, 4000);
  const each: (string | null)[] = input.clientIds.length ? [...new Set(input.clientIds)] : [null];
  for (const clientId of each) {
    await withOperator(db, clientId ? [clientId] : [], (tx) =>
      addTodo(tx, {
        title: `Sort this: email from ${input.from}`.slice(0, 300),
        owner: "operator",
        clientId,
        source: "email",
        why: input.why,
        detail,
        dueAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        dedupeKey: (each.length > 1 ? `${key}:${clientId}` : key).slice(0, 500),
      }),
    );
  }
  return done("sort", each.length === 1 ? (each[0] ?? null) : null, null);
}

/** A member's PDFs and images, as the client's documents (as forwarded mail keeps them). */
async function keepAttachments(
  tx: Tx,
  content: ContentStore | undefined,
  tenantId: string,
  mail: InboundMail,
  parsed: ReplyEmail,
): Promise<{ events: EventRow[]; fresh: string[]; documents: string[] }> {
  const out = { events: [] as EventRow[], fresh: [] as string[], documents: [] as string[] };
  if (!content) return out;
  const [upload] = await tx
    .select({ id: connection.id })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
    .orderBy(connection.createdAt)
    .limit(1);
  if (!upload) return out;
  const files = await parseForwardedEmail(mail.raw).catch(() => null);
  for (const a of files?.attachments ?? []) {
    if (out.documents.length >= REPLY_DOCUMENTS_MAX || !bytesMatchType(a.bytes, a.mimeType))
      continue;
    try {
      const stored = await storeDocument(tx, content, {
        tenantId,
        source: "email",
        connectionId: upload.id,
        bytes: a.bytes,
        filename: redactCardNumbers(a.filename),
        mimeType: a.mimeType,
        meta: {
          email: {
            from: parsed.from ?? mail.from.toLowerCase(),
            envelopeFrom: mail.from.toLowerCase(),
            to: mail.to.toLowerCase(),
            subject: parsed.subject,
            messageId: parsed.messageId,
          },
          backOffice: true,
        },
      });
      if (!out.documents.includes(stored.document.id)) out.documents.push(stored.document.id);
      if (stored.created) out.fresh.push(stored.document.id);
      if (stored.event) out.events.push(stored.event);
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
    }
  }
  return out;
}

/** A client-side message on an issue's or ask's conversation. */
async function postClientSide(
  tx: Tx,
  tenantId: string,
  threadId: string,
  senderId: string | null,
  text: string,
) {
  const [th] = await tx
    .select()
    .from(thread)
    .where(and(eq(thread.id, threadId), eq(thread.tenantId, tenantId)));
  if (!th) return null;
  return postMessage(tx, {
    tenantId,
    thread: th,
    senderType: senderId ? "user" : "system",
    senderId,
    kind: "text",
    body: { text },
    sources: [],
    audience: "client",
  });
}

/**
 * Handles mail to the back office's addresses. `{handled: false}` when the address isn't one of
 * them, so the email handler goes on with its other kinds.
 */
export async function receiveBackOfficeEmail(
  db: Db,
  mail: InboundMail,
  options: { domain: string; locals: readonly string[]; content?: ContentStore; now?: Date },
): Promise<BackOfficeOutcome> {
  const addr = backOfficeAddress(mail.to, options.domain, options.locals);
  if (!addr) return { handled: false };
  const parsed = await parseReplyEmail(mail.raw);
  const text = parsed.text.trim().slice(0, TEXT_MAX);
  const from = senders(mail, parsed);
  const sender = from[from.length - 1] ?? mail.from.toLowerCase();
  const all = await liveClientIds(db);

  if (addr.tag) {
    const tag = parseTag(addr.tag);
    if (tag.kind === "client" && all.includes(tag.tenantId)) {
      const tenantId = tag.tenantId;
      const landed = await withOperator(db, [tenantId], async (tx) => {
        const members = (await clientMembers(tx, from)).filter((m) => m.tenantId === tenantId);
        const member = members[0] ?? null;
        const [iss] = await tx
          .select()
          .from(issue)
          .where(and(eq(issue.tenantId, tenantId), eq(issue.replyTag, tag.tag)));
        if (iss) {
          const fromRaiser = !!iss.raisedByEmail && from.includes(iss.raisedByEmail.toLowerCase());
          if (!fromRaiser && !member) return null;
          if (!text) return { kind: "issue_reply" as const, id: iss.id };
          await postClientSide(
            tx,
            tenantId,
            iss.threadId,
            member?.userId ?? (fromRaiser ? iss.raisedBy : null),
            text,
          );
          if (iss.stage === "verify") {
            await tx
              .update(issue)
              .set({ waitingOn: "operator" })
              .where(and(eq(issue.id, iss.id), eq(issue.tenantId, tenantId)));
          }
          await needsRead(tx, tenantId, iss.id, options.now);
          return { kind: "issue_reply" as const, id: iss.id };
        }
        const [ask] = await tx
          .select()
          .from(clientAsk)
          .where(and(eq(clientAsk.tenantId, tenantId), eq(clientAsk.replyTag, tag.tag)));
        if (ask) {
          const fromRaiser = !!ask.raisedByEmail && from.includes(ask.raisedByEmail.toLowerCase());
          if (!fromRaiser && !member) return null;
          if (text) {
            await postClientSide(
              tx,
              tenantId,
              ask.threadId,
              member?.userId ?? (fromRaiser ? ask.raisedBy : null),
              text,
            );
          }
          return { kind: "ask_reply" as const, id: ask.id };
        }
        return null;
      });
      if (landed) return done(landed.kind, tenantId, landed.id);
      return sortThis(db, {
        clientIds: [tenantId],
        from: sender,
        to: mail.to,
        parsed,
        why: "A reply to a request we couldn't match to its sender.",
      });
    }
    if (tag.kind === "deal") {
      const landed = await withOperator(db, all, async (tx) => {
        const [d] = await tx.select().from(deal).where(eq(deal.replyTag, tag.tag));
        if (!d) return null;
        const people = await tx.select().from(dealPerson).where(eq(dealPerson.dealId, d.id));
        const person = people.find((p) => p.email && from.includes(p.email.toLowerCase()));
        if (!person) return { d, matched: false as const };
        // Lead attachments are dropped and logged without content (DECISION below).
        await addActivity(tx, d.id, {
          kind: "email_in",
          actor: "contact",
          subject: parsed.subject?.slice(0, 200) ?? null,
          body: text,
          meta: {
            personId: person.id,
            name: person.name,
            from: sender,
            messageId: parsed.messageId,
          },
        });
        await tx.update(deal).set({ waitingOn: "operator" }).where(eq(deal.id, d.id));
        return { d, matched: true as const };
      });
      if (landed?.matched) return done("deal_reply", landed.d.clientId, landed.d.id);
      // A reply on an expansion deal from someone not on it is still about that client.
      if (landed?.d.clientId) {
        return sortThis(db, {
          clientIds: [landed.d.clientId],
          from: sender,
          to: mail.to,
          parsed,
          why: "A reply on a deal from someone who isn't on it.",
        });
      }
    }
    return sortThis(db, {
      clientIds: [],
      from: sender,
      to: mail.to,
      parsed,
      why: "A reply we couldn't match to an issue or a deal.",
    });
  }

  // Untagged: who is it from?
  const members = await withOperator(db, all, (tx) => clientMembers(tx, from));
  const clients = [...new Set(members.map((m) => m.tenantId))];
  if (clients.length === 1) {
    const tenantId = clients[0] as string;
    const member = members.find((m) => m.tenantId === tenantId);
    const out = await withOperator(db, [tenantId], async (tx) => {
      const row = await createIssue(tx, {
        tenantId,
        title: issueTitle(parsed.subject, text || "Email"),
        description: text,
        source: "email",
        raisedBy: member?.userId ?? null,
        raisedByEmail: sender,
        actor: "client",
        userId: member?.userId ?? null,
        openingText: text || null,
        ...(options.now ? { now: options.now } : {}),
      });
      const tag = clientItemTag(tenantId);
      await tx
        .update(issue)
        .set({ replyTag: tag })
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, tenantId)));
      const docs = await keepAttachments(tx, options.content, tenantId, mail, parsed);
      return { id: row.id, docs };
    });
    return done("issue", tenantId, out.id, out.docs);
  }
  if (addr.local === HELLO_LOCAL && clients.length === 0) {
    // DECISION: a lead's attachments are not kept (they are no client's documents yet); they are
    // dropped and only counted in the activity's meta, without content.
    const files = await parseForwardedEmail(mail.raw).catch(() => null);
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    const company = domain.split(".").slice(-2, -1)[0] ?? domain;
    const id = await withOperator(db, [], async (tx) => {
      // The same sender writing again before a reply: one open deal, its timeline grows.
      const [open] = await tx
        .select({ id: deal.id })
        .from(deal)
        .innerJoin(dealPerson, eq(dealPerson.dealId, deal.id))
        .where(
          and(
            eq(deal.outcome, "open"),
            isNull(deal.clientId),
            sql`lower(${dealPerson.email}) = ${sender}`,
          ),
        )
        .limit(1);
      let dealId = open?.id ?? null;
      if (!dealId) {
        const [made] = await tx
          .insert(deal)
          .values({
            kind: "new",
            company: (company.charAt(0).toUpperCase() + company.slice(1)).slice(0, 200) || domain,
            title: issueTitle(parsed.subject, text || `Email from ${sender}`),
            description: text.slice(0, 2000),
            stage: "lead",
            source: "email",
            sourceDetail: `Email to ${addr.local}@`,
            replyTag: dealTag(),
            waitingOn: "operator",
            nextStep: "First reply",
          })
          .returning({ id: deal.id });
        if (!made) throw new Error("deal insert returned nothing");
        dealId = made.id;
        await tx.insert(dealPerson).values({
          dealId,
          name: sender.split("@")[0]?.slice(0, 200) || sender,
          email: sender,
          isPrimary: true,
        });
        await addActivity(tx, dealId, {
          kind: "system",
          actor: "system",
          body: "A lead wrote to us.",
        });
      }
      const [person] = await tx
        .select({ id: dealPerson.id, name: dealPerson.name })
        .from(dealPerson)
        .where(and(eq(dealPerson.dealId, dealId), sql`lower(${dealPerson.email}) = ${sender}`));
      await addActivity(tx, dealId, {
        kind: "email_in",
        actor: "contact",
        subject: parsed.subject?.slice(0, 200) ?? null,
        body: text,
        meta: {
          personId: person?.id ?? null,
          name: person?.name ?? sender,
          from: sender,
          messageId: parsed.messageId,
          attachmentsDropped: files?.attachments.length ?? 0,
        },
      });
      await addTodo(tx, {
        title: `First reply to ${sender}`,
        owner: "operator",
        about: { kind: "deal", id: dealId },
        source: "email",
        playKey: "first_reply",
        why: "A lead wrote to hello@. Within an hour, business hours.",
        detail: text.slice(0, 4000),
        dueAt: new Date((options.now ?? new Date()).getTime() + 60 * 60 * 1000),
        primaryAction: { label: "Open", kind: "open", ref: { dealId } },
        dedupeKey: `deal:first-reply:${dealId}`,
      });
      return dealId;
    });
    return done("lead", null, id);
  }
  // DECISION: a sender who is a member of more than one client gets a to-do in each of their
  // clients, so the email is read only by operators who serve one of them (invariant 1).
  return sortThis(db, {
    clientIds: clients,
    from: sender,
    to: mail.to,
    parsed,
    why:
      clients.length > 1
        ? "The sender is a member of more than one client: which one is it about?"
        : "An email from someone we don't know.",
  });
}
