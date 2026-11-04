import { z } from "zod";
import type { ConsentState, SendBlock } from "../messaging/rules";

// Phone calls by agents (docs/plan.md §1.19, §1.23): who may be called, what every call says first,
// and what a caller hears when no agent may answer. Checked in code before any call is placed or
// answered, never left to a model. Pure: the API, the connectors and the web app share them.

/** Whether this contact may be called by an agent, quiet hours aside. Calls go to `phone`. */
export function callBlock(c: ConsentState): SendBlock | null {
  if (c.optedOutAt) return "opted_out";
  if (!c.phone) return "no_number";
  if (!c.consent.voice) return "no_consent";
  return null;
}

/** Plain words for a blocked call, for errors and the approval card. */
export function callBlockMessage(block: SendBlock | "no_contact", extra: { until?: string } = {}) {
  switch (block) {
    case "no_contact":
      return "that number is not one of this client's contacts";
    case "no_number":
      return "this contact has no phone number";
    case "no_consent":
      return "this contact hasn't agreed to calls from an automated assistant";
    case "opted_out":
      return "this contact opted out of messages and calls";
    case "quiet_hours":
      return `it is quiet hours for this client${extra.until ? ` until ${extra.until}` : ""}`;
    case "a2p_pending":
      return "the client's US registration isn't approved yet";
  }
}

// ── Languages ────────────────────────────────────────────────────────────────────────────────────

/** The portal's languages (docs/plan.md §1.18); calls are made in the contact's, else the client's. */
export const CALL_LANGUAGES = ["en", "es", "fr", "pt-BR", "it", "de"] as const;
export type CallLanguage = (typeof CALL_LANGUAGES)[number];

/** A contact's or client's language as a call language (English when unknown). */
export function callLanguage(...candidates: (string | null | undefined)[]): CallLanguage {
  for (const c of candidates) {
    if (!c) continue;
    const exact = CALL_LANGUAGES.find((l) => l === c);
    if (exact) return exact;
    const base = c.slice(0, 2).toLowerCase();
    if (base === "pt") return "pt-BR";
    const found = CALL_LANGUAGES.find((l) => l === base);
    if (found) return found;
  }
  return "en";
}

// DECISION: the opening disclosure and the voicemail greeting are platform rules, written here in
// each portal language and marked for review by a fluent speaker (§1.18), not operator settings: a
// call always says it is an automated assistant and asks before keeping a record, whatever the
// agent's version says.
interface CallWords {
  /** Outbound: the first thing said. `{client}` is the client's name. */
  outbound: string;
  /** Inbound, answered by an agent. */
  inbound: string;
  /** Asked straight after, before anything else. */
  recording: string;
  /** No agent may answer. */
  voicemail: string;
  /** After the voicemail tone. */
  goodbye: string;
  /** A call that couldn't be connected to its agent. */
  sorry: string;
}

// REVIEW: translations below need a fluent speaker's review before a client hears them.
export const CALL_WORDS: Record<CallLanguage, CallWords> = {
  en: {
    outbound: "Hello, this is an automated assistant calling for {client}.",
    inbound: "Hello, you've reached {client}. This is an automated assistant.",
    recording: "May I keep a written record of this call?",
    voicemail:
      "Thanks for calling {client}. No one can take your call right now. Please leave a message after the tone, or send a text to this number.",
    goodbye: "Thank you. Goodbye.",
    sorry: "Sorry, we can't take this call right now. Please try again later.",
  },
  es: {
    outbound: "Hola, le habla un asistente automático en nombre de {client}.",
    inbound: "Hola, ha llamado a {client}. Le atiende un asistente automático.",
    recording: "¿Me permite guardar un registro escrito de esta llamada?",
    voicemail:
      "Gracias por llamar a {client}. Ahora no podemos atenderle. Deje un mensaje después del tono o envíe un texto a este número.",
    goodbye: "Gracias. Adiós.",
    sorry: "Lo sentimos, ahora no podemos atender esta llamada. Inténtelo más tarde.",
  },
  fr: {
    outbound: "Bonjour, ici un assistant automatique qui appelle de la part de {client}.",
    inbound: "Bonjour, vous êtes chez {client}. Vous parlez à un assistant automatique.",
    recording: "Puis-je garder une trace écrite de cet appel ?",
    voicemail:
      "Merci d'avoir appelé {client}. Personne ne peut vous répondre pour le moment. Laissez un message après le bip, ou envoyez un SMS à ce numéro.",
    goodbye: "Merci. Au revoir.",
    sorry: "Désolé, nous ne pouvons pas prendre cet appel pour le moment. Réessayez plus tard.",
  },
  "pt-BR": {
    outbound: "Olá, aqui é um assistente automático ligando em nome de {client}.",
    inbound: "Olá, você ligou para {client}. Quem fala é um assistente automático.",
    recording: "Posso guardar um registro escrito desta ligação?",
    voicemail:
      "Obrigado por ligar para {client}. Ninguém pode atender agora. Deixe uma mensagem após o sinal ou mande uma mensagem de texto para este número.",
    goodbye: "Obrigado. Tchau.",
    sorry: "Desculpe, não podemos atender esta ligação agora. Tente mais tarde.",
  },
  it: {
    outbound: "Buongiorno, sono un assistente automatico e chiamo per conto di {client}.",
    inbound: "Buongiorno, ha chiamato {client}. Le risponde un assistente automatico.",
    recording: "Posso conservare una trascrizione di questa chiamata?",
    voicemail:
      "Grazie per aver chiamato {client}. Al momento nessuno può rispondere. Lasci un messaggio dopo il segnale acustico, oppure invii un SMS a questo numero.",
    goodbye: "Grazie. Arrivederci.",
    sorry: "Ci scusi, al momento non possiamo rispondere. Riprovi più tardi.",
  },
  de: {
    outbound: "Guten Tag, hier ist ein automatischer Assistent im Auftrag von {client}.",
    inbound:
      "Guten Tag, Sie sind mit {client} verbunden. Hier spricht ein automatischer Assistent.",
    recording: "Darf ich eine schriftliche Aufzeichnung dieses Gesprächs behalten?",
    voicemail:
      "Danke für Ihren Anruf bei {client}. Gerade kann niemand rangehen. Bitte hinterlassen Sie nach dem Ton eine Nachricht oder schicken Sie eine SMS an diese Nummer.",
    goodbye: "Danke. Auf Wiederhören.",
    sorry: "Leider können wir diesen Anruf gerade nicht annehmen. Bitte versuchen Sie es später.",
  },
};

export function callWords(language: CallLanguage, client: string): CallWords {
  const w = CALL_WORDS[language];
  const fill = (s: string) => s.replaceAll("{client}", client);
  return {
    outbound: fill(w.outbound),
    inbound: fill(w.inbound),
    recording: fill(w.recording),
    voicemail: fill(w.voicemail),
    goodbye: fill(w.goodbye),
    sorry: fill(w.sorry),
  };
}

/**
 * The first thing a call says: the automated-assistant disclosure, the agent's own opening (from
 * its version, if any), then the question about keeping a record. The order is fixed in code.
 */
export function openingLine(input: {
  direction: "in" | "out";
  language: CallLanguage;
  client: string;
  firstMessage?: string | null | undefined;
}): string {
  const w = callWords(input.language, input.client);
  const parts = [input.direction === "out" ? w.outbound : w.inbound];
  const own = input.firstMessage?.trim();
  if (own) parts.push(own);
  parts.push(w.recording);
  return parts.join(" ");
}

// ── Outcomes ─────────────────────────────────────────────────────────────────────────────────────

/** How a call ended, as `call.completed` and `call.get` say it. */
export const CallOutcome = z.enum([
  /** An agent spoke with them. */
  "answered",
  "voicemail",
  "forwarded",
  "no_answer",
  "busy",
  "failed",
  "canceled",
]);
export type CallOutcome = z.infer<typeof CallOutcome>;

/** Twilio's final call statuses. */
export const FINAL_CALL_STATUSES = ["completed", "busy", "no-answer", "failed", "canceled"];

export function outcomeOfStatus(status: string): CallOutcome | null {
  switch (status) {
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

/** Who answers an inbound call, and why (recorded with the call). */
export const InboundDecision = z.enum(["agent", "forward", "voicemail"]);
export type InboundDecision = z.infer<typeof InboundDecision>;

/** The longest an agent's call may last. */
export const CALL_MAX_MINUTES = 30;
export const CALL_DEFAULT_MINUTES = 10;
