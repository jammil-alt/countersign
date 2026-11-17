// The Purchasing area's questions for a client's intake (docs/cases-plan.md §4.2 step 2; docs/plan.md
// §1.126.2): data in the manifest, asked on the Purchasing card of Getting started. Plain words;
// never a secret. "Who approves" is the general card's question too, so it is asked once.

import type { GuideSectionSourceInput } from "@countersign/core";

export const PURCHASING_INTAKE_SECTION = {
  kind: "area",
  area: "purchasing",
  title: "Purchasing",
  intro: "How you buy materials and pay for them today.",
  fields: [
    {
      key: "purchasing.bills_to",
      label: "Where do vendors send their bills today?",
      kind: "text",
      hint: "An email address, the mail or a supplier portal.",
      fileSection: "processes",
      requiredToStart: true,
    },
    {
      key: "purchasing.bills",
      label: "About how many bills do you get in a month?",
      kind: "number",
      fileSection: "volumes",
    },
    {
      key: "purchasing.vendors",
      label: "About how many vendors do you buy from?",
      kind: "number",
      fileSection: "volumes",
    },
    {
      key: "purchasing.approver",
      shareKey: "general.approver",
      label: "Who approves a purchase or a bill?",
      kind: "text",
      fileSection: "people",
      requiredToStart: true,
    },
    {
      key: "purchasing.wrong",
      label: "What goes wrong today? For example, prices creeping up unnoticed.",
      kind: "long_text",
      fileSection: "pains",
    },
  ],
} as const satisfies GuideSectionSourceInput;
