// The platform services the `resend` connector calls (EmailServices), over the client's contacts:
// may this address be emailed (a contact of this client, with email consent, not opted out), was
// this send already made (a re-run after a crash), and record the email once in the contact's
// thread. Each call is one short withTenant transaction for the connection's client (invariant 1).

import type { ConnectionRef, EmailServices } from "@countersign/connectors";
import { consentBlockFor } from "@countersign/core";
import { contact, type Db, externalAction, message, rawRecord, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import {
  contactThread,
  getContact,
  reachContactOf,
  type ThreadMessageBody,
} from "../messaging/contacts";

export const EMAIL_MESSAGE_ENTITY = "EmailMessage";

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
          text: `${m.subject}\n\n${m.text}`,
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
