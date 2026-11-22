// docs/plan.md §1.212 (round 4, plan 2): the eval harness in the back office. Operators only.
//
// Save as a case: an approval the client gave (as proposed, or corrected before signing) becomes a
// test case of the template the client's agent came from, in that client (its records: the case
// runs and shows only there, invariant 1, and never leaves it: CI never sees it, invariant 14). Its
// input is the run's workflow and trigger payload; it expects that change, as signed, from the step
// that proposed it (`$writes`, scope `named`).
//
// The scorecard: per template workflow and version, the golden datasets' measures (shipped with
// the Worker from CI's replayed run) and each suite run's (the latest finished full run per version,
// workflow and scope).

import {
  Decimal,
  type GoldenScorecardRow,
  isPlainObject,
  parseSkillRef,
  routes,
  type ScorecardRow,
  stepIdOf,
  WRITES_KEY,
  WRITES_SCOPE_KEY,
  writeStepTools,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  externalAction,
  inboxItem,
  run,
  stepRun,
  testCase,
  testCaseResult,
  testSuiteRun,
} from "@countersign/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import golden from "../evals/golden-scorecard.json";
import { decisionOf } from "../exports/tables";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import { fullSuiteRun } from "../testbench/partial";
import { caseView, clientNames } from "./testbench";

const refuse = (code: string, message: string) => new HttpError(422, code, message);

/** The golden scorecard CI measured (apps/api/src/evals/golden-scorecard.json). */
function goldenRows(): GoldenScorecardRow[] {
  return Object.entries(golden as Record<string, Omit<GoldenScorecardRow, "template" | "workflow">>)
    .map(([key, card]) => {
      const [template = "", workflow = ""] = key.split("/");
      return {
        template,
        workflow,
        cases: card.cases,
        passed: card.passed,
        exactRate: card.exactRate,
        verifierAgreement: card.verifierAgreement,
        costPerCase: card.costPerCase,
      };
    })
    .sort((a, b) => `${a.template}/${a.workflow}`.localeCompare(`${b.template}/${b.workflow}`));
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1] ?? null;
};
const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

export function evalsRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsSaveCaseFromInbox, async (ctx) => {
    const { tx, params, body, session, tenantIds } = ctx;
    const [item] = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, params.id), inArray(inboxItem.tenantId, [...tenantIds])));
    if (!item) throw notFound("inbox item");
    const tenantId = item.tenantId;
    if (decisionOf(item) !== "approved") {
      throw refuse(
        "not_approved",
        "Only a change that was approved (as it was, or corrected) can be saved as a case.",
      );
    }
    const [action] = await tx
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.inboxItemId, item.id), eq(externalAction.tenantId, tenantId)));
    if (!action?.runId || !action.stepRunId) {
      throw refuse(
        "no_change",
        "This item has no change of a run to save: only a run's approved change can be.",
      );
    }
    // One click, once: the same item saved again answers the case it made.
    const sourceRef = `inbox:${item.id}`;
    const [existing] = await tx
      .select()
      .from(testCase)
      .where(
        and(
          eq(testCase.tenantId, tenantId),
          eq(testCase.sourceRef, sourceRef),
          isNull(testCase.archivedAt),
        ),
      );
    if (existing)
      return { case: caseView(existing, await clientNames(tx, [tenantId])), created: false };

    const [r] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, action.runId), eq(run.tenantId, tenantId)));
    if (!r) throw notFound("run");
    const [a] = await tx
      .select({ templateId: agent.templateId })
      .from(agent)
      .where(and(eq(agent.id, r.agentId), eq(agent.tenantId, tenantId)));
    if (!a?.templateId) {
      throw refuse(
        "not_from_template",
        "This agent wasn't made from a template, so its cases have nowhere to go.",
      );
    }
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.id, r.agentVersionId));
    const [sr] = await tx
      .select({ nodeId: stepRun.nodeId, input: stepRun.input })
      .from(stepRun)
      .where(and(eq(stepRun.id, action.stepRunId), eq(stepRun.tenantId, tenantId)));
    if (!sr) throw notFound("step");
    const step = stepIdOf(sr.nodeId);
    // DECISION: the write as signed: a person's correction (`edited_input`) over what the step
    // proposed (the step's own input, which a rerun of the step compares with).
    const corrected = action.editedInput !== null && action.editedInput !== undefined;
    const input = corrected ? action.editedInput : (sr.input ?? action.input);
    const tool = writeStepTools((v?.bundle as { workflows?: unknown } | undefined)?.workflows).get(
      step,
    );
    // The client agent's skill parameters (its AP mailbox, say), so the template runs as it does.
    const parameters: Record<string, Record<string, unknown>> = {};
    const skills = (v?.bundle as { definition?: { skills?: unknown } } | undefined)?.definition
      ?.skills;
    for (const ref of Array.isArray(skills) ? skills : []) {
      if (!isPlainObject(ref) || typeof ref.skill !== "string" || !isPlainObject(ref.parameters))
        continue;
      if (Object.keys(ref.parameters).length > 0)
        parameters[parseSkillRef(ref.skill).id] = ref.parameters;
    }
    const trigger = isPlainObject(r.trigger) ? r.trigger : {};
    const payload = isPlainObject(trigger.payload) ? trigger.payload : {};
    const name =
      body.name ?? `${corrected ? "Corrected" : "Approved"}: ${item.title}`.slice(0, 200);
    const [row] = await tx
      .insert(testCase)
      .values({
        tenantId,
        targetKind: "template",
        targetId: a.templateId,
        name,
        input: {
          workflow: r.workflowSlug,
          payload,
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        },
        fixtures: [],
        expected: {
          [WRITES_KEY]: [{ step, expect: { ...(tool ? { tool } : {}), input } }],
          [WRITES_SCOPE_KEY]: "named",
        },
        matcher: { kind: "subset", tolerances: {} },
        // DECISION: saved cases don't gate a publish until the operator makes them required.
        required: false,
        source: "run",
        sourceRef,
        createdBy: session.user.id,
      })
      .returning();
    if (!row) throw new Error("test case insert returned nothing");
    return { case: caseView(row, await clientNames(tx, [tenantId])), created: true };
  });

  mount(app, routes.opsScorecard, async (ctx) => {
    const { tx, query, tenantIds } = ctx;
    const scope =
      tenantIds.length > 0
        ? or(isNull(testSuiteRun.tenantId), inArray(testSuiteRun.tenantId, [...tenantIds]))
        : isNull(testSuiteRun.tenantId);
    const suites = await tx
      .select()
      .from(testSuiteRun)
      .where(
        and(
          eq(testSuiteRun.targetKind, "template"),
          eq(testSuiteRun.status, "done"),
          fullSuiteRun(),
          scope,
          ...(query.template ? [eq(testSuiteRun.targetId, query.template)] : []),
        ),
      )
      .orderBy(desc(testSuiteRun.createdAt))
      .limit(200);
    if (suites.length === 0) return { golden: goldenRows(), rows: [] };
    const results = await tx
      .select({
        suiteRunId: testCaseResult.suiteRunId,
        status: testCaseResult.status,
        diff: testCaseResult.diff,
        costUsd: testCaseResult.costUsd,
        input: testCase.input,
      })
      .from(testCaseResult)
      .innerJoin(testCase, eq(testCase.id, testCaseResult.testCaseId))
      .where(
        inArray(
          testCaseResult.suiteRunId,
          suites.map((s) => s.id),
        ),
      );
    const templates = await tx
      .select({ id: agent.id, name: agent.name, slug: agent.slug })
      .from(agent)
      .where(inArray(agent.id, [...new Set(suites.map((s) => s.targetId))]));
    const versions = await tx
      .select({ id: agentVersion.id, version: agentVersion.version })
      .from(agentVersion)
      .where(inArray(agentVersion.id, [...new Set(suites.map((s) => s.versionId))]));
    const names = await clientNames(
      tx,
      suites.map((s) => s.tenantId),
    );
    const tpl = new Map(templates.map((t) => [t.id, t]));
    const ver = new Map(versions.map((v) => [v.id, v.version]));

    type Acc = {
      cases: number;
      passed: number;
      writeCases: number;
      exact: number;
      judged: number;
      agreed: number;
      cost: Decimal;
      ms: number[];
    };
    const rows: ScorecardRow[] = [];
    const seen = new Set<string>();
    for (const s of suites) {
      const byWorkflow = new Map<string, Acc>();
      for (const r of results) {
        if (r.suiteRunId !== s.id) continue;
        const wf =
          isPlainObject(r.input) && typeof r.input.workflow === "string" ? r.input.workflow : "?";
        const acc = byWorkflow.get(wf) ?? {
          cases: 0,
          passed: 0,
          writeCases: 0,
          exact: 0,
          judged: 0,
          agreed: 0,
          cost: new Decimal(0),
          ms: [],
        };
        const d = (isPlainObject(r.diff) ? r.diff : {}) as {
          ms?: unknown;
          writes?: { exact?: unknown };
          verifier?: unknown;
        };
        acc.cases += 1;
        if (r.status === "pass") acc.passed += 1;
        if (typeof d.writes?.exact === "boolean") {
          acc.writeCases += 1;
          if (d.writes.exact) acc.exact += 1;
        }
        // The verifier's verdict, once the round-4 verifier records one on the result (§1.212).
        if (typeof d.verifier === "boolean") {
          acc.judged += 1;
          if (d.verifier) acc.agreed += 1;
        }
        acc.cost = acc.cost.plus(r.costUsd ?? 0);
        if (typeof d.ms === "number") acc.ms.push(d.ms);
        byWorkflow.set(wf, acc);
      }
      for (const [workflow, acc] of byWorkflow) {
        // The latest finished run per version, workflow and scope (suites come newest first).
        const key = `${s.versionId}|${workflow}|${s.tenantId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = tpl.get(s.targetId);
        rows.push({
          templateId: s.targetId,
          templateName: t?.name ?? "A template",
          templateSlug: t?.slug ?? "",
          versionId: s.versionId,
          version: ver.get(s.versionId) ?? null,
          workflow,
          clientName: s.tenantId ? (names.get(s.tenantId) ?? null) : null,
          suiteRunId: s.id,
          finishedAt: iso(s.finishedAt),
          cases: acc.cases,
          passed: acc.passed,
          exactRate: acc.writeCases === 0 ? null : ratio(acc.exact, acc.writeCases),
          writeCases: acc.writeCases,
          verifierAgreement: acc.judged === 0 ? null : ratio(acc.agreed, acc.judged),
          costPerCase: acc.cost.div(Math.max(acc.cases, 1)).toFixed(6),
          msMedian: median(acc.ms),
        });
      }
    }
    return { golden: goldenRows(), rows };
  });
}
