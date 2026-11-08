// P-6: the line the client's lead thread gets when we step in on one of their items (docs/plan.md
// §1.68), so the person it was waiting on hears of it through the lead-message notification. The
// Worker writes it in the client's language, beside the release and Desk words.
// TODO(review): es, fr, pt-BR, it and de need a fluent speaker's read.
import type { Locale } from "./locale";

export type StepInLineAction = "approve" | "reject" | "answer" | "reassign";

export interface StepInWords {
  /** "We stepped in on "{title}" and approved it." */
  line(action: StepInLineAction, title: string): string;
  /** "Why: {reason}" */
  why(reason: string): string;
}

const quote = (t: string) => `"${t}"`;

export const STEP_IN_WORDS: Record<Locale, StepInWords> = {
  en: {
    line: (a, t) =>
      ({
        approve: `We stepped in on ${quote(t)} and approved it for you.`,
        reject: `We stepped in on ${quote(t)} and turned it down for you.`,
        answer: `We stepped in on ${quote(t)} and answered it for you.`,
        reassign: `We stepped in on ${quote(t)} and passed it to someone else on your team.`,
      })[a],
    why: (r) => `Why: ${r}`,
  },
  es: {
    line: (a, t) =>
      ({
        approve: `Intervenimos en ${quote(t)} y lo aprobamos por usted.`,
        reject: `Intervenimos en ${quote(t)} y lo rechazamos por usted.`,
        answer: `Intervenimos en ${quote(t)} y lo respondimos por usted.`,
        reassign: `Intervenimos en ${quote(t)} y lo pasamos a otra persona de su equipo.`,
      })[a],
    why: (r) => `Motivo: ${r}`,
  },
  fr: {
    line: (a, t) =>
      ({
        approve: `Nous sommes intervenus sur ${quote(t)} et l'avons approuvé pour vous.`,
        reject: `Nous sommes intervenus sur ${quote(t)} et l'avons refusé pour vous.`,
        answer: `Nous sommes intervenus sur ${quote(t)} et y avons répondu pour vous.`,
        reassign: `Nous sommes intervenus sur ${quote(t)} et l'avons confié à une autre personne de votre équipe.`,
      })[a],
    why: (r) => `Motif : ${r}`,
  },
  "pt-BR": {
    line: (a, t) =>
      ({
        approve: `Intervimos em ${quote(t)} e aprovamos por você.`,
        reject: `Intervimos em ${quote(t)} e recusamos por você.`,
        answer: `Intervimos em ${quote(t)} e respondemos por você.`,
        reassign: `Intervimos em ${quote(t)} e passamos para outra pessoa da sua equipe.`,
      })[a],
    why: (r) => `Motivo: ${r}`,
  },
  it: {
    line: (a, t) =>
      ({
        approve: `Siamo intervenuti su ${quote(t)} e l'abbiamo approvato per voi.`,
        reject: `Siamo intervenuti su ${quote(t)} e l'abbiamo rifiutato per voi.`,
        answer: `Siamo intervenuti su ${quote(t)} e abbiamo risposto per voi.`,
        reassign: `Siamo intervenuti su ${quote(t)} e l'abbiamo passato a un'altra persona del vostro team.`,
      })[a],
    why: (r) => `Motivo: ${r}`,
  },
  de: {
    line: (a, t) =>
      ({
        approve: `Wir haben bei ${quote(t)} eingegriffen und es für Sie freigegeben.`,
        reject: `Wir haben bei ${quote(t)} eingegriffen und es für Sie abgelehnt.`,
        answer: `Wir haben bei ${quote(t)} eingegriffen und es für Sie beantwortet.`,
        reassign: `Wir haben bei ${quote(t)} eingegriffen und es an eine andere Person in Ihrem Team gegeben.`,
      })[a],
    why: (r) => `Grund: ${r}`,
  },
};

/** The lead-thread line, in one language. */
export function stepInLine(
  locale: Locale,
  action: StepInLineAction,
  title: string,
  reason: string,
): string {
  const w = STEP_IN_WORDS[locale] ?? STEP_IN_WORDS.en;
  return `${w.line(action, title)} ${w.why(reason)}`;
}
