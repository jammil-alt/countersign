// Twilio's voice API as calls use it (docs/plan.md §1.23): placing a call from the client's number,
// pointing a number's incoming calls at our webhook, reading Twilio's voice webhooks, and the TwiML
// we answer with when no agent may take a call (voicemail or a forward). The voice agent itself is
// ElevenLabs' (../elevenlabs). What we couldn't check is in NOTES.md.

import { E164, normalizePhone, trimTrailingSlashes } from "@countersign/core";
import { z } from "zod";
import type { FetchLike } from "../http";
import { AccountSid, accountUrl, type TwilioAuth, twilioRequest } from "./api";

/** Raw records on the client's Twilio connection. */
export const TWILIO_CALL_ENTITY = "Call";
/** An agent's call, before Twilio has an id for it (our call id). */
export const TWILIO_CALL_REQUEST_ENTITY = "CallRequest";
/** A call handed to its voice agent (once per call). */
export const TWILIO_CALL_SESSION_ENTITY = "CallSession";
/** A call's final status (by call id and status). */
export const TWILIO_CALL_STATUS_ENTITY = "CallStatus";
/** A voicemail (by recording id). */
export const TWILIO_RECORDING_ENTITY = "CallRecording";
/** Something the caller asked to change, noted by the voice agent during the call. */
export const TWILIO_FOLLOW_UP_ENTITY = "CallFollowUp";
/** A tool the voice agent used during the call. */
export const TWILIO_CALL_TOOL_ENTITY = "CallToolCall";

/** `connection.config.voice`: calls are on for this client. */
export const TwilioVoiceConfig = z.object({
  enabledAt: z.string(),
  /** Unanswered inbound calls are forwarded here; voicemail when null. */
  forwardTo: E164.nullable().default(null),
  /** Where Twilio asks about calls: incoming, picked-up outbound, and status. */
  webhooks: z.object({ voice: z.string(), answer: z.string(), status: z.string() }),
  /** Numbers (PN…) whose incoming calls come to us. */
  answering: z.array(z.string()).default([]),
});
export type TwilioVoiceConfig = z.infer<typeof TwilioVoiceConfig>;

export function readVoiceConfig(config: unknown): TwilioVoiceConfig | null {
  const v = (config as { voice?: unknown } | null)?.voice;
  if (v == null) return null;
  const r = TwilioVoiceConfig.safeParse(v);
  return r.success ? r.data : null;
}

export function twilioVoiceUrls(origin: string, tenantId: string) {
  const base = `${trimTrailingSlashes(origin)}/api/twilio/${tenantId}/voice`;
  return { voice: base, answer: `${base}/answer`, status: `${base}/status` };
}

// ── REST ─────────────────────────────────────────────────────────────────────────────────────────

const CallCreated = z.object({
  sid: z.string().regex(/^CA[0-9a-f]{32}$/),
  status: z.string().nullish(),
});

/**
 * Places a call. Twilio rings `to` from `from`; once it is picked up, Twilio asks `url` what to do
 * (we hand it to the voice agent), and posts the final status to `statusCallback`.
 */
export async function placeCall(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { to: string; from: string; url: string; statusCallback: string; timeLimitSecs: number },
): Promise<{ sid: string; status: string }> {
  const c = CallCreated.parse(
    await twilioRequest(fetch, auth, "POST", `${accountUrl(auth.accountSid)}/Calls.json`, {
      form: {
        To: input.to,
        From: input.from,
        Url: input.url,
        Method: "POST",
        StatusCallback: input.statusCallback,
        StatusCallbackMethod: "POST",
        // Ring for 30 seconds; no answering-machine detection (a voicemail greeting talks to the
        // agent, which hears it and ends the call).
        Timeout: "30",
        TimeLimit: String(input.timeLimitSecs),
      },
    }),
  );
  return { sid: c.sid, status: c.status ?? "queued" };
}

const ListedCall = z.object({
  sid: z.string(),
  to: z.string().nullish(),
  from: z.string().nullish(),
  status: z.string().nullish(),
  direction: z.string().nullish(),
  date_created: z.string().nullish(),
  start_time: z.string().nullish(),
});
export type ListedCall = z.infer<typeof ListedCall>;

/**
 * Twilio's recent calls from `from` to `to`, newest first (one page): what a re-run looks through
 * for a call it may have placed before a crash.
 */
export async function listCalls(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { to: string; from: string },
): Promise<ListedCall[]> {
  const body = z.object({ calls: z.array(ListedCall).default([]) }).parse(
    await twilioRequest(fetch, auth, "GET", `${accountUrl(auth.accountSid)}/Calls.json`, {
      query: { To: input.to, From: input.from, PageSize: "50" },
    }),
  );
  return body.calls;
}

/** Points a number's incoming calls (and their final status) at us, or back to nothing. */
export async function setNumberVoice(
  fetch: FetchLike,
  auth: TwilioAuth,
  numberSid: string,
  urls: { voice: string; status: string } | null,
): Promise<void> {
  await twilioRequest(
    fetch,
    auth,
    "POST",
    `${accountUrl(auth.accountSid)}/IncomingPhoneNumbers/${numberSid}.json`,
    {
      form: urls
        ? {
            VoiceUrl: urls.voice,
            VoiceMethod: "POST",
            StatusCallback: urls.status,
            StatusCallbackMethod: "POST",
          }
        : { VoiceUrl: "", StatusCallback: "" },
    },
  );
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

const CallSidRe = z.string().regex(/^CA[0-9a-f]{32}$/);

export interface VoiceWebhook {
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  /** `inbound`, `outbound-api`, … */
  direction: string;
  status: string;
}

/** A call webhook's fields (incoming call or picked-up outbound call), or null. */
export function parseVoiceWebhook(p: Record<string, string>): VoiceWebhook | null {
  const sid = CallSidRe.safeParse(p.CallSid);
  const account = AccountSid.safeParse(p.AccountSid);
  const from = normalizePhone(p.From ?? "");
  const to = normalizePhone(p.To ?? "");
  if (!sid.success || !account.success || !from || !to) return null;
  return {
    callSid: sid.data,
    accountSid: account.data,
    from,
    to,
    direction: (p.Direction ?? "").slice(0, 40),
    status: (p.CallStatus ?? "").toLowerCase().slice(0, 40),
  };
}

export type CallStatusWebhook =
  | {
      kind: "status";
      callSid: string;
      accountSid: string;
      status: string;
      durationSecs: number | null;
    }
  | {
      kind: "recording";
      callSid: string;
      accountSid: string;
      recordingSid: string;
      durationSecs: number | null;
      status: string;
    };

const intOrNull = (v: string | undefined) => {
  if (v === undefined || !/^\d{1,7}$/.test(v)) return null;
  return Number.parseInt(v, 10);
};

/** A call's status callback, or a voicemail's recording callback, or null. */
export function parseCallStatus(p: Record<string, string>): CallStatusWebhook | null {
  const sid = CallSidRe.safeParse(p.CallSid);
  const account = AccountSid.safeParse(p.AccountSid);
  if (!sid.success || !account.success) return null;
  if (p.RecordingSid !== undefined) {
    if (!/^RE[0-9a-f]{32}$/.test(p.RecordingSid)) return null;
    return {
      kind: "recording",
      callSid: sid.data,
      accountSid: account.data,
      recordingSid: p.RecordingSid,
      durationSecs: intOrNull(p.RecordingDuration),
      status: (p.RecordingStatus ?? "completed").toLowerCase().slice(0, 40),
    };
  }
  const status = (p.CallStatus ?? "").toLowerCase();
  if (!/^[a-z-]{2,20}$/.test(status)) return null;
  return {
    kind: "status",
    callSid: sid.data,
    accountSid: account.data,
    status,
    durationSecs: intOrNull(p.CallDuration),
  };
}

// ── TwiML ────────────────────────────────────────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Our call languages as Twilio <Say> languages. */
export function twilioSayLanguage(language: string): string {
  const map: Record<string, string> = {
    en: "en-US",
    es: "es-US",
    fr: "fr-FR",
    "pt-BR": "pt-BR",
    it: "it-IT",
    de: "de-DE",
  };
  return map[language] ?? "en-US";
}

const say = (text: string, language: string) =>
  `<Say language="${twilioSayLanguage(language)}">${xmlEscape(text)}</Say>`;

/** A greeting, the tone, up to two minutes of message, then goodbye. */
export function voicemailTwiml(input: {
  greeting: string;
  goodbye: string;
  language: string;
  recordingCallback: string;
}): string {
  return `${XML_HEAD}<Response>${say(input.greeting, input.language)}<Record maxLength="120" timeout="5" playBeep="true" recordingStatusCallback="${xmlEscape(input.recordingCallback)}" recordingStatusCallbackMethod="POST"/>${say(input.goodbye, input.language)}</Response>`;
}

/** Rings the forward number for 20 seconds, showing the caller's number. */
export function forwardTwiml(input: { to: string; callerId: string }): string {
  return `${XML_HEAD}<Response><Dial timeout="20" callerId="${xmlEscape(input.callerId)}"><Number>${xmlEscape(input.to)}</Number></Dial></Response>`;
}

export function sayAndHangUpTwiml(text: string, language: string): string {
  return `${XML_HEAD}<Response>${say(text, language)}<Hangup/></Response>`;
}

export const TWIML_HANGUP = `${XML_HEAD}<Response><Hangup/></Response>`;
