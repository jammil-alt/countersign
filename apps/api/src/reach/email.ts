// The platform services the email connectors (`resend`, `gmail`) call (EmailServices), over the
// client's contacts: may this address be emailed (a contact of this client, with email consent, not
// opted out), was this send already made or started (a re-run after a crash), where replies come
// back (the client's forwarding address), and record the email once in the contact's thread. Each
// call is one short withTenant transaction for the connection's client (invariant 1).

import {
  attachmentLine,
  type ConnectionRef,
  type EmailSendAttempt,
  type EmailServices,
  forwardingOf,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { consentBlockFor } from "@countersign/core";
import {
  connection as connectionTable,
  contact,
  type Db,
  externalAction,
  message,
  rawRecord,
  withTenant,
} from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  contactThread,
  getContact,
  reachContactOf,
  type ThreadMessageBody,
} from "../messaging/contacts";

export const EMAIL_MESSAGE_ENTITY = "EmailMessage";
/** A send started and not yet known to be done (Gmail takes no idempotency key). */
export const EMAIL_ATTEMPT_ENTITY = "EmailAttempt";
/** A started send the provider refused: it answered and sent nothing, so it may be tried again. */
export const EMAIL_ATTEMPT_REFUSED_ENTITY = "EmailAttemptRefused";

// DECISION: the first try keeps the record it always had (external version null), so a send
// started before tries were numbered still stands; try n > 1 has version "n", and a refusal of
// try n is its own record with version "n". Records are only ever added (raw_record is immutable).
const attemptVersion = (attempt: number) => (attempt === 1 ? null : String(attempt));

const BLOCK_WORDS = {
  opted_out: "this contact opted out of messages",
  no_address: "this contact has no email address",
  no_consent: "this contact hasn't agreed to email",
} as const;

export function dbEmailServices(db: Db, connection: ConnectionRef): EmailServices {
  const tenantId = connection.tenantId;
  return {
    checkSend({ to }) {
      return withTenant(db, tenantId, async (tx) => {
        const [c] = await tx
          .select()
          .from(contact)
          .where(and(eq(contact.tenantId, tenantId), eq(contact.email, to.toLowerCase())));
        if (!c) return { ok: false, message: "that address is not one of this client's contacts" };
        const block = consentBlockFor(reachContactOf(c), "email");
        if (block && block in BLOCK_WORDS) {
          return { ok: false, message: BLOCK_WORDS[block as keyof typeof BLOCK_WORDS] };
        }
        return { ok: true, contact: { id: c.id, name: c.name } };
      });
    },

    startAttempt(a) {
      return withTenant(db, tenantId, async (tx) => {
        // Once per key and try (the raw record's external id and version): a second start keeps
        // the first.
        const attempt = a.attempt ?? 1;
        const { refused: _refused, ...rest } = a;
        await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: connection.id,
            connector: connection.connector,
            entityType: EMAIL_ATTEMPT_ENTITY,
            externalId: a.idempotencyKey,
            externalVersion: attemptVersion(attempt),
            payload: { ...rest, attempt, startedAt: a.startedAt.toISOString() },
            syncedAt: a.startedAt,
          })
          .onConflictDoNothing();
      });
    },

    attemptFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            entityType: rawRecord.entityType,
            version: rawRecord.externalVersion,
            payload: rawRecord.payload,
          })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              inArray(rawRecord.entityType, [EMAIL_ATTEMPT_ENTITY, EMAIL_ATTEMPT_REFUSED_ENTITY]),
              eq(rawRecord.externalId, idempotencyKey),
            ),
          );
        const tryOf = (version: string | null) => (version === null ? 1 : Number(version));
        const newest = rows
          .filter((r) => r.entityType === EMAIL_ATTEMPT_ENTITY)
          .sort((x, y) => tryOf(y.version) - tryOf(x.version))[0];
        if (!newest) return null;
        const attempt = tryOf(newest.version);
        const refused = rows.some(
          (r) => r.entityType === EMAIL_ATTEMPT_REFUSED_ENTITY && tryOf(r.version) === attempt,
        );
        const p = newest.payload as Omit<EmailSendAttempt, "startedAt"> & { startedAt: string };
        return { ...p, startedAt: new Date(p.startedAt), attempt, refused };
      });
    },

    refuseAttempt({ idempotencyKey, attempt, reason, at }) {
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: connection.id,
            connector: connection.connector,
            entityType: EMAIL_ATTEMPT_REFUSED_ENTITY,
            externalId: idempotencyKey,
            externalVersion: attemptVersion(attempt),
            payload: {
              idempotencyKey,
              attempt,
              reason: reason.slice(0, 200),
              at: at.toISOString(),
            },
            syncedAt: at,
          })
          .onConflictDoNothing();
      });
    },

    replyAddress() {
      return withTenant(db, tenantId, async (tx) => {
        const [up] = await tx
          .select()
          .from(connectionTable)
          .where(
            and(
              eq(connectionTable.tenantId, tenantId),
              eq(connectionTable.connector, UPLOAD_CONNECTOR_ID),
            ),
          )
          .orderBy(connectionTable.createdAt)
          .limit(1);
        return up ? (forwardingOf(up).address ?? null) : null;
      });
    },

    sentFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ payload: rawRecord.payload })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.entityType, EMAIL_MESSAGE_ENTITY),
              sql`${rawRecord.payload}->>'idempotencyKey' = ${idempotencyKey}`,
            ),
          )
          .limit(1);
        const p = row?.payload as { output?: unknown } | undefined;
        return (p?.output as Awaited<ReturnType<EmailServices["sentFor"]>>) ?? null;
      });
    },

    recordOutbound(m) {
      return withTenant(db, tenantId, async (tx) => {
        const [stored] = await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: m.connectionId,
            connector: connection.connector,
            entityType: EMAIL_MESSAGE_ENTITY,
            externalId: m.output.id,
            externalVersion: null,
            payload: {
              direction: "out",
              output: m.output,
              subject: m.subject,
              text: m.text,
              contactId: m.contactId,
              idempotencyKey: m.idempotencyKey,
            },
            syncedAt: m.sentAt,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        if (!stored) return;
        const [action] = await tx
          .select({ agentVersionId: externalAction.agentVersionId })
          .from(externalAction)
          .where(
            and(
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.idempotencyKey, m.idempotencyKey),
            ),
          )
          .limit(1);
        const c = await getContact(tx, tenantId, m.contactId);
        const threadId = await contactThread(tx, c);
        const body: ThreadMessageBody = {
          direction: "out",
          channel: "email",
          // P-3: the files that went with it, by name and size (docs/plan.md §1.65).
          text: [`${m.subject}\n\n${m.text}`, attachmentLine(m.output.attachments ?? [])]
            .filter(Boolean)
            .join("\n\n"),
          sid: m.output.id,
          rawRecordId: stored.id,
          status: "sent",
        };
        await tx.insert(message).values({
          tenantId,
          threadId,
          senderType: "agent",
          agentVersionId: action?.agentVersionId ?? null,
          body: body as unknown as Record<string, unknown>,
          sources: [stored.id],
        });
      });
    },
  };
}
