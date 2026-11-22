// docs/plan.md §1.234: the work statement's words, for the portal page and the PDF, in each portal
// language. Only the statement's lazy screen and the API's PDF import them, so they stay out of the
// web's first load. The counters' names in English are `WORK_COUNTERS[id].words`.
// REVIEW: the translations need a fluent speaker (§1.18).

import {
  WORK_COUNTER_IDS,
  type WorkAmount,
  type WorkCounterId,
  type WorkCounts,
} from "../api/work-statement";
import { formatKpi } from "../kpi/format";
import type { OwnerArea } from "../owners/areas";
import type { Locale } from "./locale";

export interface WorkStatementWords {
  title: string;
  soFar: string;
  monthLabel: string;
  show: string;
  invoice: (number: string) => string;
  totals: string;
  byArea: string;
  byAgent: string;
  agent: string;
  area: string;
  runs: string;
  none: string;
  pdf: string;
  counters: Record<WorkCounterId, string>;
  areas: Record<OwnerArea, string>;
  /** The email that carries the PDF with the invoice. */
  emailSubject: (month: string) => string;
  emailBody: (input: { client: string; month: string; link: string | null }) => string;
}

const en: WorkStatementWords = {
  title: "Work statement",
  soFar: "This month so far",
  monthLabel: "Month",
  show: "Show",
  invoice: (n) => `With invoice ${n}`,
  totals: "In total",
  byArea: "By area",
  byAgent: "By agent",
  agent: "Agent",
  area: "Area",
  runs: "Runs",
  none: "No work this month.",
  pdf: "Download PDF",
  counters: {
    itemsProcessed: "Items processed",
    autoPosted: "Posted automatically",
    sentForApproval: "Sent for approval",
    exceptionsCaught: "Exceptions caught",
    dollarsIdentified: "Dollars identified",
  },
  areas: {
    purchasing: "Purchasing",
    sales: "Sales",
    receivables: "Receivables",
    bookkeeping: "Bookkeeping",
    marketing: "Marketing",
    general: "General",
  },
  emailSubject: (m) => `Your work statement for ${m}`,
  emailBody: ({ client, month, link }) =>
    [
      `Here is what your agents did for ${client} in ${month}. It is attached as a PDF.`,
      "Your invoice for the month comes in a separate email from Stripe.",
      link ? `You can also see it in Mezonas: ${link}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
};

export const WORK_STATEMENT_WORDS: Record<Locale, WorkStatementWords> = {
  en,
  es: {
    title: "Resumen de trabajo",
    soFar: "Este mes hasta hoy",
    monthLabel: "Mes",
    show: "Mostrar",
    invoice: (n) => `Con la factura ${n}`,
    totals: "En total",
    byArea: "Por área",
    byAgent: "Por agente",
    agent: "Agente",
    area: "Área",
    runs: "Ejecuciones",
    none: "Sin trabajo este mes.",
    pdf: "Descargar PDF",
    counters: {
      itemsProcessed: "Elementos procesados",
      autoPosted: "Registrados automáticamente",
      sentForApproval: "Enviados para aprobación",
      exceptionsCaught: "Excepciones detectadas",
      dollarsIdentified: "Importe identificado",
    },
    areas: {
      purchasing: "Compras",
      sales: "Ventas",
      receivables: "Cobros",
      bookkeeping: "Contabilidad",
      marketing: "Marketing",
      general: "General",
    },
    emailSubject: (m) => `Su resumen de trabajo de ${m}`,
    emailBody: ({ client, month, link }) =>
      [
        `Esto es lo que sus agentes hicieron para ${client} en ${month}. Va adjunto en PDF.`,
        "La factura del mes llega en otro correo de Stripe.",
        link ? `También puede verlo en Mezonas: ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  fr: {
    title: "Relevé de travail",
    soFar: "Ce mois-ci jusqu'à présent",
    monthLabel: "Mois",
    show: "Afficher",
    invoice: (n) => `Avec la facture ${n}`,
    totals: "Au total",
    byArea: "Par domaine",
    byAgent: "Par agent",
    agent: "Agent",
    area: "Domaine",
    runs: "Exécutions",
    none: "Aucun travail ce mois-ci.",
    pdf: "Télécharger le PDF",
    counters: {
      itemsProcessed: "Éléments traités",
      autoPosted: "Enregistrés automatiquement",
      sentForApproval: "Envoyés pour approbation",
      exceptionsCaught: "Anomalies détectées",
      dollarsIdentified: "Montants identifiés",
    },
    areas: {
      purchasing: "Achats",
      sales: "Ventes",
      receivables: "Encaissements",
      bookkeeping: "Comptabilité",
      marketing: "Marketing",
      general: "Général",
    },
    emailSubject: (m) => `Votre relevé de travail de ${m}`,
    emailBody: ({ client, month, link }) =>
      [
        `Voici ce que vos agents ont fait pour ${client} en ${month}. Le PDF est joint.`,
        "La facture du mois arrive dans un autre e-mail, de Stripe.",
        link ? `Vous pouvez aussi le voir dans Mezonas : ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  "pt-BR": {
    title: "Resumo de trabalho",
    soFar: "Este mês até agora",
    monthLabel: "Mês",
    show: "Mostrar",
    invoice: (n) => `Com a fatura ${n}`,
    totals: "No total",
    byArea: "Por área",
    byAgent: "Por agente",
    agent: "Agente",
    area: "Área",
    runs: "Execuções",
    none: "Nenhum trabalho este mês.",
    pdf: "Baixar PDF",
    counters: {
      itemsProcessed: "Itens processados",
      autoPosted: "Lançados automaticamente",
      sentForApproval: "Enviados para aprovação",
      exceptionsCaught: "Exceções detectadas",
      dollarsIdentified: "Valores identificados",
    },
    areas: {
      purchasing: "Compras",
      sales: "Vendas",
      receivables: "Recebíveis",
      bookkeeping: "Contabilidade",
      marketing: "Marketing",
      general: "Geral",
    },
    emailSubject: (m) => `Seu resumo de trabalho de ${m}`,
    emailBody: ({ client, month, link }) =>
      [
        `Veja o que seus agentes fizeram para ${client} em ${month}. O PDF está anexo.`,
        "A fatura do mês chega em outro e-mail, da Stripe.",
        link ? `Você também pode vê-lo no Mezonas: ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  it: {
    title: "Riepilogo del lavoro",
    soFar: "Questo mese finora",
    monthLabel: "Mese",
    show: "Mostra",
    invoice: (n) => `Con la fattura ${n}`,
    totals: "In totale",
    byArea: "Per area",
    byAgent: "Per agente",
    agent: "Agente",
    area: "Area",
    runs: "Esecuzioni",
    none: "Nessun lavoro questo mese.",
    pdf: "Scarica PDF",
    counters: {
      itemsProcessed: "Elementi elaborati",
      autoPosted: "Registrati automaticamente",
      sentForApproval: "Inviati per approvazione",
      exceptionsCaught: "Eccezioni rilevate",
      dollarsIdentified: "Importi individuati",
    },
    areas: {
      purchasing: "Acquisti",
      sales: "Vendite",
      receivables: "Crediti",
      bookkeeping: "Contabilità",
      marketing: "Marketing",
      general: "Generale",
    },
    emailSubject: (m) => `Il riepilogo del lavoro di ${m}`,
    emailBody: ({ client, month, link }) =>
      [
        `Ecco cosa hanno fatto i vostri agenti per ${client} a ${month}. Il PDF è allegato.`,
        "La fattura del mese arriva in un'altra email, da Stripe.",
        link ? `Potete vederlo anche in Mezonas: ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  de: {
    title: "Leistungsnachweis",
    soFar: "Dieser Monat bisher",
    monthLabel: "Monat",
    show: "Anzeigen",
    invoice: (n) => `Zur Rechnung ${n}`,
    totals: "Insgesamt",
    byArea: "Nach Bereich",
    byAgent: "Nach Agent",
    agent: "Agent",
    area: "Bereich",
    runs: "Durchläufe",
    none: "Diesen Monat keine Arbeit.",
    pdf: "PDF herunterladen",
    counters: {
      itemsProcessed: "Bearbeitete Vorgänge",
      autoPosted: "Automatisch gebucht",
      sentForApproval: "Zur Freigabe gesendet",
      exceptionsCaught: "Erkannte Ausnahmen",
      dollarsIdentified: "Ermittelte Beträge",
    },
    areas: {
      purchasing: "Einkauf",
      sales: "Vertrieb",
      receivables: "Forderungen",
      bookkeeping: "Buchhaltung",
      marketing: "Marketing",
      general: "Allgemein",
    },
    emailSubject: (m) => `Ihr Leistungsnachweis für ${m}`,
    emailBody: ({ client, month, link }) =>
      [
        `Das haben Ihre Agenten im ${month} für ${client} erledigt. Das PDF ist angehängt.`,
        "Die Rechnung für den Monat kommt in einer eigenen E-Mail von Stripe.",
        link ? `Sie finden ihn auch in Mezonas: ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
};

/** "October 2026" in the reader's language, from `2026-10`. */
export function workMonthName(month: string, locale: Locale): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Amounts as the reader writes money ("$1,250.00, €40.00"), or a zero when there are none. */
export function workAmountsText(amounts: readonly WorkAmount[], locale: Locale): string {
  if (amounts.length === 0) return new Intl.NumberFormat(locale).format(0);
  return amounts.map((a) => formatKpi(a.total, "money", locale, a.currency) ?? a.total).join(", ");
}

/** Each counter's name and value in the reader's language, in the statement's order. */
export function workCountLines(
  counts: WorkCounts,
  locale: Locale,
): { id: WorkCounterId; label: string; value: string }[] {
  const w = WORK_STATEMENT_WORDS[locale];
  const num = new Intl.NumberFormat(locale);
  return WORK_COUNTER_IDS.map((id) => ({
    id,
    label: w.counters[id],
    value:
      id === "dollarsIdentified"
        ? workAmountsText(counts.dollarsIdentified, locale)
        : num.format(counts[id]),
  }));
}
