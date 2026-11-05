// The Gmail test email (portal Connections, "Send a test email") in each language (docs/plan.md
// §1.18, §1.31). The Worker writes it, so it lives here beside the release words, not in the
// portal's bundle. Plain text, no exclamation marks; a fluent speaker reviews it with the rest.
import type { Locale } from "./locale";

export interface GmailTestWords {
  subject: string;
  text: string;
}

export const GMAIL_TEST_WORDS: Record<Locale, GmailTestWords> = {
  en: {
    subject: "Mezonas test email",
    text: "This is a test from Mezonas. Your Gmail connection works: agents can send email from this address, and each email waits for your approval before it is sent. You can disconnect Gmail at any time from Connections.",
  },
  es: {
    subject: "Correo de prueba de Mezonas",
    text: "Esta es una prueba de Mezonas. Su conexión con Gmail funciona: los agentes pueden enviar correos desde esta dirección, y cada correo espera su aprobación antes de enviarse. Puede desconectar Gmail en cualquier momento desde Conexiones.",
  },
  fr: {
    subject: "E-mail de test Mezonas",
    text: "Ceci est un test de Mezonas. Votre connexion Gmail fonctionne : les agents peuvent envoyer des e-mails depuis cette adresse, et chaque e-mail attend votre approbation avant d'être envoyé. Vous pouvez déconnecter Gmail à tout moment depuis Connexions.",
  },
  "pt-BR": {
    subject: "E-mail de teste do Mezonas",
    text: "Este é um teste do Mezonas. Sua conexão com o Gmail funciona: os agentes podem enviar e-mails deste endereço, e cada e-mail aguarda a sua aprovação antes de ser enviado. Você pode desconectar o Gmail a qualquer momento em Conexões.",
  },
  it: {
    subject: "Email di prova di Mezonas",
    text: "Questa è una prova di Mezonas. Il collegamento con Gmail funziona: gli agenti possono inviare email da questo indirizzo, e ogni email attende la tua approvazione prima di essere inviata. Puoi scollegare Gmail in qualsiasi momento da Connessioni.",
  },
  de: {
    subject: "Mezonas-Test-E-Mail",
    text: "Dies ist ein Test von Mezonas. Ihre Gmail-Verbindung funktioniert: Agenten können E-Mails von dieser Adresse senden, und jede E-Mail wartet auf Ihre Freigabe, bevor sie gesendet wird. Sie können Gmail jederzeit unter Verbindungen trennen.",
  },
};
