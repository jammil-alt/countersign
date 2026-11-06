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
  };
  /** Not on the team yet. */
  notOnTeam(name: string): string;
  /** On the team, and whether they sign. */
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
      addSigner: (n) => `Add ${n} as a signer`,
      editPerson: (n) => `Update ${n}'s details`,
      changeContact: (n) => `Change how we reach ${n}`,
    },
    notOnTeam: (n) => `${n} is not on your team.`,
    onTeam: (n, s) =>
      s ? `${n} is on your team and signs.` : `${n} is on your team and signs nothing.`,
    joins: (n, s) =>
      s ? `${n} joins your team and signs.` : `${n} joins your team and signs nothing.`,
    signs: (r, w) => `${r} → ${w}`,
    admins: "your admins",
    field: field(EN),
    none: "none",
    askedBy: (n) => `Asked by ${n} in a conversation with Sloan.`,
  },
  es: {
    title: {
      addSigner: (n) => `Agregar a ${n} como firmante`,
      editPerson: (n) => `Actualizar los datos de ${n}`,
      changeContact: (n) => `Cambiar cómo contactamos a ${n}`,
    },
    notOnTeam: (n) => `${n} no está en su equipo.`,
    onTeam: (n, s) =>
      s ? `${n} está en su equipo y firma.` : `${n} está en su equipo y no firma nada.`,
    joins: (n, s) =>
      s ? `${n} se une a su equipo y firma.` : `${n} se une a su equipo y no firma nada.`,
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
      addSigner: (n) => `Ajouter ${n} comme signataire`,
      editPerson: (n) => `Mettre à jour les informations de ${n}`,
      changeContact: (n) => `Changer comment nous joignons ${n}`,
    },
    notOnTeam: (n) => `${n} ne fait pas partie de votre équipe.`,
    onTeam: (n, s) =>
      s
        ? `${n} fait partie de votre équipe et signe.`
        : `${n} fait partie de votre équipe et ne signe rien.`,
    joins: (n, s) =>
      s ? `${n} rejoint votre équipe et signe.` : `${n} rejoint votre équipe et ne signe rien.`,
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
      addSigner: (n) => `Adicionar ${n} como signatário`,
      editPerson: (n) => `Atualizar os dados de ${n}`,
      changeContact: (n) => `Mudar como falamos com ${n}`,
    },
    notOnTeam: (n) => `${n} não está na sua equipe.`,
    onTeam: (n, s) =>
      s ? `${n} está na sua equipe e assina.` : `${n} está na sua equipe e não assina nada.`,
    joins: (n, s) =>
      s ? `${n} entra na sua equipe e assina.` : `${n} entra na sua equipe e não assina nada.`,
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
      addSigner: (n) => `Aggiungere ${n} come firmatario`,
      editPerson: (n) => `Aggiornare i dati di ${n}`,
      changeContact: (n) => `Cambiare come contattiamo ${n}`,
    },
    notOnTeam: (n) => `${n} non fa parte del suo team.`,
    onTeam: (n, s) =>
      s ? `${n} fa parte del suo team e firma.` : `${n} fa parte del suo team e non firma nulla.`,
    joins: (n, s) =>
      s ? `${n} entra nel suo team e firma.` : `${n} entra nel suo team e non firma nulla.`,
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
      addSigner: (n) => `${n} als Unterzeichner hinzufügen`,
      editPerson: (n) => `Angaben von ${n} aktualisieren`,
      changeContact: (n) => `Ändern, wie wir ${n} erreichen`,
    },
    notOnTeam: (n) => `${n} ist nicht in Ihrem Team.`,
    onTeam: (n, s) =>
      s
        ? `${n} ist in Ihrem Team und unterschreibt.`
        : `${n} ist in Ihrem Team und unterschreibt nichts.`,
    joins: (n, s) =>
      s
        ? `${n} kommt in Ihr Team und unterschreibt.`
        : `${n} kommt in Ihr Team und unterschreibt nichts.`,
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
