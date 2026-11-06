// Notification words in each language (ARCHITECTURE §11.3, docs/plan.md §1.37). The Worker writes
// them, so they live here beside the release words. Fixed sentences with counts and one link;
// never a record's field (a vendor, an amount, a subject). Translations are marked for a fluent
// speaker's review, like the timeline's.
import type { Locale } from "./locale";

/** Counts a sentence may use; whole numbers, already formatted for the language. */
export interface NotifyNumbers {
  n: string;
  runs: string;
  changes: string;
  credits: string;
  /** The week's Monday, written out for the language. */
  week: string;
}

export interface NotifyWords {
  itemsWaiting: { subject(count: number, x: NotifyNumbers): string; action: string };
  weeklyTable: {
    subject(x: NotifyNumbers): string;
    line(x: NotifyNumbers): string;
    action: string;
  };
  reconnect: { subject: string; line: string; action: string };
  credits: { subject(block: number, x: NotifyNumbers): string; line: string; action: string };
  leadMessage: {
    toClient(count: number, x: NotifyNumbers): string;
    toLead(count: number, x: NotifyNumbers): string;
    action: string;
  };
  signoff: { subject: string; line: string; action: string };
  /** The email's last line. */
  footer: string;
}

// Reviewed by: nobody yet (needs a fluent speaker for es, fr, pt-BR, it, de).
export const NOTIFY_WORDS: Record<Locale, NotifyWords> = {
  en: {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1 ? "1 item waits for you in Mezonas" : `${x.n} items wait for you in Mezonas`,
      action: "Open your Desk",
    },
    weeklyTable: {
      subject: (x) => `Your weekly summary for the week of ${x.week}`,
      line: (x) => `Last week: ${x.runs} runs done, ${x.changes} changes to your tools.`,
      action: "Open the weekly summary",
    },
    reconnect: {
      subject: "A connection needs you to sign in again",
      line: "One of your connected tools stopped working. Sign in to it again so your services keep going.",
      action: "Open your connections",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "You have used this month's included credits"
          : `You have used ${x.credits} credits beyond this month's included ones`,
      line: "Your settings say what happens next.",
      action: "Open your settings",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "You have a new message from your Mezonas lead"
          : `You have ${x.n} new messages from your Mezonas lead`,
      toLead: (c, x) =>
        c === 1 ? "A client sent you a new message" : `A client sent you ${x.n} new messages`,
      action: "Read and reply",
    },
    signoff: {
      subject: "An agent waits for your sign-off to go live",
      line: "See what it did during its trial and sign off on your Desk.",
      action: "Open your Desk",
    },
    footer: "This email is from Mezonas. You choose which emails you get in your settings.",
  },
  es: {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1 ? "1 elemento le espera en Mezonas" : `${x.n} elementos le esperan en Mezonas`,
      action: "Abrir su escritorio",
    },
    weeklyTable: {
      subject: (x) => `Su resumen de la semana del ${x.week}`,
      line: (x) =>
        `La semana pasada: ${x.runs} ejecuciones hechas, ${x.changes} cambios en sus herramientas.`,
      action: "Abrir el resumen semanal",
    },
    reconnect: {
      subject: "Una conexión necesita que vuelva a iniciar sesión",
      line: "Una de sus herramientas conectadas dejó de funcionar. Vuelva a iniciar sesión para que sus servicios sigan.",
      action: "Abrir sus conexiones",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "Ha usado los créditos incluidos este mes"
          : `Ha usado ${x.credits} créditos más allá de los incluidos este mes`,
      line: "Su configuración indica lo que pasa ahora.",
      action: "Abrir su configuración",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "Tiene un mensaje nuevo de su responsable en Mezonas"
          : `Tiene ${x.n} mensajes nuevos de su responsable en Mezonas`,
      toLead: (c, x) =>
        c === 1
          ? "Un cliente le envió un mensaje nuevo"
          : `Un cliente le envió ${x.n} mensajes nuevos`,
      action: "Leer y responder",
    },
    signoff: {
      subject: "Un agente espera su aprobación para empezar",
      line: "Vea lo que hizo durante su prueba y apruébelo en su escritorio.",
      action: "Abrir su escritorio",
    },
    footer: "Este correo es de Mezonas. Usted elige qué correos recibe en su configuración.",
  },
  fr: {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1
          ? "1 élément vous attend dans Mezonas"
          : `${x.n} éléments vous attendent dans Mezonas`,
      action: "Ouvrir votre bureau",
    },
    weeklyTable: {
      subject: (x) => `Votre bilan de la semaine du ${x.week}`,
      line: (x) =>
        `La semaine dernière : ${x.runs} exécutions faites, ${x.changes} modifications dans vos outils.`,
      action: "Ouvrir le bilan de la semaine",
    },
    reconnect: {
      subject: "Une connexion vous demande de vous reconnecter",
      line: "Un de vos outils connectés ne fonctionne plus. Reconnectez-vous pour que vos services continuent.",
      action: "Ouvrir vos connexions",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "Vous avez utilisé les crédits inclus ce mois-ci"
          : `Vous avez utilisé ${x.credits} crédits au-delà de ceux inclus ce mois-ci`,
      line: "Vos paramètres indiquent la suite.",
      action: "Ouvrir vos paramètres",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "Vous avez un nouveau message de votre responsable Mezonas"
          : `Vous avez ${x.n} nouveaux messages de votre responsable Mezonas`,
      toLead: (c, x) =>
        c === 1
          ? "Un client vous a envoyé un nouveau message"
          : `Un client vous a envoyé ${x.n} nouveaux messages`,
      action: "Lire et répondre",
    },
    signoff: {
      subject: "Un agent attend votre accord pour démarrer",
      line: "Voyez ce qu'il a fait pendant son essai et donnez votre accord sur votre bureau.",
      action: "Ouvrir votre bureau",
    },
    footer:
      "Cet e-mail vient de Mezonas. Vous choisissez les e-mails que vous recevez dans vos paramètres.",
  },
  "pt-BR": {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1 ? "1 item espera por você no Mezonas" : `${x.n} itens esperam por você no Mezonas`,
      action: "Abrir sua mesa",
    },
    weeklyTable: {
      subject: (x) => `Seu resumo da semana de ${x.week}`,
      line: (x) =>
        `Semana passada: ${x.runs} execuções feitas, ${x.changes} alterações nas suas ferramentas.`,
      action: "Abrir o resumo semanal",
    },
    reconnect: {
      subject: "Uma conexão precisa que você entre de novo",
      line: "Uma das suas ferramentas conectadas parou de funcionar. Entre de novo para que seus serviços continuem.",
      action: "Abrir suas conexões",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "Você usou os créditos incluídos deste mês"
          : `Você usou ${x.credits} créditos além dos incluídos deste mês`,
      line: "Suas configurações dizem o que acontece agora.",
      action: "Abrir suas configurações",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "Você tem uma nova mensagem do seu responsável na Mezonas"
          : `Você tem ${x.n} novas mensagens do seu responsável na Mezonas`,
      toLead: (c, x) =>
        c === 1
          ? "Um cliente enviou uma nova mensagem"
          : `Um cliente enviou ${x.n} novas mensagens`,
      action: "Ler e responder",
    },
    signoff: {
      subject: "Um agente espera sua aprovação para começar",
      line: "Veja o que ele fez durante o teste e aprove na sua mesa.",
      action: "Abrir sua mesa",
    },
    footer: "Este e-mail é do Mezonas. Você escolhe quais e-mails recebe nas suas configurações.",
  },
  it: {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1 ? "1 elemento ti aspetta in Mezonas" : `${x.n} elementi ti aspettano in Mezonas`,
      action: "Apri la tua scrivania",
    },
    weeklyTable: {
      subject: (x) => `Il tuo riepilogo della settimana del ${x.week}`,
      line: (x) =>
        `La settimana scorsa: ${x.runs} esecuzioni fatte, ${x.changes} modifiche ai tuoi strumenti.`,
      action: "Apri il riepilogo settimanale",
    },
    reconnect: {
      subject: "Una connessione ti chiede di accedere di nuovo",
      line: "Uno dei tuoi strumenti collegati ha smesso di funzionare. Accedi di nuovo perché i tuoi servizi continuino.",
      action: "Apri le tue connessioni",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "Hai usato i crediti inclusi questo mese"
          : `Hai usato ${x.credits} crediti oltre quelli inclusi questo mese`,
      line: "Le tue impostazioni dicono cosa succede ora.",
      action: "Apri le impostazioni",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "Hai un nuovo messaggio dal tuo referente Mezonas"
          : `Hai ${x.n} nuovi messaggi dal tuo referente Mezonas`,
      toLead: (c, x) =>
        c === 1
          ? "Un cliente ti ha inviato un nuovo messaggio"
          : `Un cliente ti ha inviato ${x.n} nuovi messaggi`,
      action: "Leggi e rispondi",
    },
    signoff: {
      subject: "Un agente aspetta la tua approvazione per partire",
      line: "Guarda cosa ha fatto durante la prova e approva dalla tua scrivania.",
      action: "Apri la tua scrivania",
    },
    footer: "Questa email è di Mezonas. Scegli quali email ricevere nelle impostazioni.",
  },
  de: {
    itemsWaiting: {
      subject: (c, x) =>
        c === 1
          ? "1 Eintrag wartet in Mezonas auf Sie"
          : `${x.n} Einträge warten in Mezonas auf Sie`,
      action: "Ihren Schreibtisch öffnen",
    },
    weeklyTable: {
      subject: (x) => `Ihre Wochenübersicht für die Woche vom ${x.week}`,
      line: (x) =>
        `Letzte Woche: ${x.runs} Durchläufe erledigt, ${x.changes} Änderungen in Ihren Tools.`,
      action: "Wochenübersicht öffnen",
    },
    reconnect: {
      subject: "Eine Verbindung braucht eine neue Anmeldung",
      line: "Eines Ihrer verbundenen Tools funktioniert nicht mehr. Melden Sie sich neu an, damit Ihre Dienste weiterlaufen.",
      action: "Ihre Verbindungen öffnen",
    },
    credits: {
      subject: (b, x) =>
        b === 0
          ? "Sie haben die in diesem Monat enthaltenen Credits verbraucht"
          : `Sie haben ${x.credits} Credits über die in diesem Monat enthaltenen hinaus verbraucht`,
      line: "Ihre Einstellungen sagen, wie es weitergeht.",
      action: "Einstellungen öffnen",
    },
    leadMessage: {
      toClient: (c, x) =>
        c === 1
          ? "Sie haben eine neue Nachricht von Ihrer Ansprechperson bei Mezonas"
          : `Sie haben ${x.n} neue Nachrichten von Ihrer Ansprechperson bei Mezonas`,
      toLead: (c, x) =>
        c === 1
          ? "Ein Kunde hat Ihnen eine neue Nachricht geschickt"
          : `Ein Kunde hat Ihnen ${x.n} neue Nachrichten geschickt`,
      action: "Lesen und antworten",
    },
    signoff: {
      subject: "Ein Agent wartet auf Ihre Freigabe für den Start",
      line: "Sehen Sie, was er in der Testphase getan hat, und geben Sie ihn auf Ihrem Schreibtisch frei.",
      action: "Ihren Schreibtisch öffnen",
    },
    footer:
      "Diese E-Mail kommt von Mezonas. Welche E-Mails Sie bekommen, wählen Sie in Ihren Einstellungen.",
  },
};
