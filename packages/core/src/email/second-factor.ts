// The setup link's email (owner, 2026-11-19; docs/plan.md §1.100): after a first sign-in with a
// password, the person sets up their second step from a link sent to their sign-in address. One
// button, from Mezonas, the link's 30 minutes, and what to do if it wasn't them.

import type { Locale } from "../i18n/locale";
import { type RenderedEmail, renderBrandedEmail } from "./layout";

const WORDS: Record<
  Locale,
  { subject: string; heading: string; body: string; button: string; small: string }
> = {
  en: {
    subject: "Set up your Mezonas sign-in",
    heading: "One more step to sign in",
    body: "Open this link to add your phone number or an authenticator app. Then go back to Mezonas and sign in with a code.",
    button: "Set up my sign-in",
    small:
      "This link works for 30 minutes. If you didn't just sign in to Mezonas, don't open it and change your password.",
  },
  es: {
    subject: "Configure su acceso a Mezonas",
    heading: "Un paso más para entrar",
    body: "Abra este enlace para añadir su número de teléfono o una app de autenticación. Después vuelva a Mezonas e inicie sesión con un código.",
    button: "Configurar mi acceso",
    small:
      "Este enlace funciona durante 30 minutos. Si no acaba de iniciar sesión en Mezonas, no lo abra y cambie su contraseña.",
  },
  fr: {
    subject: "Configurez votre connexion à Mezonas",
    heading: "Encore une étape pour vous connecter",
    body: "Ouvrez ce lien pour ajouter votre numéro de téléphone ou une application d'authentification. Revenez ensuite sur Mezonas et connectez-vous avec un code.",
    button: "Configurer ma connexion",
    small:
      "Ce lien fonctionne 30 minutes. Si vous ne venez pas de vous connecter à Mezonas, ne l'ouvrez pas et changez votre mot de passe.",
  },
  "pt-BR": {
    subject: "Configure seu acesso ao Mezonas",
    heading: "Mais um passo para entrar",
    body: "Abra este link para adicionar seu número de celular ou um app autenticador. Depois volte ao Mezonas e entre com um código.",
    button: "Configurar meu acesso",
    small:
      "Este link vale por 30 minutos. Se você não acabou de entrar no Mezonas, não o abra e troque sua senha.",
  },
  it: {
    subject: "Configuri l'accesso a Mezonas",
    heading: "Ancora un passo per accedere",
    body: "Apra questo link per aggiungere il suo numero di telefono o un'app di autenticazione. Poi torni su Mezonas e acceda con un codice.",
    button: "Configura il mio accesso",
    small:
      "Questo link vale 30 minuti. Se non ha appena effettuato l'accesso a Mezonas, non lo apra e cambi la password.",
  },
  de: {
    subject: "Richten Sie Ihre Mezonas-Anmeldung ein",
    heading: "Noch ein Schritt zur Anmeldung",
    body: "Öffnen Sie diesen Link, um Ihre Telefonnummer oder eine Authenticator-App hinzuzufügen. Kehren Sie dann zu Mezonas zurück und melden Sie sich mit einem Code an.",
    button: "Anmeldung einrichten",
    small:
      "Dieser Link gilt 30 Minuten. Wenn Sie sich nicht gerade bei Mezonas angemeldet haben, öffnen Sie ihn nicht und ändern Sie Ihr Passwort.",
  },
};

export function secondFactorSetupEmail(input: {
  locale: Locale;
  /** The setup page's full URL (`APP_ORIGIN` + `setupLinkPagePath(token)`). */
  link: string;
  origin: string;
}): RenderedEmail {
  const w = WORDS[input.locale] ?? WORDS.en;
  return renderBrandedEmail({
    locale: input.locale,
    subject: w.subject,
    preheader: w.heading,
    from: { name: "Mezonas", photoUrl: null },
    blocks: [
      { kind: "heading", text: w.heading },
      { kind: "paragraph", text: w.body },
      { kind: "button", label: w.button, href: input.link },
      { kind: "small", text: w.small },
    ],
    origin: input.origin,
  });
}
