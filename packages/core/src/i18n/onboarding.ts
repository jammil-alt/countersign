// Onboarding (docs/cases-plan.md §4.4; docs/plan.md §1.125): the words of the emails a lead sends
// a client's people (the invite, a colleague asked, a few more questions) and of the welcome page
// their link opens, in each language. The platform writes them, never a model; the lead's own note
// and names are filled in as they are. Marked for a fluent speaker's review, as every
// client-facing word file is (plan §1.18).

import type { Locale } from "./locale";

/** What an intake covers, as the one line reads it. */
export interface SummaryParams {
  client: string;
  /** The general section is asked. */
  general: boolean;
  /** The areas' names, already in this language. */
  areas: readonly string[];
  agents: number;
  minutes: number;
}

export interface OnboardingWords {
  // ── The emails ──
  inviteSubject(client: string): string;
  colleagueSubject(askedBy: string, client: string): string;
  moreQuestionsSubject(client: string): string;
  /** "Hi Dana,". */
  greeting(firstName: string): string;
  /** Under the lead's name at the top. */
  leadRole: string;
  /** The one line on what's in it, without a full stop. */
  summary(p: SummaryParams): string;
  /** "What's in it: …". */
  whatsIn(line: string): string;
  inviteIntro(client: string): string;
  colleagueIntro(askedBy: string, client: string, about: string): string;
  moreQuestionsIntro(client: string, added: string): string;
  getStarted: string;
  answerThem: string;
  /** Who it's from, under the button. */
  sentBy(lead: string): string;
  sentByFor(lead: string, askedBy: string): string;
  aboutMezonas: string;
  neverPassword: string;
  /** "This link works until 1 December 2026." */
  expires(date: string): string;
  /** The plain-text part's line before the link. */
  openLink: string;
  /** The footer under every email. */
  footer: string;

  // ── The welcome page ──
  pageTitle(client: string): string;
  fromLead(lead: string): string;
  whatsInTitle: string;
  signInAs(email: string): string;
  security: string;
  continueGoogle: string;
  continueMicrosoft: string;
  continueEmail: string;
  expiredTitle: string;
  closedTitle: string;
  askNew(lead: string): string;
  askedNew(lead: string): string;
  /** "This invite is for d•••@acme.com." */
  wrongAccount(masked: string): string;
  signOut: string;
  signingIn: string;
  notFound: string;
  failed: string;
}

const list = (locale: Locale, items: readonly string[]) =>
  new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);

export const ONBOARDING_WORDS: Record<Locale, OnboardingWords> = {
  en: {
    inviteSubject: (c) => `Getting ${c} started with Mezonas`,
    colleagueSubject: (a, c) => `${a} asked you to help set up ${c} on Mezonas`,
    moreQuestionsSubject: (c) => `A few more questions for ${c}`,
    greeting: (n) => `Hi ${n},`,
    leadRole: "Your lead at Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`how ${p.client} works`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `what we need to set up ${p.agents === 1 ? "one agent" : `${p.agents} agents`}`;
      const parts = [
        ...(topics.length > 0 ? [`a few questions about ${list("en", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", and ") : "your account";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head}; about ${p.minutes} minutes` : head;
    },
    whatsIn: (l) => `What's in it: ${l}.`,
    inviteIntro: (c) => `Your Mezonas account for ${c} is ready.`,
    colleagueIntro: (a, c, about) => `${a} asked you to answer a few questions for ${c}: ${about}.`,
    moreQuestionsIntro: (c, added) => `We added a few questions for ${c}: ${added}.`,
    getStarted: "Get started",
    answerThem: "Answer them",
    sentBy: (l) => `Sent by ${l} at Mezonas.`,
    sentByFor: (l, a) => `Sent by ${l} at Mezonas, for ${a}.`,
    aboutMezonas:
      "Mezonas runs agents that do back-office work, like bills and bookkeeping, in the tools you already use.",
    neverPassword: "We'll never ask for a password by email.",
    expires: (d) => `This link works until ${d}.`,
    openLink: "Open this link to start",
    footer: "Mezonas, a Twelve Thirty-Four company. mezonas.com",
    pageTitle: (c) => `Let's get ${c} started`,
    fromLead: (l) => `From ${l}, your lead at Mezonas`,
    whatsInTitle: "What's in it",
    signInAs: (e) => `Sign in as ${e}, the address we wrote to.`,
    security: "We'll never ask for a password by email.",
    continueGoogle: "Continue with Google",
    continueMicrosoft: "Continue with Microsoft",
    continueEmail: "Continue with email",
    expiredTitle: "This link has expired",
    closedTitle: "This invite is closed",
    askNew: (l) => `Ask ${l} for a new one`,
    askedNew: (l) => `We told ${l}. A new link will come by email.`,
    wrongAccount: (m) => `This invite is for ${m}.`,
    signOut: "Sign out",
    signingIn: "Signing you in…",
    notFound: "This link doesn't work. Check that you opened all of it.",
    failed: "That didn't work. Please try again.",
  },
  es: {
    inviteSubject: (c) => `Primeros pasos de ${c} con Mezonas`,
    colleagueSubject: (a, c) => `${a} le pidió ayuda para configurar ${c} en Mezonas`,
    moreQuestionsSubject: (c) => `Algunas preguntas más para ${c}`,
    greeting: (n) => `Hola, ${n}:`,
    leadRole: "Su responsable en Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`cómo funciona ${p.client}`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `lo que necesitamos para configurar ${p.agents === 1 ? "un agente" : `${p.agents} agentes`}`;
      const parts = [
        ...(topics.length > 0 ? [`algunas preguntas sobre ${list("es", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", y ") : "su cuenta";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head}; unos ${p.minutes} minutos` : head;
    },
    whatsIn: (l) => `Qué incluye: ${l}.`,
    inviteIntro: (c) => `Su cuenta de Mezonas para ${c} está lista.`,
    colleagueIntro: (a, c, about) =>
      `${a} le pidió que responda algunas preguntas para ${c}: ${about}.`,
    moreQuestionsIntro: (c, added) => `Añadimos algunas preguntas para ${c}: ${added}.`,
    getStarted: "Empezar",
    answerThem: "Responder",
    sentBy: (l) => `Enviado por ${l}, de Mezonas.`,
    sentByFor: (l, a) => `Enviado por ${l}, de Mezonas, en nombre de ${a}.`,
    aboutMezonas:
      "Mezonas gestiona agentes que hacen trabajo administrativo, como facturas y contabilidad, en las herramientas que ya usa.",
    neverPassword: "Nunca le pediremos una contraseña por correo.",
    expires: (d) => `Este enlace funciona hasta el ${d}.`,
    openLink: "Abra este enlace para empezar",
    footer: "Mezonas, una empresa de Twelve Thirty-Four. mezonas.com",
    pageTitle: (c) => `Empecemos con ${c}`,
    fromLead: (l) => `De ${l}, su responsable en Mezonas`,
    whatsInTitle: "Qué incluye",
    signInAs: (e) => `Inicie sesión como ${e}, la dirección a la que escribimos.`,
    security: "Nunca le pediremos una contraseña por correo.",
    continueGoogle: "Continuar con Google",
    continueMicrosoft: "Continuar con Microsoft",
    continueEmail: "Continuar con correo",
    expiredTitle: "Este enlace ha caducado",
    closedTitle: "Esta invitación está cerrada",
    askNew: (l) => `Pedir uno nuevo a ${l}`,
    askedNew: (l) => `Avisamos a ${l}. Recibirá un enlace nuevo por correo.`,
    wrongAccount: (m) => `Esta invitación es para ${m}.`,
    signOut: "Cerrar sesión",
    signingIn: "Iniciando sesión…",
    notFound: "Este enlace no funciona. Compruebe que lo abrió completo.",
    failed: "No funcionó. Inténtelo de nuevo.",
  },
  fr: {
    inviteSubject: (c) => `Démarrer ${c} avec Mezonas`,
    colleagueSubject: (a, c) => `${a} vous demande de l'aide pour configurer ${c} sur Mezonas`,
    moreQuestionsSubject: (c) => `Quelques questions de plus pour ${c}`,
    greeting: (n) => `Bonjour ${n},`,
    leadRole: "Votre interlocuteur chez Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`le fonctionnement de ${p.client}`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `ce qu'il nous faut pour configurer ${p.agents === 1 ? "un agent" : `${p.agents} agents`}`;
      const parts = [
        ...(topics.length > 0 ? [`quelques questions sur ${list("fr", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", et ") : "votre compte";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head} ; environ ${p.minutes} minutes` : head;
    },
    whatsIn: (l) => `Au programme : ${l}.`,
    inviteIntro: (c) => `Votre compte Mezonas pour ${c} est prêt.`,
    colleagueIntro: (a, c, about) =>
      `${a} vous demande de répondre à quelques questions pour ${c} : ${about}.`,
    moreQuestionsIntro: (c, added) => `Nous avons ajouté quelques questions pour ${c} : ${added}.`,
    getStarted: "Commencer",
    answerThem: "Répondre",
    sentBy: (l) => `Envoyé par ${l}, de Mezonas.`,
    sentByFor: (l, a) => `Envoyé par ${l}, de Mezonas, pour ${a}.`,
    aboutMezonas:
      "Mezonas fait tourner des agents qui s'occupent du travail administratif, comme les factures et la comptabilité, dans les outils que vous utilisez déjà.",
    neverPassword: "Nous ne vous demanderons jamais de mot de passe par e-mail.",
    expires: (d) => `Ce lien est valable jusqu'au ${d}.`,
    openLink: "Ouvrez ce lien pour commencer",
    footer: "Mezonas, une société Twelve Thirty-Four. mezonas.com",
    pageTitle: (c) => `Démarrons avec ${c}`,
    fromLead: (l) => `De la part de ${l}, votre interlocuteur chez Mezonas`,
    whatsInTitle: "Au programme",
    signInAs: (e) => `Connectez-vous avec ${e}, l'adresse à laquelle nous avons écrit.`,
    security: "Nous ne vous demanderons jamais de mot de passe par e-mail.",
    continueGoogle: "Continuer avec Google",
    continueMicrosoft: "Continuer avec Microsoft",
    continueEmail: "Continuer avec l'e-mail",
    expiredTitle: "Ce lien a expiré",
    closedTitle: "Cette invitation est fermée",
    askNew: (l) => `Demander un nouveau lien à ${l}`,
    askedNew: (l) => `Nous avons prévenu ${l}. Un nouveau lien arrivera par e-mail.`,
    wrongAccount: (m) => `Cette invitation est pour ${m}.`,
    signOut: "Se déconnecter",
    signingIn: "Connexion en cours…",
    notFound: "Ce lien ne fonctionne pas. Vérifiez que vous l'avez ouvert en entier.",
    failed: "Cela n'a pas fonctionné. Veuillez réessayer.",
  },
  "pt-BR": {
    inviteSubject: (c) => `Começando ${c} com a Mezonas`,
    colleagueSubject: (a, c) => `${a} pediu sua ajuda para configurar ${c} na Mezonas`,
    moreQuestionsSubject: (c) => `Mais algumas perguntas para ${c}`,
    greeting: (n) => `Olá, ${n},`,
    leadRole: "Seu responsável na Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`como ${p.client} funciona`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `o que precisamos para configurar ${p.agents === 1 ? "um agente" : `${p.agents} agentes`}`;
      const parts = [
        ...(topics.length > 0 ? [`algumas perguntas sobre ${list("pt-BR", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", e ") : "sua conta";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head}; cerca de ${p.minutes} minutos` : head;
    },
    whatsIn: (l) => `O que inclui: ${l}.`,
    inviteIntro: (c) => `Sua conta Mezonas para ${c} está pronta.`,
    colleagueIntro: (a, c, about) =>
      `${a} pediu que você responda algumas perguntas para ${c}: ${about}.`,
    moreQuestionsIntro: (c, added) => `Adicionamos algumas perguntas para ${c}: ${added}.`,
    getStarted: "Começar",
    answerThem: "Responder",
    sentBy: (l) => `Enviado por ${l}, da Mezonas.`,
    sentByFor: (l, a) => `Enviado por ${l}, da Mezonas, a pedido de ${a}.`,
    aboutMezonas:
      "A Mezonas opera agentes que fazem o trabalho administrativo, como contas a pagar e contabilidade, nas ferramentas que você já usa.",
    neverPassword: "Nunca pediremos uma senha por e-mail.",
    expires: (d) => `Este link funciona até ${d}.`,
    openLink: "Abra este link para começar",
    footer: "Mezonas, uma empresa Twelve Thirty-Four. mezonas.com",
    pageTitle: (c) => `Vamos começar com ${c}`,
    fromLead: (l) => `De ${l}, seu responsável na Mezonas`,
    whatsInTitle: "O que inclui",
    signInAs: (e) => `Entre como ${e}, o endereço para o qual escrevemos.`,
    security: "Nunca pediremos uma senha por e-mail.",
    continueGoogle: "Continuar com Google",
    continueMicrosoft: "Continuar com Microsoft",
    continueEmail: "Continuar com e-mail",
    expiredTitle: "Este link expirou",
    closedTitle: "Este convite está encerrado",
    askNew: (l) => `Pedir um novo a ${l}`,
    askedNew: (l) => `Avisamos ${l}. Um novo link chegará por e-mail.`,
    wrongAccount: (m) => `Este convite é para ${m}.`,
    signOut: "Sair",
    signingIn: "Entrando…",
    notFound: "Este link não funciona. Verifique se você o abriu por inteiro.",
    failed: "Não funcionou. Tente novamente.",
  },
  it: {
    inviteSubject: (c) => `Iniziamo con ${c} su Mezonas`,
    colleagueSubject: (a, c) => `${a} le chiede aiuto per configurare ${c} su Mezonas`,
    moreQuestionsSubject: (c) => `Qualche altra domanda per ${c}`,
    greeting: (n) => `Buongiorno ${n},`,
    leadRole: "Il suo referente in Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`come lavora ${p.client}`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `ciò che serve per configurare ${p.agents === 1 ? "un agente" : `${p.agents} agenti`}`;
      const parts = [
        ...(topics.length > 0 ? [`qualche domanda su ${list("it", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", e ") : "il suo account";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head}; circa ${p.minutes} minuti` : head;
    },
    whatsIn: (l) => `Cosa comprende: ${l}.`,
    inviteIntro: (c) => `Il suo account Mezonas per ${c} è pronto.`,
    colleagueIntro: (a, c, about) =>
      `${a} le chiede di rispondere a qualche domanda per ${c}: ${about}.`,
    moreQuestionsIntro: (c, added) => `Abbiamo aggiunto qualche domanda per ${c}: ${added}.`,
    getStarted: "Inizia",
    answerThem: "Rispondi",
    sentBy: (l) => `Inviato da ${l}, di Mezonas.`,
    sentByFor: (l, a) => `Inviato da ${l}, di Mezonas, per conto di ${a}.`,
    aboutMezonas:
      "Mezonas gestisce agenti che svolgono il lavoro amministrativo, come fatture e contabilità, negli strumenti che usa già.",
    neverPassword: "Non le chiederemo mai una password via email.",
    expires: (d) => `Questo link funziona fino al ${d}.`,
    openLink: "Apra questo link per iniziare",
    footer: "Mezonas, una società Twelve Thirty-Four. mezonas.com",
    pageTitle: (c) => `Iniziamo con ${c}`,
    fromLead: (l) => `Da ${l}, il suo referente in Mezonas`,
    whatsInTitle: "Cosa comprende",
    signInAs: (e) => `Acceda come ${e}, l'indirizzo a cui abbiamo scritto.`,
    security: "Non le chiederemo mai una password via email.",
    continueGoogle: "Continua con Google",
    continueMicrosoft: "Continua con Microsoft",
    continueEmail: "Continua con l'email",
    expiredTitle: "Questo link è scaduto",
    closedTitle: "Questo invito è chiuso",
    askNew: (l) => `Chiedi un nuovo link a ${l}`,
    askedNew: (l) => `Abbiamo avvisato ${l}. Un nuovo link arriverà via email.`,
    wrongAccount: (m) => `Questo invito è per ${m}.`,
    signOut: "Esci",
    signingIn: "Accesso in corso…",
    notFound: "Questo link non funziona. Controlli di averlo aperto per intero.",
    failed: "Non ha funzionato. Riprovi.",
  },
  de: {
    inviteSubject: (c) => `Start von ${c} mit Mezonas`,
    colleagueSubject: (a, c) => `${a} bittet Sie um Hilfe beim Einrichten von ${c} bei Mezonas`,
    moreQuestionsSubject: (c) => `Ein paar weitere Fragen für ${c}`,
    greeting: (n) => `Hallo ${n},`,
    leadRole: "Ihr Ansprechpartner bei Mezonas",
    summary: (p) => {
      const topics = [...(p.general ? [`die Arbeitsweise von ${p.client}`] : []), ...p.areas];
      const agents =
        p.agents === 0
          ? null
          : `was wir zum Einrichten von ${p.agents === 1 ? "einem Agenten" : `${p.agents} Agenten`} brauchen`;
      const parts = [
        ...(topics.length > 0 ? [`ein paar Fragen zu ${list("de", topics)}`] : []),
        ...(agents ? [agents] : []),
      ];
      const what = parts.length > 0 ? parts.join(", und ") : "Ihr Konto";
      const head = what.charAt(0).toUpperCase() + what.slice(1);
      return p.minutes > 0 ? `${head}; etwa ${p.minutes} Minuten` : head;
    },
    whatsIn: (l) => `Was dazugehört: ${l}.`,
    inviteIntro: (c) => `Ihr Mezonas-Konto für ${c} ist bereit.`,
    colleagueIntro: (a, c, about) =>
      `${a} bittet Sie, ein paar Fragen für ${c} zu beantworten: ${about}.`,
    moreQuestionsIntro: (c, added) => `Wir haben ein paar Fragen für ${c} ergänzt: ${added}.`,
    getStarted: "Loslegen",
    answerThem: "Beantworten",
    sentBy: (l) => `Gesendet von ${l}, Mezonas.`,
    sentByFor: (l, a) => `Gesendet von ${l}, Mezonas, im Auftrag von ${a}.`,
    aboutMezonas:
      "Mezonas betreibt Agenten, die Büroarbeit wie Rechnungen und Buchhaltung in den Tools erledigen, die Sie schon nutzen.",
    neverPassword: "Wir fragen Sie nie per E-Mail nach einem Passwort.",
    expires: (d) => `Dieser Link gilt bis ${d}.`,
    openLink: "Öffnen Sie diesen Link, um zu beginnen",
    footer: "Mezonas, ein Unternehmen von Twelve Thirty-Four. mezonas.com",
    pageTitle: (c) => `Los geht's mit ${c}`,
    fromLead: (l) => `Von ${l}, Ihrem Ansprechpartner bei Mezonas`,
    whatsInTitle: "Was dazugehört",
    signInAs: (e) => `Melden Sie sich als ${e} an, mit der Adresse, an die wir geschrieben haben.`,
    security: "Wir fragen Sie nie per E-Mail nach einem Passwort.",
    continueGoogle: "Weiter mit Google",
    continueMicrosoft: "Weiter mit Microsoft",
    continueEmail: "Weiter mit E-Mail",
    expiredTitle: "Dieser Link ist abgelaufen",
    closedTitle: "Diese Einladung ist geschlossen",
    askNew: (l) => `${l} um einen neuen bitten`,
    askedNew: (l) => `Wir haben ${l} Bescheid gegeben. Ein neuer Link kommt per E-Mail.`,
    wrongAccount: (m) => `Diese Einladung ist für ${m}.`,
    signOut: "Abmelden",
    signingIn: "Anmeldung läuft…",
    notFound: "Dieser Link funktioniert nicht. Prüfen Sie, ob Sie ihn vollständig geöffnet haben.",
    failed: "Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.",
  },
};
