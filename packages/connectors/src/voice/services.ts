// What a calling connector (Twilio's voice) asks of the platform for one client: may this person be
// called now (consent to calls, opt-out, quiet hours: checked in code before any call), was this
// call already placed or started (a re-run after a crash), get a call ready (its voice agent from the agent's
// version, its webhooks), record it once placed, and read a call back. apps/api implements it over
// the client's contacts and raw records inside withTenant; the connector never reads the database.

import type { SendBlock } from "@countersign/core";
import type { SendContact } from "../messaging/services";
import type { CallRecord, VoiceSettings } from "./spec";

export interface CallCheckInput {
  /** E.164. */
  to: string;
  now: Date;
  /** Skip the quiet-hours check (the approval card is drawn at any hour; the call itself is not). */
  ignoreQuietHours?: boolean;
}

export type CallCheck =
  | { ok: true; contact: SendContact }
  | { ok: false; block: SendBlock | "no_contact"; message: string };

export interface PlacedCall {
  callSid: string;
  status: string;
  to: string;
  from: string;
  /** Who was called, as recorded then (a re-run returns the call without checking again). */
  contactId: string;
  contactName: string;
}

/**
 * A call that was started: its request (prepareOutbound), recorded with its time before Twilio is
 * called, so a re-run after a crash knows Twilio may have placed it (docs/plan.md §1.23).
 */
export interface CallAttempt {
  /** Our id for the call (the request's). */
  callId: string;
  contactId: string;
  contactName: string;
  to: string;
  from: string;
  startedAt: Date;
}

export interface OutboundCallRequest {
  /** The external action's key: one call per key. */
  idempotencyKey: string;
  connectionId: string;
  contactId: string;
  to: string;
  from: string;
  settings: VoiceSettings;
  now: Date;
}

export interface PreparedCall {
  /** Our id for the call, before Twilio has given its own. */
  callId: string;
  /** Where Twilio asks what to do once the call is picked up (signed by Twilio). */
  answerUrl: string;
  statusUrl: string;
  maxSeconds: number;
}

export interface InboundAnswer {
  callSid: string;
  /** Whether the agent took the call when it rang. */
  answered: boolean;
  /** Why (e.g. "the answering step needs approval, so the call went to voicemail"). */
  reason: string;
  from: string;
  contactName: string;
}

export interface VoiceServices {
  checkCall(input: CallCheckInput): Promise<CallCheck>;
  /** The call already placed under this key, if any. */
  placedFor(idempotencyKey: string): Promise<PlacedCall | null>;
  /** The call started under this key (its request), if any, whether or not it was placed. */
  attemptFor(idempotencyKey: string): Promise<CallAttempt | null>;
  /** Which of these call SIDs are recorded already, under any key. */
  recordedCallSids(sids: readonly string[]): Promise<string[]>;
  /**
   * Gets the call's voice agent and webhooks ready and records its request (the attempt, with its
   * time), before Twilio is called. Refuses when calls aren't set up.
   */
  prepareOutbound(request: OutboundCallRequest): Promise<PreparedCall>;
  /** Stores the call Twilio accepted, once (by call id), in the contact's thread. */
  recordPlaced(input: {
    callId: string;
    callSid: string;
    status: string;
    connectionId: string;
    contactId: string;
    to: string;
    from: string;
    idempotencyKey: string;
    at: Date;
  }): Promise<void>;
  /** How an inbound call was answered when it rang (null: no such call). */
  inboundCall(callSid: string): Promise<InboundAnswer | null>;
  getCall(callSid: string): Promise<CallRecord | null>;
}

export class CallBlockedError extends Error {
  constructor(
    readonly block:
      | SendBlock
      | "no_contact"
      | "no_services"
      | "no_sender"
      | "calls_off"
      | "not_answered"
      | "no_call",
    message: string,
  ) {
    super(message);
    this.name = "CallBlockedError";
  }
}
