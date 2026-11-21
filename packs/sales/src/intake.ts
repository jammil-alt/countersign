// The Sales area's questions for a client's intake (docs/cases-plan.md §4.2 step 2; docs/plan.md
// §1.149.2, §1.164): data in the manifest, asked on the Sales card of Getting started. Plain words;
// never a secret: the client connects its CRM itself.

import type { GuideSectionSourceInput } from "@countersign/core";

// DECISION: five questions, as the other areas' cards: the CRM and what is kept in it, the
// spreadsheets that come in and how often, who looks after the records, the fields that are the
// client's own, and what goes wrong. The CRM's sign-in is a Connect card of the template's.
export const SALES_INTAKE_SECTION = {
  kind: "area",
  area: "sales",
  title: "Sales",
  intro: "How your leads and deals are kept today.",
  fields: [
    {
      key: "sales.crm",
      label: "Which CRM do you keep your leads and deals in?",
      kind: "text",
      hint: "For example Zoho CRM.",
      fileSection: "systems",
      requiredToStart: true,
    },
    {
      key: "sales.sheets",
      label: "Which spreadsheets should update it, and where do they come from?",
      kind: "long_text",
      hint: "For example a weekly export from a trade show app, sent by email.",
      fileSection: "processes",
    },
    {
      key: "sales.who",
      label: "Who keeps the CRM's records up to date today?",
      kind: "text",
      fileSection: "people",
    },
    {
      key: "sales.volume",
      label: "About how many rows does a spreadsheet have?",
      kind: "number",
      fileSection: "volumes",
    },
    {
      key: "sales.wrong",
      label: "What takes the most time, or goes wrong? For example duplicate leads.",
      kind: "long_text",
      fileSection: "pains",
    },
  ],
} as const satisfies GuideSectionSourceInput;
