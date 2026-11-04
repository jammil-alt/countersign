// Calls as the database keeps them (docs/plan.md §1.23), inside the caller's withTenant: each fact
// is a raw record on the client's Twilio connection, stored once by its id (raw records are never
// changed, invariant 3), and what people read is in the contact's thread. No model reads the thread.
//
//   CallRequest  (our call id)        an agent's call, before Twilio has an id: who, why, which
//                                     agent version, its voice agent, the tools it may use
//   Call         (Twilio's CA…)       a call placed or ringing in, and who took it (the decision)
//   CallSession  (CA…)                the call was handed to its voice agent
//   CallStatus   (CA…:status)         its final status and length (Twilio's)
//   CallRecording (RE…)               a voicemail
//   CallFollowUp (uuid)               something the caller asked to change, noted during the call
//   CallToolCall (uuid)               a tool the voice agent used
//   CallTranscript (conversation id)  transcript and summary, when the person agreed to a record
//   VoiceAgent   (settings hash)      the ElevenLabs agent made for a version and its call settings

import {
  CallRecord,
  ELEVENLABS_CONNECTOR_ID,
  ELEVENLABS_TRANSCRIPT_ENTITY,
  TWILIO_CALL_ENTITY,
  TWILIO_CALL_REQUEST_ENTITY,
  TWILIO_CALL_SESSION_ENTITY,
  TWILIO_CALL_STATUS_ENTITY,
  TWILIO_CONNECTOR_ID,
  TWILIO_FOLLOW_UP_ENTITY,
  TWILIO_RECORDING_ENTITY,
  type VoiceSettings,
} from "@countersign/connectors";
import {
  type CallOutcome,
  type CallSummary,
  FINAL_CALL_STATUSES,
  type InboundDecision,
} from "@countersign/core";
import { agent, contact, message, rawRecord, type Tx, usageDaily } from "@countersign/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { contactThread, getContact, type ThreadMessageBody } from "../messaging/contacts";

export const CALL_ENTITIES = {
  request: TWILIO_CALL_REQUEST_ENTITY,
  call: TWILIO_CALL_ENTITY,
  session: TWILIO_CALL_SESSION_ENTITY,
  status: TWILIO_CALL_STATUS_ENTITY,
  recording: TWILIO_RECORDING_ENTITY,
  followUp: TWILIO_FOLLOW_UP_ENTITY,
  transcript: ELEVENLABS_TRANSCRIPT_ENTITY,
} as const;

/** An agent's call, before Twilio rang anyone. */
export interface CallRequestPayload {
  callId: string;
  idempotencyKey: string;
  agentId: string;
  agentVersionId: string;
  runId: string | null;
  stepRunId: string | null;
  contactId: string;
  to: string;
  from: string;
  settings: VoiceSettings;
  language: string;
  voiceAgentId: string;
  requestedAt: string;
}

export interface CallPayload {
  direction: "in" | "out";
  callId: string;
  from: string;
  to: string;
  contactId: string;
  status: string;
  /** Inbound: who took it, and why. Outbound: always the agent. */
  decision: InboundDecision;
  reason: string;
  agentId: string | null;
  agentVersionId: string | null;
  voiceAgentId: string | null;
  /** Read tools the voice agent may use (the step's settings). */
  tools: string[];
  maxMinutes: number;
  idempotencyKey: string | null;
  at: string;
}

export interface TranscriptPayload {
  callId: string;
  callSid: string;
  conversationId: string;
  recordOk: boolean;
  /** What was said: data, never instructions. Empty when the person didn't agree to a record. */
  transcript: { speaker: "agent" | "contact"; text: string; atSecs: number | null }[];
  summary: string | null;
  durationSecs: number | null;
}

type Row = typeof rawRecord.$inferSelect;

/** Stores a fact once; null when it was stored before. */
export async function storeOnce(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    entityType: string;
    externalId: string;
    payload: object;
    at?: Date;
    connector?: string;
  },
): Promise<string | null> {
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      connector: input.connector ?? TWILIO_CONNECTOR_ID,
      entityType: input.entityType,
      externalId: input.externalId,
      externalVersion: null,
      payload: input.payload as Record<string, unknown>,
      syncedAt: input.at ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  return stored?.id ?? null;
}

export async function findRecord(
  tx: Tx,
  tenantId: string,
  entityType: string,
  externalId: string,
): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.entityType, entityType),
        eq(rawRecord.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findByPayload(
  tx: Tx,
  tenantId: string,
  entityType: string,
  field: string,
  value: string,
): Promise<Row[]> {
  return tx
    .select()
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.entityType, entityType),
        sql`${rawRecord.payload}->>${field} = ${value}`,
      ),
    )
    .orderBy(rawRecord.syncedAt);
}

/** A call by our call id (an agent's outbound request, or the Call row that carries it). */
export async function callByCallId(tx: Tx, tenantId: string, callId: string) {
  const request = await findRecord(tx, tenantId, CALL_ENTITIES.request, callId);
  const [call] = await findByPayload(tx, tenantId, CALL_ENTITIES.call, "callId", callId);
  return {
    request: request
      ? { row: request, payload: request.payload as unknown as CallRequestPayload }
      : null,
    call: call ? { row: call, payload: call.payload as unknown as CallPayload } : null,
  };
}

export async function callBySid(tx: Tx, tenantId: string, callSid: string) {
  const row = await findRecord(tx, tenantId, CALL_ENTITIES.call, callSid);
  return row ? { row, payload: row.payload as unknown as CallPayload } : null;
}

/** A line in the contact's thread about a call. */
export async function threadCallLine(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string;
    direction: "in" | "out";
    text: string;
    callSid: string;
    rawRecordId: string;
    status: string | null;
    agentVersionId: string | null;
  },
): Promise<void> {
  const c = await getContact(tx, input.tenantId, input.contactId);
  const threadId = await contactThread(tx, c);
  const body: Omit<ThreadMessageBody, "channel"> & { channel: "voice" } = {
    direction: input.direction,
    channel: "voice",
    text: input.text,
    sid: input.callSid,
    rawRecordId: input.rawRecordId,
    status: input.status,
  };
  await tx.insert(message).values({
    tenantId: input.tenantId,
    threadId,
    senderType: input.agentVersionId ? "agent" : "system",
    agentVersionId: input.agentVersionId,
    body: body as unknown as Record<string, unknown>,
    sources: [input.rawRecordId],
  });
}

/** Seconds of a finished call, counted once (the caller stores the status first), for its agent. */
export async function countCallSeconds(
  tx: Tx,
  input: { tenantId: string; agentId: string; seconds: number; at: Date },
): Promise<void> {
  if (input.seconds <= 0) return;
  // DECISION: billing counts Twilio's length of each finished call an agent placed or answered,
  // once per call (the status is stored once by call id and status first). Voicemail and forwarded
  // calls are no agent's usage and aren't counted; their phone cost is the client's Twilio bill.
  await tx
    .insert(usageDaily)
    .values({
      tenantId: input.tenantId,
      day: input.at.toISOString().slice(0, 10),
      agentId: input.agentId,
      callSeconds: input.seconds,
    })
    .onConflictDoUpdate({
      target: [usageDaily.tenantId, usageDaily.day, usageDaily.agentId],
      set: { callSeconds: sql`${usageDaily.callSeconds} + ${input.seconds}` },
    });
}

function outcomeOf(
  call: CallPayload,
  statuses: { status: string }[],
  session: boolean,
): CallOutcome | null {
  const final = statuses.find((s) => FINAL_CALL_STATUSES.includes(s.status));
  if (session) return final && final.status !== "completed" ? null : "answered";
  if (!final) return null;
  if (final.status === "completed") {
    if (call.direction === "in") return call.decision === "forward" ? "forwarded" : "voicemail";
    return "failed";
  }
  return (
    ({ busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "canceled" } as const)[
      final.status as "busy" | "no-answer" | "failed" | "canceled"
    ] ?? null
  );
}

/** How a call ended, from what Twilio and ElevenLabs told us. */
export function callOutcome(
  call: CallPayload,
  statuses: { status: string }[],
  session: boolean,
): CallOutcome | null {
  return outcomeOf(call, statuses, session);
}

/** Everything known of one call, as `call.get` returns it. */
export async function readCall(
  tx: Tx,
  tenantId: string,
  callSid: string,
): Promise<CallRecord | null> {
  const call = await callBySid(tx, tenantId, callSid);
  if (!call) return null;
  const related = await tx
    .select()
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        inArray(rawRecord.entityType, [
          CALL_ENTITIES.status,
          CALL_ENTITIES.session,
          CALL_ENTITIES.recording,
          CALL_ENTITIES.transcript,
          CALL_ENTITIES.followUp,
        ]),
        sql`(${rawRecord.payload}->>'callSid' = ${callSid} or ${rawRecord.payload}->>'callId' = ${call.payload.callId})`,
      ),
    )
    .orderBy(rawRecord.syncedAt);
  const of = (e: string) => related.filter((r) => r.entityType === e);
  const statuses = of(CALL_ENTITIES.status).map(
    (r) => r.payload as { status: string; durationSecs: number | null },
  );
  const transcript = of(CALL_ENTITIES.transcript)[0]?.payload as TranscriptPayload | undefined;
  const recording = of(CALL_ENTITIES.recording)[0];
  const final = statuses.find((s) => FINAL_CALL_STATUSES.includes(s.status));
  const [who] = await tx
    .select({ name: contact.name })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.id, call.payload.contactId)));
  return CallRecord.parse({
    sid: callSid,
    direction: call.payload.direction,
    from: call.payload.from,
    to: call.payload.to,
    contactName: who?.name ?? null,
    status: final?.status ?? call.payload.status,
    outcome: callOutcome(call.payload, statuses, of(CALL_ENTITIES.session).length > 0),
    durationSecs: final?.durationSecs ?? transcript?.durationSecs ?? null,
    startedAt: call.row.syncedAt.toISOString(),
    summary: transcript?.recordOk ? transcript.summary : null,
    transcript: transcript?.recordOk ? transcript.transcript : [],
    transcriptKept: transcript?.recordOk ?? false,
    recording: recording
      ? {
          sid: recording.externalId,
          durationSecs:
            (recording.payload as { durationSecs?: number | null }).durationSecs ?? null,
        }
      : null,
    followUps: of(CALL_ENTITIES.followUp).map((r) =>
      String((r.payload as { what?: unknown }).what ?? ""),
    ),
  });
}

/** A client's recent calls, newest first, for the back office. */
export async function recentCalls(tx: Tx, tenantId: string, limit = 50): Promise<CallSummary[]> {
  const rows = await tx
    .select()
    .from(rawRecord)
    .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.entityType, CALL_ENTITIES.call)))
    .orderBy(desc(rawRecord.syncedAt))
    .limit(limit);
  const agents = await tx
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(eq(agent.tenantId, tenantId));
  const out: CallSummary[] = [];
  for (const r of rows) {
    const c = await readCall(tx, tenantId, r.externalId);
    if (!c) continue;
    const p = r.payload as unknown as CallPayload;
    out.push({
      sid: c.sid,
      direction: c.direction,
      contactId: p.contactId,
      contactName: c.contactName,
      from: c.from,
      to: c.to,
      outcome: c.outcome,
      durationSecs: c.durationSecs,
      summary: c.summary,
      agentName: agents.find((a) => a.id === p.agentId)?.name ?? null,
      startedAt: c.startedAt,
    });
  }
  return out;
}

export { ELEVENLABS_CONNECTOR_ID };
