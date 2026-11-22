// Round 4 D (docs/plan.md §1.211; ARCHITECTURE §10.18): the evidence on a proposed write, and the
// client's dollar thresholds. The evidence is read from the rows the write already left; the
// portal's copy carries no model, prompt, cost or agent version (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { WriteEvidence, WriteThreshold, WriteThresholdSet } from "../oversight/verify";
import { defineRoute } from "./contract";

const IdParams = z.object({ id: z.string().refine((v) => isUuid(v), "not an id") });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** The back office's evidence: the portal's, with the agent version that proposed the write. */
export const OpsWriteEvidence = WriteEvidence.extend({
  agentVersionId: z.string().nullable(),
});
export type OpsWriteEvidence = z.infer<typeof OpsWriteEvidence>;

export const ThresholdsView = WriteThresholdSet.extend({
  /** Whether the person may also raise or remove one (only the client's admin). */
  mayLoosen: z.boolean(),
});
export type ThresholdsView = z.infer<typeof ThresholdsView>;

export const ThresholdsBody = z.object({
  thresholds: z.array(WriteThreshold).max(10),
  /** The revision the editor read: a save over a newer one answers 409. */
  revision: z.number().int().min(0),
});

export const evidenceRoutes = {
  portalInboxEvidence: defineRoute({
    method: "GET",
    path: "/api/inbox/:id/evidence",
    auth: "session",
    roles: CLIENT,
    summary: "What a proposed change rests on: its sources, the step, the values and the check",
    params: IdParams,
    response: z.object({ evidence: WriteEvidence }),
  }),
  opsInboxEvidence: defineRoute({
    method: "GET",
    path: "/api/ops/inbox/:id/evidence",
    auth: "session",
    roles: OPS,
    summary: "What a proposed change rests on, with the agent version that proposed it",
    params: IdParams,
    response: z.object({ evidence: OpsWriteEvidence }),
  }),
  portalWriteThresholds: defineRoute({
    method: "GET",
    path: "/api/settings/write-thresholds",
    auth: "session",
    roles: CLIENT,
    summary: "The amounts from which every change waits for a person",
    response: ThresholdsView,
  }),
  portalSaveWriteThresholds: defineRoute({
    method: "PUT",
    path: "/api/settings/write-thresholds",
    auth: "session",
    roles: ["client_admin"] as const,
    summary: "Set the amounts from which every change waits for a person",
    body: ThresholdsBody,
    response: ThresholdsView,
  }),
  opsWriteThresholds: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/write-thresholds",
    auth: "session",
    roles: OPS,
    summary: "A client's amounts from which every change waits for a person",
    params: IdParams,
    response: ThresholdsView,
  }),
  opsSaveWriteThresholds: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/write-thresholds",
    auth: "session",
    roles: OPS,
    summary: "Lower or add a client's thresholds (we never raise or remove one)",
    params: IdParams,
    body: ThresholdsBody,
    response: ThresholdsView,
  }),
} as const;
