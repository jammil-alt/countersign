// Twilio's voice webhooks (docs/plan.md §1.23), public, answered with TwiML:
//
// - `POST /api/twilio/:tenantId/voice`: someone is calling one of the client's numbers. Who takes it
//   is decided in code (calls/answer.ts planInbound) and stored with the call: the client agent's
//   voice agent only where its answering step may run without approval; otherwise the forward
//   number or voicemail. `call.received` is emitted with the decision.
// - `POST /api/twilio/:tenantId/voice/answer?call=<id>`: a call an agent placed was picked up; it
//   is handed to its voice agent.
// - `POST /api/twilio/:tenantId/voice/status`: a call's final status (its length is counted for
//   billing once) or a voicemail recording.
//
// As for texts: X-Twilio-Signature under the client's subaccount token, over the URL we gave Twilio
// (stored with the connection), is the credential; the path's client scopes every lookup; the
// AccountSid must be that client's subaccount. Unknown client, bad signature: 403, nothing to probe.
// Every fact is stored once, so Twilio's retries and replays change nothing.

import {
  CALL_COMPLETED_EVENT,
  CALL_RECEIVED_EVENT,
  type CallCompletedPayload,
  type CallReceivedPayload,
  formDecode,
  forwardTwiml,
  globalFetch,
  parseCallStatus,
  parseVoiceWebhook,
  readTwilioConfig,
  readVoiceConfig,
  registerCall,
  sayAndHangUpTwiml,
  TWILIO_CONNECTOR_ID,
  twilioCredentialsOf,
  verifyTwilioSignature,
  voicemailTwiml,
  voiceToolToken,
} from "@countersign/connectors";
import {
  type CallLanguage,
  callLanguage,
  callWords,
  FINAL_CALL_STATUSES,
  routes,
} from "@countersign/core";
import { connection, type Tx, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  ensureVoiceAgent,
  planInbound,
  type VoiceDeps,
  voiceAgentConfig,
  voiceDepsFromEnv,
} from "../calls/answer";
import {
  CALL_ENTITIES,
  type CallPayload,
  type CallRequestPayload,
  callBySid,
  callOutcome,
  countCallSeconds,
  findByPayload,
  findRecord,
  storeOnce,
  threadCallLine,
} from "../calls/store";
import { type AppEnv, errorResponse, HttpError, type Services } from "../http";
import { createContact, findContactByNumber } from "../messaging/contacts";
import { dispatchEvents } from "../runs/dispatch";
import { connectionCredentials } from "../secrets";

const Params = z.object({ tenantId: z.uuid() });
const MAX_BYTES = 64 * 1024;
type ConnectionRow = typeof connection.$inferSelect;

const refuse = () => new HttpError(403, "forbidden", "unknown client or bad signature");

function twiml(c: Context<AppEnv>, body: string) {
  return c.body(body, 200, { "content-type": "text/xml; charset=utf-8" });
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

export function voiceDepsFor(services: Services, c: Context<AppEnv>): VoiceDeps {
  return voiceDepsFromEnv(
    services.env,
    services.deps.fetch?.(services.env) ?? globalFetch(),
    new URL(c.req.url).origin,
  );
}

/** The client's Twilio connection with calls on, checked against the AccountSid and signature. */
async function verifiedVoice(
  tx: Tx,
  c: Context<AppEnv>,
  tenantId: string,
  form: Record<string, string>,
  url: (voice: NonNullable<ReturnType<typeof readVoiceConfig>>) => string,
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
  const voice = row ? readVoiceConfig(row.config) : null;
  if (!row || !config || !voice) throw refuse();
  const auth = twilioCredentialsOf(
    await (await connectionCredentials(tx, services.env, row)).get(),
  );
  if (!auth) throw refuse();
  const ok = await verifyTwilioSignature({
    authToken: auth.authToken,
    url: url(voice),
    params: form,
    signature: c.req.header("x-twilio-signature"),
  });
  if (!ok) throw refuse();
  return { row, config, voice };
}

async function clientOf(
  tx: Tx,
  tenantId: string,
): Promise<{ name: string; language: CallLanguage }> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  return {
    name: t?.name ?? "us",
    language: callLanguage((t?.settings as { language?: string } | null)?.language),
  };
}

/** Hands a picked-up or ringing call to its voice agent: the TwiML that connects them. */
async function handOver(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    voice: VoiceDeps;
    voiceAgentId: string;
    callId: string;
    callSid: string;
    from: string;
    to: string;
    direction: "inbound" | "outbound";
    contactName: string;
  },
): Promise<string> {
  const el = input.voice.elevenlabs;
  if (!el) throw new Error("ElevenLabs isn't set up");
  const twimlBody = await registerCall(input.voice.fetch, el, {
    agentId: input.voiceAgentId,
    from: input.from,
    to: input.to,
    direction: input.direction,
    dynamicVariables: {
      call_id: input.callId,
      tenant_id: input.tenantId,
      contact_name: input.contactName,
      secret__call_token: await voiceToolToken(el.webhookSecret, input.tenantId, input.callId),
    },
  });
  await storeOnce(tx, {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    entityType: CALL_ENTITIES.session,
    externalId: input.callSid,
    payload: { callSid: input.callSid, callId: input.callId, voiceAgentId: input.voiceAgentId },
  });
  return twimlBody;
}

function fallbackTwiml(
  plan: { decision: "agent" | "forward" | "voicemail" },
  input: {
    forwardTo: string | null;
    callerId: string;
    statusUrl: string;
    client: string;
    language: CallLanguage;
  },
): string {
  const w = callWords(input.language, input.client);
  if (plan.decision === "forward" && input.forwardTo) {
    return forwardTwiml({ to: input.forwardTo, callerId: input.callerId });
  }
  return voicemailTwiml({
    greeting: w.voicemail,
    goodbye: w.goodbye,
    language: input.language,
    recordingCallback: input.statusUrl,
  });
}

export function twilioVoiceRoutes(app: Hono<AppEnv>): void {
  app.post(routes.twilioVoiceInbound.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      if (!params.success) throw refuse();
      const { tenantId } = params.data;
      const form = await readForm(c.req.raw);
      const services = c.get("req").services();
      const voiceDeps = voiceDepsFor(services, c);
      const now = new Date();
      const collect: EventRow[] = [];
      const body = await withTenant(services.db, tenantId, async (tx) => {
        const { row, config, voice } = await verifiedVoice(
          tx,
          c,
          tenantId,
          form,
          (v) => v.webhooks.voice,
        );
        const call = parseVoiceWebhook(form);
        if (!call) throw new HttpError(400, "invalid_body", "not a Twilio call");
        if (!config.numbers.some((n) => n.phoneNumber === call.to)) throw refuse();
        const client = await clientOf(tx, tenantId);

        // Twilio asked before (a retry): answer the same way, without deciding or storing again.
        const before = await callBySid(tx, tenantId, call.callSid);
        let contactRow = await findContactByNumber(tx, tenantId, "sms", call.from);
        const knownContact = contactRow !== null;
        if (!contactRow) {
          // Someone not yet a contact becomes one, with no consent: calling in is not agreeing to
          // be called or texted.
          contactRow = await createContact(
            tx,
            tenantId,
            { name: call.from, phone: call.from },
            null,
            now,
          );
        }
        const language = callLanguage(contactRow.language, client.language);
        let payload: CallPayload;
        if (before) {
          payload = before.payload;
        } else {
          const plan = await planInbound(tx, {
            tenantId,
            connectionId: row.id,
            permissions: row.permissions as ConnectionRow["permissions"],
            config: row.config,
            forwardTo: voice.forwardTo,
            voice: voiceDeps,
          });
          payload = {
            direction: "in",
            callId: crypto.randomUUID(),
            from: call.from,
            to: call.to,
            contactId: contactRow.id,
            status: call.status || "ringing",
            decision: plan.decision,
            reason: plan.reason,
            agentId: plan.answering?.agentId ?? null,
            agentVersionId: plan.answering?.agentVersionId ?? null,
            voiceAgentId: null,
            tools: plan.settings?.tools ?? [],
            maxMinutes: plan.settings?.maxMinutes ?? 10,
            idempotencyKey: null,
            at: now.toISOString(),
          };
          if (plan.decision === "agent" && plan.answering && plan.settings) {
            const config = voiceAgentConfig({
              tenantId,
              client: client.name,
              agentSlug: plan.answering.agentSlug,
              bundle: plan.answering.bundle,
              settings: plan.settings,
              language,
              direction: "in",
              origin: voiceDeps.origin,
              platform: services.platform,
            });
            try {
              payload.voiceAgentId = await ensureVoiceAgent(tx, {
                tenantId,
                connectionId: row.id,
                agentVersionId: plan.answering.agentVersionId,
                config,
                voice: voiceDeps,
              });
            } catch (error) {
              console.error("voice agent could not be made", error);
              payload.decision = voice.forwardTo ? "forward" : "voicemail";
              payload.reason = "the voice agent couldn't be reached";
            }
          }
          const stored = await storeOnce(tx, {
            tenantId,
            connectionId: row.id,
            entityType: CALL_ENTITIES.call,
            externalId: call.callSid,
            payload,
            at: now,
          });
          if (!stored) throw new HttpError(409, "conflict", "this call is being answered");
          // The decision, for people to read in the contact's thread.
          await threadCallLine(tx, {
            tenantId,
            contactId: contactRow.id,
            direction: "in",
            text: `They called: ${payload.reason}`,
            callSid: call.callSid,
            rawRecordId: stored,
            status: payload.status,
            agentVersionId: payload.agentVersionId,
          });
          const received: CallReceivedPayload = {
            connectionId: row.id,
            callSid: call.callSid,
            rawRecordId: stored,
            contactId: contactRow.id,
            knownContact,
            from: call.from,
            to: call.to,
            decision: payload.decision,
            reason: payload.reason,
            receivedAt: now.toISOString(),
          };
          const ev = await emit(
            tx,
            {
              tenantId,
              type: CALL_RECEIVED_EVENT,
              subjectType: "raw_record",
              subjectId: stored,
              payload: received,
            },
            { registry: services.platform.events },
          );
          if (ev) collect.push(ev);
        }
        const fallback = () =>
          fallbackTwiml(payload, {
            forwardTo: voice.forwardTo,
            callerId: call.from,
            statusUrl: voice.webhooks.status,
            client: client.name,
            language,
          });
        if (payload.decision !== "agent" || !payload.voiceAgentId) return fallback();
        try {
          return await handOver(tx, {
            tenantId,
            connectionId: row.id,
            voice: voiceDeps,
            voiceAgentId: payload.voiceAgentId,
            callId: payload.callId,
            callSid: call.callSid,
            from: call.from,
            to: call.to,
            direction: "inbound",
            contactName: contactRow.name,
          });
        } catch (error) {
          // DECISION: if ElevenLabs can't take a call that rang in, the caller still reaches
          // voicemail (or the forward), rather than silence.
          console.error("call hand-over failed", error);
          return fallbackTwiml(
            { decision: voice.forwardTo ? "forward" : "voicemail" },
            {
              forwardTo: voice.forwardTo,
              callerId: call.from,
              statusUrl: voice.webhooks.status,
              client: client.name,
              language,
            },
          );
        }
      });
      if (collect.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, collect),
        );
      }
      return twiml(c, body);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(routes.twilioVoiceAnswer.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      const callId = z.uuid().safeParse(c.req.query("call"));
      if (!params.success || !callId.success) throw refuse();
      const { tenantId } = params.data;
      const form = await readForm(c.req.raw);
      const services = c.get("req").services();
      const voiceDeps = voiceDepsFor(services, c);
      const body = await withTenant(services.db, tenantId, async (tx) => {
        const { row } = await verifiedVoice(
          tx,
          c,
          tenantId,
          form,
          (v) => `${v.webhooks.answer}?call=${callId.data}`,
        );
        const call = parseVoiceWebhook(form);
        if (!call) throw new HttpError(400, "invalid_body", "not a Twilio call");
        const request = await findRecord(tx, tenantId, CALL_ENTITIES.request, callId.data);
        const p = request?.payload as unknown as CallRequestPayload | undefined;
        const client = await clientOf(tx, tenantId);
        if (!p || p.to !== call.to) throw refuse();
        // Twilio's call must be the one placed for this call id (once it is recorded).
        const placed = await callBySid(tx, tenantId, call.callSid);
        if (placed && placed.payload.callId !== p.callId) throw refuse();
        try {
          return await handOver(tx, {
            tenantId,
            connectionId: row.id,
            voice: voiceDeps,
            voiceAgentId: p.voiceAgentId,
            callId: p.callId,
            callSid: call.callSid,
            from: p.from,
            to: p.to,
            direction: "outbound",
            contactName: "",
          });
        } catch (error) {
          console.error("call hand-over failed", error);
          const lang = callLanguage(p.language);
          return sayAndHangUpTwiml(callWords(lang, client.name).sorry, lang);
        }
      });
      return twiml(c, body);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(routes.twilioVoiceStatus.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      if (!params.success) throw refuse();
      const { tenantId } = params.data;
      const form = await readForm(c.req.raw);
      const services = c.get("req").services();
      const now = new Date();
      const collect: EventRow[] = [];
      await withTenant(services.db, tenantId, async (tx) => {
        const { row } = await verifiedVoice(tx, c, tenantId, form, (v) => v.webhooks.status);
        const st = parseCallStatus(form);
        if (!st) throw new HttpError(400, "invalid_body", "not a Twilio call status");
        const call = await callBySid(tx, tenantId, st.callSid);
        if (!call) return;
        if (st.kind === "recording") {
          const stored = await storeOnce(tx, {
            tenantId,
            connectionId: row.id,
            entityType: CALL_ENTITIES.recording,
            externalId: st.recordingSid,
            payload: {
              callSid: st.callSid,
              callId: call.payload.callId,
              durationSecs: st.durationSecs,
            },
            at: now,
          });
          if (!stored) return;
          await threadCallLine(tx, {
            tenantId,
            contactId: call.payload.contactId,
            direction: "in",
            text: `They left a voicemail${st.durationSecs ? ` (${st.durationSecs} seconds)` : ""}`,
            callSid: st.callSid,
            rawRecordId: stored,
            status: "voicemail",
            agentVersionId: null,
          });
          return;
        }
        const stored = await storeOnce(tx, {
          tenantId,
          connectionId: row.id,
          entityType: CALL_ENTITIES.status,
          externalId: `${st.callSid}:${st.status}`,
          payload: {
            callSid: st.callSid,
            callId: call.payload.callId,
            status: st.status,
            durationSecs: st.durationSecs,
          },
          at: now,
        });
        // Delivered before (a retry or a replay): nothing more.
        if (!stored || !FINAL_CALL_STATUSES.includes(st.status)) return;
        const agentCall = call.payload.direction === "out" || call.payload.decision === "agent";
        if (agentCall && call.payload.agentId && st.durationSecs) {
          await countCallSeconds(tx, {
            tenantId,
            agentId: call.payload.agentId,
            seconds: st.durationSecs,
            at: now,
          });
        }
        // A call its voice agent spoke on is completed by ElevenLabs' post-call webhook, with its
        // transcript; every other call is completed here.
        const session = await findRecord(tx, tenantId, CALL_ENTITIES.session, st.callSid);
        if (session && st.status === "completed") return;
        const outcome = callOutcome(call.payload, [{ status: st.status }], false) ?? "failed";
        const followUps = await findByPayload(
          tx,
          tenantId,
          CALL_ENTITIES.followUp,
          "callId",
          call.payload.callId,
        );
        const done: CallCompletedPayload = {
          connectionId: row.id,
          callSid: st.callSid,
          direction: call.payload.direction,
          contactId: call.payload.contactId,
          outcome,
          durationSecs: st.durationSecs,
          rawRecordId: call.row.id,
          followUps: followUps.length,
          at: now.toISOString(),
        };
        const ev = await emit(
          tx,
          {
            tenantId,
            type: CALL_COMPLETED_EVENT,
            subjectType: "raw_record",
            subjectId: call.row.id,
            payload: done,
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
      return twiml(c, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
