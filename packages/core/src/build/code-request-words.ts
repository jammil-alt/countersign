// The Dev queue's words for the screens (docs/plan.md §1.125), apart from the schemas so they
// load with the back office, not in the app's first load (scripts/web-size.mjs).

import type { StepCodeRequest } from "../api/step-code-request";
import type {
  CloseReason,
  CodeRequestDecision,
  CodeRequestKind,
  CodeRequestStatus,
} from "./code-requests";

export const CODE_REQUEST_KIND_WORDS: Record<CodeRequestKind, string> = {
  extend_existing: "Extend a part",
  new_tool: "New tool",
  new_skill_code: "New skill code",
  config_only: "Config only",
};

export const CODE_REQUEST_STATUS_WORDS: Record<CodeRequestStatus, string> = {
  triage: "Triage",
  accepted: "Accepted",
  in_progress: "In progress",
  shipped: "Shipped",
  closed: "Closed",
};

export const DECISION_WORDS: Record<CodeRequestDecision, string> = {
  exists: "It exists",
  config: "Configure what exists",
  extend: "Extend a part",
  new_general: "New, general part",
  one_off: "One-off",
};

export const CLOSE_REASON_WORDS: Record<CloseReason, string> = {
  exists: "It exists",
  config: "Configuration does it",
  merged: "Merged into another request",
  not_worth_it: "Not worth it",
  not_possible: "Not possible: the provider's API doesn't allow it",
  superseded: "Superseded",
};

/** "Requires code · DQ-012 · In review": a step's status from its request. */
export function stepCodeStatus(r: StepCodeRequest["request"]): string {
  const words: Record<StepCodeRequest["request"]["status"], string> = {
    triage: "Triage",
    accepted: "Accepted",
    in_progress: "In progress",
    shipped: "Shipped",
    closed: "Closed",
  };
  return `Requires code · ${r.ref} · ${r.inReview ? "In review" : words[r.status]}`;
}
