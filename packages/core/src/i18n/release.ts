// The human release code message and its inbox item in each language (docs/plan.md §1.26). The
// Worker writes them, so they live here beside the timeline words (§1.18), not in the portal's
// bundle. Short, the code first, no link.
import type { Locale } from "./locale";

export interface ReleaseWords {
  /** How a text starts, before the code: also how agents' message reads recognise one. */
  prefix: string;
  /** After the code. */
  body(agent: string, tool: string, window: string): string;
  run: string;
  testRun: string;
  hours(n: number): string;
  subject: string;
  replyOrEnter: string;
  enter: string;
  title(channel: "sms" | "email", agent: string, tool: string): string;
}

export const RELEASE_WORDS: Record<Locale, ReleaseWords> = {
  en: {
    prefix: "Mezonas code:",
    body: (a, t, w) => `Enter it to let ${a} use ${t} ${w}. It expires in 10 minutes.`,
    run: "for this run",
    testRun: "for this test run",
    hours: (n) => (n === 1 ? "for the next hour" : `for the next ${n} hours`),
    subject: "Your Mezonas code",
    replyOrEnter: "Reply to this email with just the code, or enter it in Mezonas.",
    enter: "Enter it in Mezonas.",
    title: (c, a, t) =>
      `Enter the code we ${c === "sms" ? "texted" : "emailed"} you to let ${a} use ${t}`,
  },
  es: {
    prefix: "Código de Mezonas:",
    body: (a, t, w) => `Introdúzcalo para que ${a} use ${t} ${w}. Caduca en 10 minutos.`,
    run: "en esta ejecución",
    testRun: "en esta ejecución de prueba",
    hours: (n) => (n === 1 ? "durante la próxima hora" : `durante las próximas ${n} horas`),
    subject: "Su código de Mezonas",
    replyOrEnter: "Responda a este correo solo con el código, o introdúzcalo en Mezonas.",
    enter: "Introdúzcalo en Mezonas.",
    title: (c, a, t) =>
      `Introduzca el código que le enviamos por ${c === "sms" ? "SMS" : "correo"} para que ${a} use ${t}`,
  },
  fr: {
    prefix: "Code Mezonas :",
    body: (a, t, w) => `Saisissez-le pour que ${a} utilise ${t} ${w}. Il expire dans 10 minutes.`,
    run: "pour cette exécution",
    testRun: "pour cette exécution de test",
    hours: (n) => (n === 1 ? "pendant la prochaine heure" : `pendant les ${n} prochaines heures`),
    subject: "Votre code Mezonas",
    replyOrEnter: "Répondez à cet e-mail avec le code seul, ou saisissez-le dans Mezonas.",
    enter: "Saisissez-le dans Mezonas.",
    title: (c, a, t) =>
      `Saisissez le code envoyé par ${c === "sms" ? "SMS" : "e-mail"} pour que ${a} utilise ${t}`,
  },
  "pt-BR": {
    prefix: "Código Mezonas:",
    body: (a, t, w) => `Digite-o para que ${a} use ${t} ${w}. Ele expira em 10 minutos.`,
    run: "nesta execução",
    testRun: "nesta execução de teste",
    hours: (n) => (n === 1 ? "pela próxima hora" : `pelas próximas ${n} horas`),
    subject: "Seu código Mezonas",
    replyOrEnter: "Responda a este e-mail só com o código, ou digite-o no Mezonas.",
    enter: "Digite-o no Mezonas.",
    title: (c, a, t) =>
      `Digite o código que enviamos por ${c === "sms" ? "SMS" : "e-mail"} para que ${a} use ${t}`,
  },
  it: {
    prefix: "Codice Mezonas:",
    body: (a, t, w) => `Inseriscilo per consentire a ${a} di usare ${t} ${w}. Scade tra 10 minuti.`,
    run: "per questa esecuzione",
    testRun: "per questa esecuzione di prova",
    hours: (n) => (n === 1 ? "per la prossima ora" : `per le prossime ${n} ore`),
    subject: "Il tuo codice Mezonas",
    replyOrEnter: "Rispondi a questa email con il solo codice, oppure inseriscilo in Mezonas.",
    enter: "Inseriscilo in Mezonas.",
    title: (c, a, t) =>
      `Inserisci il codice inviato via ${c === "sms" ? "SMS" : "email"} per consentire a ${a} di usare ${t}`,
  },
  de: {
    prefix: "Mezonas-Code:",
    body: (a, t, w) =>
      `Geben Sie ihn ein, damit ${a} ${t} ${w} nutzen kann. Er läuft in 10 Minuten ab.`,
    run: "für diesen Durchlauf",
    testRun: "für diesen Testdurchlauf",
    hours: (n) => (n === 1 ? "für die nächste Stunde" : `für die nächsten ${n} Stunden`),
    subject: "Ihr Mezonas-Code",
    replyOrEnter:
      "Antworten Sie auf diese E-Mail nur mit dem Code oder geben Sie ihn in Mezonas ein.",
    enter: "Geben Sie ihn in Mezonas ein.",
    title: (c, a, t) =>
      `Geben Sie den Code ein, den wir per ${c === "sms" ? "SMS" : "E-Mail"} gesendet haben, damit ${a} ${t} nutzen kann`,
  },
};

/** How every language's code text starts: agents' message reads hide texts that start so. */
export const RELEASE_TEXT_PREFIXES: readonly string[] = Object.values(RELEASE_WORDS).map(
  (w) => w.prefix,
);
