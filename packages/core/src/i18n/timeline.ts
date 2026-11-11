// The platform's own words on the client timeline (docs/plan.md §1.18), in each language.
import type { Locale } from "./locale";

/**
 * What the executor writes after a step's operator-written label on the client timeline, when the
 * step has no summary of its own: "Check the bill: done". The label stays as the operator wrote it;
 * durations (`2 days`) and path names are the operator's too.
 */
export interface TimelineWords {
  done: string;
  failed: string;
  approved: string;
  notApproved: string;
  answered: string;
  declined: string;
  waitingForApproval: string;
  waitingForAnswer: string;
  /** A conversation or reach-out waiting for the contact's reply. */
  waitingForReply: string;
  /** A step waiting for a person to release a vault item with a code (docs/plan.md §1.26). */
  waitingForRelease: string;
  needsOperator: string;
  noAnswerInTime: string;
  /** The fork's fallback path, which the operator does not name. */
  otherwise: string;
  sent: string;
  /**
   * A test run's write, recorded as proposed and never made (ARCHITECTURE §10.4), from the step's
   * operator-written name: "Would itemize the bill (test run, not written)".
   */
  wouldWrite(step: string): string;
  /** A test run's notify step, which sends nothing: "Would say what changed (test run, not sent)". */
  wouldSend(step: string): string;
  stopped: Record<"succeeded" | "failed" | "cancelled", string>;
  items(n: number): string;
  waiting(duration: string): string;
  waited(duration: string): string;
}

/**
 * "Itemize the bill" → "itemize the bill", to follow "Would". A first word that isn't a plain
 * capitalised word (QuickBooks, QBO, a single letter) keeps its case.
 */
function afterWould(step: string): string {
  return /^[A-Z][a-z]+\b/.test(step) ? step.charAt(0).toLowerCase() + step.slice(1) : step;
}

const plural = (locale: Locale, n: number, one: string, other: string) =>
  `${n} ${new Intl.PluralRules(locale).select(n) === "one" ? one : other}`;

export const TIMELINE_WORDS: Record<Locale, TimelineWords> = {
  en: {
    done: "done",
    failed: "failed",
    approved: "approved",
    notApproved: "not approved",
    answered: "answered",
    declined: "declined",
    waitingForApproval: "waiting for approval",
    waitingForAnswer: "waiting for an answer",
    waitingForReply: "waiting for a reply",
    waitingForRelease: "waiting for a code",
    needsOperator: "needs the operator",
    noAnswerInTime: "no answer in time",
    otherwise: "Otherwise",
    sent: "sent",
    wouldWrite: (s) => `Would ${afterWould(s)} (test run, not written)`,
    wouldSend: (s) => `Would ${afterWould(s)} (test run, not sent)`,
    stopped: { succeeded: "succeeded", failed: "failed", cancelled: "cancelled" },
    items: (n) => plural("en", n, "item", "items"),
    waiting: (d) => `waiting ${d}`,
    waited: (d) => `waited ${d}`,
  },
  es: {
    done: "hecho",
    failed: "falló",
    approved: "aprobado",
    notApproved: "no aprobado",
    answered: "respondido",
    declined: "rechazado",
    waitingForApproval: "esperando aprobación",
    waitingForAnswer: "esperando una respuesta",
    waitingForReply: "esperando una contestación",
    waitingForRelease: "esperando un código",
    needsOperator: "lo revisa nuestro equipo",
    noAnswerInTime: "sin respuesta a tiempo",
    otherwise: "En otro caso",
    sent: "enviado",
    wouldWrite: (s) => `Propuesto: ${s} (prueba, sin escribir)`,
    wouldSend: (s) => `Propuesto: ${s} (prueba, sin enviar)`,
    stopped: { succeeded: "terminado", failed: "falló", cancelled: "cancelado" },
    items: (n) => plural("es", n, "elemento", "elementos"),
    waiting: (d) => `esperando ${d}`,
    waited: (d) => `esperó ${d}`,
  },
  fr: {
    done: "terminé",
    failed: "échec",
    approved: "approuvé",
    notApproved: "non approuvé",
    answered: "répondu",
    declined: "refusé",
    waitingForApproval: "en attente d'approbation",
    waitingForAnswer: "en attente d'une réponse",
    waitingForReply: "en attente d'un retour",
    waitingForRelease: "en attente d'un code",
    needsOperator: "notre équipe s'en occupe",
    noAnswerInTime: "pas de réponse à temps",
    otherwise: "Sinon",
    sent: "envoyé",
    wouldWrite: (s) => `Proposé : ${s} (test, rien n'est écrit)`,
    wouldSend: (s) => `Proposé : ${s} (test, rien n'est envoyé)`,
    stopped: { succeeded: "terminé", failed: "échec", cancelled: "annulé" },
    items: (n) => plural("fr", n, "élément", "éléments"),
    waiting: (d) => `en attente : ${d}`,
    waited: (d) => `attendu : ${d}`,
  },
  "pt-BR": {
    done: "concluído",
    failed: "falhou",
    approved: "aprovado",
    notApproved: "não aprovado",
    answered: "respondido",
    declined: "recusado",
    waitingForApproval: "aguardando aprovação",
    waitingForAnswer: "aguardando uma resposta",
    waitingForReply: "aguardando um retorno",
    waitingForRelease: "aguardando um código",
    needsOperator: "nossa equipe vai verificar",
    noAnswerInTime: "sem resposta a tempo",
    otherwise: "Caso contrário",
    sent: "enviado",
    wouldWrite: (s) => `Proposto: ${s} (teste, nada gravado)`,
    wouldSend: (s) => `Proposto: ${s} (teste, nada enviado)`,
    stopped: { succeeded: "concluído", failed: "falhou", cancelled: "cancelado" },
    items: (n) => plural("pt-BR", n, "item", "itens"),
    waiting: (d) => `aguardando ${d}`,
    waited: (d) => `aguardou ${d}`,
  },
  it: {
    done: "fatto",
    failed: "non riuscito",
    approved: "approvato",
    notApproved: "non approvato",
    answered: "risposto",
    declined: "rifiutato",
    waitingForApproval: "in attesa di approvazione",
    waitingForAnswer: "in attesa di una risposta",
    waitingForReply: "in attesa di un riscontro",
    waitingForRelease: "in attesa di un codice",
    needsOperator: "se ne occupa il nostro team",
    noAnswerInTime: "nessuna risposta in tempo",
    otherwise: "Altrimenti",
    sent: "inviato",
    wouldWrite: (s) => `Proposto: ${s} (prova, non scritto)`,
    wouldSend: (s) => `Proposto: ${s} (prova, non inviato)`,
    stopped: { succeeded: "completato", failed: "non riuscito", cancelled: "annullato" },
    items: (n) => plural("it", n, "elemento", "elementi"),
    waiting: (d) => `in attesa: ${d}`,
    waited: (d) => `atteso: ${d}`,
  },
  de: {
    done: "erledigt",
    failed: "fehlgeschlagen",
    approved: "freigegeben",
    notApproved: "nicht freigegeben",
    answered: "beantwortet",
    declined: "abgelehnt",
    waitingForApproval: "wartet auf Freigabe",
    waitingForAnswer: "wartet auf eine Antwort",
    waitingForReply: "wartet auf eine Rückmeldung",
    waitingForRelease: "wartet auf einen Code",
    needsOperator: "unser Team kümmert sich",
    noAnswerInTime: "keine Antwort rechtzeitig",
    otherwise: "Sonst",
    sent: "gesendet",
    wouldWrite: (s) => `Vorgeschlagen: ${s} (Testlauf, nicht geschrieben)`,
    wouldSend: (s) => `Vorgeschlagen: ${s} (Testlauf, nicht gesendet)`,
    stopped: { succeeded: "abgeschlossen", failed: "fehlgeschlagen", cancelled: "abgebrochen" },
    items: (n) => plural("de", n, "Eintrag", "Einträge"),
    waiting: (d) => `wartet: ${d}`,
    waited: (d) => `gewartet: ${d}`,
  },
};
