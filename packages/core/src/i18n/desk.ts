// The Desk's words the server writes for clients (docs/plan.md §1.39, v0.12 "Client words"): why
// an item waits for a signature, and who signs what on the team page. Six languages, like the
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
  /** The agent's service name, or null for any agent. */
  agent: string | null;
}

export interface DeskWords {
  /** One short line per reason a change waits. */
  why: Record<Exclude<WhyCode, "stage">, string>;
  stage: { trial: string; signoff: string };
  /** The approver rules chose who signs. */
  byRule: string;
  team: {
    /** A viewer: sees, signs nothing. */
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
      step: "This step asks for a signature.",
      matrix: "Your settings for this tool ask for a signature.",
      grant: "This agent's access to the tool asks for a signature.",
      mode: "This agent only suggests changes.",
      person: "The person it reaches asked to see changes first.",
    },
    stage: {
      trial: "The agent is in its trial: every change is signed.",
      signoff: "The agent is waiting for your sign-off: every change is signed.",
    },
    byRule: "Your approval rules send it to you.",
    team: {
      viewer: "Sees everything, signs nothing.",
      everythingElse: "Every change no rule sends to someone else.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
    },
  },
  es: {
    why: {
      step: "Este paso pide una firma.",
      matrix: "Su configuración de esta herramienta pide una firma.",
      grant: "El acceso de este agente a la herramienta pide una firma.",
      mode: "Este agente solo sugiere cambios.",
      person: "La persona a la que llega pidió ver los cambios antes.",
    },
    stage: {
      trial: "El agente está en su prueba: cada cambio se firma.",
      signoff: "El agente espera su aprobación final: cada cambio se firma.",
    },
    byRule: "Sus reglas de aprobación se lo envían a usted.",
    team: {
      viewer: "Lo ve todo, no firma nada.",
      everythingElse: "Todo cambio que ninguna regla envía a otra persona.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
    },
  },
  fr: {
    why: {
      step: "Cette étape demande une signature.",
      matrix: "Vos réglages pour cet outil demandent une signature.",
      grant: "L'accès de cet agent à l'outil demande une signature.",
      mode: "Cet agent ne fait que suggérer des changements.",
      person: "La personne concernée a demandé à voir les changements avant.",
    },
    stage: {
      trial: "L'agent est en période d'essai : chaque changement est signé.",
      signoff: "L'agent attend votre validation finale : chaque changement est signé.",
    },
    byRule: "Vos règles d'approbation vous l'envoient.",
    team: {
      viewer: "Voit tout, ne signe rien.",
      everythingElse: "Tout changement qu'aucune règle n'envoie à quelqu'un d'autre.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
    },
  },
  "pt-BR": {
    why: {
      step: "Esta etapa pede uma assinatura.",
      matrix: "Suas configurações desta ferramenta pedem uma assinatura.",
      grant: "O acesso deste agente à ferramenta pede uma assinatura.",
      mode: "Este agente só sugere mudanças.",
      person: "A pessoa que recebe pediu para ver as mudanças antes.",
    },
    stage: {
      trial: "O agente está em teste: cada mudança é assinada.",
      signoff: "O agente aguarda sua aprovação final: cada mudança é assinada.",
    },
    byRule: "Suas regras de aprovação enviam isto para você.",
    team: {
      viewer: "Vê tudo, não assina nada.",
      everythingElse: "Toda mudança que nenhuma regra envia para outra pessoa.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
    },
  },
  it: {
    why: {
      step: "Questo passaggio chiede una firma.",
      matrix: "Le sue impostazioni per questo strumento chiedono una firma.",
      grant: "L'accesso di questo agente allo strumento chiede una firma.",
      mode: "Questo agente suggerisce soltanto modifiche.",
      person: "La persona interessata ha chiesto di vedere prima le modifiche.",
    },
    stage: {
      trial: "L'agente è in prova: ogni modifica viene firmata.",
      signoff: "L'agente attende la sua approvazione finale: ogni modifica viene firmata.",
    },
    byRule: "Le sue regole di approvazione lo inviano a lei.",
    team: {
      viewer: "Vede tutto, non firma nulla.",
      everythingElse: "Ogni modifica che nessuna regola invia a qualcun altro.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
    },
  },
  de: {
    why: {
      step: "Dieser Schritt verlangt eine Unterschrift.",
      matrix: "Ihre Einstellungen für dieses Tool verlangen eine Unterschrift.",
      grant: "Der Zugriff dieses Agenten auf das Tool verlangt eine Unterschrift.",
      mode: "Dieser Agent schlägt Änderungen nur vor.",
      person: "Die betroffene Person möchte Änderungen vorher sehen.",
    },
    stage: {
      trial: "Der Agent ist in der Probephase: Jede Änderung wird unterschrieben.",
      signoff: "Der Agent wartet auf Ihre Freigabe: Jede Änderung wird unterschrieben.",
    },
    byRule: "Ihre Freigaberegeln senden es an Sie.",
    team: {
      viewer: "Sieht alles, unterschreibt nichts.",
      everythingElse: "Jede Änderung, die keine Regel an jemand anderen sendet.",
      rule: ({ what, verb, amount, agent }) =>
        [
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
          .join(" ") + ".",
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
