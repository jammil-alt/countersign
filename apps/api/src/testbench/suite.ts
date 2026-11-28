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
  AgentsError,
  createVersion,
  dbActionSwitches,
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
  expectedWritesOf,
  Fixtures,
  labelOutcome,
  type MatchDiff,
  Matcher,
  matchOutput,
  parseSkillRef,
  runWrites,
  type SkillDefinition,
  scoreWrites,
  suiteTotals,
  TemplateCaseInput,
  type TestResultStatus,
  type TestTargetKind,
  type Tolerance,
  verificationOfWrites,
  WRITES_KEY,
  WRITES_SCOPE_KEY,
  writeStepTools,
} from "@countersign/core";
import {
  agentVersion,
  buildItem,
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
import { and, asc, type Column, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { connectionsToBind } from "../runs/bind-connections";
import { createRunRow } from "../runs/dispatch";
import { executeRun, forClient, type RunDeps } from "../runs/execute";
import { partialMarks } from "./partial";

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
  /** builder-plan.md B1: a run of some cases (`caseIds` named), kept out of every gate. */
  partial?: boolean;
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
  /** §1.211: whether the verifier agreed with the run's writes (absent: it checked none). */
  verifier?: boolean;
  /** §1.212: a case with expected writes: whether they matched exactly. */
  exact?: boolean;
  ms?: number;
  got: unknown;
  diff: unknown;
  costUsd: string;
  runId: string | null;
  label: CaseOutcome["label"];
}

/** §1.212: a case's tolerances on its writes: `$writes.<step>.<index>.…`, the prefix taken off. */
function writeTolerances(c: CaseRow) {
  const out: Record<string, Tolerance> = {};
  for (const [p, t] of Object.entries(Matcher.parse(c.matcher).tolerances)) {
    if (p.startsWith(`${WRITES_KEY}.`)) out[p.slice(WRITES_KEY.length + 1)] = t;
  }
  return out;
}

function scored(c: CaseRow, got: unknown, extra: Record<string, unknown>, costUsd: string) {
  return scoredOutputs(c, c.expected, got, extra, costUsd);
}

function scoredOutputs(
  c: CaseRow,
  expected: unknown,
  got: unknown,
  extra: Record<string, unknown>,
  costUsd: string,
) {
  const matcher = Matcher.parse(c.matcher);
  // §1.212: tolerances on `$writes` paths are the writes' own (scoreWrites), not the outputs'.
  const outputMatcher = {
    ...matcher,
    tolerances: Object.fromEntries(
      Object.entries(matcher.tolerances).filter(([p]) => !p.startsWith("$")),
    ),
  };
  const match = matchOutput(outputMatcher, expected, got);
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
    {
      tools: deps.platform.tools,
      transport,
      // Web's switches, as a live run reads them.
      actionSwitches: dbActionSwitches(deps.db),
      ...(deps.now ? { now: deps.now } : {}),
    },
    {
      definition: params.skill,
      tenantId: c.tenantId,
      input: c.input,
      fixtures: Fixtures.parse(c.fixtures),
    },
  );
  const calls = result.toolCalls;
  // Step model §8: a Loop's turns are kept with its result, for the turn-by-turn view.
  const trace = result.turns.length > 0 ? { calls, turns: result.turns } : { calls };
  if (result.status !== "succeeded") {
    return failed(result.error ?? "the skill failed", trace, result.costUsd);
  }
  return { ...scored(c, result.output, trace, result.costUsd), runId: null };
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
  const needed = requiredConnectors(bundle, skills, deps.platform.tools);
  const add = await connectionsToBind(tx, {
    tenantId,
    needed,
    bindings: copy.bindings,
    rebind: copy.testCopy === true,
  });
  if (Object.keys(add).length === 0) return copy;
  return updateOperational(tx, {
    agentId: copy.id,
    actorId,
    patch: { bindings: { ...copy.bindings, ...add } },
  });
}

/**
 * A bench wait that timed out: a person, approval or event step's `<kind>:timeout` (a tool's own
 * timeout names the tool, e.g. `gmail.send:timeout`, and is an error like any other).
 */
function benchTimeout(errorKey: string | undefined): boolean {
  return !!errorKey && /^[a-z_]+:timeout$/.test(errorKey);
}

/** Why a case's run stopped, in words, with what to do when it was the client's connection. */
function stoppedWhy(result: { reason?: string; nodeId?: string; errorKey?: string }): string {
  const reason = (result.reason ?? "the run failed").trim().replace(/[.\s]+$/, "");
  const at = result.nodeId ? `The run stopped at "${result.nodeId}": ${reason}.` : `${reason}.`;
  const connection =
    /:unauthorized$|:forbidden$/.test(result.errorKey ?? "") ||
    /\b(401|403)\b|unauthori[sz]ed|expired|disconnected|not connected|no connection|connection is|is bound|sign[- ]?in/i.test(
      reason,
    );
  return connection
    ? `${at} Reconnect the client's connection, then try it again.`
    : `${at} Fix it, then try it again.`;
}

/**
 * §1.212: skill parameters set on a bundle's skill refs (by skill id), as a client agent sets
 * them; the golden datasets and cases saved from a client's run use it.
 */
export function withParameters(parameters: Record<string, Record<string, unknown>>) {
  return (bundle: AgentBundle): AgentBundle =>
    ({
      ...bundle,
      definition: {
        ...bundle.definition,
        skills: bundle.definition.skills.map((ref) => {
          const own = parameters[parseSkillRef(ref.skill).id];
          return own ? { ...ref, parameters: { ...(ref.parameters ?? {}), ...own } } : ref;
        }),
      },
    }) as AgentBundle;
}

/** A template test run's steps, cost and time, as `runTemplateTest` answers them. */
export interface TemplateTestRun {
  runId: string;
  /** The bundle the run ran (the test copy's version). */
  bundle: AgentBundle;
  result: Awaited<ReturnType<typeof executeRun>>;
  steps: { nodeId: string; nodeType: string; input: unknown; output: unknown; status: string }[];
  costUsd: string;
  /** Wall-clock milliseconds of the run itself (docs/plan.md §1.212). */
  ms: number;
}

/**
 * A test run of a template version's workflow in a client, to its end (§1.46 template cases; the
 * evals of §1.212 run their golden cases through it too). The test copy and its run row are made
 * in an operator scope naming only that client.
 */
export async function runTemplateTest(
  deps: RunDeps,
  args: {
    runTenantId: string;
    versionId: string;
    actorId: string | null;
    workflow: string;
    payload: Record<string, unknown>;
    /** §1.212: the bundle as a client agent would set it (a skill's parameters), run as a version of the test copy. */
    adjust?: (bundle: AgentBundle) => AgentBundle;
  },
): Promise<TemplateTestRun> {
  const runTenant = args.runTenantId;
  const { req, ranBundle } = await withOperator(deps.db, [runTenant], async (tx) => {
    const target = await templateTestCopy(tx, {
      tenantId: runTenant,
      templateVersionId: args.versionId,
      actorId: args.actorId,
    });
    const copy = target.agent.testCopy
      ? await bindCopy(tx, deps, target.agent, target.version.bundle, args.actorId)
      : target.agent;
    await snapshotSharedSkills(tx, {
      tenantId: runTenant,
      bundle: target.version.bundle,
      catalog: deps.platform.catalog,
    });
    // §1.212: a golden case's parameters, as the client agent would set them: a version of the
    // test copy of its own (the copy is the case's, in a client of its own).
    const version = args.adjust
      ? await createVersion(tx, {
          agentId: copy.id,
          bundle: args.adjust(target.version.bundle),
          authorType: "operator",
          authorId: args.actorId,
          changeNote: "Test copy with a case's parameters",
          basedOnTemplateVersionId: target.version.basedOnTemplateVersionId ?? args.versionId,
        }).catch(async (error) => {
          // The copy's latest version is already this one (an earlier case with the same values).
          if (!(error instanceof AgentsError) || error.code !== "no_op") throw error;
          const [latest] = await tx
            .select()
            .from(agentVersion)
            .where(and(eq(agentVersion.agentId, copy.id), eq(agentVersion.tenantId, runTenant)))
            .orderBy(desc(agentVersion.version))
            .limit(1);
          if (!latest) throw error;
          return latest as typeof target.version;
        })
      : target.version;
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
      workflowSlug: args.workflow,
      payload: args.payload,
      mode: "test",
      versionId: version.id,
      bundle: version.bundle,
    });
    await createRunRow(tx, r);
    return { req: r, ranBundle: version.bundle as AgentBundle };
  });
  // Run to the end here; a test run emits nothing that starts other runs (§10.4).
  const { instances: _none, ...runDeps } = deps;
  const started = Date.now();
  const result = await executeRun(runDeps, req, benchRunner());
  const ms = Date.now() - started;
  const { steps, costUsd } = await withTenant(deps.db, runTenant, async (tx) => {
    const rows = await tx
      .select({
        nodeId: stepRun.nodeId,
        nodeType: stepRun.nodeType,
        input: stepRun.input,
        output: stepRun.output,
        status: stepRun.status,
      })
      .from(stepRun)
      .where(and(eq(stepRun.runId, req.runId), eq(stepRun.tenantId, runTenant)))
      .orderBy(asc(stepRun.id));
    const [r] = await tx
      .select({ costUsd: run.costUsd })
      .from(run)
      .where(and(eq(run.id, req.runId), eq(run.tenantId, runTenant)));
    return { steps: rows, costUsd: String(r?.costUsd ?? "0") };
  });
  return { runId: req.runId, bundle: ranBundle, result, steps, costUsd, ms };
}

async function runTemplate(deps: RunDeps, params: SuiteParams, c: CaseRow): Promise<Scored> {
  const input = TemplateCaseInput.safeParse(c.input);
  if (!input.success) return failed("a template case's input is {workflow, payload}");
  const runTenant = params.runTenantId;
  if (!runTenant) return failed("the suite has no client to run the template in");
  const ran = await runTemplateTest(deps, {
    runTenantId: runTenant,
    versionId: params.versionId,
    actorId: params.actorId,
    workflow: input.data.workflow,
    payload: input.data.payload,
    ...(input.data.parameters ? { adjust: withParameters(input.data.parameters) } : {}),
  });
  const { result, steps, costUsd } = ran;
  // §1.212: the writes it expects (`$writes`), scored apart from the named steps' outputs.
  const {
    [WRITES_KEY]: _w,
    [WRITES_SCOPE_KEY]: _s,
    ...outputs
  } = (c.expected ?? {}) as Record<string, unknown>;
  const writesExpected = expectedWritesOf(c.expected);
  // The named steps' outputs (the last row of each, a retried step's included).
  const expected = outputs;
  // DECISION (builder-plan.md B1): a case that names no step yet (an example tried on a build)
  // records every step's output: what the agent would do, kept as the answer if it is right.
  const every = Object.keys(expected).length === 0 && !writesExpected;
  const got: Record<string, unknown> = {};
  for (const s of steps) {
    if (every || Object.hasOwn(expected, s.nodeId)) got[s.nodeId] = s.output ?? null;
  }
  const writes = runWrites(steps, (id) => writeStepTools(ran.bundle.workflows).get(id) ?? null);
  const writeScore = writesExpected
    ? scoreWrites(writesExpected.writes, writes, writeTolerances(c), writesExpected.scope)
    : null;
  if (writesExpected)
    got[WRITES_KEY] = writes.map(({ step, tool, input }) => ({ step, tool, input }));
  // §1.211: the verifier's outcome on the run's writes, where the agent verifies them.
  const verification = verificationOfWrites(writes);
  const extra = {
    run: { status: result.status, reason: result.reason ?? null },
    steps: steps.map((s) => ({ id: s.nodeId, status: s.status })),
    ms: ran.ms,
    ...(writeScore ? { writes: writeScore } : {}),
    ...(verification ? { verification, verifier: verification === "agreed" } : {}),
  };
  // INTEG-1: a run that failed on a step's error (the client's tool refused it: a sign-in that
  // expired, a connection disconnected or missing) is an error, never scored: a try or a kept case
  // expecting nothing would otherwise pass on the tool's error. The bench's own waits time out on
  // purpose (`benchRunner`), and those runs are scored as they are.
  if (result.status === "failed" && !benchTimeout(result.errorKey)) {
    return { ...failed(stoppedWhy(result), extra, costUsd), runId: ran.runId };
  }
  // A shared case's run lives in the Sandbox: its result names it, without a foreign key.
  const outcome = scoredOutputs(c, expected, got, extra, costUsd);
  if (writeScore && !writeScore.exact) outcome.status = "fail";
  return {
    ...outcome,
    runId: ran.runId,
    ms: ran.ms,
    ...(writeScore ? { exact: writeScore.exact } : {}),
    ...(verification ? { verifier: verification === "agreed" } : {}),
  };
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
    const d = (prior.result.diff ?? {}) as {
      ms?: unknown;
      writes?: { exact?: unknown };
      verifier?: unknown;
    };
    return {
      status: prior.result.status,
      costUsd: String(prior.result.costUsd),
      ...(typeof d.ms === "number" ? { ms: d.ms } : {}),
      ...(typeof d.writes?.exact === "boolean" ? { exact: d.writes.exact } : {}),
      ...(typeof d.verifier === "boolean" ? { verifier: d.verifier } : {}),
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
  return {
    status: outcome.status,
    costUsd: outcome.costUsd,
    label: outcome.label,
    ...(outcome.ms !== undefined ? { ms: outcome.ms } : {}),
    ...(outcome.exact !== undefined ? { exact: outcome.exact } : {}),
    ...(outcome.verifier !== undefined ? { verifier: outcome.verifier } : {}),
  };
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
        // A partial run stays marked: it never counts for a gate (testbench/partial.ts).
        metrics: { ...totals.metrics, ...(params.partial ? partialMarks(params.caseIds) : {}) },
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
  // docs/plan.md §1.169: a build's test issue closes when its case passes in a full run, the
  // step that settles it; nothing else closes it but dropping it.
  if (status === "done" && !params.partial && totals.passed > 0) {
    const passed = await inSuiteScope(db, params.tenantId, (tx) =>
      tx
        .select({ caseId: testCaseResult.testCaseId })
        .from(testCaseResult)
        .where(
          and(
            eq(testCaseResult.suiteRunId, params.suiteRunId),
            tenantIs(testCaseResult.tenantId, params.tenantId),
            eq(testCaseResult.status, "pass"),
          ),
        ),
    );
    if (passed.length > 0) {
      await closePassedTests(
        db,
        params.tenantId,
        passed.map((r) => r.caseId),
      );
    }
  }
}

/** Closes the build test issues of these cases, now passing. */
async function closePassedTests(
  db: Db,
  tenantId: string | null,
  caseIds: readonly string[],
): Promise<void> {
  const note = "Settled: its test passes.";
  await withOperator(db, tenantId ? [tenantId] : [], (tx) =>
    tx
      .update(buildItem)
      .set({
        state: "done",
        resolvedAt: new Date(),
        detail: sql`left(case when ${buildItem.detail} = '' then ${note} else ${buildItem.detail} || ${`\n${note}`} end, 2000)`,
      })
      .where(
        and(
          eq(buildItem.kind, "test"),
          inArray(sql`${buildItem.ref}->>'testCaseId'`, [...caseIds]),
          inArray(buildItem.state, ["open", "in_progress", "waiting", "deferred"]),
        ),
      ),
  );
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
