// The run reconciler (docs/plan.md §1.2 "Starting runs"): a run's row is written before its
// RunWorkflow instance starts, and the start can fail after the row commits (the engine is
// unreachable, the Worker is stopped); an instance can also end without finishing its run (its
// load or finish step out of retries, a terminate in the engine). Either way the run would show as
// running for ever and an approval signed for it would go nowhere. Every 10 minutes the cron
// looks at each client's live runs still going and asks the engine about each: a recent run with
// no instance, whose agent still runs, is started (the id is the run id, so a second start answers
// `exists`); any other run with no instance, and a run whose instance has ended, is marked failed
// with the reason and reported once.

import { closeRunApprovalsTx } from "@countersign/agents";
import { isPlainObject } from "@countersign/core";
import {
  activeClient,
  agent,
  type Db,
  reachOut,
  run,
  stepRun,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import type { RunRange, RunRequest } from "@countersign/workflows";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { postCouldNotAnswer } from "../account/could-not-answer";
import { reportHandled, reportProblem } from "../observability/report";
import { queueFinishedRun } from "../run-audit/store";
import type { RunInstances, RunParams } from "./instances";

/** The reconciler runs every this many minutes… */
export const RECONCILE_EVERY_MINUTES = 10;
/**
 * …at this minute of each period: 8, 18, …, 58, a minute no other periodic pass uses (QuickBooks
 * 4/19/34/49, Ramp and Zoho 9/24/39/54, notifications every 5, capture 2/12/…, usage 7, search 11,
 * health 12, the hourly sweeps 23, bank feeds 26).
 */
export const RECONCILE_MINUTE = 8;
/** A run younger than this is left alone: its start may still be on its way. */
export const RECONCILE_AFTER_MS = 5 * 60_000;
/**
 * A run with no instance is started late only this soon after it was created; an older one is
 * failed (`not_started`), since running it from its first step now could repeat work a person has
 * done since, and the engine can't tell a run that never started from one whose instance it has
 * since removed.
 */
export const START_LATE_WITHIN_MS = 60 * 60_000;
/**
 * A run older than this is failed quietly: its status and error are set, but no `run.failed` is
 * emitted (hand-offs and watches would react to something long over); one report per pass counts
 * them.
 */
export const QUIET_AFTER_MS = 24 * 60 * 60_000;
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
  /** Runs that will never finish on their own (no instance, or it ended), now failed. */
  failed: number;
  /** Of `failed`, those failed quietly (older than QUIET_AFTER_MS). */
  quiet: number;
}

/** A run's start parameters, from its row: what the API or the dispatcher started it with. */
export function paramsOfRow(r: typeof run.$inferSelect): RunParams {
  const { payload, range, ...trigger } = (r.trigger ?? {}) as Record<string, unknown>;
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
    // A test of some of the steps (docs/plan.md §1.185), kept with the trigger.
    ...(isPlainObject(range) ? { range: range as RunRange } : {}),
  };
}

/**
 * Ends a run's reach-outs still open or awaiting approval (outcome `no_reply`), so nobody is
 * reminded or chased for a run that is over; its run won't wait for them (`run_received_at`).
 */
export async function closeRunReachOuts(
  tx: Tx,
  r: { id: string; tenantId: string },
  reason: string,
): Promise<void> {
  const now = new Date();
  await tx
    .update(reachOut)
    .set({
      status: "ended",
      outcome: "no_reply",
      reason,
      nextAttemptAt: null,
      endedAt: now,
      runReceivedAt: now,
    })
    .where(
      and(
        eq(reachOut.runId, r.id),
        eq(reachOut.tenantId, r.tenantId),
        ne(reachOut.status, "ended"),
      ),
    );
}

/**
 * Marks a run failed that will never record its own end, in the caller's transaction: its open
 * steps fail, its open inbox items expire (nobody can sign for a run that is over), its open
 * reach-outs end, its proposed writes are rejected, `run.failed` is emitted (not when `quiet`) and
 * it is queued for audit, as a finished run is. Only a run still open changes; returns whether it
 * did.
 */
export async function failOpenRun(
  tx: Tx,
  r: Pick<
    typeof run.$inferSelect,
    "id" | "tenantId" | "agentId" | "agentVersionId" | "workflowSlug" | "mode"
  >,
  error: { reason: string; code: string },
  options: { quiet?: boolean } = {},
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
  // Audit 3.3: the same close as every run's end, of every open item here.
  await closeRunApprovalsTx(
    tx,
    r.tenantId,
    r.id,
    { code: "run_failed", message: error.reason },
    { items: "all" },
  );
  await closeRunReachOuts(tx, r, "the run ended");
  await queueFinishedRun(tx, r);
  if (options.quiet) return true;
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
  // S2.1: a lost Sloan run tells the person it couldn't answer (dispatched by the cron sweep).
  await postCouldNotAnswer(tx, r);
  return true;
}

/**
 * One client's pass: up to RECONCILE_PER_CLIENT of its live runs still going and older than
 * RECONCILE_AFTER_MS, each checked with the engine; runs with no step yet (never started, most
 * likely) first.
 */
// DECISION: live runs only. A test run may have no instance by design (the test bench and an
// agent's ask run inline), and starting one late would run it twice; a test run whose start fails
// in the API is failed there (`startAfterCommit`).
// DECISION: a run with no instance is started only within START_LATE_WITHIN_MS of its creation and
// only while its agent is active; otherwise it is failed (`not_started`) and a person runs it again
// if it is still wanted.
// DECISION: beyond the runs with no step, the runs checked are a random sample when a client has
// more than the bound, so a client with many runs waiting on people has each checked within a few
// passes; no column records when a run was last checked.
export async function reconcileClientRuns(
  deps: ReconcileDeps,
  tenantId: string,
  at: Date,
): Promise<Reconciled> {
  const out: Reconciled = { started: 0, failed: 0, quiet: 0 };
  const inspect = deps.instances.inspect?.bind(deps.instances);
  if (!inspect) return out;
  const hasStep = sql`exists (select 1 from step_run s where s.run_id = "run"."id" and s.tenant_id = "run"."tenant_id")`;
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({ r: run, agentRunStatus: agent.runStatus })
      .from(run)
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
      .where(
        and(
          eq(run.tenantId, tenantId),
          eq(run.mode, "live"),
          inArray(run.status, [...OPEN]),
          lt(run.createdAt, new Date(at.getTime() - RECONCILE_AFTER_MS)),
        ),
      )
      .orderBy(hasStep, sql`random()`)
      .limit(RECONCILE_PER_CLIENT),
  );
  for (const { r, agentRunStatus } of rows) {
    const tags = { job: "reconcile", client: tenantId, run: r.id };
    try {
      // Throws when the engine can't say (only "no such instance" is null): nothing is decided.
      const state = await inspect(r.id);
      let failure: { reason: string; code: string };
      if (state === null) {
        const recent = r.createdAt.getTime() > at.getTime() - START_LATE_WITHIN_MS;
        if (recent && agentRunStatus === "active") {
          if ((await deps.instances.start(paramsOfRow(r))) === "started") {
            out.started++;
            reportProblem("a run that never started was started by the reconciler", tags);
          }
          continue;
        }
        failure = {
          code: "not_started",
          reason: recent
            ? "the run never started, and its agent is no longer running"
            : "the run never started, and it is too late to start it now",
        };
      } else if (ENDED.has(state.status)) {
        const why = state.error ? `: ${state.error}` : "";
        failure = {
          code: "instance_ended",
          reason: `the run stopped before it finished (its instance is ${state.status})${why}`,
        };
      } else {
        continue;
      }
      const quiet = r.createdAt.getTime() < at.getTime() - QUIET_AFTER_MS;
      const failed = await withTenant(deps.db, tenantId, (tx) =>
        failOpenRun(tx, r, failure, { quiet }),
      );
      if (!failed) continue;
      out.failed++;
      if (quiet) out.quiet++;
      else {
        reportProblem("a run that will never finish on its own was failed", {
          ...tags,
          code: failure.code,
          ...(state ? { instance: state.status } : {}),
        });
      }
    } catch (error) {
      reportHandled(`reconciling run ${r.id} failed`, error, tags);
    }
  }
  return out;
}

/** The cron's call: every RECONCILE_EVERY_MINUTES minutes, each client in its own scope. */
// DECISION: runs older than QUIET_AFTER_MS are failed quietly and counted in one report per pass:
// on the first deploy, every run left open by an old failed start would otherwise emit
// `run.failed` at once, days after the fact, for hand-offs and watches to react to.
export async function reconcileRuns(deps: ReconcileDeps, at: Date): Promise<Reconciled> {
  const out: Reconciled = { started: 0, failed: 0, quiet: 0 };
  if (at.getUTCMinutes() % RECONCILE_EVERY_MINUTES !== RECONCILE_MINUTE) return out;
  const clients = await deps.db.select({ id: tenant.id }).from(tenant).where(activeClient());
  for (const client of clients) {
    try {
      const done = await reconcileClientRuns(deps, client.id, at);
      out.started += done.started;
      out.failed += done.failed;
      out.quiet += done.quiet;
    } catch (error) {
      reportHandled(`reconciling runs for client ${client.id} failed`, error, {
        job: "reconcile",
        client: client.id,
      });
    }
  }
  if (out.quiet > 0) {
    reportProblem("runs that never finished, over a day old, were failed without an event", {
      job: "reconcile",
      count: String(out.quiet),
    });
  }
  return out;
}

/**
 * Starts a run whose row the request just committed (`afterCommit`). A start that fails is
 * reported; the person still gets the run's id.
 */
// DECISION: the API answers success when the row has committed and the instance won't start: a
// live run is started by the reconciler within about 15 minutes (the row is the promise), so a second click
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
