// The Desk's words the server writes for clients (docs/plan.md §1.39, v0.12 "Client words"): why
// an item waits for approval, and who approves what (Settings, Approvals). Six languages, like the
// release words; the translations are marked for a fluent speaker's review.
// TODO(review): es, fr, pt-BR, it and de need a fluent speaker's read.
import type { WhyCode } from "../permissions/explain";
import type { Locale } from "./locale";

type WriteVerb = "create" | "update" | "delete";

export interface DeskRuleParts {
  /** The tool or connector, as people name it ("QuickBooks Online"); null for any. */
  what: string | null;
  verb: WriteVerb | null;
  /** "USD 2000.00", or null. */
  amount: string | null;
  /** The agent's name as the client sees it, or null for any agent. */
  agent: string | null;
}

export interface DeskWords {
  /** One short line per reason a change waits. */
  why: Record<Exclude<WhyCode, "stage">, string>;
  stage: { trial: string; signoff: string };
  /** The approver rules chose who approves. */
  byRule: string;
  team: {
    /** A viewer: sees, approves nothing. */
    viewer: string;
    /** The client admin: what no rule sends elsewhere. */
    everythingElse: string;
    /** One rule that sends changes to this person, in plain words. */
    rule(parts: DeskRuleParts): string;
  };
}

export const DESK_WORDS: Record<Locale, DeskWords> = {
  en: {
    why: {
      step: "This step needs your approval.",
      matrix: "Your settings for this tool ask for approval.",
      grant: "This agent's access to the tool asks for approval.",
      mode: "This agent only suggests changes.",
      person: "The person it reaches asked to see changes first.",
      always: "A change like this one is always signed by a person.",
    },
    stage: {
      trial: "The agent is in its trial: every change needs approval.",
      signoff: "The agent is waiting for your approval to go live: every change needs approval.",
    },
    byRule: "Your approval rules send it to you.",
    team: {
      viewer: "Sees everything, approves nothing.",
      everythingElse: "Every change no rule sends to someone else.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "New records"
            : verb === "update"
              ? "Updates"
              : verb === "delete"
                ? "Deletions"
                : "Changes",
          what ? `in ${what}` : null,
          amount ? `over ${amount}` : null,
          agent ? `by ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
  es: {
    why: {
      step: "Este paso necesita su aprobación.",
      matrix: "Su configuración de esta herramienta pide aprobación.",
      grant: "El acceso de este agente a la herramienta pide aprobación.",
      mode: "Este agente solo sugiere cambios.",
      person: "La persona a la que llega pidió ver los cambios antes.",
      always: "Un cambio como este siempre lo firma una persona.",
    },
    stage: {
      trial: "El agente está en su prueba: cada cambio necesita aprobación.",
      signoff: "El agente espera su aprobación para empezar: cada cambio necesita aprobación.",
    },
    byRule: "Sus reglas de aprobación se lo envían a usted.",
    team: {
      viewer: "Lo ve todo, no aprueba nada.",
      everythingElse: "Todo cambio que ninguna regla envía a otra persona.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "Registros nuevos"
            : verb === "update"
              ? "Actualizaciones"
              : verb === "delete"
                ? "Eliminaciones"
                : "Cambios",
          what ? `en ${what}` : null,
          amount ? `de más de ${amount}` : null,
          agent ? `de ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
  fr: {
    why: {
      step: "Cette étape demande votre approbation.",
      matrix: "Vos réglages pour cet outil demandent une approbation.",
      grant: "L'accès de cet agent à l'outil demande une approbation.",
      mode: "Cet agent ne fait que suggérer des changements.",
      person: "La personne concernée a demandé à voir les changements avant.",
      always: "Un changement comme celui-ci est toujours signé par une personne.",
    },
    stage: {
      trial: "L'agent est en période d'essai : chaque changement demande une approbation.",
      signoff:
        "L'agent attend votre approbation pour démarrer : chaque changement demande une approbation.",
    },
    byRule: "Vos règles d'approbation vous l'envoient.",
    team: {
      viewer: "Voit tout, n'approuve rien.",
      everythingElse: "Tout changement qu'aucune règle n'envoie à quelqu'un d'autre.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "Nouveaux enregistrements"
            : verb === "update"
              ? "Mises à jour"
              : verb === "delete"
                ? "Suppressions"
                : "Changements",
          what ? `dans ${what}` : null,
          amount ? `de plus de ${amount}` : null,
          agent ? `par ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
  "pt-BR": {
    why: {
      step: "Esta etapa precisa da sua aprovação.",
      matrix: "Suas configurações desta ferramenta pedem aprovação.",
      grant: "O acesso deste agente à ferramenta pede aprovação.",
      mode: "Este agente só sugere mudanças.",
      person: "A pessoa que recebe pediu para ver as mudanças antes.",
      always: "Uma mudança como esta é sempre assinada por uma pessoa.",
    },
    stage: {
      trial: "O agente está em teste: cada mudança precisa de aprovação.",
      signoff: "O agente aguarda sua aprovação para começar: cada mudança precisa de aprovação.",
    },
    byRule: "Suas regras de aprovação enviam isto para você.",
    team: {
      viewer: "Vê tudo, não aprova nada.",
      everythingElse: "Toda mudança que nenhuma regra envia para outra pessoa.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "Novos registros"
            : verb === "update"
              ? "Atualizações"
              : verb === "delete"
                ? "Exclusões"
                : "Mudanças",
          what ? `em ${what}` : null,
          amount ? `acima de ${amount}` : null,
          agent ? `de ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
  it: {
    why: {
      step: "Questo passaggio richiede la sua approvazione.",
      matrix: "Le sue impostazioni per questo strumento chiedono un'approvazione.",
      grant: "L'accesso di questo agente allo strumento chiede un'approvazione.",
      mode: "Questo agente suggerisce soltanto modifiche.",
      person: "La persona interessata ha chiesto di vedere prima le modifiche.",
      always: "Una modifica come questa la firma sempre una persona.",
    },
    stage: {
      trial: "L'agente è in prova: ogni modifica richiede un'approvazione.",
      signoff:
        "L'agente aspetta la tua approvazione per partire: ogni modifica richiede un'approvazione.",
    },
    byRule: "Le sue regole di approvazione lo inviano a lei.",
    team: {
      viewer: "Vede tutto, non approva nulla.",
      everythingElse: "Ogni modifica che nessuna regola invia a qualcun altro.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "Nuovi record"
            : verb === "update"
              ? "Aggiornamenti"
              : verb === "delete"
                ? "Eliminazioni"
                : "Modifiche",
          what ? `in ${what}` : null,
          amount ? `oltre ${amount}` : null,
          agent ? `di ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
  de: {
    why: {
      step: "Dieser Schritt braucht Ihre Freigabe.",
      matrix: "Ihre Einstellungen für dieses Tool verlangen eine Freigabe.",
      grant: "Der Zugriff dieses Agenten auf das Tool verlangt eine Freigabe.",
      mode: "Dieser Agent schlägt Änderungen nur vor.",
      person: "Die betroffene Person möchte Änderungen vorher sehen.",
      always: "Eine Änderung wie diese unterschreibt immer ein Mensch.",
    },
    stage: {
      trial: "Der Agent ist in der Probephase: Jede Änderung braucht eine Freigabe.",
      signoff:
        "Der Agent wartet auf Ihre Freigabe für den Start: Jede Änderung braucht eine Freigabe.",
    },
    byRule: "Ihre Freigaberegeln senden es an Sie.",
    team: {
      viewer: "Sieht alles, gibt nichts frei.",
      everythingElse: "Jede Änderung, die keine Regel an jemand anderen sendet.",
      rule: ({ what, verb, amount, agent }) =>
        `${[
          verb === "create"
            ? "Neue Datensätze"
            : verb === "update"
              ? "Aktualisierungen"
              : verb === "delete"
                ? "Löschungen"
                : "Änderungen",
          what ? `in ${what}` : null,
          amount ? `über ${amount}` : null,
          agent ? `von ${agent}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`,
    },
  },
};

/** The lines that say why an item waits, in the reader's language. */
export function whyLines(
  why: {
    reasons: readonly WhyCode[];
    stage?: "trial" | "signoff" | undefined;
    route?: { source: string } | undefined;
  },
  locale: Locale,
): string[] {
  const w = DESK_WORDS[locale];
  const lines = why.reasons.map((code) =>
    code === "stage" ? w.stage[why.stage ?? "trial"] : w.why[code],
  );
  if (why.route?.source === "rule") lines.push(w.byRule);
  return lines;
}
