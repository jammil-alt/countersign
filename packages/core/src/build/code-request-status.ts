// A Dev queue request's statuses (docs/plan.md §1.125), on their own: a build's view names them
// ("Requires code · DQ-012 · In progress") and is in the web app's first load, which must not carry
// the rest of the Dev queue's schemas.

import { z } from "zod";

export const CODE_REQUEST_STATUSES = [
  "triage",
  "accepted",
  "in_progress",
  "shipped",
  "closed",
] as const;
export const CodeRequestStatus = z.enum(CODE_REQUEST_STATUSES);
export type CodeRequestStatus = z.infer<typeof CodeRequestStatus>;
