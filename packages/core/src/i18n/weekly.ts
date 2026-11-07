// The Weekly Table's words in each language (ARCHITECTURE §11.4, docs/plan.md §1.37), for its PDF
// and anything else the Worker writes from it. Marked for a fluent speaker's review.
import type { Locale } from "./locale";

export interface WeeklyWords {
  title: string;
  weekOf(date: string): string;
  runsDone: string;
  /** "+3 on last week", "−2 on last week", "same as last week". */
  versusLastWeek(change: number, formatted: string): string;
  changes: string;
  automatic: string;
  signed: string;
  signatures: string;
  documents: string;
  agents: string;
  note(lead: string | null): string;
  decisions: string;
  options: string;
  nextWeek: string;
  setup: string;
  connect(tool: string, agent: string): string;
  replied: string;
}

// Reviewed by: nobody yet (needs a fluent speaker for es, fr, pt-BR, it, de).
export const WEEKLY_WORDS: Record<Locale, WeeklyWords> = {
  en: {
    title: "Weekly summary",
    weekOf: (d) => `Week of ${d}`,
    runsDone: "Runs done",
    versusLastWeek: (c, f) =>
      c === 0 ? "same as last week" : `${c > 0 ? "+" : "-"}${f} on last week`,
    changes: "Changes to your tools",
    automatic: "automatic",
    signed: "approved",
    signatures: "Approvals given",
    documents: "Documents read",
    agents: "Your agents",
    note: (l) => (l ? `A note from ${l}` : "A note from your Mezonas lead"),
    decisions: "Decisions for you",
    options: "Options",
    nextWeek: "Next week",
    setup: "Still to set up",
    connect: (t, a) => `Connect your ${t} (${a})`,
    replied: "Answered",
  },
  es: {
    title: "Resumen semanal",
    weekOf: (d) => `Semana del ${d}`,
    runsDone: "Ejecuciones hechas",
    versusLastWeek: (c, f) =>
      c === 0 ? "igual que la semana pasada" : `${c > 0 ? "+" : "-"}${f} frente a la semana pasada`,
    changes: "Cambios en sus herramientas",
    automatic: "automáticos",
    signed: "aprobados",
    signatures: "Aprobaciones dadas",
    documents: "Documentos leídos",
    agents: "Sus agentes",
    note: (l) => (l ? `Una nota de ${l}` : "Una nota de su responsable en Mezonas"),
    decisions: "Decisiones para usted",
    options: "Opciones",
    nextWeek: "La próxima semana",
    setup: "Pendiente de configurar",
    connect: (t, a) => `Conecte su ${t} (${a})`,
    replied: "Respondida",
  },
  fr: {
    title: "Bilan de la semaine",
    weekOf: (d) => `Semaine du ${d}`,
    runsDone: "Exécutions faites",
    versusLastWeek: (c, f) =>
      c === 0
        ? "comme la semaine dernière"
        : `${c > 0 ? "+" : "-"}${f} par rapport à la semaine dernière`,
    changes: "Modifications dans vos outils",
    automatic: "automatiques",
    signed: "approuvées",
    signatures: "Approbations données",
    documents: "Documents lus",
    agents: "Vos agents",
    note: (l) => (l ? `Un mot de ${l}` : "Un mot de votre responsable Mezonas"),
    decisions: "Décisions pour vous",
    options: "Options",
    nextWeek: "La semaine prochaine",
    setup: "Encore à configurer",
    connect: (t, a) => `Connectez votre ${t} (${a})`,
    replied: "Répondu",
  },
  "pt-BR": {
    title: "Resumo semanal",
    weekOf: (d) => `Semana de ${d}`,
    runsDone: "Execuções feitas",
    versusLastWeek: (c, f) =>
      c === 0 ? "igual à semana passada" : `${c > 0 ? "+" : "-"}${f} em relação à semana passada`,
    changes: "Alterações nas suas ferramentas",
    automatic: "automáticas",
    signed: "aprovadas",
    signatures: "Aprovações dadas",
    documents: "Documentos lidos",
    agents: "Seus agentes",
    note: (l) => (l ? `Uma nota de ${l}` : "Uma nota do seu responsável na Mezonas"),
    decisions: "Decisões para você",
    options: "Opções",
    nextWeek: "Próxima semana",
    setup: "Ainda a configurar",
    connect: (t, a) => `Conecte seu ${t} (${a})`,
    replied: "Respondida",
  },
  it: {
    title: "Riepilogo settimanale",
    weekOf: (d) => `Settimana del ${d}`,
    runsDone: "Esecuzioni fatte",
    versusLastWeek: (c, f) =>
      c === 0
        ? "come la settimana scorsa"
        : `${c > 0 ? "+" : "-"}${f} rispetto alla settimana scorsa`,
    changes: "Modifiche ai tuoi strumenti",
    automatic: "automatiche",
    signed: "approvate",
    signatures: "Approvazioni date",
    documents: "Documenti letti",
    agents: "I tuoi agenti",
    note: (l) => (l ? `Una nota da ${l}` : "Una nota dal tuo referente Mezonas"),
    decisions: "Decisioni per te",
    options: "Opzioni",
    nextWeek: "La prossima settimana",
    setup: "Ancora da configurare",
    connect: (t, a) => `Collega il tuo ${t} (${a})`,
    replied: "Risposta data",
  },
  de: {
    title: "Wochenübersicht",
    weekOf: (d) => `Woche vom ${d}`,
    runsDone: "Erledigte Durchläufe",
    versusLastWeek: (c, f) =>
      c === 0 ? "wie letzte Woche" : `${c > 0 ? "+" : "-"}${f} gegenüber letzter Woche`,
    changes: "Änderungen in Ihren Tools",
    automatic: "automatisch",
    signed: "freigegeben",
    signatures: "Erteilte Freigaben",
    documents: "Gelesene Dokumente",
    agents: "Ihre Agenten",
    note: (l) => (l ? `Eine Notiz von ${l}` : "Eine Notiz Ihrer Ansprechperson bei Mezonas"),
    decisions: "Entscheidungen für Sie",
    options: "Optionen",
    nextWeek: "Nächste Woche",
    setup: "Noch einzurichten",
    connect: (t, a) => `Verbinden Sie Ihr ${t} (${a})`,
    replied: "Beantwortet",
  },
};
