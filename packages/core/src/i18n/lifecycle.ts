// The go-live sign-off item the client admin sees on the Desk (ARCHITECTURE §10.9), in each
// language (docs/plan.md §1.36). The Worker writes it, so it lives here like RELEASE_WORDS.
// Counts only: no record content, no internals (instructions, prompts, cost).
// TODO(review): es, fr, pt-BR, it and de want a fluent speaker's review.
import type { Locale } from "./locale";

export interface GoLiveCounts {
  runs: number;
  failed: number;
  changesMade: number;
  signed: number;
  rejected: number;
}

export interface GoLiveWords {
  /** "<agent> going live". */
  title(agent: string): string;
  /** One sentence of the trial in numbers. */
  summary(c: GoLiveCounts): string;
  /** What approving and rejecting do. */
  ask: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const GO_LIVE_WORDS: Record<Locale, GoLiveWords> = {
  en: {
    title: (a) => `${a} going live`,
    summary: (c) =>
      `In its trial: ${plural(c.runs, "run", "runs")} (${c.failed} failed), ${plural(c.changesMade, "change", "changes")} made, ${c.signed} signed, ${c.rejected} rejected.`,
    ask: "Approve and it works on its own within the permissions you set. Reject and its trial goes on: tell us why.",
  },
  es: {
    title: (a) => `${a} pasa a producción`,
    summary: (c) =>
      `En su prueba: ${plural(c.runs, "ejecución", "ejecuciones")} (${c.failed} fallidas), ${plural(c.changesMade, "cambio hecho", "cambios hechos")}, ${c.signed} firmados, ${c.rejected} rechazados.`,
    ask: "Si lo aprueba, trabajará solo dentro de los permisos que usted fijó. Si lo rechaza, su prueba sigue: díganos por qué.",
  },
  fr: {
    title: (a) => `${a} passe en production`,
    summary: (c) =>
      `Pendant son essai : ${plural(c.runs, "exécution", "exécutions")} (${c.failed} en échec), ${plural(c.changesMade, "modification faite", "modifications faites")}, ${c.signed} signées, ${c.rejected} refusées.`,
    ask: "Approuvez-le et il travaillera seul dans les permissions que vous avez fixées. Refusez-le et son essai continue : dites-nous pourquoi.",
  },
  "pt-BR": {
    title: (a) => `${a} entrando em produção`,
    summary: (c) =>
      `No período de teste: ${plural(c.runs, "execução", "execuções")} (${c.failed} com falha), ${plural(c.changesMade, "alteração feita", "alterações feitas")}, ${c.signed} assinadas, ${c.rejected} rejeitadas.`,
    ask: "Aprove e ele trabalha sozinho dentro das permissões que você definiu. Rejeite e o teste continua: diga-nos por quê.",
  },
  it: {
    title: (a) => `${a} entra in produzione`,
    summary: (c) =>
      `Nella prova: ${plural(c.runs, "esecuzione", "esecuzioni")} (${c.failed} non riuscite), ${plural(c.changesMade, "modifica fatta", "modifiche fatte")}, ${c.signed} firmate, ${c.rejected} rifiutate.`,
    ask: "Se lo approva, lavora da solo entro i permessi che ha fissato. Se lo rifiuta, la prova continua: ci dica perché.",
  },
  de: {
    title: (a) => `${a} geht live`,
    summary: (c) =>
      `In der Testphase: ${plural(c.runs, "Lauf", "Läufe")} (${c.failed} fehlgeschlagen), ${plural(c.changesMade, "Änderung", "Änderungen")} vorgenommen, ${c.signed} unterschrieben, ${c.rejected} abgelehnt.`,
    ask: "Genehmigen Sie, arbeitet er selbstständig innerhalb der von Ihnen gesetzten Berechtigungen. Lehnen Sie ab, läuft die Testphase weiter: Sagen Sie uns, warum.",
  },
};
