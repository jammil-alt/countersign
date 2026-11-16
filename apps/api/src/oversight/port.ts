// v0.13 W2-I: the executor's OversightPort over packages/agents' `overseeStep` and the database
// (ARCHITECTURE §10.11; docs/plan.md §1.54). The run's own client agent reviews the step, on the
// run's own client's data only (invariant 1); the executor applies what it decided.

import {
  choosePath,
  dbOversightStore,
  judgePass,
  overseeStep,
  type RuntimeDeps,
} from "@countersign/agents";
import {
  AREA_OWNER_WORDS,
  type OversightSettings,
  OWNER_MEMORY_IN_REVIEW,
  type OwnerArea,
} from "@countersign/core";
import { type Db, withTenant } from "@countersign/db";
import type { ChoicePort, OversightPort, RunInfo } from "@countersign/workflows";
import { ownerMemory } from "../owners/store";

/** The area owner a run pinned (ARCHITECTURE v0.19 §10.15). */
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
        // v0.19: the area owner, with its memory read now (inside the review's durable step).
        ...(owner
          ? {
              owner: {
                ownerId: owner.ownerId,
                name: owner.name,
                area: AREA_OWNER_WORDS.en.functionOf[owner.area],
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

/**
 * M61 (ARCHITECTURE v0.17 §10.14; docs/plan.md §1.99): the executor's ChoicePort, the run's own
 * agent choosing an `if`'s path or judging a repeat's pass, on its owner's model and within the
 * owner's per-run budget, on its own client's data only (invariant 1).
 */
export function choicePort(
  runtime: RuntimeDeps,
  db: Db,
  run: RunInfo,
  settings: OversightSettings | undefined,
): ChoicePort {
  const store = dbOversightStore(db);
  const who = {
    id: run.id,
    tenantId: run.tenantId,
    agentId: run.agentId,
    agentVersionId: run.agentVersionId,
    language: run.language,
  };
  return {
    choose: (req) =>
      choosePath(runtime, store, {
        run: who,
        nodeId: req.nodeId,
        stepRunId: req.stepRunId,
        stepId: req.stepId,
        stepName: req.stepName,
        paths: req.paths,
        data: req.data,
        settings,
      }),
    judge: (req) =>
      judgePass(runtime, store, {
        run: who,
        nodeId: req.nodeId,
        stepRunId: req.stepRunId,
        stepId: req.stepId,
        stepName: req.stepName,
        pass: req.pass,
        maxTimes: req.maxTimes,
        goal: req.goal,
        data: req.data,
        settings,
      }),
  };
}
