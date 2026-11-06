// Twilio's webhooks (docs/plan.md §1.22): `POST /api/twilio/:tenantId/messages` (a text or WhatsApp
// message to one of the client's numbers) and `/status` (delivery status of a message we sent). No
// session: X-Twilio-Signature under the client's subaccount auth token, over the URL we gave Twilio,
// is the credential. The path's client scopes the lookup (withTenant); the AccountSid must be that
// client's subaccount and an inbound message's To one of its numbers. Unknown client, wrong
// account, bad signature: all 403 with nothing to probe.
//
// Each message is stored once (a raw record keyed by its SID; a status by SID and status), so a
// replayed delivery, signed or not, is acknowledged and does nothing. STOP and START are acted on
// in the same transaction, before anything else can send. The text is the sender's: it goes to the
// contact's thread for people to read and is reached by agents only through `message.get`
// (invariants 9 and 12); the events carry no text.

import {
  formDecode,
  keywordOfInbound,
  MESSAGE_RECEIVED_EVENT,
  MESSAGE_STATUS_EVENT,
  type MessageReceivedPayload,
  type MessageStatusPayload,
  parseInbound,
  parseStatus,
  readTwilioConfig,
  TWILIO_CONNECTOR_ID,
  TWILIO_MESSAGE_ENTITY,
  TWILIO_STATUS_ENTITY,
  twilioCredentialsOf,
  verifyTwilioSignature,
} from "@countersign/connectors";
import { redactCardNumbers, routes, TWIML_EMPTY } from "@countersign/core";
import { connection, message, rawRecord, type Tx, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { consumeTextReply, type Wake, wakeRelease } from "../access/release";
import { type AppEnv, errorResponse, HttpError } from "../http";
import {
  applyKeyword,
  contactThread,
  createContact,
  findContactByNumber,
  markThreadStatus,
  type ThreadMessageBody,
} from "../messaging/contacts";
import { dispatchEvents } from "../runs/dispatch";
import { connectionCredentials } from "../secrets";

const Params = z.object({ tenantId: z.uuid() });
/** An inbound text consumed by a human release: kept without its text, once per SID. */
const RELEASE_REPLY_ENTITY = "ReleaseReply";
const MAX_BYTES = 64 * 1024;

const refuse = () => new HttpError(403, "forbidden", "unknown client or bad signature");

function twiml(c: Context<AppEnv>, status = 200) {
  return c.body(TWIML_EMPTY, status as 200, { "content-type": "text/xml; charset=utf-8" });
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new HttpError(413, "too_large", "the body is too large");
  const text = await req.text();
  if (text.length > MAX_BYTES) throw new HttpError(413, "too_large", "the body is too large");
  try {
    return formDecode(text);
  } catch {
    throw new HttpError(400, "invalid_body", "the form is malformed");
  }
}

/** The client's Twilio connection, checked against the AccountSid and the signature. */
async function verified(
  tx: Tx,
  c: Context<AppEnv>,
  tenantId: string,
  form: Record<string, string>,
  which: "messages" | "status",
) {
  const services = c.get("req").services();
  const [row] = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, TWILIO_CONNECTOR_ID),
        eq(connection.status, "connected"),
        sql`${connection.config}->>'subaccountSid' = ${form.AccountSid ?? ""}`,
      ),
    )
    .limit(1);
  const config = row ? readTwilioConfig(row.config) : null;
  if (!row || !config) throw refuse();
  const auth = twilioCredentialsOf(
    await (await connectionCredentials(tx, services.env, row)).get(),
  );
  if (!auth) throw refuse();
  const ok = await verifyTwilioSignature({
    authToken: auth.authToken,
    // DECISION: the signature is checked over the URL we gave Twilio (stored with the connection),
    // not the URL this request arrived at, which a proxy in front of the Worker may rewrite.
    url: config.webhooks[which],
    params: form,
    signature: c.req.header("x-twilio-signature"),
  });
  if (!ok) throw refuse();
  return { row, config };
}

export function twilioHookRoutes(app: Hono<AppEnv>): void {
  app.post(routes.twilioInboundMessage.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      if (!params.success) throw refuse();
      const { tenantId } = params.data;
      const form = await readForm(c.req.raw);
      const services = c.get("req").services();
      const now = new Date();
      const collect: EventRow[] = [];
      let released: Wake | null = null;
      await withTenant(services.db, tenantId, async (tx) => {
        const { row, config } = await verified(tx, c, tenantId, form, "messages");
        // A card number in a text is never stored (PCI DSS 3.3, docs/plan.md §1.35).
        const parsed = parseInbound(form);
        if (!parsed) throw new HttpError(400, "invalid_body", "not a Twilio message");
        const msg = { ...parsed, text: redactCardNumbers(parsed.text) };
        if (!config.numbers.some((n) => n.phoneNumber === msg.to)) throw refuse();
        // A code for a pending human release is consumed before anything is stored: no raw
        // record of its text, no thread line, no event, so no agent or person reads it there
        // (docs/plan.md §1.26). A marker without the text keeps Twilio's retries from reading it
        // as a new message.
        const [seen] = await tx
          .select({ id: rawRecord.id })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, row.id),
              inArray(rawRecord.entityType, [TWILIO_MESSAGE_ENTITY, RELEASE_REPLY_ENTITY]),
              eq(rawRecord.externalId, msg.sid),
            ),
          )
          .limit(1);
        if (seen) return;
        if (msg.channel === "sms") {
          const reply = await consumeTextReply(
            tx,
            { secrets: services.env },
            {
              tenantId,
              from: msg.from,
              text: msg.text,
              now,
            },
          );
          if (reply.consumed) {
            await tx.insert(rawRecord).values({
              tenantId,
              connectionId: row.id,
              connector: TWILIO_CONNECTOR_ID,
              entityType: RELEASE_REPLY_ENTITY,
              externalId: msg.sid,
              externalVersion: null,
              payload: { direction: "in", channel: msg.channel, from: msg.from, to: msg.to },
              syncedAt: now,
            });
            released = reply.wake;
            return;
          }
        }
        const [stored] = await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: row.id,
            connector: TWILIO_CONNECTOR_ID,
            entityType: TWILIO_MESSAGE_ENTITY,
            externalId: msg.sid,
            externalVersion: null,
            payload: {
              direction: "in",
              channel: msg.channel,
              from: msg.from,
              to: msg.to,
              text: msg.text,
              numMedia: msg.numMedia,
              media: msg.media,
              profileName: msg.profileName,
            },
            syncedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        // Delivered before (Twilio retries, or a replay): acknowledged, nothing more.
        if (!stored) return;

        let contactRow = await findContactByNumber(tx, tenantId, msg.channel, msg.from);
        const knownContact = contactRow !== null;
        if (!contactRow) {
          // DECISION: someone not yet a contact becomes one, with no consent, so their thread and
          // any STOP are kept; consent still has to be given before anyone texts them.
          contactRow = await createContact(
            tx,
            tenantId,
            {
              name: msg.profileName?.trim() || msg.from,
              ...(msg.channel === "sms" ? { phone: msg.from } : { whatsapp: msg.from }),
            },
            null,
            now,
          );
        }
        const keyword = keywordOfInbound(msg);
        if (keyword) contactRow = await applyKeyword(tx, contactRow, keyword, msg.channel, now);

        const threadId = await contactThread(tx, contactRow);
        const body: ThreadMessageBody = {
          direction: "in",
          channel: msg.channel,
          text: msg.text,
          sid: msg.sid,
          rawRecordId: stored.id,
          status: null,
        };
        await tx.insert(message).values({
          tenantId,
          threadId,
          senderType: "contact",
          senderId: contactRow.id,
          body: body as unknown as Record<string, unknown>,
          sources: [stored.id],
        });
        const payload: MessageReceivedPayload = {
          connectionId: row.id,
          channel: msg.channel,
          messageSid: msg.sid,
          rawRecordId: stored.id,
          contactId: contactRow.id,
          knownContact,
          from: msg.from,
          to: msg.to,
          keyword,
          numMedia: msg.numMedia,
          receivedAt: now.toISOString(),
        };
        const ev = await emit(
          tx,
          {
            tenantId,
            type: MESSAGE_RECEIVED_EVENT,
            subjectType: "raw_record",
            subjectId: stored.id,
            payload,
          },
          { registry: services.platform.events },
        );
        if (ev) collect.push(ev);
      });
      if (collect.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, collect),
        );
      }
      const wake = released;
      if (wake) await wakeRelease(services.instances, wake);
      return twiml(c);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(routes.twilioMessageStatus.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      if (!params.success) throw refuse();
      const { tenantId } = params.data;
      const form = await readForm(c.req.raw);
      const services = c.get("req").services();
      const now = new Date();
      const collect: EventRow[] = [];
      await withTenant(services.db, tenantId, async (tx) => {
        const { row } = await verified(tx, c, tenantId, form, "status");
        const st = parseStatus(form);
        if (!st) throw new HttpError(400, "invalid_body", "not a Twilio status callback");
        const [stored] = await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: row.id,
            connector: TWILIO_CONNECTOR_ID,
            entityType: TWILIO_STATUS_ENTITY,
            externalId: `${st.sid}:${st.status}`,
            externalVersion: null,
            payload: {
              sid: st.sid,
              status: st.status,
              errorCode: st.errorCode,
              to: st.to,
              channel: st.channel,
            },
            syncedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        if (!stored) return;
        await markThreadStatus(tx, tenantId, st.sid, st.status);
        const payload: MessageStatusPayload = {
          connectionId: row.id,
          channel: st.channel,
          messageSid: st.sid,
          rawRecordId: stored.id,
          status: st.status,
          errorCode: st.errorCode,
          to: st.to,
          at: now.toISOString(),
        };
        const ev = await emit(
          tx,
          {
            tenantId,
            type: MESSAGE_STATUS_EVENT,
            subjectType: "raw_record",
            subjectId: stored.id,
            payload,
          },
          { registry: services.platform.events },
        );
        if (ev) collect.push(ev);
      });
      if (collect.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, collect),
        );
      }
      return twiml(c);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
