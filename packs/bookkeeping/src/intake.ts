// The Bookkeeping area's questions for a client's intake (docs/cases-plan.md §4.2 step 2; docs/plan.md
// §1.149.2): data in the manifest, asked on the Bookkeeping card of Getting started. Plain words;
// never a secret: accounts are named, never numbered, and the client connects the bank itself.

import type { GuideSectionSourceInput } from "@countersign/core";

export const BOOKKEEPING_INTAKE_SECTION = {
  kind: "area",
  area: "bookkeeping",
  title: "Bookkeeping",
  intro: "How your books are kept today.",
  fields: [
    {
      key: "bookkeeping.accounts",
      label: "Which bank accounts and cards should we keep the books for?",
      kind: "long_text",
      hint: "Their names are enough, for example Chase checking.",
      fileSection: "systems",
      requiredToStart: true,
    },
    {
      key: "bookkeeping.who",
      label: "Who keeps the books today?",
      kind: "text",
      fileSection: "people",
    },
    {
      key: "bookkeeping.volume",
      label: "About how many bank and card transactions are there in a month?",
      kind: "number",
      fileSection: "volumes",
    },
    {
      key: "bookkeeping.behind",
      label: "How up to date are the books?",
      kind: "choice",
      choices: ["Up to date", "A month or two behind", "More than that"],
      fileSection: "processes",
    },
    {
      key: "bookkeeping.wrong",
      label: "What takes the most time, or goes wrong?",
      kind: "long_text",
      fileSection: "pains",
    },
  ],
} as const satisfies GuideSectionSourceInput;
