// The words of a change Sloan drafts (docs/plan.md §1.47, v0.12 "Client words"): the Desk item's
// title and its "now" and "after" lines, in each language. The Worker writes them from ids and
// names, never from model text. Rule lines come from the Desk's own words (DESK_WORDS.team.rule).
// TODO(review): es, fr, pt-BR, it and de want a fluent speaker's review.
import type { Locale } from "../i18n/locale";

export type AccountChangeField =
  | "name"
  | "title"
  | "notes"
  | "language"
  | "timezone"
  | "quietHours"
  | "preferredChannels"
  | "roles"
  | "organizationId"
  | "relationship"
  | "email"
  | "phone"
  | "whatsapp";

export interface AccountWords {
  title: {
    addSigner(name: string): string;
    editPerson(name: string): string;
    changeContact(name: string): string;
    /** docs/plan.md §1.98: an email inviting people to sign up for texts. */
    inviteToTexts(names: string, count: number): string;
  };
  /** Not signed up for texts. */
  notOnTexts(name: string): string;
  /** Gets the invitation email. */
  getsTextInvite(name: string): string;
  /** Not on the team yet. */
  notOnTeam(name: string): string;
  /** On the team, and whether they approve. */
  onTeam(name: string, signs: boolean): string;
  joins(name: string, signs: boolean): string;
  /** "<rule> → <who>". */
  signs(rule: string, who: string): string;
  /** The client's admins, as an approver. */
  admins: string;
  /** "<field>: <value>". */
  field(field: AccountChangeField, value: string): string;
  /** An empty value. */
  none: string;
  /** Who asked, under the lines. */
  askedBy(name: string): string;
}

type Labels = Record<AccountChangeField, string>;

const field = (labels: Labels) => (f: AccountChangeField, v: string) => `${labels[f]}: ${v}`;

const EN: Labels = {
  name: "Name",
  title: "Title",
  notes: "Notes",
  language: "Language",
  timezone: "Time zone",
  quietHours: "Quiet hours",
  preferredChannels: "Reach by",
  roles: "Roles",
  organizationId: "Organization",
  relationship: "Relationship",
  email: "Email",
  phone: "Phone",
  whatsapp: "WhatsApp",
};

export const ACCOUNT_WORDS: Record<Locale, AccountWords> = {
  en: {
    title: {
      addSigner: (n) => `Add ${n} as an approver`,
      editPerson: (n) => `Update ${n}'s details`,
      changeContact: (n) => `Change how we reach ${n}`,
      inviteToTexts: (n, c) =>
        c === 1 ? `Invite ${n} to get texts` : `Invite ${c} people to get texts`,
    },
    notOnTexts: (n) => `${n} hasn't signed up for texts.`,
    getsTextInvite: (n) =>
      `${n} gets an email inviting them to sign up for texts. Texting stays their choice.`,
    notOnTeam: (n) => `${n} is not on your team.`,
    onTeam: (n, s) =>
      s
        ? `${n} is on your team and approves changes.`
        : `${n} is on your team and approves nothing.`,
    joins: (n, s) =>
      s
        ? `${n} joins your team and approves changes.`
        : `${n} joins your team and approves nothing.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "your admins",
    field: field(EN),
    none: "none",
    askedBy: (n) => `Asked by ${n} in a conversation with Sloan.`,
  },
  es: {
    title: {
      addSigner: (n) => `Agregar a ${n} como aprobador`,
      editPerson: (n) => `Actualizar los datos de ${n}`,
      changeContact: (n) => `Cambiar cómo contactamos a ${n}`,
      inviteToTexts: (n, c) =>
        c === 1
          ? `Invitar a ${n} a recibir mensajes de texto`
          : `Invitar a ${c} personas a recibir mensajes de texto`,
    },
    notOnTexts: (n) => `${n} no se ha registrado para recibir mensajes de texto.`,
    getsTextInvite: (n) =>
      `${n} recibe un correo que le invita a registrarse para recibir mensajes de texto. Sigue siendo su decisión.`,
    notOnTeam: (n) => `${n} no está en su equipo.`,
    onTeam: (n, s) =>
      s ? `${n} está en su equipo y aprueba cambios.` : `${n} está en su equipo y no aprueba nada.`,
    joins: (n, s) =>
      s
        ? `${n} se une a su equipo y aprueba cambios.`
        : `${n} se une a su equipo y no aprueba nada.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "sus administradores",
    field: field({
      name: "Nombre",
      title: "Cargo",
      notes: "Notas",
      language: "Idioma",
      timezone: "Zona horaria",
      quietHours: "Horas de silencio",
      preferredChannels: "Contactar por",
      roles: "Funciones",
      organizationId: "Organización",
      relationship: "Relación",
      email: "Correo",
      phone: "Teléfono",
      whatsapp: "WhatsApp",
    }),
    none: "ninguno",
    askedBy: (n) => `Lo pidió ${n} en una conversación con Sloan.`,
  },
  fr: {
    title: {
      addSigner: (n) => `Ajouter ${n} comme approbateur`,
      editPerson: (n) => `Mettre à jour les informations de ${n}`,
      changeContact: (n) => `Changer comment nous joignons ${n}`,
      inviteToTexts: (n, c) =>
        c === 1 ? `Inviter ${n} à recevoir des SMS` : `Inviter ${c} personnes à recevoir des SMS`,
    },
    notOnTexts: (n) => `${n} ne s'est pas inscrit aux SMS.`,
    getsTextInvite: (n) =>
      `${n} reçoit un e-mail l'invitant à s'inscrire aux SMS. Le choix lui appartient.`,
    notOnTeam: (n) => `${n} ne fait pas partie de votre équipe.`,
    onTeam: (n, s) =>
      s
        ? `${n} fait partie de votre équipe et approuve les modifications.`
        : `${n} fait partie de votre équipe et n'approuve rien.`,
    joins: (n, s) =>
      s
        ? `${n} rejoint votre équipe et approuve les modifications.`
        : `${n} rejoint votre équipe et n'approuve rien.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "vos administrateurs",
    field: field({
      name: "Nom",
      title: "Fonction",
      notes: "Notes",
      language: "Langue",
      timezone: "Fuseau horaire",
      quietHours: "Heures calmes",
      preferredChannels: "Joindre par",
      roles: "Rôles",
      organizationId: "Organisation",
      relationship: "Relation",
      email: "E-mail",
      phone: "Téléphone",
      whatsapp: "WhatsApp",
    }),
    none: "aucun",
    askedBy: (n) => `Demandé par ${n} dans une conversation avec Sloan.`,
  },
  "pt-BR": {
    title: {
      addSigner: (n) => `Adicionar ${n} como aprovador`,
      editPerson: (n) => `Atualizar os dados de ${n}`,
      changeContact: (n) => `Mudar como falamos com ${n}`,
      inviteToTexts: (n, c) =>
        c === 1
          ? `Convidar ${n} para receber mensagens de texto`
          : `Convidar ${c} pessoas para receber mensagens de texto`,
    },
    notOnTexts: (n) => `${n} não se inscreveu para receber mensagens de texto.`,
    getsTextInvite: (n) =>
      `${n} recebe um e-mail convidando para se inscrever nas mensagens de texto. A escolha continua sendo dela.`,
    notOnTeam: (n) => `${n} não está na sua equipe.`,
    onTeam: (n, s) =>
      s
        ? `${n} está na sua equipe e aprova alterações.`
        : `${n} está na sua equipe e não aprova nada.`,
    joins: (n, s) =>
      s
        ? `${n} entra na sua equipe e aprova alterações.`
        : `${n} entra na sua equipe e não aprova nada.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "seus administradores",
    field: field({
      name: "Nome",
      title: "Cargo",
      notes: "Notas",
      language: "Idioma",
      timezone: "Fuso horário",
      quietHours: "Horário de silêncio",
      preferredChannels: "Falar por",
      roles: "Funções",
      organizationId: "Organização",
      relationship: "Relação",
      email: "E-mail",
      phone: "Telefone",
      whatsapp: "WhatsApp",
    }),
    none: "nenhum",
    askedBy: (n) => `Pedido por ${n} em uma conversa com a Sloan.`,
  },
  it: {
    title: {
      addSigner: (n) => `Aggiungere ${n} come approvatore`,
      editPerson: (n) => `Aggiornare i dati di ${n}`,
      changeContact: (n) => `Cambiare come contattiamo ${n}`,
      inviteToTexts: (n, c) =>
        c === 1 ? `Invitare ${n} a ricevere SMS` : `Invitare ${c} persone a ricevere SMS`,
    },
    notOnTexts: (n) => `${n} non si è iscritto agli SMS.`,
    getsTextInvite: (n) =>
      `${n} riceve un'email che lo invita a iscriversi agli SMS. La scelta resta sua.`,
    notOnTeam: (n) => `${n} non fa parte del suo team.`,
    onTeam: (n, s) =>
      s
        ? `${n} fa parte del suo team e approva le modifiche.`
        : `${n} fa parte del suo team e non approva nulla.`,
    joins: (n, s) =>
      s
        ? `${n} entra nel suo team e approva le modifiche.`
        : `${n} entra nel suo team e non approva nulla.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "i suoi amministratori",
    field: field({
      name: "Nome",
      title: "Ruolo",
      notes: "Note",
      language: "Lingua",
      timezone: "Fuso orario",
      quietHours: "Ore di silenzio",
      preferredChannels: "Contattare via",
      roles: "Funzioni",
      organizationId: "Organizzazione",
      relationship: "Relazione",
      email: "Email",
      phone: "Telefono",
      whatsapp: "WhatsApp",
    }),
    none: "nessuno",
    askedBy: (n) => `Chiesto da ${n} in una conversazione con Sloan.`,
  },
  de: {
    title: {
      addSigner: (n) => `${n} als freigebende Person hinzufügen`,
      editPerson: (n) => `Angaben von ${n} aktualisieren`,
      changeContact: (n) => `Ändern, wie wir ${n} erreichen`,
      inviteToTexts: (n, c) => (c === 1 ? `${n} zu SMS einladen` : `${c} Personen zu SMS einladen`),
    },
    notOnTexts: (n) => `${n} hat sich nicht für SMS angemeldet.`,
    getsTextInvite: (n) =>
      `${n} erhält eine E-Mail mit der Einladung, sich für SMS anzumelden. Die Wahl bleibt bei ihnen.`,
    notOnTeam: (n) => `${n} ist nicht in Ihrem Team.`,
    onTeam: (n, s) =>
      s
        ? `${n} ist in Ihrem Team und gibt Änderungen frei.`
        : `${n} ist in Ihrem Team und gibt nichts frei.`,
    joins: (n, s) =>
      s
        ? `${n} kommt in Ihr Team und gibt Änderungen frei.`
        : `${n} kommt in Ihr Team und gibt nichts frei.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "Ihre Administratoren",
    field: field({
      name: "Name",
      title: "Position",
      notes: "Notizen",
      language: "Sprache",
      timezone: "Zeitzone",
      quietHours: "Ruhezeiten",
      preferredChannels: "Erreichen per",
      roles: "Rollen",
      organizationId: "Organisation",
      relationship: "Beziehung",
      email: "E-Mail",
      phone: "Telefon",
      whatsapp: "WhatsApp",
    }),
    none: "keine",
    askedBy: (n) => `Erbeten von ${n} in einem Gespräch mit Sloan.`,
  },
};
