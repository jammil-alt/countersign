// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library and the client's settings"): where each
// of the Library's banks lives, in the order the Library shows them, and the words for each.
import type { LibraryBank } from "@countersign/core";
import { OPS_PATHS } from "../paths";

export const LIBRARY_PATHS = {
  index: OPS_PATHS.library,
  processes: "/ops/library/processes",
  skills: OPS_PATHS.skills,
  tools: "/ops/library/tools",
  connectors: OPS_PATHS.connectors,
  browserSites: OPS_PATHS.browserSites,
  triggers: "/ops/library/triggers",
  recordTypes: "/ops/library/record-types",
  conditions: "/ops/library/conditions",
} as const;

export interface BankInfo {
  bank: LibraryBank;
  title: string;
  /** One line: what the bank holds. */
  line: string;
  to: string;
  /** Other addresses the bank's tab owns (browser sites are connectors too). */
  also?: readonly string[];
}

export const BANKS: readonly BankInfo[] = [
  {
    bank: "processes",
    title: "Processes",
    line: "Triggers, then steps top to bottom. Templates a client's agent is forked from, and processes used inside others.",
    to: LIBRARY_PATHS.processes,
  },
  {
    bank: "skills",
    title: "Skills",
    line: "Data in, data out, by rules, by AI, or rules then AI. A skill may read; it never writes.",
    to: LIBRARY_PATHS.skills,
  },
  {
    bank: "tools",
    title: "Tools",
    line: "One fixed action that reads or writes, by connector, with how each write is undone.",
    to: LIBRARY_PATHS.tools,
  },
  {
    bank: "connectors",
    title: "Connectors",
    line: "A client's account in one system: its tools and its events. A website is one too.",
    to: LIBRARY_PATHS.connectors,
    also: [LIBRARY_PATHS.browserSites],
  },
  {
    bank: "triggers",
    title: "Triggers",
    line: "What starts a process: six kinds, and the events a trigger can wait for.",
    to: LIBRARY_PATHS.triggers,
  },
  {
    bank: "record_types",
    title: "Record types",
    line: "The records tools touch: bills, invoices, contacts. Access is set per record type.",
    to: LIBRARY_PATHS.recordTypes,
  },
  {
    bank: "conditions",
    title: "Condition sets",
    line: "Plain rules a check or an if step tests, and every process that uses them.",
    to: LIBRARY_PATHS.conditions,
  },
];

/** Lowercase search over a row's words; an empty query matches everything. */
export function matches(query: string, ...texts: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

/** "1 process", "3 processes": a count with its noun. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
