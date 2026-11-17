// A build's step that requires code, with its Dev queue request's status now (docs/plan.md
// §1.125). Its own module: a build's view carries it, and the build is in the web app's first load.

import { z } from "zod";
import { CodeRequestStatus } from "../build/code-request-status";

/** A step that requires code (docs/plan.md §1.125), and its request as the Dev queue has it now. */
export const StepCodeRequest = z.object({
  buildId: z.string(),
  workflowId: z.string().nullable(),
  stepId: z.string().nullable(),
  request: z.object({
    id: z.string(),
    ref: z.string(),
    title: z.string(),
    status: CodeRequestStatus,
    inReview: z.boolean(),
    shippedStagingAt: z.string().nullable(),
  }),
});
export type StepCodeRequest = z.infer<typeof StepCodeRequest>;
