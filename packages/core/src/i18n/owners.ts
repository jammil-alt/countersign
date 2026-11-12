// v0.17 (ARCHITECTURE §10.15 "Signature", docs/plan.md §1.96): how an owner signs a message that
// goes outside the client, in the client's language. Platform words: the operator can't remove
// them. Names (the owner's, the client's) are filled in as they are.
//
// The lines other than English are drafts for the owner's fluent speakers to review.

import type { OwnerArea } from "../owners/areas";
import type { Locale } from "./locale";

export interface OwnerWords {
  /** The area's function, lower case, as it reads in "Pia, purchasing agent for Acme". */
  functionOf: Record<OwnerArea, string>;
  /** "Pia, purchasing agent for Acme Supply". */
  signature(name: string, fn: string, client: string): string;
  /** Under the signature. */
  poweredBy: string;
  /** v0.17: who is answering in a chat: "purchasing agent". */
  role(fn: string): string;
  /** Sloan's role in a chat. */
  assistant: string;
  /** Under the name, so nobody takes an agent for a person. */
  agentNote: string;
}

const POWERED = "mezonas.com";

export const OWNER_WORDS: Record<Locale, OwnerWords> = {
  en: {
    functionOf: {
      purchasing: "purchasing",
      sales: "sales",
      receivables: "receivables",
      bookkeeping: "bookkeeping",
      marketing: "marketing",
      general: "operations",
    },
    signature: (n, f, c) => `${n}, ${f} agent for ${c}`,
    poweredBy: `Powered by ${POWERED}`,
    role: (f) => `${f} agent`,
    assistant: "account assistant",
    agentNote: "A Mezonas agent",
  },
  es: {
    functionOf: {
      purchasing: "compras",
      sales: "ventas",
      receivables: "cobros",
      bookkeeping: "contabilidad",
      marketing: "marketing",
      general: "operaciones",
    },
    signature: (n, f, c) => `${n}, agente de ${f} de ${c}`,
    poweredBy: `Con la tecnología de ${POWERED}`,
    role: (f) => `agente de ${f}`,
    assistant: "asistente de la cuenta",
    agentNote: "Un agente de Mezonas",
  },
  fr: {
    functionOf: {
      purchasing: "achats",
      sales: "ventes",
      receivables: "recouvrement",
      bookkeeping: "comptabilité",
      marketing: "marketing",
      general: "opérations",
    },
    signature: (n, f, c) => `${n}, agent ${f} pour ${c}`,
    poweredBy: `Propulsé par ${POWERED}`,
    role: (f) => `agent ${f}`,
    assistant: "assistant du compte",
    agentNote: "Un agent Mezonas",
  },
  "pt-BR": {
    functionOf: {
      purchasing: "compras",
      sales: "vendas",
      receivables: "cobrança",
      bookkeeping: "contabilidade",
      marketing: "marketing",
      general: "operações",
    },
    signature: (n, f, c) => `${n}, agente de ${f} da ${c}`,
    poweredBy: `Com tecnologia ${POWERED}`,
    role: (f) => `agente de ${f}`,
    assistant: "assistente da conta",
    agentNote: "Um agente da Mezonas",
  },
  it: {
    functionOf: {
      purchasing: "acquisti",
      sales: "vendite",
      receivables: "incassi",
      bookkeeping: "contabilità",
      marketing: "marketing",
      general: "operazioni",
    },
    signature: (n, f, c) => `${n}, agente ${f} per ${c}`,
    poweredBy: `Con tecnologia ${POWERED}`,
    role: (f) => `agente ${f}`,
    assistant: "assistente dell'account",
    agentNote: "Un agente Mezonas",
  },
  de: {
    functionOf: {
      purchasing: "Einkauf",
      sales: "Vertrieb",
      receivables: "Forderungen",
      bookkeeping: "Buchhaltung",
      marketing: "Marketing",
      general: "Betrieb",
    },
    signature: (n, f, c) => `${n}, Agent für ${f} bei ${c}`,
    poweredBy: `Bereitgestellt von ${POWERED}`,
    role: (f) => `Agent für ${f}`,
    assistant: "Kontoassistent",
    agentNote: "Ein Mezonas-Agent",
  },
};

/** Channels a signed message goes out on. */
export type SignedChannel = "email" | "sms" | "whatsapp" | "voice" | "other";

/**
 * The lines under a message an owner's agent sends outside the client. Email carries both; a text
 * or WhatsApp message carries "Powered by" only on a conversation's first message, for length.
 */
export function ownerSignature(input: {
  name: string;
  area: OwnerArea;
  client: string;
  locale: Locale;
  channel: SignedChannel;
  /** The first message of this conversation with this person. */
  first: boolean;
}): { signature: string; poweredBy: string | null } {
  const w = OWNER_WORDS[input.locale];
  const short = input.channel === "sms" || input.channel === "whatsapp";
  return {
    signature: w.signature(input.name, w.functionOf[input.area], input.client),
    poweredBy: short && !input.first ? null : w.poweredBy,
  };
}

/**
 * A decision's timeline line with the owner's name: "Pia corrected the vendor name and tried
 * again". English joins the name to the line; the other languages, whose lines don't all read
 * after a name, put the name first with a colon (drafts for the fluent speakers to review).
 */
export function ownerDid(locale: Locale, name: string, line: string): string {
  if (locale === "en") return `${name} ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  return `${name}: ${line}`;
}

/** v0.17: an owner's role in a chat, in the client's language ("purchasing agent"). */
export function ownerRole(locale: Locale, area: OwnerArea): string {
  const w = OWNER_WORDS[locale];
  return w.role(w.functionOf[area]);
}
