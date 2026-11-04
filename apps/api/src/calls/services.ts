// The platform services the Twilio connector's call tools use (packages/connectors' VoiceServices),
// over the client's contacts and call records: each call is one short withTenant transaction for
// the connection's client, so a call can only ever see and record its own client's contacts and
// calls (invariant 1).

import {
  CallBlockedError,
  type ConnectionRef,
  readVoiceConfig,
  type VoiceServices,
} from "@countersign/connectors";
import {
  type ContactConsent,
  callBlock,
  callBlockMessage,
  callLanguage,
  inQuietHours,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  contact,
  type Db,
  externalAction,
  run,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { findContactByNumber, getContact, messagingSettings } from "../messaging/contacts";
import type { Platform } from "../platform";
import { ensureVoiceAgent, type VoiceDeps, voiceAgentConfig } from "./answer";
import {
  CALL_ENTITIES,
  type CallPayload,
  type CallRequestPayload,
  callBySid,
  findByPayload,
  readCall,
  storeOnce,
  threadCallLine,
} from "./store";

export function dbVoiceServices(
  db: Db,
  connection: ConnectionRef,
  deps: { voice: VoiceDeps; platform: Platform },
): VoiceServices {
  const tenantId = connection.tenantId;
  return {
    checkCall(input) {
      return withTenant(db, tenantId, async (tx) => {
        const c = await findContactByNumber(tx, tenantId, "sms", input.to);
        if (!c) {
          return {
            ok: false as const,
            block: "no_contact" as const,
            message: callBlockMessage("no_contact"),
          };
        }
        const block = callBlock({
          phone: c.phone,
          whatsapp: c.whatsapp,
          consent: (c.consent ?? {}) as ContactConsent,
          optedOutAt: c.optedOutAt,
        });
        if (block) return { ok: false as const, block, message: callBlockMessage(block) };
        if (!input.ignoreQuietHours) {
          const s = await messagingSettings(tx, tenantId);
          if (inQuietHours(input.now, s.timezone, s.quietHours)) {
            return {
              ok: false as const,
              block: "quiet_hours" as const,
              message: `${callBlockMessage("quiet_hours", { until: `${s.quietHours.end} (${s.timezone})` })}; place it again after that`,
            };
          }
        }
        return { ok: true as const, contact: { id: c.id, name: c.name, language: c.language } };
      });
    },

    placedFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await findByPayload(
          tx,
          tenantId,
          CALL_ENTITIES.call,
          "idempotencyKey",
          idempotencyKey,
        );
        if (!row) return null;
        const p = row.payload as unknown as CallPayload;
        // Not getContact: a placed call is returned even if its contact was removed since.
        const [who] = await tx
          .select({ name: contact.name })
          .from(contact)
          .where(and(eq(contact.id, p.contactId), eq(contact.tenantId, tenantId)));
        return {
          callSid: row.externalId,
          status: p.status,
          to: p.to,
          from: p.from,
          contactId: p.contactId,
          contactName: who?.name ?? p.to,
        };
      });
    },

    async prepareOutbound(r) {
      const voiceDeps = deps.voice;
      if (!voiceDeps.elevenlabs) {
        throw new CallBlockedError("calls_off", "voice agents aren't set up on this deployment");
      }
      return withTenant(db, tenantId, async (tx) => {
        const voice = readVoiceConfig(connection.config);
        if (!voice)
          throw new CallBlockedError("calls_off", "calls aren't turned on for this client");
        // The action that is placing the call names its run and the agent version (invariant 10).
        const [action] = await tx
          .select({
            agentVersionId: externalAction.agentVersionId,
            runId: externalAction.runId,
            stepRunId: externalAction.stepRunId,
            agentId: run.agentId,
          })
          .from(externalAction)
          .leftJoin(
            run,
            and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)),
          )
          .where(
            and(
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.idempotencyKey, r.idempotencyKey),
            ),
          )
          .limit(1);
        if (!action?.agentVersionId || !action.agentId) {
          throw new CallBlockedError("no_call", "a call is placed only by an agent's run");
        }
        const [v] = await tx
          .select({ bundle: agentVersion.bundle, slug: agent.slug })
          .from(agentVersion)
          .innerJoin(agent, eq(agent.id, agentVersion.agentId))
          .where(
            and(eq(agentVersion.id, action.agentVersionId), eq(agentVersion.tenantId, tenantId)),
          );
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
        if (!v || !t) throw new CallBlockedError("no_call", "the agent's version is missing");
        const who = await getContact(tx, tenantId, r.contactId);
        const language = callLanguage(
          who.language,
          (t.settings as { language?: string } | null)?.language,
        );
        // r.settings' purpose and opening are the step's fixed text: the gate refused the call
        // otherwise, before its approval card (call.place `fixedInputs`, invariant 9).
        const config = voiceAgentConfig({
          tenantId,
          client: t.name,
          agentSlug: v.slug,
          bundle: v.bundle,
          settings: r.settings,
          language,
          direction: "out",
          origin: voiceDeps.origin,
          platform: deps.platform,
        });
        const voiceAgentId = await ensureVoiceAgent(tx, {
          tenantId,
          connectionId: connection.id,
          agentVersionId: action.agentVersionId,
          config,
          voice: voiceDeps,
        });
        const callId = crypto.randomUUID();
        const payload: CallRequestPayload = {
          callId,
          idempotencyKey: r.idempotencyKey,
          agentId: action.agentId,
          agentVersionId: action.agentVersionId,
          runId: action.runId,
          stepRunId: action.stepRunId,
          contactId: r.contactId,
          to: r.to,
          from: r.from,
          settings: r.settings,
          language,
          voiceAgentId,
          requestedAt: r.now.toISOString(),
        };
        await storeOnce(tx, {
          tenantId,
          connectionId: connection.id,
          entityType: CALL_ENTITIES.request,
          externalId: callId,
          payload,
          at: r.now,
        });
        return {
          callId,
          answerUrl: voice.webhooks.answer,
          statusUrl: voice.webhooks.status,
          maxSeconds: r.settings.maxMinutes * 60,
        };
      });
    },

    recordPlaced(i) {
      return withTenant(db, tenantId, async (tx) => {
        const request = (
          await findByPayload(tx, tenantId, CALL_ENTITIES.request, "callId", i.callId)
        )[0]?.payload as unknown as CallRequestPayload | undefined;
        const payload: CallPayload = {
          direction: "out",
          callId: i.callId,
          from: i.from,
          to: i.to,
          contactId: i.contactId,
          status: i.status,
          decision: "agent",
          reason: "placed by an agent's run, after approval",
          agentId: request?.agentId ?? null,
          agentVersionId: request?.agentVersionId ?? null,
          voiceAgentId: request?.voiceAgentId ?? null,
          tools: request?.settings.tools ?? [],
          maxMinutes: request?.settings.maxMinutes ?? 10,
          idempotencyKey: i.idempotencyKey,
          at: i.at.toISOString(),
        };
        const stored = await storeOnce(tx, {
          tenantId,
          connectionId: i.connectionId,
          entityType: CALL_ENTITIES.call,
          externalId: i.callSid,
          payload,
          at: i.at,
        });
        if (!stored) return;
        await threadCallLine(tx, {
          tenantId,
          contactId: i.contactId,
          direction: "out",
          text: `We called: ${request?.settings.purpose ?? "a call"}`,
          callSid: i.callSid,
          rawRecordId: stored,
          status: i.status,
          agentVersionId: request?.agentVersionId ?? null,
        });
      });
    },

    inboundCall(callSid) {
      return withTenant(db, tenantId, async (tx) => {
        const call = await callBySid(tx, tenantId, callSid);
        if (call?.payload.direction !== "in") return null;
        const c = await getContact(tx, tenantId, call.payload.contactId);
        return {
          callSid,
          answered: call.payload.decision === "agent",
          reason: call.payload.reason,
          from: call.payload.from,
          contactName: c.name,
        };
      });
    },

    getCall(callSid) {
      return withTenant(db, tenantId, (tx) => readCall(tx, tenantId, callSid));
    },
  };
}
