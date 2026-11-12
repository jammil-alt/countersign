// v0.13 W2-I: the executor's OversightPort over packages/agents' `overseeStep` and the database
// (ARCHITECTURE §10.11; docs/plan.md §1.54). The run's own client agent reviews the step, on the
// run's own client's data only (invariant 1); the executor applies what it decided.

import { dbOversightStore, overseeStep, type RuntimeDeps } from "@countersign/agents";
import {
  type OversightSettings,
  OWNER_MEMORY_IN_REVIEW,
  OWNER_WORDS,
  type OwnerArea,
} from "@countersign/core";
import { type Db, withTenant } from "@countersign/db";
import type { OversightPort, RunInfo } from "@countersign/workflows";
import { ownerMemory } from "../owners/store";

/** v0.17: the area owner a run pinned (ARCHITECTURE §10.15). */
export interface RunAreaOwner {
  ownerId: string;
  versionId: string;
  name: string;
  area: OwnerArea;
  notes: string;
}

export function oversightPort(
  runtime: RuntimeDeps,
  db: Db,
  run: RunInfo,
  settings: OversightSettings | undefined,
  owner?: RunAreaOwner,
): OversightPort {
  const store = dbOversightStore(db);
  return {
    review: async (req) =>
      overseeStep(runtime, store, {
        // v0.17: the area owner, with its memory read now (inside the review's durable step).
        ...(owner
          ? {
              owner: {
                ownerId: owner.ownerId,
                name: owner.name,
                area: OWNER_WORDS.en.functionOf[owner.area],
                notes: owner.notes,
                memory: await withTenant(db, run.tenantId, (tx) =>
                  ownerMemory(tx, run.tenantId, owner.ownerId, OWNER_MEMORY_IN_REVIEW),
                ),
              },
            }
          : {}),
        tenantId: run.tenantId,
        runId: run.id,
        agentId: run.agentId,
        agentVersionId: run.agentVersionId,
        workflowSlug: run.workflowSlug,
        mode: run.mode,
        language: run.language,
        step: req.step,
        nodeId: req.nodeId,
        stepRunId: req.stepRunId,
        seq: req.seq,
        cause: req.cause,
        input: req.input,
        error: req.error,
        errorKey: req.errorKey,
        attempts: req.attempts,
        // v0.13 M32: a checkpoint's output.
        ...(req.output === undefined ? {} : { output: req.output }),
        automation: req.automation,
        // R6: the cheap watch's signals that asked for this review, as data.
        ...(req.signals?.length ? { signals: req.signals } : {}),
        settings,
      }),
  };
}
