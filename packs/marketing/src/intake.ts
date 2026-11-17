// The Marketing area's questions for a client's intake (docs/cases-plan.md §4.2 step 2; docs/plan.md
// §1.126.2): data in the manifest, asked on the Marketing card of Getting started. Plain words.

import type { GuideSectionSourceInput } from "@countersign/core";

export const MARKETING_INTAKE_SECTION = {
  kind: "area",
  area: "marketing",
  title: "Marketing",
  intro: "How people find you today.",
  fields: [
    {
      key: "marketing.sites",
      label: "Which websites do you have?",
      kind: "text",
      hint: "Their addresses, for example acme.com.",
      fileSection: "systems",
      requiredToStart: true,
    },
    {
      key: "marketing.who",
      label: "Who looks after marketing today?",
      kind: "text",
      fileSection: "people",
    },
    {
      key: "marketing.channels",
      label: "Where do you post or write today?",
      kind: "text",
      hint: "For example LinkedIn, a newsletter, forums.",
      fileSection: "systems",
    },
    {
      key: "marketing.want",
      label: "What would you like more of: visits, calls, sign-ups?",
      kind: "long_text",
      fileSection: "business",
    },
    {
      key: "marketing.first",
      label: "What would you hand off first?",
      kind: "long_text",
      fileSection: "pains",
    },
  ],
} as const satisfies GuideSectionSourceInput;
