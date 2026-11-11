// Reshape data (owner, 2026-11-11; ARCHITECTURE §10.14 "Reshape data"): the builder's two questions
// about a Reshape step, back office only (invariant 11). "Propose a mapping" answers the
// deterministic proposal by name and type, then the Builder AI's checked suggestions for what is
// left; "sample" answers what each field would hold, from the latest test or live run's stored step
// outputs when there is one, else from samples built from the schemas.

import { z } from "zod";
import { ReshapeMapping } from "../process/reshape";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

/** How a field's mapping was found: by name, kept, the Builder AI's, or by hand (absent). */
export const RESHAPE_MATCHES = ["exact", "name", "synonym", "kept", "ai"] as const;
export const ReshapeMatchView = z.enum(RESHAPE_MATCHES);

export const ReshapeProposalView = z.object({
  stepId: z.string(),
  /** The step after it, whose input the fields are; null when there is none that takes input. */
  next: z.object({ stepId: z.string(), name: z.string() }).nullable(),
  /** What the step can read: each source's input key, its name and the template that brings it in. */
  sources: z.array(z.object({ key: z.string(), label: z.string(), template: z.string() })),
  /** The step's input: the sources its mapping reads. */
  input: z.record(z.string(), z.string()),
  mapping: ReshapeMapping,
  /** By field: how its mapping was found. */
  how: z.record(z.string(), ReshapeMatchView),
  /** Fields still unmapped (`lines.account` for a mapped list's item field). */
  unmapped: z.array(z.string()),
  /** The Builder AI, asked once for what was left (never during a client's run). */
  ai: z.object({
    asked: z.boolean(),
    /** Fields it filled, each checked against the expression schema and typed. */
    fields: z.array(z.string()),
    /** What it said that was dropped, and why: those stay unmapped. */
    dropped: z.array(z.object({ field: z.string(), reason: z.string() })),
    why: z.record(z.string(), z.string()),
    /** What the call cost (the operator's, never a client's). */
    costUsd: z.string().nullable(),
  }),
});
export type ReshapeProposalView = z.infer<typeof ReshapeProposalView>;

export const ReshapeSampleView = z.object({
  /** `run`: a run's stored step outputs; `schema`: values built from the schemas. */
  source: z.enum(["run", "schema"]),
  run: z.object({ id: z.string(), mode: z.enum(["test", "live"]), at: z.string() }).nullable(),
  /** The step's input as that run (or the sample) would give it. */
  input: z.unknown(),
  fields: z.array(
    z.object({ name: z.string(), value: z.unknown(), problem: z.string().nullable() }),
  ),
});
export type ReshapeSampleView = z.infer<typeof ReshapeSampleView>;

const StepBody = {
  /** The process being edited (a v4 process; the builder's draft, unsaved). */
  process: z.unknown(),
  /** The Reshape data step. */
  stepId: z.string().min(1).max(64),
};

export const reshapeRoutes = {
  opsReshapePropose: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/reshape/propose",
    auth: "session",
    roles: OPS,
    summary: "Propose a Reshape step's mapping: by name and type, then the Builder AI for the rest",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      ...StepBody,
      /** Keep each field whose mapping still type-checks ("Propose an updated mapping"). */
      update: z.boolean().optional(),
      /** Ask the Builder AI for what is left (default true). */
      ai: z.boolean().optional(),
    }),
    response: ReshapeProposalView,
  }),
  opsReshapeSample: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/reshape/sample",
    auth: "session",
    roles: OPS,
    summary: "What each field of a Reshape step would hold, from the latest run or a sample",
    params: z.object({ id: ApiId }),
    body: z.strictObject(StepBody),
    response: ReshapeSampleView,
  }),
};
