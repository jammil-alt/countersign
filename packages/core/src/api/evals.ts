import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { TestCaseView } from "./testbench";

// docs/plan.md §1.212 (round 4, plan 2): the eval harness in the back office. Saving an approved
// or corrected change from the inbox as a test case (the client's: it runs and shows in that
// client only, invariant 1), and the scorecard per template workflow and version: the golden
// datasets' (replayed in CI) and the suite runs'. Operators only (invariant 11).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const SaveCaseFromInboxBody = z.strictObject({
  /** The case's name; absent: from the item's title. */
  name: z.string().trim().min(1).max(200).optional(),
});

/** One dataset's golden scorecard, as CI measured it on replay (no run time: replay has none). */
export const GoldenScorecardRow = z.object({
  template: z.string(),
  workflow: z.string(),
  cases: z.number().int(),
  passed: z.number().int(),
  exactRate: z.number(),
  verifierAgreement: z.number().nullable(),
  costPerCase: z.string(),
});
export type GoldenScorecardRow = z.infer<typeof GoldenScorecardRow>;

/** A workflow of a template version, from its latest finished suite run in a scope. */
export const ScorecardRow = z.object({
  templateId: z.string(),
  templateName: z.string(),
  templateSlug: z.string(),
  versionId: z.string(),
  version: z.number().int().nullable(),
  workflow: z.string(),
  /** The suite run's client (its cases are that client's); null: shared cases. */
  clientName: z.string().nullable(),
  suiteRunId: z.string(),
  finishedAt: z.string().nullable(),
  cases: z.number().int(),
  passed: z.number().int(),
  /** Cases with expected writes that matched exactly / cases with expected writes; null: none. */
  exactRate: z.number().nullable(),
  writeCases: z.number().int(),
  verifierAgreement: z.number().nullable(),
  costPerCase: z.string(),
  msMedian: z.number().nullable(),
});
export type ScorecardRow = z.infer<typeof ScorecardRow>;

export const evalsRoutes = {
  opsSaveCaseFromInbox: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/save-as-case",
    auth: "session",
    roles: OPS,
    summary:
      "Save an approved or corrected change as a test case of the template its agent came from: the run's trigger, and the change as the write it expects (the client's case)",
    params: z.object({ id: Id }),
    body: SaveCaseFromInboxBody,
    response: z.object({ case: TestCaseView, created: z.boolean() }),
  }),
  opsScorecard: defineRoute({
    method: "GET",
    path: "/api/ops/evals/scorecard",
    auth: "session",
    roles: OPS,
    summary:
      "The scorecard per template workflow and version: exact match on writes, the verifier's agreement, cost and run time, from the golden datasets and the suite runs",
    query: z.object({ template: Id.optional() }),
    response: z.object({
      golden: z.array(GoldenScorecardRow),
      rows: z.array(ScorecardRow),
    }),
  }),
} as const;
