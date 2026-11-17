// The run reconciler (docs/plan.md §1.2 "Starting runs"): a run's row is written before its
// RunWorkflow instance starts, and the start can fail after the row commits (the engine is
// unreachable, the Worker is stopped); an instance can also end without finishing its run (its
// load or finish step out of retries, a terminate in the engine). Either way the run would show as
// running for ever and an approval signed for it would go nowhere. Every few minutes the cron
// looks at each client's live runs still going and asks the engine about each: a run with no
// instance is started (the id is the run id, so a second start answers `exists`); a run whose
// instance has ended is marked failed with the reason and reported once.

import {
  type Db,
  externalAction,
  inboxItem,
  run,
  stepRun,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import type { RunRequest } from "@countersign/workflows";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { reportHandled, reportProblem } from "../observability/report";
import { queueFinishedRun } from "../run-audit/store";
import type { RunInstances, RunParams } from "./instances";

/** The reconciler runs every this many minutes… */
export const RECONCILE_EVERY_MINUTES = 5;
/** …at this minute of each period (apart from the capture restart's minute 2 of 10). */
export const RECONCILE_MINUTE = 4;
/** A run younger than this is left alone: its start may still be on its way. */
export const RECONCILE_AFTER_MS = 5 * 60_000;
/** At most this many runs per client per pass, so a pass stays short. */
export const RECONCILE_PER_CLIENT = 10;

const OPEN = ["queued", "running", "waiting"] as const;
const OPEN_STEP = ["pending", "running", "waiting"] as const;
/** Instance states after which the run will never record its own end. */
const ENDED = new Set(["errored", "terminated", "complete"]);

export interface ReconcileDeps {
  db: Db;
  instances: RunInstances;
}

export interface Reconciled {
  /** Runs whose instance was missing and was started. */
  started: number;
  /** Runs whose instance had ended without finishing them, now failed. */
  failed: number;
}

/** A run's start parameters, from its row: what the API or the dispatcher started it with. */
export function paramsOfRow(r: typeof run.$inferSelect): RunParams {
  const { payload, ...trigger } = (r.trigger ?? {}) as Record<string, unknown>;
  return {
    runId: r.id,
    tenantId: r.tenantId,
    agentId: r.agentId,
    agentVersionId: r.agentVersionId,
    workflowSlug: r.workflowSlug,
    mode: r.mode,
    trigger: trigger as unknown as RunRequest["trigger"],
    payload: payload ?? {},
    ...(r.retryOf ? { retryOf: r.retryOf, resumeFrom: r.resumeFrom ?? null } : {}),
  };
}

/**
 * Marks a run failed that will never record its own end, in the caller's transaction: its open
 * steps fail, its open inbox items expire (nobody can sign for a run that is over), its proposed
 * writes are rejected, `run.failed` is emitted and it is queued for audit, as a finished run is.
 * Only a run still open changes; returns whether it did.
 */
export async function failOpenRun(
  tx: Tx,
  r: Pick<
    typeof run.$inferSelect,
    "id" | "tenantId" | "agentId" | "agentVersionId" | "workflowSlug" | "mode"
  >,
  error: { reason: string; code: string },
): Promise<boolean> {
  const now = new Date();
  const [updated] = await tx
    .update(run)
    .set({
      status: "failed",
      finishedAt: now,
      error: { reason: error.reason, code: error.code, key: `run:${error.code}`, nodeId: null },
    })
    .where(and(eq(run.id, r.id), eq(run.tenantId, r.tenantId), inArray(run.status, [...OPEN])))
    .returning({ id: run.id });
  if (!updated) return false;
  await tx
    .update(stepRun)
    .set({ status: "failed", finishedAt: now })
    .where(
      and(
        eq(stepRun.runId, r.id),
        eq(stepRun.tenantId, r.tenantId),
        inArray(stepRun.status, [...OPEN_STEP]),
      ),
    );
  await tx
    .update(inboxItem)
    .set({ status: "expired" })
    .where(
      and(
        eq(inboxItem.runId, r.id),
        eq(inboxItem.tenantId, r.tenantId),
        eq(inboxItem.status, "open"),
      ),
    );
  await tx
    .update(externalAction)
    .set({ status: "rejected", error: { code: "run_failed", message: error.reason } })
    .where(
      and(
        eq(externalAction.runId, r.id),
        eq(externalAction.tenantId, r.tenantId),
        eq(externalAction.status, "proposed"),
      ),
    );
  await queueFinishedRun(tx, r);
  await emit(
    tx,
    {
      tenantId: r.tenantId,
      type: "run.failed",
      subjectType: "run",
      subjectId: r.id,
      payload: {
        runId: r.id,
        agentId: r.agentId,
        agentVersionId: r.agentVersionId,
        workflowSlug: r.workflowSlug,
        stepId: null,
        error: error.reason.slice(0, 1000),
      },
    },
    { testRun: r.mode === "test" },
  );
  return true;
}

/**
 * One client's pass: up to RECONCILE_PER_CLIENT of its live runs still going and older than
 * RECONCILE_AFTER_MS, each checked with the engine.
 */
// DECISION: live runs only. A test run may have no instance by design (the test bench and an
// agent's ask run inline), and starting one late would run it twice; a test run whose start fails
// in the API is failed there (`startAfterCommit`).
// DECISION: a run with no instance is started whatever its agent's state now: it was accepted
// while the agent was running, and a pause lets running runs finish (lifecycle/pause.ts).
// DECISION: the runs checked are a random sample when a client has more than the bound, so a
// client with many runs waiting on people has each checked within a few passes; no column records
// when a run was last checked.
export async function reconcileClientRuns(
  deps: ReconcileDeps,
  tenantId: string,
  at: Date,
): Promise<Reconciled> {
  const out: Reconciled = { started: 0, failed: 0 };
  const inspect = deps.instances.inspect?.bind(deps.instances);
  if (!inspect) return out;
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select()
      .from(run)
      .where(
        and(
          eq(run.tenantId, tenantId),
          eq(run.mode, "live"),
          inArray(run.status, [...OPEN]),
          lt(run.createdAt, new Date(at.getTime() - RECONCILE_AFTER_MS)),
        ),
      )
      .orderBy(sql`random()`)
      .limit(RECONCILE_PER_CLIENT),
  );
  for (const r of rows) {
    const tags = { job: "reconcile", client: tenantId, run: r.id };
    try {
      const state = await inspect(r.id);
      if (state === null) {
        if ((await deps.instances.start(paramsOfRow(r))) === "started") {
          out.started++;
          reportProblem("a run that never started was started by the reconciler", tags);
        }
        continue;
      }
      if (!ENDED.has(state.status)) continue;
      const why = state.error ? `: ${state.error}` : "";
      const failed = await withTenant(deps.db, tenantId, (tx) =>
        failOpenRun(tx, r, {
          reason: `the run stopped before it finished (its instance is ${state.status})${why}`,
          code: "instance_ended",
        }),
      );
      if (failed) {
        out.failed++;
        reportProblem("a run's instance ended without finishing the run", {
          ...tags,
          instance: state.status,
        });
      }
    } catch (error) {
      reportHandled(`reconciling run ${r.id} failed`, error, tags);
    }
  }
  return out;
}

/** The cron's call: every RECONCILE_EVERY_MINUTES minutes, each client in its own scope. */
export async function reconcileRuns(deps: ReconcileDeps, at: Date): Promise<Reconciled> {
  const out: Reconciled = { started: 0, failed: 0 };
  if (at.getUTCMinutes() % RECONCILE_EVERY_MINUTES !== RECONCILE_MINUTE) return out;
  const clients = await deps.db
    .select({ id: tenant.id })
    .from(tenant)
    .where(isNull(tenant.retiredAt));
  for (const client of clients) {
    try {
      const done = await reconcileClientRuns(deps, client.id, at);
      out.started += done.started;
      out.failed += done.failed;
    } catch (error) {
      reportHandled(`reconciling runs for client ${client.id} failed`, error, {
        job: "reconcile",
        client: client.id,
      });
    }
  }
  return out;
}

/**
 * Starts a run whose row the request just committed (`afterCommit`). A start that fails is
 * reported; the person still gets the run's id.
 */
// DECISION: the API answers success when the row has committed and the instance won't start: a
// live run is started by the reconciler within minutes (the row is the promise), so a second click
// can't make a second run, and a retry whose start failed is started rather than left as a dead
// end. A test run is failed at once with the reason (the reconciler leaves test runs alone), so the
// operator sees it and runs it again.
export async function startAfterCommit(deps: ReconcileDeps, params: RunParams): Promise<void> {
  try {
    await deps.instances.start(params);
  } catch (error) {
    const tags = { kind: "after_commit", client: params.tenantId, run: params.runId };
    if (params.mode === "live") {
      reportHandled(`starting run ${params.runId} failed; the reconciler starts it`, error, tags);
      return;
    }
    reportHandled(`starting test run ${params.runId} failed`, error, tags);
    await withTenant(deps.db, params.tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(run)
        .where(and(eq(run.id, params.runId), eq(run.tenantId, params.tenantId)));
      if (r) {
        await failOpenRun(tx, r, {
          reason: "the test run could not be started; run it again",
          code: "not_started",
        });
      }
    });
  }
}
