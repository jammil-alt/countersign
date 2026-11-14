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
   * operator-written name: "Would itemize the bill (test run, not written)". `standIn`: later
   * steps got the tool's stand-in values for what it would have returned (docs/plan.md §1.94).
   */
  wouldWrite(step: string, standIn?: boolean): string;
  /** A test run's notify step, which sends nothing: "Would say what changed (test run, not sent)". */
  wouldSend(step: string): string;
  stopped: Record<"succeeded" | "failed" | "cancelled", string>;
  items(n: number): string;
  waiting(duration: string): string;
  waited(duration: string): string;
  /** v0.17: a repeat's line: "done after 2 rounds", or "stopped after 3 rounds" at its limit. */
  rounds(n: number, done: boolean): string;
  /** M61: an `if` its agent decided: "Pia chose: Get two quotes". */
  chose(agent: string, path: string): string;
  /** M61: the agent wasn't sure, and a person picked: "Pia wasn't sure, so it asked: Get two quotes". */
  askedThenTook(agent: string, path: string): string;
  /** M61: the agent wasn't sure, and the run took the otherwise path. */
  unsure(agent: string): string;
  // Hand off (owner, 2026-11-11)
  /** A hand-off step that started another agent's run: "Handed off to Price checker (run R-1a2b3c)". */
  handedOff(agent: string, run: string): string;
  /** A test run's hand-off, which starts nothing: "Would hand off to Price checker at 5 · Itemize the invoice (test run, nothing started)". */
  wouldHandOff(agent: string, at: string): string;
  /** A hand-off to an agent that isn't started: "Price checker isn't started, so the hand-off didn't run". */
  handOffNotStarted(agent: string): string;
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
    wouldWrite: (s, standIn) =>
      `Would ${afterWould(s)} (test run, not written${standIn ? "; stand-in values" : ""})`,
    wouldSend: (s) => `Would ${afterWould(s)} (test run, not sent)`,
    stopped: { succeeded: "succeeded", failed: "failed", cancelled: "cancelled" },
    items: (n) => plural("en", n, "item", "items"),
    waiting: (d) => `waiting ${d}`,
    waited: (d) => `waited ${d}`,
    rounds: (n, done) =>
      `${done ? "done after" : "stopped after"} ${plural("en", n, "round", "rounds")}`,
    chose: (a, p) => `${a} chose: ${p}`,
    askedThenTook: (a, p) => `${a} wasn't sure, so it asked: ${p}`,
    unsure: (a) => `${a} wasn't sure: otherwise`,
    handedOff: (a, r) => `Handed off to ${a} (run ${r})`,
    wouldHandOff: (a, at) => `Would hand off to ${a} at ${at} (test run, nothing started)`,
    handOffNotStarted: (a) => `${a} isn't started, so the hand-off didn't run`,
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
    wouldWrite: (s, standIn) =>
      `Propuesto: ${s} (prueba, sin escribir${standIn ? "; valores de muestra" : ""})`,
    wouldSend: (s) => `Propuesto: ${s} (prueba, sin enviar)`,
    stopped: { succeeded: "terminado", failed: "falló", cancelled: "cancelado" },
    items: (n) => plural("es", n, "elemento", "elementos"),
    waiting: (d) => `esperando ${d}`,
    waited: (d) => `esperó ${d}`,
    rounds: (n, done) =>
      `${done ? "terminado tras" : "detenido tras"} ${plural("es", n, "ronda", "rondas")}`,
    chose: (a, p) => `${a} eligió: ${p}`,
    askedThenTook: (a, p) => `${a} no estaba seguro, así que preguntó: ${p}`,
    unsure: (a) => `${a} no estaba seguro: en otro caso`,
    handedOff: (a, r) => `Pasado a ${a} (ejecución ${r})`,
    wouldHandOff: (a, at) => `Se pasaría a ${a} en ${at} (prueba, no se inició nada)`,
    handOffNotStarted: (a) => `${a} no está iniciado, así que no se pasó el trabajo`,
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
    wouldWrite: (s, standIn) =>
      `Proposé : ${s} (test, rien n'est écrit${standIn ? " ; valeurs fictives" : ""})`,
    wouldSend: (s) => `Proposé : ${s} (test, rien n'est envoyé)`,
    stopped: { succeeded: "terminé", failed: "échec", cancelled: "annulé" },
    items: (n) => plural("fr", n, "élément", "éléments"),
    waiting: (d) => `en attente : ${d}`,
    waited: (d) => `attendu : ${d}`,
    rounds: (n, done) =>
      `${done ? "terminé après" : "arrêté après"} ${plural("fr", n, "tour", "tours")}`,
    chose: (a, p) => `${a} a choisi : ${p}`,
    askedThenTook: (a, p) => `${a} n'était pas sûr, donc a demandé : ${p}`,
    unsure: (a) => `${a} n'était pas sûr : sinon`,
    handedOff: (a, r) => `Transmis à ${a} (exécution ${r})`,
    wouldHandOff: (a, at) => `Serait transmis à ${a} à l'étape ${at} (test, rien n'est lancé)`,
    handOffNotStarted: (a) => `${a} n'est pas démarré : le travail n'a pas été transmis`,
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
    wouldWrite: (s, standIn) =>
      `Proposto: ${s} (teste, nada gravado${standIn ? "; valores fictícios" : ""})`,
    wouldSend: (s) => `Proposto: ${s} (teste, nada enviado)`,
    stopped: { succeeded: "concluído", failed: "falhou", cancelled: "cancelado" },
    items: (n) => plural("pt-BR", n, "item", "itens"),
    waiting: (d) => `aguardando ${d}`,
    waited: (d) => `aguardou ${d}`,
    rounds: (n, done) =>
      `${done ? "concluído após" : "parado após"} ${plural("pt-BR", n, "rodada", "rodadas")}`,
    chose: (a, p) => `${a} escolheu: ${p}`,
    askedThenTook: (a, p) => `${a} não tinha certeza, então perguntou: ${p}`,
    unsure: (a) => `${a} não tinha certeza: caso contrário`,
    handedOff: (a, r) => `Passado para ${a} (execução ${r})`,
    wouldHandOff: (a, at) => `Passaria para ${a} em ${at} (teste, nada iniciado)`,
    handOffNotStarted: (a) => `${a} não está ativo, então o trabalho não foi passado`,
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
    wouldWrite: (s, standIn) =>
      `Proposto: ${s} (prova, non scritto${standIn ? "; valori fittizi" : ""})`,
    wouldSend: (s) => `Proposto: ${s} (prova, non inviato)`,
    stopped: { succeeded: "completato", failed: "non riuscito", cancelled: "annullato" },
    items: (n) => plural("it", n, "elemento", "elementi"),
    waiting: (d) => `in attesa: ${d}`,
    waited: (d) => `atteso: ${d}`,
    rounds: (n, done) =>
      `${done ? "completato dopo" : "fermato dopo"} ${plural("it", n, "giro", "giri")}`,
    chose: (a, p) => `${a} ha scelto: ${p}`,
    askedThenTook: (a, p) => `${a} non era sicuro, quindi ha chiesto: ${p}`,
    unsure: (a) => `${a} non era sicuro: altrimenti`,
    handedOff: (a, r) => `Passato a ${a} (esecuzione ${r})`,
    wouldHandOff: (a, at) => `Passerebbe a ${a} al passo ${at} (prova, nulla avviato)`,
    handOffNotStarted: (a) => `${a} non è avviato, quindi il lavoro non è stato passato`,
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
    wouldWrite: (s, standIn) =>
      `Vorgeschlagen: ${s} (Testlauf, nicht geschrieben${standIn ? "; Platzhalterwerte" : ""})`,
    wouldSend: (s) => `Vorgeschlagen: ${s} (Testlauf, nicht gesendet)`,
    stopped: { succeeded: "abgeschlossen", failed: "fehlgeschlagen", cancelled: "abgebrochen" },
    items: (n) => plural("de", n, "Eintrag", "Einträge"),
    waiting: (d) => `wartet: ${d}`,
    waited: (d) => `gewartet: ${d}`,
    rounds: (n, done) =>
      `${done ? "fertig nach" : "angehalten nach"} ${plural("de", n, "Runde", "Runden")}`,
    chose: (a, p) => `${a} hat gewählt: ${p}`,
    askedThenTook: (a, p) => `${a} war unsicher und hat gefragt: ${p}`,
    unsure: (a) => `${a} war unsicher: sonst`,
    handedOff: (a, r) => `Übergeben an ${a} (Ablauf ${r})`,
    wouldHandOff: (a, at) => `Würde an ${a} bei ${at} übergeben (Testlauf, nichts gestartet)`,
    handOffNotStarted: (a) => `${a} ist nicht gestartet, daher wurde nicht übergeben`,
  },
};
