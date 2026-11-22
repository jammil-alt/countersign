import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// SOC 2 readiness (docs/plan.md §1.218): the facts the readiness checklist needs from the database,
// and the quarterly access review's record. Operator only. Served beside the registry
// (`allRoutes`), so their schemas load with the readiness screen, not in the app's first load.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const ACCESS_REVIEW_NOTE_MAX = 2000;
export const ACCESS_REVIEW_ITEM_NOTE_MAX = 500;

export const AccessReviewSummary = z.object({
  id: z.string(),
  period: z.string(),
  createdAt: z.string(),
  reviewerEmail: z.string(),
  clients: z.number().int(),
  people: z.number().int(),
  removals: z.number().int(),
});

export const Soc2FactsView = z.object({
  now: z.string(),
  accessReviews: z.array(AccessReviewSummary),
  deletionDrill: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      tables: z.number().int(),
      rows: z.number().int(),
      failed: z.string().nullable(),
    })
    .nullable(),
});

export const AccessReviewItemView = z.object({
  client: z.object({ id: z.string(), name: z.string().nullable() }),
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  lastSignInAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  decision: z.enum(["keep", "remove"]),
  note: z.string(),
});
export type AccessReviewItemView = z.infer<typeof AccessReviewItemView>;

export const AccessReviewView = AccessReviewSummary.extend({
  note: z.string(),
  /** Only the clients this operator serves (row-level security). */
  items: z.array(AccessReviewItemView),
});
export type AccessReviewView = z.infer<typeof AccessReviewView>;

export const RecordAccessReview = z
  .object({
    note: z.string().trim().max(ACCESS_REVIEW_NOTE_MAX).default(""),
    /**
     * The people whose access to a client should go. Everyone else the review finds is kept. The
     * people themselves are read on the server at the time of recording, never taken from here.
     */
    remove: z
      .array(
        z
          .object({
            clientId: Id,
            userId: Id,
            note: z.string().trim().max(ACCESS_REVIEW_ITEM_NOTE_MAX).default(""),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();

export const soc2Routes = {
  opsSoc2Facts: defineRoute({
    method: "GET",
    path: "/api/ops/security/soc2",
    auth: "session",
    roles: OPS,
    summary:
      "What the SOC 2 readiness checklist needs from the database: the recent access reviews and the last deletion drill",
    response: Soc2FactsView,
  }),
  opsAccessReviewRecord: defineRoute({
    method: "GET",
    path: "/api/ops/access-reviews/:id",
    auth: "session",
    roles: OPS,
    summary: "One recorded access review, with the people it found in the clients served",
    params: z.object({ id: Id }),
    response: AccessReviewView,
  }),
  opsAccessReviewCreate: defineRoute({
    method: "POST",
    path: "/api/ops/access-reviews",
    auth: "session",
    roles: OPS,
    summary:
      "Record this quarter's access review: every person in the clients served as they are now, and who should lose access",
    body: RecordAccessReview,
    response: AccessReviewView,
  }),
};
