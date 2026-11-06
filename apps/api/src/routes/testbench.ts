// v0.12 W2-C: the test bench (ARCHITECTURE §9.10, §14 "Tests"; docs/plan.md §1.46). Back office
// only. Test cases for a skill or a template: shared ones (synthetic data, tenant_id null) and a
// client's (made from its records: they run and show only in that client, invariant 1). Suite runs
// run every case of one version, as a TestSuiteWorkflow, never writing; their results are
// insert-only. Every handler runs inside withOperator(the clients served), and every query also
// filters by client.

import { SHARED_COPY_PREFIX } from "@countersign/agents";
import {
  type CaseResultView,
  type MatcherInput,
  routes,
  type SuiteRunView,
  type TestCaseView,
  type TestTargetKind,
  testCaseProblems,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  skill,
  skillVersion,
  type Tx,
  tenant,
  testCase,
  testCaseResult,
  testSuiteRun,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { auditInTx } from "../audit";
import type { Bindings } from "../env";
import {
  type AppDeps,
  type AppEnv,
  ensureClient,
  type HandlerCtx,
  HttpError,
  iso,
  mount,
  notFound,
} from "../http";
import { runDepsFromEnv } from "../runs/execute";
import { type TestSuiteJobs, testSuiteJobs } from "../testbench/instances";
import { executeSuite, type SuiteParams } from "../testbench/suite";

type Scope = Pick<HandlerCtx<never>, "tx" | "tenantIds">;
type CaseRow = typeof testCase.$inferSelect;
type SuiteRow = typeof testSuiteRun.$inferSelect;

/** The deployment's TestSuiteWorkflow (tests pass their own); null where it isn't bound. */
export function testSuiteJobsFor(deps: AppDeps, env: Bindings): TestSuiteJobs | null {
  if (deps.testSuites) return deps.testSuites(env);
  return env.TEST_SUITE_WORKFLOW ? testSuiteJobs(env.TEST_SUITE_WORKFLOW) : null;
}

/** Rows of the shared scope (null) and of the clients served. */
function visible(column: typeof testCase.tenantId | typeof testSuiteRun.tenantId, ids: Scope) {
  return ids.tenantIds.length > 0
    ? or(isNull(column), inArray(column, [...ids.tenantIds]))
    : isNull(column);
}

interface Target {
  kind: TestTargetKind;
  id: string;
  /** The skill's client (a client's own skill); null for shared skills and templates. */
  tenantId: string | null;
  requireTests: boolean | null;
}

/** A skill (an operator skill, not a client's copy of a shared one) or a template, in scope. */
async function targetInScope(ctx: Scope, kind: TestTargetKind, id: string): Promise<Target> {
  if (kind === "skill") {
    const [row] = await ctx.tx.select().from(skill).where(eq(skill.id, id));
    if (!row || row.slug.startsWith(SHARED_COPY_PREFIX)) throw notFound("skill");
    if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("skill");
    return { kind, id, tenantId: row.tenantId, requireTests: row.requireTests };
  }
  const [row] = await ctx.tx
    .select({ id: agent.id, kind: agent.kind, tenantId: agent.tenantId })
    .from(agent)
    .where(eq(agent.id, id));
  if (row?.kind !== "template" || row.tenantId !== null) throw notFound("template");
  return { kind, id, tenantId: null, requireTests: null };
}

/**
 * Where a target's cases may live: a client's own skill only in that client; a shared skill or a
 * template shared, or in a client the operator serves.
 */
function caseScope(ctx: Scope, target: Target, clientId: string | undefined): string | null {
  if (clientId) ensureClient(ctx, clientId);
  if (target.tenantId !== null) {
    if (clientId !== undefined && clientId !== target.tenantId) {
      throw new HttpError(422, "invalid_request", "a client's own skill has that client's cases");
    }
    return target.tenantId;
  }
  return clientId ?? null;
}

async function clientNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => x !== null))];
  if (want.length === 0) return new Map();
  const rows = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function caseView(row: CaseRow, names: Map<string, string>): TestCaseView {
  return {
    id: row.id,
    clientId: row.tenantId,
    clientName: row.tenantId ? (names.get(row.tenantId) ?? null) : null,
    targetKind: row.targetKind,
    targetId: row.targetId,
    name: row.name,
    input: row.input,
    fixtures: (row.fixtures ?? []) as TestCaseView["fixtures"],
    expected: row.expected,
    matcher: row.matcher as MatcherInput as TestCaseView["matcher"],
    required: row.required,
    source: row.source,
    sourceRef: row.sourceRef,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt) as string,
    archivedAt: iso(row.archivedAt),
  };
}

/** Version numbers for suite runs, skill or template. */
async function versionNumbers(tx: Tx, rows: SuiteRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const skills = rows.filter((r) => r.targetKind === "skill").map((r) => r.versionId);
  const templates = rows.filter((r) => r.targetKind === "template").map((r) => r.versionId);
  if (skills.length) {
    const vs = await tx
      .select({ id: skillVersion.id, version: skillVersion.version })
      .from(skillVersion)
      .where(inArray(skillVersion.id, [...new Set(skills)]));
    for (const v of vs) out.set(v.id, v.version);
  }
  if (templates.length) {
    const vs = await tx
      .select({ id: agentVersion.id, version: agentVersion.version })
      .from(agentVersion)
      .where(inArray(agentVersion.id, [...new Set(templates)]));
    for (const v of vs) out.set(v.id, v.version);
  }
  return out;
}

export function suiteView(row: SuiteRow, versions: Map<string, number>): SuiteRunView {
  const metrics = row.metrics as Record<string, unknown> | null;
  return {
    id: row.id,
    clientId: row.tenantId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    versionId: row.versionId,
    version: versions.get(row.versionId) ?? null,
    status: row.status,
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    metrics: metrics && "passRate" in metrics ? (metrics as SuiteRunView["metrics"]) : null,
    costUsd: String(row.costUsd),
    startedBy: row.startedBy,
    createdAt: iso(row.createdAt) as string,
    finishedAt: iso(row.finishedAt),
  };
}

/** Suite runs as views, with their versions' numbers. */
export async function suiteViews(tx: Tx, rows: SuiteRow[]): Promise<SuiteRunView[]> {
  const versions = await versionNumbers(tx, rows);
  return rows.map((r) => suiteView(r, versions));
}

async function caseInScope(ctx: Scope, id: string): Promise<CaseRow> {
  const [row] = await ctx.tx
    .select()
    .from(testCase)
    .where(and(eq(testCase.id, id), visible(testCase.tenantId, ctx)));
  if (!row) throw notFound("test case");
  return row;
}

function refuseProblems(kind: TestTargetKind, fields: Parameters<typeof testCaseProblems>[1]) {
  const problems = testCaseProblems(kind, fields);
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_test_case", problems.join("; "), problems);
  }
}

/** The Sandbox client this operator serves: where a shared template case runs. */
async function sandboxClient(ctx: Scope): Promise<string> {
  const ids = [...ctx.tenantIds];
  const [row] = ids.length
    ? await ctx.tx
        .select({ id: tenant.id })
        .from(tenant)
        .where(and(inArray(tenant.id, ids), sql`(${tenant.settings}->>'sandbox')::boolean`))
        .orderBy(tenant.createdAt)
        .limit(1)
    : [];
  if (!row) {
    throw new HttpError(409, "no_sandbox", "a template is test-run in a Sandbox client you serve");
  }
  return row.id;
}

export function testbenchRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsTests, async (ctx) => {
    const { tx, query } = ctx;
    const target = await targetInScope(ctx, query.target.kind, query.target.id);
    if (query.client) ensureClient(ctx, query.client);
    const scoped = (column: typeof testCase.tenantId | typeof testSuiteRun.tenantId) =>
      query.client ? eq(column, query.client) : visible(column, ctx);
    const cases = await tx
      .select()
      .from(testCase)
      .where(
        and(
          eq(testCase.targetKind, target.kind),
          eq(testCase.targetId, target.id),
          scoped(testCase.tenantId),
          query.archived === "true" ? undefined : isNull(testCase.archivedAt),
        ),
      )
      .orderBy(asc(testCase.createdAt));
    const runs = await tx
      .select()
      .from(testSuiteRun)
      .where(
        and(
          eq(testSuiteRun.targetKind, target.kind),
          eq(testSuiteRun.targetId, target.id),
          scoped(testSuiteRun.tenantId),
        ),
      )
      .orderBy(desc(testSuiteRun.createdAt))
      .limit(20);
    const names = await clientNames(tx, [
      ...cases.map((c) => c.tenantId),
      ...runs.map((r) => r.tenantId),
    ]);
    return {
      cases: cases.map((c) => caseView(c, names)),
      runs: await suiteViews(tx, runs),
      requireTests: target.requireTests,
    };
  });

  mount(app, routes.opsCreateTest, async (ctx) => {
    const { tx, body, session } = ctx;
    const target = await targetInScope(ctx, body.targetKind, body.targetId);
    const scope = caseScope(ctx, target, body.clientId);
    refuseProblems(target.kind, body);
    const [row] = await tx
      .insert(testCase)
      .values({
        tenantId: scope,
        targetKind: target.kind,
        targetId: target.id,
        name: body.name,
        input: body.input ?? null,
        fixtures: body.fixtures,
        expected: body.expected ?? null,
        matcher: body.matcher,
        required: body.required,
        source: body.source,
        sourceRef: body.sourceRef ?? null,
        createdBy: session.user.id,
      })
      .returning();
    if (!row) throw new Error("test case insert returned nothing");
    return { case: caseView(row, await clientNames(tx, [row.tenantId])) };
  });

  mount(app, routes.opsUpdateTest, async (ctx) => {
    const { tx, body } = ctx;
    const row = await caseInScope(ctx, ctx.params.id);
    const next = {
      name: body.name ?? row.name,
      input: body.input !== undefined ? body.input : row.input,
      fixtures: body.fixtures ?? row.fixtures,
      expected: body.expected !== undefined ? body.expected : row.expected,
      matcher: body.matcher ?? row.matcher,
      required: body.required ?? row.required,
    };
    refuseProblems(row.targetKind, next as Parameters<typeof testCaseProblems>[1]);
    const [updated] = await tx
      .update(testCase)
      .set(next)
      .where(and(eq(testCase.id, row.id), visible(testCase.tenantId, ctx)))
      .returning();
    if (!updated) throw notFound("test case");
    return { case: caseView(updated, await clientNames(tx, [updated.tenantId])) };
  });

  // DECISION: "delete" archives: a case's past results point at it and are never deleted
  // (insert-only), so the case stays as their record and no longer runs.
  mount(app, routes.opsArchiveTest, async (ctx) => {
    const row = await caseInScope(ctx, ctx.params.id);
    const [updated] = row.archivedAt
      ? [row]
      : await ctx.tx
          .update(testCase)
          .set({ archivedAt: new Date() })
          .where(and(eq(testCase.id, row.id), visible(testCase.tenantId, ctx)))
          .returning();
    if (!updated) throw notFound("test case");
    return { case: caseView(updated, await clientNames(ctx.tx, [updated.tenantId])) };
  });

  mount(app, routes.opsRunTests, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const target = await targetInScope(ctx, body.targetKind, body.targetId);
    const scope = caseScope(ctx, target, body.clientId);
    let skillDefinition: SuiteParams["skill"];
    let runTenantId: string | undefined;
    if (target.kind === "skill") {
      const [v] = await tx.select().from(skillVersion).where(eq(skillVersion.id, body.versionId));
      if (!v || v.skillId !== target.id) throw notFound("skill version");
      skillDefinition = v.definition;
    } else {
      const [v] = await tx
        .select({ id: agentVersion.id, agentId: agentVersion.agentId })
        .from(agentVersion)
        .where(eq(agentVersion.id, body.versionId));
      if (!v || v.agentId !== target.id) throw notFound("template version");
      // A shared case runs the template's test copy in the Sandbox; a client's, in its client.
      runTenantId = scope ?? (await sandboxClient(ctx));
    }
    const cases = await tx
      .select({ id: testCase.id })
      .from(testCase)
      .where(
        and(
          eq(testCase.targetKind, target.kind),
          eq(testCase.targetId, target.id),
          isNull(testCase.archivedAt),
          scope ? eq(testCase.tenantId, scope) : isNull(testCase.tenantId),
        ),
      )
      .orderBy(asc(testCase.createdAt), asc(testCase.id));
    if (cases.length === 0) {
      throw new HttpError(422, "no_test_cases", "there are no test cases to run in this scope");
    }
    const [suite] = await tx
      .insert(testSuiteRun)
      .values({
        tenantId: scope,
        targetKind: target.kind,
        targetId: target.id,
        versionId: body.versionId,
        status: "running",
        total: cases.length,
        startedBy: session.user.id,
      })
      .returning();
    if (!suite) throw new Error("suite run insert returned nothing");
    const params: SuiteParams = {
      suiteRunId: suite.id,
      tenantId: scope,
      targetKind: target.kind,
      targetId: target.id,
      versionId: body.versionId,
      caseIds: cases.map((c) => c.id),
      ...(skillDefinition ? { skill: skillDefinition } : {}),
      ...(runTenantId ? { runTenantId } : {}),
      actorId: session.user.id,
    };
    const jobs = testSuiteJobsFor(services.deps, services.env);
    if (jobs) {
      ctx.afterCommit(() => jobs.start(params));
    } else {
      // DECISION: where TestSuiteWorkflow isn't bound, the suite runs after the response in the
      // request's own lifetime (each case its own transactions, none held across a model call).
      ctx.defer(() =>
        executeSuite(
          runDepsFromEnv(services.env, { db: services.db, platform: services.platform }),
          params,
          { do: (_name, fn) => fn() },
        ),
      );
    }
    return { suiteRun: (await suiteViews(tx, [suite]))[0] as SuiteRunView };
  });

  mount(app, routes.opsTestSuiteRun, async (ctx) => {
    const { tx } = ctx;
    const [suite] = await tx
      .select()
      .from(testSuiteRun)
      .where(and(eq(testSuiteRun.id, ctx.params.id), visible(testSuiteRun.tenantId, ctx)));
    if (!suite) throw notFound("suite run");
    const rows = await tx
      .select({
        result: testCaseResult,
        name: testCase.name,
        required: testCase.required,
      })
      .from(testCaseResult)
      .innerJoin(testCase, eq(testCase.id, testCaseResult.testCaseId))
      .where(
        and(
          eq(testCaseResult.suiteRunId, suite.id),
          suite.tenantId
            ? eq(testCaseResult.tenantId, suite.tenantId)
            : isNull(testCaseResult.tenantId),
        ),
      )
      .orderBy(asc(testCaseResult.createdAt));
    const results: CaseResultView[] = rows.map(({ result, name, required }) => ({
      id: result.id,
      testCaseId: result.testCaseId,
      name,
      required,
      status: result.status,
      got: result.got,
      diff: result.diff,
      costUsd: String(result.costUsd),
      runId: result.runId,
      createdAt: iso(result.createdAt) as string,
    }));
    return { suiteRun: (await suiteViews(tx, [suite]))[0] as SuiteRunView, results };
  });

  mount(app, routes.opsSkillRequireTests, async (ctx) => {
    const { tx, body, session } = ctx;
    const target = await targetInScope(ctx, "skill", ctx.params.id);
    await tx
      .update(skill)
      .set({ requireTests: body.required })
      .where(
        and(
          eq(skill.id, target.id),
          target.tenantId ? eq(skill.tenantId, target.tenantId) : isNull(skill.tenantId),
        ),
      );
    if (!body.required && target.requireTests) {
      // DECISION: plan §1.46 logs the switch-off in `agent_change`, but its `agent_id` is a
      // required reference to an agent, so a skill can't have a row there without a migration.
      // It is logged in the audit log instead: the skill's id and the reason (cut to 200
      // characters, operator-written text, never record content).
      await auditInTx(tx, null, {
        tenantId: target.tenantId,
        actorKind: "user",
        actorUserId: session.user.id,
        actorEmail: session.user.email ?? null,
        actorRole: ctx.role,
        action: "skill.require_tests.off",
        outcome: "ok",
        target: { skillId: target.id, reason: (body.reason ?? "").slice(0, 200) },
      });
    }
    return { skillId: target.id, requireTests: body.required };
  });
}
