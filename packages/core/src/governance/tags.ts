// Governance's light parts (docs/builder-plan.md §8): the tiers, the tags and their words, and the
// charter's limits. The back office and the portal use these; the guardrails' and policies' text
// (./guardrails.ts, ./policies.ts) and the charter's drafting prompt (./charter.ts) are the Worker's.
// DECISION (staging CI, 2026-11-19): kept apart so the web app's first load doesn't carry that text.

import { z } from "zod";
import { OWNER_AREAS } from "../owners/areas";

/** The guardrails' version (./guardrails.ts); "How Mezonas agents work" follows it. */
export const GUARDRAILS_VERSION = "2026-11-19.1";

/** What a policy covers. A client's policies use the same tags, plus the business areas. */
export const GOVERNANCE_TOPICS = [
  "security",
  "writing-into-tools",
  "money",
  "contacting-people",
  "data-handling",
  "people-and-roles",
] as const;
export type GovernanceTopic = (typeof GOVERNANCE_TOPICS)[number];

export const GOVERNANCE_TAGS = [...GOVERNANCE_TOPICS, ...OWNER_AREAS] as const;
export const GovernanceTag = z.enum(GOVERNANCE_TAGS);
export type GovernanceTag = z.infer<typeof GovernanceTag>;

/** Words for each tag, for the back office and the portal. */
export const GOVERNANCE_TAG_LABELS: Record<GovernanceTag, string> = {
  security: "Security",
  "writing-into-tools": "Writing into tools",
  money: "Money",
  "contacting-people": "Contacting people",
  "data-handling": "Data handling",
  "people-and-roles": "People and roles",
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Receivables",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
  general: "General",
};

export const GOVERNANCE_TIERS = ["charter", "policy"] as const;
export const GovernanceTier = z.enum(GOVERNANCE_TIERS);
export type GovernanceTier = z.infer<typeof GovernanceTier>;

/** The tags a client's policy may carry: the standard topics and the business areas. */
export const KnowledgeTags = z
  .array(GovernanceTag)
  .max(GovernanceTag.options.length)
  .transform((tags) => [...new Set(tags)].sort());

export const CHARTER_TITLE = "Our charter";

/** How long each part of a drafted charter may be: it is read on every model call. */
export const CHARTER_LINE_MAX = 300;
export const CHARTER_LIST_MAX = 6;
