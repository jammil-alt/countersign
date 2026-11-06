// The platform's own words in a client's threads (ARCHITECTURE §11.2; docs/plan.md §1.38), in each
// language. The Worker writes them as system messages, so they live here beside the timeline and
// release words (§1.18). Plain text, no exclamation marks; a fluent speaker reviews them with the rest.
import type { Locale } from "./locale";

export interface ThreadWords {
  /** The system's answer to `/name` when no agent of the client answers to it. */
  unknownCommand(name: string): string;
}

export const THREAD_WORDS: Record<Locale, ThreadWords> = {
  en: { unknownCommand: (n) => `No agent called /${n} here.` },
  es: { unknownCommand: (n) => `Aquí no hay ningún agente llamado /${n}.` },
  fr: { unknownCommand: (n) => `Aucun agent ne s'appelle /${n} ici.` },
  "pt-BR": { unknownCommand: (n) => `Não há nenhum agente chamado /${n} aqui.` },
  it: { unknownCommand: (n) => `Qui non c'è nessun agente chiamato /${n}.` },
  de: { unknownCommand: (n) => `Hier gibt es keinen Agenten namens /${n}.` },
};
