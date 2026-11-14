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
    line: "A job from start to finish: what starts it, then its steps in order. A client's agent is a copy of one.",
    to: LIBRARY_PATHS.processes,
  },
  {
    bank: "skills",
    title: "Skills",
    line: "How an agent works something out, by rules or with AI. A skill decides; it never changes anything.",
    to: LIBRARY_PATHS.skills,
  },
  {
    bank: "tools",
    title: "Tools",
    line: "One action in a system: look something up, or make a change. A change waits for approval by default.",
    to: LIBRARY_PATHS.tools,
  },
  {
    bank: "connectors",
    title: "Connectors",
    line: "A system an agent works in, such as QuickBooks or Gmail, and the tools it brings. A website login is one too.",
    to: LIBRARY_PATHS.connectors,
    also: [LIBRARY_PATHS.browserSites],
  },
  {
    bank: "triggers",
    title: "Triggers",
    line: "What starts a process: a schedule, a message, a person, or something happening in a system.",
    to: LIBRARY_PATHS.triggers,
  },
  {
    bank: "record_types",
    title: "Record types",
    line: "The kinds of record tools touch, such as bills or contacts. Access is set for each one.",
    to: LIBRARY_PATHS.recordTypes,
  },
  {
    bank: "conditions",
    title: "Condition sets",
    line: 'Plain rules a step checks before it goes on, such as "the total is over a limit".',
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
