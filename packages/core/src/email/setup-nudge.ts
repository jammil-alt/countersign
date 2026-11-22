// The setup nudge (docs/setup-plan.md §8; docs/plan.md §1.185, SU6): Nudge on the back office's
// Setup tab writes it to the notifications outbox as `intake_reminder`; it goes from the client's
// lead in the branded layout (`./layout`), in the person's language, listing what is still waiting
// on them before their agents' trial, with one button to Getting started. What it lists are the
// overview's own lines (the client's words); nothing else from the client file.

import type { Locale } from "../i18n/locale";
import { ONBOARDING_WORDS } from "../i18n/onboarding";
import { type BrandedBlock, type RenderedEmail, renderBrandedEmail } from "./layout";
import { firstNameOf } from "./onboarding";

export interface SetupNudgeEmailInput {
  locale: Locale;
  client: string;
  to: { name: string; email: string };
  lead: { name: string; photoUrl: string | null };
  /** What is waiting on them, one line each. */
  items: readonly string[];
  /** Getting started's full URL. */
  link: string;
  origin: string;
}

interface NudgeWords {
  subject(client: string): string;
  intro(client: string, count: number): string;
  button: string;
  more(count: number): string;
}

const NUDGE_WORDS: Record<Locale, NudgeWords> = {
  en: {
    subject: (c) => `A few things left to set up ${c}`,
    intro: (c, n) =>
      n === 1
        ? `One thing is waiting on you before ${c}'s trial can start:`
        : `${n} things are waiting on you before ${c}'s trial can start:`,
    button: "Open Getting started",
    more: (n) => `And ${n} more on Getting started.`,
  },
  es: {
    subject: (c) => `Quedan algunas cosas para configurar ${c}`,
    intro: (c, n) =>
      n === 1
        ? `Falta una cosa de su parte para empezar la prueba de ${c}:`
        : `Faltan ${n} cosas de su parte para empezar la prueba de ${c}:`,
    button: "Abrir Primeros pasos",
    more: (n) => `Y ${n} más en Primeros pasos.`,
  },
  fr: {
    subject: (c) => `Il reste quelques étapes pour configurer ${c}`,
    intro: (c, n) =>
      n === 1
        ? `Une chose vous attend avant que l'essai de ${c} puisse commencer :`
        : `${n} choses vous attendent avant que l'essai de ${c} puisse commencer :`,
    button: "Ouvrir Pour commencer",
    more: (n) => `Et ${n} de plus dans Pour commencer.`,
  },
  "pt-BR": {
    subject: (c) => `Faltam algumas coisas para configurar ${c}`,
    intro: (c, n) =>
      n === 1
        ? `Falta uma coisa sua para começar o teste de ${c}:`
        : `Faltam ${n} coisas suas para começar o teste de ${c}:`,
    button: "Abrir Primeiros passos",
    more: (n) => `E mais ${n} em Primeiros passos.`,
  },
  it: {
    subject: (c) => `Mancano alcune cose per configurare ${c}`,
    intro: (c, n) =>
      n === 1
        ? `Manca una cosa da parte sua prima che inizi la prova di ${c}:`
        : `Mancano ${n} cose da parte sua prima che inizi la prova di ${c}:`,
    button: "Apri Per iniziare",
    more: (n) => `E altre ${n} in Per iniziare.`,
  },
  de: {
    subject: (c) => `Noch ein paar Schritte, um ${c} einzurichten`,
    intro: (c, n) =>
      n === 1
        ? `Eine Sache wartet auf Sie, bevor die Testphase von ${c} beginnen kann:`
        : `${n} Dinge warten auf Sie, bevor die Testphase von ${c} beginnen kann:`,
    button: "Erste Schritte öffnen",
    more: (n) => `Und ${n} weitere unter Erste Schritte.`,
  },
};

// DECISION: at most ten lines are named in one email; the page shows the rest.
const SHOWN = 10;

/** The nudge, from the lead. */
export function renderSetupNudgeEmail(input: SetupNudgeEmailInput): RenderedEmail {
  const w = ONBOARDING_WORDS[input.locale];
  const n = NUDGE_WORDS[input.locale];
  const items = input.items.map((i) => i.trim()).filter(Boolean);
  const shown = items.slice(0, SHOWN);
  const intro = n.intro(input.client, items.length);
  const blocks: BrandedBlock[] = [
    { kind: "paragraph", text: w.greeting(firstNameOf(input.to.name)) },
    { kind: "paragraph", text: intro },
    ...shown.map((i): BrandedBlock => ({ kind: "paragraph", text: `· ${i}` })),
    ...(items.length > shown.length
      ? [{ kind: "paragraph", text: n.more(items.length - shown.length) } as BrandedBlock]
      : []),
    { kind: "button", label: n.button, href: input.link },
    { kind: "small", text: `${w.sentBy(input.lead.name)} ${w.aboutMezonas}` },
    { kind: "small", text: w.neverPassword },
  ];
  return renderBrandedEmail({
    locale: input.locale,
    subject: n.subject(input.client),
    preheader: intro,
    from: { name: input.lead.name, photoUrl: input.lead.photoUrl, role: w.leadRole },
    origin: input.origin,
    blocks,
  });
}
