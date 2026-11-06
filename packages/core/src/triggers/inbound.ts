// What is kept of a message sent to an agent (docs/plan.md §1.48 "Inbound messages"): its own
// words, quoted history cut, card numbers redacted, at most 4,000 characters. The text is the
// sender's data, reached only through `inbound.get` (invariants 9 and 12); and the fixed words the
// platform sends back. Line-by-line checks with plain string tests (no regex over the body).

import { redactCardNumbers } from "../compliance/card-numbers";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locale";

export const INBOUND_TEXT_MAX = 4000;
/** The raw record an email to an agent is kept as, on the client's upload connection. */
export const INBOUND_MESSAGE_ENTITY = "InboundMessage";

/** Words mail apps put before the sender's name in "On … wrote:", in the portal's languages. */
const ATTRIBUTION_START = ["on ", "el ", "le ", "em ", "il ", "am "];
const ATTRIBUTION_END = [
  "wrote:",
  "escribió:",
  "a écrit :",
  "a écrit:",
  "escreveu:",
  "ha scritto:",
];

function isAttribution(line: string): boolean {
  const l = line.toLowerCase();
  if (l.length > 300 || !ATTRIBUTION_START.some((s) => l.startsWith(s))) return false;
  if (ATTRIBUTION_END.some((e) => l.endsWith(e))) return true;
  return l.startsWith("am ") && l.includes(" schrieb ") && l.endsWith(":");
}

function isOriginalMessage(line: string): boolean {
  const l = line.toLowerCase();
  return l.startsWith("--") && l.includes("original message") && l.endsWith("--");
}

/** The message's own words, ready to keep. */
export function inboundText(body: string): string {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (t.startsWith(">") || isAttribution(t) || isOriginalMessage(t)) break;
    out.push(line);
  }
  return redactCardNumbers(out.join("\n").trim()).slice(0, INBOUND_TEXT_MAX);
}

export interface TriggerWords {
  /** The polite reply to someone the agent doesn't take messages from. */
  strangerReply(agentName: string): string;
  /** The subject line of that reply by email. */
  strangerSubject(agentName: string): string;
  /** The lead's note in the client's lead thread. */
  strangerNote(agentName: string, channel: string, from: string): string;
  /** The subject of `reply.confirm` by email. */
  confirmSubject(agentName: string): string;
}

// DECISION: the polite reply is fixed text in the client's language: it says only that the message
// can't be taken here, and names no one, so it tells a stranger nothing about the client.
export const TRIGGER_WORDS: Record<Locale, TriggerWords> = {
  en: {
    strangerReply: (a) =>
      `Thanks for your message. ${a} can only take requests from people the business has set up, so nothing was done. Please contact the business directly.`,
    strangerSubject: (a) => `Your message to ${a}`,
    strangerNote: (a, c, f) =>
      `${a} got a message by ${c} from ${f}, who isn't set up to send it requests. Nothing was done.`,
    confirmSubject: (a) => `${a} got your message`,
  },
  es: {
    strangerReply: (a) =>
      `Gracias por su mensaje. ${a} solo acepta solicitudes de personas que la empresa ha configurado, así que no se hizo nada. Comuníquese directamente con la empresa.`,
    strangerSubject: (a) => `Su mensaje a ${a}`,
    strangerNote: (a, c, f) =>
      `${a} recibió un mensaje por ${c} de ${f}, que no puede enviarle solicitudes. No se hizo nada.`,
    confirmSubject: (a) => `${a} recibió su mensaje`,
  },
  fr: {
    strangerReply: (a) =>
      `Merci pour votre message. ${a} n'accepte que les demandes des personnes enregistrées par l'entreprise, donc rien n'a été fait. Veuillez contacter l'entreprise directement.`,
    strangerSubject: (a) => `Votre message à ${a}`,
    strangerNote: (a, c, f) =>
      `${a} a reçu un message par ${c} de ${f}, qui ne peut pas lui envoyer de demandes. Rien n'a été fait.`,
    confirmSubject: (a) => `${a} a reçu votre message`,
  },
  "pt-BR": {
    strangerReply: (a) =>
      `Obrigado pela mensagem. ${a} só aceita pedidos de pessoas cadastradas pela empresa, então nada foi feito. Entre em contato diretamente com a empresa.`,
    strangerSubject: (a) => `Sua mensagem para ${a}`,
    strangerNote: (a, c, f) =>
      `${a} recebeu uma mensagem por ${c} de ${f}, que não pode enviar pedidos. Nada foi feito.`,
    confirmSubject: (a) => `${a} recebeu sua mensagem`,
  },
  it: {
    strangerReply: (a) =>
      `Grazie per il messaggio. ${a} accetta solo richieste dalle persone registrate dall'azienda, quindi non è stato fatto nulla. Contatti direttamente l'azienda.`,
    strangerSubject: (a) => `Il suo messaggio a ${a}`,
    strangerNote: (a, c, f) =>
      `${a} ha ricevuto un messaggio via ${c} da ${f}, che non può inviargli richieste. Non è stato fatto nulla.`,
    confirmSubject: (a) => `${a} ha ricevuto il suo messaggio`,
  },
  de: {
    strangerReply: (a) =>
      `Danke für Ihre Nachricht. ${a} nimmt nur Anfragen von Personen an, die das Unternehmen eingerichtet hat, daher wurde nichts getan. Bitte wenden Sie sich direkt an das Unternehmen.`,
    strangerSubject: (a) => `Ihre Nachricht an ${a}`,
    strangerNote: (a, c, f) =>
      `${a} hat eine Nachricht per ${c} von ${f} erhalten, der ihm keine Anfragen senden darf. Es wurde nichts getan.`,
    confirmSubject: (a) => `${a} hat Ihre Nachricht erhalten`,
  },
};

export function triggerWords(locale: Locale | null | undefined): TriggerWords {
  return TRIGGER_WORDS[locale ?? DEFAULT_LOCALE] ?? TRIGGER_WORDS.en;
}
