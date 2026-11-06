// v0.13 W2-I: run oversight's words on the client timeline (ARCHITECTURE §10.11; docs/plan.md
// §1.54), in each language. One line per decision, in the platform's words: the client never sees
// the agent's note, a prompt, a model or a cost (invariant 11). Field names and people's names are
// filled in as they are (a field's label comes from the step's input schema, written by us or the
// operator, never by the model).
//
// The lines other than English are drafts for the owner's fluent speakers to review.

import type { OversightActionName } from "../oversight/decision";
import type { Locale } from "./locale";

export interface OversightWords {
  /** `retry`: the step ran again as it was. */
  triedAgain: string;
  /** `retry_with`, one field changed: "Corrected the vendor name and tried again". */
  correctedField(field: string): string;
  /** `retry_with`, several fields or none we can name. */
  correctedInput: string;
  /** `ask`, to a named person. */
  asked(name: string): string;
  /** `ask`, to a role (no one person). */
  askedTeam: string;
  stopped: string;
  /** `continue` after a checkpoint (v0.13 M32). */
  checked: string;
  /** An ask's inbox title, before the agent's question: `Before we try "Find the vendor" again`. */
  askTitle(step: string): string;
  /** v0.13 M32: a checkpoint's ask, before the agent's question: `Before we go on from "Read…"`. */
  askCheckTitle(step: string): string;
}

export const OVERSIGHT_WORDS: Record<Locale, OversightWords> = {
  en: {
    triedAgain: "Tried again",
    correctedField: (f) => `Corrected the ${f} and tried again`,
    correctedInput: "Corrected the input and tried again",
    asked: (n) => `Asked ${n}`,
    askedTeam: "Asked your team",
    stopped: "Stopped",
    checked: "Checked and went on",
    askTitle: (s) => `Before we try "${s}" again`,
    askCheckTitle: (s) => `Before we go on from "${s}"`,
  },
  es: {
    triedAgain: "Se intentó de nuevo",
    correctedField: (f) => `Se corrigió el campo «${f}» y se intentó de nuevo`,
    correctedInput: "Se corrigieron los datos y se intentó de nuevo",
    asked: (n) => `Se preguntó a ${n}`,
    askedTeam: "Se preguntó a su equipo",
    stopped: "Se detuvo",
    checked: "Se revisó y se continuó",
    askTitle: (s) => `Antes de volver a intentar «${s}»`,
    askCheckTitle: (s) => `Antes de continuar después de «${s}»`,
  },
  fr: {
    triedAgain: "Nouvel essai",
    correctedField: (f) => `Champ « ${f} » corrigé, puis nouvel essai`,
    correctedInput: "Données corrigées, puis nouvel essai",
    asked: (n) => `Question posée à ${n}`,
    askedTeam: "Question posée à votre équipe",
    stopped: "Arrêté",
    checked: "Vérifié, puis poursuivi",
    askTitle: (s) => `Avant de réessayer « ${s} »`,
    askCheckTitle: (s) => `Avant de continuer après « ${s} »`,
  },
  "pt-BR": {
    triedAgain: "Tentamos de novo",
    correctedField: (f) => `Corrigimos o campo "${f}" e tentamos de novo`,
    correctedInput: "Corrigimos os dados e tentamos de novo",
    asked: (n) => `Perguntamos a ${n}`,
    askedTeam: "Perguntamos à sua equipe",
    stopped: "Interrompido",
    checked: "Verificado e seguimos",
    askTitle: (s) => `Antes de tentar "${s}" de novo`,
    askCheckTitle: (s) => `Antes de seguir depois de "${s}"`,
  },
  it: {
    triedAgain: "Riprovato",
    correctedField: (f) => `Corretto il campo «${f}» e riprovato`,
    correctedInput: "Corretti i dati e riprovato",
    asked: (n) => `Chiesto a ${n}`,
    askedTeam: "Chiesto al vostro team",
    stopped: "Interrotto",
    checked: "Controllato e proseguito",
    askTitle: (s) => `Prima di riprovare «${s}»`,
    askCheckTitle: (s) => `Prima di proseguire dopo «${s}»`,
  },
  de: {
    triedAgain: "Erneut versucht",
    correctedField: (f) => `Feld „${f}“ korrigiert und erneut versucht`,
    correctedInput: "Eingaben korrigiert und erneut versucht",
    asked: (n) => `${n} gefragt`,
    askedTeam: "Ihr Team gefragt",
    stopped: "Angehalten",
    checked: "Geprüft und fortgesetzt",
    askTitle: (s) => `Bevor wir „${s}“ erneut versuchen`,
    askCheckTitle: (s) => `Bevor wir nach „${s}“ weitermachen`,
  },
};

/** One decision's line on the client timeline, in the client's language. */
export function oversightLine(
  locale: Locale,
  decision: {
    action: OversightActionName;
    /** `retry_with`: the label of the one field it changed, else null. */
    field?: string | null;
    /** `ask`: the person asked, else null (a role). */
    askedName?: string | null;
  },
): string {
  const w = OVERSIGHT_WORDS[locale] ?? OVERSIGHT_WORDS.en;
  switch (decision.action) {
    case "retry":
      return w.triedAgain;
    case "retry_with":
      return decision.field ? w.correctedField(decision.field) : w.correctedInput;
    case "ask":
      return decision.askedName ? w.asked(decision.askedName) : w.askedTeam;
    case "stop":
      return w.stopped;
    case "continue":
      return w.checked;
  }
}
