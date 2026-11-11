// v0.13 W2-I: the executor's OversightPort over packages/agents' `overseeStep` and the database
// (ARCHITECTURE §10.11; docs/plan.md §1.54). The run's own client agent reviews the step, on the
// run's own client's data only (invariant 1); the executor applies what it decided.

import { dbOversightStore, overseeStep, type RuntimeDeps } from "@countersign/agents";
import type { OversightSettings } from "@countersign/core";
import type { Db } from "@countersign/db";
import type { OversightPort, RunInfo } from "@countersign/workflows";

export function oversightPort(
  runtime: RuntimeDeps,
  db: Db,
  run: RunInfo,
  settings: OversightSettings | undefined,
): OversightPort {
  const store = dbOversightStore(db);
  return {
    review: (req) =>
      overseeStep(runtime, store, {
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
