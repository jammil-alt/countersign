// The confirm page's words (docs/plan.md §1.219), in each portal language. Kept here, in the
// page's own chunk, rather than in the app's catalogs: only someone signing in to one of our apps
// sees them, and the catalogs are part of every visit's first load (scripts/web-size.mjs).
// REVIEW: the translations need a fluent speaker (§1.18).
import type { Locale, MobileApp } from "@countersign/core";

const en = {
  eyebrow: "Sign in",
  titlePhone: "Open the Mezonas phone app?",
  titleDesktop: "Open the Mezonas desktop app?",
  who: "You're signed in as {email}.",
  explainPhone: "Open signs the phone app in as you. This browser signs out.",
  explainDesktop: "Open signs the desktop app on this computer in as you. This browser signs out.",
  warn: "Only continue if you just chose Sign in in the app. If you didn't, cancel.",
  open: "Open the app",
  cancel: "Cancel",
  goneTitle: "This sign-in has ended",
  gone: "It expired or was already used. Start again from the app.",
} as const;

export type AppHandoffKey = keyof typeof en;

export const APP_HANDOFF_WORDS: Record<Locale, Record<AppHandoffKey, string>> = {
  en,
  es: {
    eyebrow: "Iniciar sesión",
    titlePhone: "¿Abrir la app de Mezonas para el teléfono?",
    titleDesktop: "¿Abrir la app de escritorio de Mezonas?",
    who: "Ha iniciado sesión como {email}.",
    explainPhone:
      "Abrir inicia sesión en la app del teléfono como usted. Este navegador cierra la sesión.",
    explainDesktop:
      "Abrir inicia sesión en la app de escritorio de esta computadora como usted. Este navegador cierra la sesión.",
    warn: "Continúe solo si acaba de elegir Iniciar sesión en la app. Si no, cancele.",
    open: "Abrir la app",
    cancel: "Cancelar",
    goneTitle: "Este inicio de sesión terminó",
    gone: "Venció o ya se usó. Empiece de nuevo desde la app.",
  },
  fr: {
    eyebrow: "Connexion",
    titlePhone: "Ouvrir l'application Mezonas pour téléphone ?",
    titleDesktop: "Ouvrir l'application de bureau Mezonas ?",
    who: "Vous êtes connecté en tant que {email}.",
    explainPhone:
      "Ouvrir connecte l'application du téléphone en votre nom. Ce navigateur se déconnecte.",
    explainDesktop:
      "Ouvrir connecte l'application de bureau de cet ordinateur en votre nom. Ce navigateur se déconnecte.",
    warn: "Continuez seulement si vous venez de choisir Se connecter dans l'application. Sinon, annulez.",
    open: "Ouvrir l'application",
    cancel: "Annuler",
    goneTitle: "Cette connexion est terminée",
    gone: "Elle a expiré ou a déjà servi. Recommencez depuis l'application.",
  },
  "pt-BR": {
    eyebrow: "Entrar",
    titlePhone: "Abrir o app da Mezonas para celular?",
    titleDesktop: "Abrir o app da Mezonas para computador?",
    who: "Você entrou como {email}.",
    explainPhone: "Abrir conecta o app do celular como você. Este navegador sai da conta.",
    explainDesktop: "Abrir conecta o app deste computador como você. Este navegador sai da conta.",
    warn: "Só continue se você acabou de escolher Entrar no app. Se não, cancele.",
    open: "Abrir o app",
    cancel: "Cancelar",
    goneTitle: "Este acesso terminou",
    gone: "Expirou ou já foi usado. Comece de novo pelo app.",
  },
  it: {
    eyebrow: "Accedi",
    titlePhone: "Aprire l'app Mezonas per telefono?",
    titleDesktop: "Aprire l'app desktop Mezonas?",
    who: "Hai effettuato l'accesso come {email}.",
    explainPhone: "Apri fa accedere l'app del telefono a tuo nome. Questo browser esce.",
    explainDesktop:
      "Apri fa accedere l'app desktop di questo computer a tuo nome. Questo browser esce.",
    warn: "Continua solo se hai appena scelto Accedi nell'app. Altrimenti, annulla.",
    open: "Apri l'app",
    cancel: "Annulla",
    goneTitle: "Questo accesso è terminato",
    gone: "È scaduto o è già stato usato. Ricomincia dall'app.",
  },
  de: {
    eyebrow: "Anmelden",
    titlePhone: "Mezonas-App auf dem Telefon öffnen?",
    titleDesktop: "Mezonas-Desktop-App öffnen?",
    who: "Sie sind als {email} angemeldet.",
    explainPhone: "Öffnen meldet die Telefon-App als Sie an. Dieser Browser meldet sich ab.",
    explainDesktop:
      "Öffnen meldet die Desktop-App auf diesem Computer als Sie an. Dieser Browser meldet sich ab.",
    warn: "Fahren Sie nur fort, wenn Sie gerade in der App Anmelden gewählt haben. Sonst brechen Sie ab.",
    open: "App öffnen",
    cancel: "Abbrechen",
    goneTitle: "Diese Anmeldung ist beendet",
    gone: "Sie ist abgelaufen oder wurde schon verwendet. Beginnen Sie in der App neu.",
  },
};

export function appHandoffWords(locale: Locale) {
  const words = APP_HANDOFF_WORDS[locale] ?? en;
  return (key: AppHandoffKey, vars: Record<string, string> = {}): string =>
    words[key].replace(/\{(\w+)\}/g, (m, v: string) => vars[v] ?? m);
}

/** The page's title for the app asking. */
export const TITLE: Record<MobileApp, AppHandoffKey> = {
  phone: "titlePhone",
  desktop: "titleDesktop",
};
export const EXPLAIN: Record<MobileApp, AppHandoffKey> = {
  phone: "explainPhone",
  desktop: "explainDesktop",
};
