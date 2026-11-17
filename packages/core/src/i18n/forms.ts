// Forms (docs/plan.md §1.121): the words of the message that carries a form's link, and of the page
// a person fills it in on, in each language. The platform writes them, never a model; the form's
// own questions are the agent's or the operator's, in the words they wrote. Marked for a fluent
// speaker's review, as every client-facing word file is (plan §1.18).
import type { Locale } from "./locale";

export interface FormMessageParams {
  client: string;
  title: string;
  /** The due date, already formatted for the reader. */
  due: string;
  link: string;
}

export interface FormMessageWords {
  subject(p: FormMessageParams): string;
  text(p: FormMessageParams): string;
}

export const FORM_MESSAGE_WORDS: Record<Locale, FormMessageWords> = {
  en: {
    subject: (p) => `${p.client}: ${p.title}`,
    text: (p) =>
      `${p.client} needs a few details from you: ${p.title}. Please answer by ${p.due} on this form (no sign-in needed): ${p.link}`,
  },
  es: {
    subject: (p) => `${p.client}: ${p.title}`,
    text: (p) =>
      `${p.client} necesita algunos datos suyos: ${p.title}. Responda antes del ${p.due} en este formulario (sin iniciar sesión): ${p.link}`,
  },
  fr: {
    subject: (p) => `${p.client} : ${p.title}`,
    text: (p) =>
      `${p.client} a besoin de quelques informations de votre part : ${p.title}. Merci de répondre avant le ${p.due} sur ce formulaire (sans connexion) : ${p.link}`,
  },
  "pt-BR": {
    subject: (p) => `${p.client}: ${p.title}`,
    text: (p) =>
      `${p.client} precisa de algumas informações suas: ${p.title}. Responda até ${p.due} neste formulário (sem precisar entrar): ${p.link}`,
  },
  it: {
    subject: (p) => `${p.client}: ${p.title}`,
    text: (p) =>
      `${p.client} ha bisogno di alcune informazioni da lei: ${p.title}. Risponda entro il ${p.due} su questo modulo (senza accesso): ${p.link}`,
  },
  de: {
    subject: (p) => `${p.client}: ${p.title}`,
    text: (p) =>
      `${p.client} braucht ein paar Angaben von Ihnen: ${p.title}. Bitte antworten Sie bis ${p.due} in diesem Formular (ohne Anmeldung): ${p.link}`,
  },
};

export interface FormPageWords {
  /** "Asked by Client A". */
  askedBy(client: string): string;
  /** "Please answer by …". */
  dueBy(date: string): string;
  required: string;
  optional: string;
  yes: string;
  no: string;
  other: string;
  otherPlaceholder: string;
  addFiles: string;
  uploading: string;
  remove: string;
  addRow: string;
  removeRow: string;
  save: string;
  saved: string;
  review: string;
  back: string;
  submit: string;
  checkAnswers: string;
  needed: string;
  thanksTitle: string;
  thanksText(client: string): string;
  closedTitle: string;
  closedText(client: string): string;
  notFound: string;
  failed: string;
  noAnswer: string;
}

export const FORM_PAGE_WORDS: Record<Locale, FormPageWords> = {
  en: {
    askedBy: (c) => `Asked by ${c}`,
    dueBy: (d) => `Please answer by ${d}`,
    required: "Needed",
    optional: "Optional",
    yes: "Yes",
    no: "No",
    other: "Other",
    otherPlaceholder: "In your words",
    addFiles: "Add files",
    uploading: "Uploading…",
    remove: "Remove",
    addRow: "Add a row",
    removeRow: "Remove row",
    save: "Save and finish later",
    saved: "Saved. You can come back to this link.",
    review: "Review answers",
    back: "Change answers",
    submit: "Send answers",
    checkAnswers: "Check your answers, then send them. You can't change them after sending.",
    needed: "This one is needed",
    thanksTitle: "Thank you",
    thanksText: (c) => `Your answers went to ${c}. You can close this page.`,
    closedTitle: "This form is closed",
    closedText: (c) =>
      `This form no longer takes answers. If you still need to send them, contact ${c}.`,
    notFound: "This link has expired or doesn't exist.",
    failed: "That didn't work. Please try again.",
    noAnswer: "No answer",
  },
  es: {
    askedBy: (c) => `Lo pide ${c}`,
    dueBy: (d) => `Responda antes del ${d}`,
    required: "Obligatorio",
    optional: "Opcional",
    yes: "Sí",
    no: "No",
    other: "Otro",
    otherPlaceholder: "Con sus palabras",
    addFiles: "Añadir archivos",
    uploading: "Subiendo…",
    remove: "Quitar",
    addRow: "Añadir una fila",
    removeRow: "Quitar fila",
    save: "Guardar y terminar después",
    saved: "Guardado. Puede volver a este enlace.",
    review: "Revisar respuestas",
    back: "Cambiar respuestas",
    submit: "Enviar respuestas",
    checkAnswers: "Revise sus respuestas y envíelas. No podrá cambiarlas después.",
    needed: "Esta es obligatoria",
    thanksTitle: "Gracias",
    thanksText: (c) => `Sus respuestas llegaron a ${c}. Puede cerrar esta página.`,
    closedTitle: "Este formulario está cerrado",
    closedText: (c) =>
      `Este formulario ya no acepta respuestas. Si aún necesita enviarlas, contacte con ${c}.`,
    notFound: "Este enlace caducó o no existe.",
    failed: "No funcionó. Inténtelo de nuevo.",
    noAnswer: "Sin respuesta",
  },
  fr: {
    askedBy: (c) => `Demandé par ${c}`,
    dueBy: (d) => `Merci de répondre avant le ${d}`,
    required: "Obligatoire",
    optional: "Facultatif",
    yes: "Oui",
    no: "Non",
    other: "Autre",
    otherPlaceholder: "Avec vos mots",
    addFiles: "Ajouter des fichiers",
    uploading: "Envoi…",
    remove: "Retirer",
    addRow: "Ajouter une ligne",
    removeRow: "Retirer la ligne",
    save: "Enregistrer et finir plus tard",
    saved: "Enregistré. Vous pouvez revenir à ce lien.",
    review: "Relire les réponses",
    back: "Modifier les réponses",
    submit: "Envoyer les réponses",
    checkAnswers: "Vérifiez vos réponses, puis envoyez-les. Vous ne pourrez plus les modifier.",
    needed: "Celle-ci est obligatoire",
    thanksTitle: "Merci",
    thanksText: (c) => `Vos réponses ont été transmises à ${c}. Vous pouvez fermer cette page.`,
    closedTitle: "Ce formulaire est fermé",
    closedText: (c) =>
      `Ce formulaire n'accepte plus de réponses. Si vous devez encore les envoyer, contactez ${c}.`,
    notFound: "Ce lien a expiré ou n'existe pas.",
    failed: "Cela n'a pas fonctionné. Merci de réessayer.",
    noAnswer: "Sans réponse",
  },
  "pt-BR": {
    askedBy: (c) => `Pedido por ${c}`,
    dueBy: (d) => `Responda até ${d}`,
    required: "Obrigatório",
    optional: "Opcional",
    yes: "Sim",
    no: "Não",
    other: "Outro",
    otherPlaceholder: "Com suas palavras",
    addFiles: "Adicionar arquivos",
    uploading: "Enviando…",
    remove: "Remover",
    addRow: "Adicionar linha",
    removeRow: "Remover linha",
    save: "Salvar e terminar depois",
    saved: "Salvo. Você pode voltar a este link.",
    review: "Revisar respostas",
    back: "Alterar respostas",
    submit: "Enviar respostas",
    checkAnswers: "Confira suas respostas e envie. Depois de enviar, não é possível alterá-las.",
    needed: "Esta é obrigatória",
    thanksTitle: "Obrigado",
    thanksText: (c) => `Suas respostas foram para ${c}. Você pode fechar esta página.`,
    closedTitle: "Este formulário está fechado",
    closedText: (c) =>
      `Este formulário não aceita mais respostas. Se ainda precisar enviá-las, fale com ${c}.`,
    notFound: "Este link expirou ou não existe.",
    failed: "Não funcionou. Tente de novo.",
    noAnswer: "Sem resposta",
  },
  it: {
    askedBy: (c) => `Richiesto da ${c}`,
    dueBy: (d) => `Risponda entro il ${d}`,
    required: "Obbligatoria",
    optional: "Facoltativa",
    yes: "Sì",
    no: "No",
    other: "Altro",
    otherPlaceholder: "Con parole sue",
    addFiles: "Aggiungi file",
    uploading: "Caricamento…",
    remove: "Rimuovi",
    addRow: "Aggiungi una riga",
    removeRow: "Rimuovi riga",
    save: "Salva e finisci dopo",
    saved: "Salvato. Può tornare a questo link.",
    review: "Rivedi le risposte",
    back: "Modifica le risposte",
    submit: "Invia le risposte",
    checkAnswers: "Controlli le risposte e le invii. Dopo l'invio non si possono modificare.",
    needed: "Questa è obbligatoria",
    thanksTitle: "Grazie",
    thanksText: (c) => `Le sue risposte sono arrivate a ${c}. Può chiudere questa pagina.`,
    closedTitle: "Questo modulo è chiuso",
    closedText: (c) =>
      `Questo modulo non accetta più risposte. Se deve ancora inviarle, contatti ${c}.`,
    notFound: "Questo link è scaduto o non esiste.",
    failed: "Non ha funzionato. Riprovi.",
    noAnswer: "Nessuna risposta",
  },
  de: {
    askedBy: (c) => `Angefragt von ${c}`,
    dueBy: (d) => `Bitte antworten Sie bis ${d}`,
    required: "Pflichtangabe",
    optional: "Optional",
    yes: "Ja",
    no: "Nein",
    other: "Sonstiges",
    otherPlaceholder: "In Ihren Worten",
    addFiles: "Dateien hinzufügen",
    uploading: "Wird hochgeladen…",
    remove: "Entfernen",
    addRow: "Zeile hinzufügen",
    removeRow: "Zeile entfernen",
    save: "Speichern und später fertigstellen",
    saved: "Gespeichert. Sie können über diesen Link zurückkehren.",
    review: "Antworten prüfen",
    back: "Antworten ändern",
    submit: "Antworten senden",
    checkAnswers:
      "Prüfen Sie Ihre Antworten und senden Sie sie. Danach lassen sie sich nicht mehr ändern.",
    needed: "Diese Angabe fehlt noch",
    thanksTitle: "Vielen Dank",
    thanksText: (c) => `Ihre Antworten sind bei ${c} angekommen. Sie können diese Seite schließen.`,
    closedTitle: "Dieses Formular ist geschlossen",
    closedText: (c) =>
      `Dieses Formular nimmt keine Antworten mehr an. Wenn Sie sie noch senden müssen, wenden Sie sich an ${c}.`,
    notFound: "Dieser Link ist abgelaufen oder existiert nicht.",
    failed: "Das hat nicht funktioniert. Bitte versuchen Sie es noch einmal.",
    noAnswer: "Keine Antwort",
  },
};
