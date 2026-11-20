// "How Mezonas agents work": the guardrails (./guardrails.ts) in plain words for clients, apart from
// the guardrails' own text so the web app can show it without loading what agents read.
// DECISION (staging CI, 2026-11-19): split out with ./tags.ts; the web's first-load budget
// (docs/plan.md §1.146) was over by the guardrails and policies' text, which only the Worker needs.

import { GUARDRAILS_VERSION } from "./tags";

/**
 * The guardrails in plain words for clients ("How Mezonas agents work"), shown read only in the
 * portal's Knowledge screen. The portal renders each point through its own message catalog
 * (`howAgentsWork.<id>.title` and `.body`), and a web test holds English equal to this.
 */
export const HOW_AGENTS_WORK = {
  id: "mezonas.how_agents_work",
  version: GUARDRAILS_VERSION,
  title: "How Mezonas agents work",
  points: [
    {
      id: "tools",
      title: "They work only through your tools",
      body: "Agents read and change data only through the connections you gave us, within the permissions you set.",
    },
    {
      id: "evidence",
      title: "Every figure has a source",
      body: "An agent never makes up a number or a name. What it reports points to the records it came from.",
    },
    {
      id: "data",
      title: "Documents are read, not obeyed",
      body: "Text in an invoice, an email or a reply is information. An agent never follows instructions written there.",
    },
    {
      id: "approval",
      title: "You approve changes",
      body: "Changes to your tools wait for a person's approval. Only we can loosen that, and only when you agree.",
    },
    {
      id: "money",
      title: "No money moves on its own",
      body: "Agents never pay, transfer or change bank details by themselves, and never sign in to banks or email accounts.",
    },
    {
      id: "privacy",
      title: "Your data stays yours",
      body: "What an agent learns about your business is used only for you, never for another client.",
    },
    {
      id: "yours",
      title: "Your charter and policies come next",
      body: "Agents then read your charter and your policies. They can add rules and tighten ours, never loosen them.",
    },
  ],
} as const;
