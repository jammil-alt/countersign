// v0.12 W2-C: running a suite (ARCHITECTURE §9.10, docs/plan.md §1.46). One durable step per case,
// then one that totals the run. Every read and write is in the suite's scope: a client's suite in
// that client only (withTenant), a shared suite in an operator transaction naming no client, and
// every query filters by the suite's tenant as well (invariant 1). Results are only inserted; the
// suite run's counts, metrics and status are written once, at the end.
//
// A skill case runs the skill's version through the agents runtime with fixtures only (no
// connector, nothing written). A template case is a test run of the template's test copy in the
// Sandbox client (or the case's own client), run here to the end: test runs never write to a
// client's tool (invariant 8).

import {
  type AgentRow,
  requiredConnectors,
  runSkillCase,
  skillContext,
  snapshotSharedSkills,
  templateTestCopy,
  updateOperational,
} from "@countersign/agents";
import {
  type AgentBundle,
  type CaseOutcome,
  Fixtures,
  labelOutcome,
  type MatchDiff,
  Matcher,
  matchOutput,
  type SkillDefinition,
  suiteTotals,
  TemplateCaseInput,
  type TestResultStatus,
  type TestTargetKind,
} from "@countersign/core";
import {
  connection,
  type Db,
  run,
  stepRun,
  type Tx,
  testCase,
  testCaseResult,
  testSuiteRun,
  withOperator,
  withTenant,
} from "@countersign/db";
import { requestRun, type StepRunner, WaitTimeoutError } from "@countersign/workflows";
import { and, asc, type Column, eq, isNull } from "drizzle-orm";
import { createRunRow } from "../runs/dispatch";
import { executeRun, forClient, type RunDeps } from "../runs/execute";

/** What a TestSuiteWorkflow instance is given (plain JSON); the instance id is the suite run's. */
export interface SuiteParams {
  suiteRunId: string;
  /** The suite's client; null for a shared suite (shared cases only). */
  tenantId: string | null;
  targetKind: TestTargetKind;
  targetId: string;
  /** The skill version or template version under test. */
  versionId: string;
  /** The cases, in the order they run. */
  caseIds: string[];
  /** Skills: the definition at `versionId`, read when the suite started. */
  skill?: SkillDefinition;
  /** Templates: where the test copy runs (the Sandbox for a shared suite, else the client). */
  runTenantId?: string;
  actorId: string | null;
}

/** The part of a StepRunner a suite uses. */
export interface SuiteRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** A shared suite in an operator transaction naming no client; a client's in that client. */
export function inSuiteScope<T>(
  db: Db,
  tenantId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tenantId ? withTenant(db, tenantId, fn) : withOperator(db, [], fn);
}

const tenantIs = (column: Column, tenantId: string | null) =>
  tenantId ? eq(column, tenantId) : isNull(column);

/**
 * Runs a workflow to its end in one go, for a template case: every step at once, no retries.
 * DECISION: on the bench nothing waits. A wait for a person or an event times out at once and the
 * workflow goes on as it would after a timeout; a `wait` step's sleep is skipped. A test run never
 * writes, so nothing is lost; a case that needs a person's answer shows that step as timed out.
 */
export function benchRunner(): StepRunner {
  return {
    do: (_name, fn) => fn(),
    waitForEvent: async (name, options) => {
      throw new WaitTimeoutError(name, options.type);
    },
    sleep: async () => undefined,
  };
}

interface CaseRow {
  id: string;
  tenantId: string | null;
  input: unknown;
  fixtures: unknown;
  expected: unknown;
  matcher: unknown;
}

interface Scored {
  status: TestResultStatus;
  got: unknown;
  diff: unknown;
  costUsd: string;
  runId: string | null;
  label: CaseOutcome["label"];
}

function scored(c: CaseRow, got: unknown, extra: Record<string, unknown>, costUsd: string) {
  const matcher = Matcher.parse(c.matcher);
  const match = matchOutput(matcher, c.expected, got);
  return {
    status: match.pass ? ("pass" as const) : ("fail" as const),
    got,
    diff: { fields: match.diff as MatchDiff[], ...extra },
    costUsd,
    label: labelOutcome(matcher, c.expected, got),
  };
}

const failed = (error: string, extra: Record<string, unknown> = {}, costUsd = "0"): Scored => ({
  status: "error",
  got: null,
  diff: { fields: [], error: error.slice(0, 2000), ...extra },
  costUsd,
  runId: null,
  label: null,
});

async function runSkill(deps: RunDeps, params: SuiteParams, c: CaseRow): Promise<Scored> {
  if (!params.skill) return failed("the suite has no skill definition");
  // A client's case is held to the client's HIPAA mode like its runs (docs/plan.md §1.35).
  const transport = (c.tenantId ? forClient(deps, c.tenantId) : deps).transport;
  const result = await runSkillCase(
    { tools: deps.platform.tools, transport, ...(deps.now ? { now: deps.now } : {}) },
    {
      definition: params.skill,
      tenantId: c.tenantId,
      input: c.input,
      fixtures: Fixtures.parse(c.fixtures),
    },
  );
  const calls = result.toolCalls;
  if (result.status !== "succeeded") {
    return failed(result.error ?? "the skill failed", { calls }, result.costUsd);
  }
  return { ...scored(c, result.output, { calls }, result.costUsd), runId: null };
}

/** Binds the test copy's unbound required connectors to its client's connection for each. */
// DECISION: as a template test run from the back office does (routes/ops-agents.ts), so a case's
// test run reads the Sandbox's (or its client's) tools; bindings the operator set are kept.
async function bindCopy(
  tx: Tx,
  deps: RunDeps,
  copy: AgentRow,
  bundle: AgentBundle,
  actorId: string | null,
): Promise<AgentRow> {
  const tenantId = copy.tenantId as string;
  const { skills } = await skillContext(tx, { tenantId, bundle, catalog: deps.platform.catalog });
  const needed = requiredConnectors(bundle, skills, deps.platform.tools).filter(
    (c) => !copy.bindings[c],
  );
  if (needed.length === 0) return copy;
  const rows = await tx
    .select({ id: connection.id, connector: connection.connector })
    .from(connection)
    .where(eq(connection.tenantId, tenantId))
    .orderBy(connection.createdAt);
  const add: Record<string, string> = {};
  for (const r of rows) if (needed.includes(r.connector)) add[r.connector] ??= r.id;
  if (Object.keys(add).length === 0) return copy;
  return updateOperational(tx, {
    agentId: copy.id,
    actorId,
    patch: { bindings: { ...copy.bindings, ...add } },
  });
}

async function runTemplate(deps: RunDeps, params: SuiteParams, c: CaseRow): Promise<Scored> {
  const input = TemplateCaseInput.safeParse(c.input);
  if (!input.success) return failed("a template case's input is {workflow, payload}");
  const runTenant = params.runTenantId;
  if (!runTenant) return failed("the suite has no client to run the template in");
  // The test copy and its run row: in an operator scope naming only the client it runs in.
  const req = await withOperator(deps.db, [runTenant], async (tx) => {
    const target = await templateTestCopy(tx, {
      tenantId: runTenant,
      templateVersionId: params.versionId,
      actorId: params.actorId,
    });
    const copy = target.agent.testCopy
      ? await bindCopy(tx, deps, target.agent, target.version.bundle, params.actorId)
      : target.agent;
    await snapshotSharedSkills(tx, {
      tenantId: runTenant,
      bundle: target.version.bundle,
      catalog: deps.platform.catalog,
    });
    const r = requestRun({
      agent: {
        id: copy.id,
        tenantId: copy.tenantId,
        kind: copy.kind,
        status: copy.status,
        runStatus: copy.runStatus,
        liveVersionId: copy.liveVersionId,
        liveBundle: null,
      },
      workflowSlug: input.data.workflow,
      payload: input.data.payload,
      mode: "test",
      versionId: target.version.id,
      bundle: target.version.bundle,
    });
    await createRunRow(tx, r);
    return r;
  });
  // Run to the end here; a test run emits nothing that starts other runs (§10.4).
  const { instances: _none, ...runDeps } = deps;
  const result = await executeRun(runDeps, req, benchRunner());
  const { steps, costUsd } = await withTenant(deps.db, runTenant, async (tx) => {
    const rows = await tx
      .select({ nodeId: stepRun.nodeId, output: stepRun.output, status: stepRun.status })
      .from(stepRun)
      .where(and(eq(stepRun.runId, req.runId), eq(stepRun.tenantId, runTenant)))
      .orderBy(asc(stepRun.id));
    const [r] = await tx
      .select({ costUsd: run.costUsd })
      .from(run)
      .where(and(eq(run.id, req.runId), eq(run.tenantId, runTenant)));
    return { steps: rows, costUsd: r?.costUsd ?? "0" };
  });
  // The named steps' outputs (the last row of each, a retried step's included).
  const expected = (c.expected ?? {}) as Record<string, unknown>;
  const got: Record<string, unknown> = {};
  for (const s of steps) {
    if (Object.hasOwn(expected, s.nodeId)) got[s.nodeId] = s.output ?? null;
  }
  const extra = {
    run: { status: result.status, reason: result.reason ?? null },
    steps: steps.map((s) => ({ id: s.nodeId, status: s.status })),
  };
  // A shared case's run lives in the Sandbox: its result names it, without a foreign key.
  return { ...scored(c, got, extra, String(costUsd)), runId: req.runId };
}

/** One case: run, compare, insert its result. A replayed step finds its result and returns it. */
export async function runCase(
  deps: RunDeps,
  params: SuiteParams,
  caseId: string,
): Promise<CaseOutcome> {
  const { db } = deps;
  const prior = await inSuiteScope(db, params.tenantId, async (tx) => {
    const [r] = await tx
      .select()
      .from(testCaseResult)
      .where(
        and(
          eq(testCaseResult.suiteRunId, params.suiteRunId),
          eq(testCaseResult.testCaseId, caseId),
          tenantIs(testCaseResult.tenantId, params.tenantId),
        ),
      );
    const [c] = await tx
      .select()
      .from(testCase)
      .where(and(eq(testCase.id, caseId), tenantIs(testCase.tenantId, params.tenantId)));
    return { result: r ?? null, case: c ?? null };
  });
  if (prior.result) {
    const matcher = prior.case ? Matcher.safeParse(prior.case.matcher) : null;
    return {
      status: prior.result.status,
      costUsd: String(prior.result.costUsd),
      label:
        prior.result.status !== "error" && prior.case && matcher?.success
          ? labelOutcome(matcher.data, prior.case.expected, prior.result.got)
          : null,
    };
  }
  let outcome: Scored;
  if (!prior.case) {
    outcome = failed("the case is no longer in this suite's scope");
  } else {
    try {
      outcome =
        params.targetKind === "skill"
          ? await runSkill(deps, params, prior.case)
          : await runTemplate(deps, params, prior.case);
    } catch (error) {
      outcome = failed(error instanceof Error ? error.message : String(error));
    }
  }
  await inSuiteScope(db, params.tenantId, async (tx) => {
    await tx
      .insert(testCaseResult)
      .values({
        tenantId: params.tenantId,
        suiteRunId: params.suiteRunId,
        testCaseId: caseId,
        status: outcome.status,
        got: outcome.got ?? null,
        diff: outcome.diff ?? null,
        costUsd: outcome.costUsd,
        runId: outcome.runId,
      })
      .onConflictDoNothing();
  });
  return { status: outcome.status, costUsd: outcome.costUsd, label: outcome.label };
}

/** Writes the suite run's totals, metrics and cost, once. */
export async function finishSuite(
  db: Db,
  params: SuiteParams,
  outcomes: readonly CaseOutcome[],
  status: "done" | "failed" = "done",
): Promise<void> {
  const totals = suiteTotals(outcomes);
  await inSuiteScope(db, params.tenantId, async (tx) => {
    await tx
      .update(testSuiteRun)
      .set({
        status,
        total: Math.max(totals.total, params.caseIds.length),
        passed: totals.passed,
        failed: totals.failed,
        metrics: { ...totals.metrics },
        costUsd: totals.costUsd,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(testSuiteRun.id, params.suiteRunId),
          params.tenantId
            ? eq(testSuiteRun.tenantId, params.tenantId)
            : isNull(testSuiteRun.tenantId),
          eq(testSuiteRun.status, "running"),
        ),
      );
  });
}

/** The whole suite: each case in its own step, then the totals. */
export async function executeSuite(
  deps: RunDeps,
  params: SuiteParams,
  runner: SuiteRunner,
): Promise<{ total: number; passed: number }> {
  const outcomes: CaseOutcome[] = [];
  try {
    for (const caseId of params.caseIds) {
      outcomes.push(await runner.do(`case:${caseId}`, () => runCase(deps, params, caseId)));
    }
  } catch (error) {
    await runner.do("finish", () => finishSuite(deps.db, params, outcomes, "failed"));
    throw error;
  }
  await runner.do("finish", () => finishSuite(deps.db, params, outcomes));
  return {
    total: params.caseIds.length,
    passed: outcomes.filter((o) => o.status === "pass").length,
  };
}
