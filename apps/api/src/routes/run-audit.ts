// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the back office's audit queue, a reviewer's
// marks, the counts per client and agent, each client's sampling rule, and one run's whole trail
// as a file. Operator only (invariant 11): nothing here is a portal route.

import {
  type AuditQueueRun,
  type AuditSettingsView,
  type AuditStat,
  DEFAULT_AUDIT_RULE,
  effectiveAuditRule,
  type ModelCallBody,
  type OpsModelCall,
  type RunAuditSettings,
  routes,
  runAuditSettingsOf,
  shortRunId,
} from "@countersign/core";
import {
  agent,
  appUser,
  inboxItem,
  modelCall,
  run,
  runAudit,
  runAuditMark,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { auditInTx } from "../audit";
import {
  type AppEnv,
  auditActor,
  ensureClient,
  HttpError,
  mount,
  mountLongFile,
  notFound,
} from "../http";
import { buildRunExport, runExportHtml, runExportJson } from "../run-audit/export";
import { marksOf, markView, queueByHand, runAuditState, runOwnerChecks } from "../run-audit/store";
import { opsRunDetail } from "./ops-clients";
import { stepFinder, timelineChecks } from "./run-checks";

/** The latest mark's verdict on the queue row's run (null while unaudited). */
const latestVerdict = sql<string | null>`(select m.verdict from ${runAuditMark} m
  where m.run_id = ${runAudit.runId} and m.tenant_id = ${runAudit.tenantId}
  order by m.created_at desc, m.id desc limit 1)`;
const latestAt = sql<Date | null>`(select max(m.created_at) from ${runAuditMark} m
  where m.run_id = ${runAudit.runId} and m.tenant_id = ${runAudit.tenantId})`;
const markCount = sql<number>`(select count(*)::int from ${runAuditMark} m
  where m.run_id = ${runAudit.runId} and m.tenant_id = ${runAudit.tenantId})`;

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

function scopeWhere(
  tenantIds: readonly string[],
  query: { client?: string | undefined; agent?: string | undefined },
): SQL[] {
  const where: SQL[] = [inArray(runAudit.tenantId, [...tenantIds])];
  if (query.client) where.push(eq(runAudit.tenantId, query.client));
  if (query.agent) where.push(eq(runAudit.agentId, query.agent));
  return where;
}

function modelCallView(m: typeof modelCall.$inferSelect): OpsModelCall {
  return {
    id: m.id,
    runId: m.runId,
    stepRunId: m.stepRunId,
    agentVersionId: m.agentVersionId,
    provider: m.provider,
    model: m.model,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    costUsd: m.costUsd,
    durationMs: m.durationMs,
    stopReason: m.stopReason,
    createdAt: m.createdAt.toISOString(),
  };
}

/** A client's settings view: its rule, the default, and each of its agents' overrides. */
async function settingsView(tx: Tx, tenantId: string): Promise<AuditSettingsView> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const settings = runAuditSettingsOf(t.settings);
  const agents = await tx
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)))
    .orderBy(agent.name);
  return {
    clientId: tenantId,
    default: DEFAULT_AUDIT_RULE,
    rule: settings.rule ?? null,
    effective: effectiveAuditRule(settings, "").rule,
    agents: agents.map((a) => ({
      agentId: a.id,
      name: a.name,
      rule:
        settings.agents && Object.hasOwn(settings.agents, a.id)
          ? (settings.agents[a.id] ?? null)
          : null,
      effective: effectiveAuditRule(settings, a.id).rule,
    })),
  };
}

export function runAuditRouteHandlers(app: Hono<AppEnv>): void {
  // ── The queue ─────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsAuditQueue, async (ctx) => {
    const { tx, tenantIds, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const where = scopeWhere(tenantIds, query);
    const state: SQL[] =
      query.state === "unaudited"
        ? [sql`${latestVerdict} is null`]
        : query.state === "audited"
          ? [sql`${latestVerdict} is not null`]
          : query.state === "problem"
            ? [sql`${latestVerdict} = 'problem'`]
            : [];
    const rows = await tx
      .select({
        queued: runAudit,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        agentVersionId: run.agentVersionId,
        workflowSlug: run.workflowSlug,
        clientName: tenant.name,
        agentName: agent.name,
        marks: markCount,
      })
      .from(runAudit)
      .innerJoin(run, and(eq(run.id, runAudit.runId), eq(run.tenantId, runAudit.tenantId)))
      .innerJoin(tenant, eq(tenant.id, runAudit.tenantId))
      .innerJoin(agent, and(eq(agent.id, runAudit.agentId), eq(agent.tenantId, runAudit.tenantId)))
      .where(and(...where, ...state))
      .orderBy(desc(runAudit.createdAt), desc(runAudit.id))
      .limit(query.limit);
    const marks = await marksOf(
      tx,
      tenantIds,
      rows.map((r) => r.queued.runId),
    );
    const latest = new Map<string, (typeof marks)[number]>();
    for (const m of marks) if (!latest.has(m.runId)) latest.set(m.runId, m);
    const inner = tx
      .select({ lv: sql<string | null>`${latestVerdict}`.as("lv") })
      .from(runAudit)
      .where(and(...where))
      .as("q");
    const [counts] = await tx
      .select({
        unaudited: sql<number>`count(*) filter (where ${inner.lv} is null)::int`,
        audited: sql<number>`count(*) filter (where ${inner.lv} is not null)::int`,
        problem: sql<number>`count(*) filter (where ${inner.lv} = 'problem')::int`,
      })
      .from(inner);
    return {
      runs: rows.map(
        (r): AuditQueueRun => ({
          runId: r.queued.runId,
          tenantId: r.queued.tenantId,
          clientName: r.clientName,
          agentId: r.queued.agentId,
          agentName: r.agentName,
          agentVersionId: r.agentVersionId,
          workflowSlug: r.workflowSlug,
          status: r.status,
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          queuedAt: r.queued.createdAt.toISOString(),
          reason: r.queued.reason,
          latest: latest.get(r.queued.runId) ?? null,
          marks: Number(r.marks),
        }),
      ),
      counts: {
        unaudited: Number(counts?.unaudited ?? 0),
        audited: Number(counts?.audited ?? 0),
        problem: Number(counts?.problem ?? 0),
      },
    };
  });

  mount(app, routes.opsAuditStats, async (ctx) => {
    const { tx, tenantIds, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const inner = tx
      .select({
        tenantId: runAudit.tenantId,
        agentId: runAudit.agentId,
        lv: sql<string | null>`${latestVerdict}`.as("lv"),
        la: sql<Date | null>`${latestAt}`.as("la"),
      })
      .from(runAudit)
      .where(and(...scopeWhere(tenantIds, query)))
      .as("q");
    const figures = {
      queued: sql<number>`count(*)::int`,
      audited: sql<number>`count(*) filter (where ${inner.lv} is not null)::int`,
      problems: sql<number>`count(*) filter (where ${inner.lv} = 'problem')::int`,
      lastAuditedAt: sql<string | null>`max(${inner.la})`,
    };
    const byAgent = await tx
      .select({ tenantId: inner.tenantId, agentId: inner.agentId, ...figures })
      .from(inner)
      .groupBy(inner.tenantId, inner.agentId);
    const byClient = await tx
      .select({ tenantId: inner.tenantId, ...figures })
      .from(inner)
      .groupBy(inner.tenantId);
    const clientIds = [...new Set(byClient.map((r) => r.tenantId))];
    const clients = clientIds.length
      ? await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, clientIds))
      : [];
    const agentIds = [...new Set(byAgent.map((r) => r.agentId))];
    const agents = agentIds.length
      ? await tx
          .select({ id: agent.id, name: agent.name })
          .from(agent)
          .where(and(inArray(agent.id, agentIds), inArray(agent.tenantId, [...tenantIds])))
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const at = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    const line = (
      r: {
        tenantId: string;
        queued: number;
        audited: number;
        problems: number;
        lastAuditedAt: unknown;
      },
      agentId: string | null,
    ): AuditStat => ({
      tenantId: r.tenantId,
      clientName: clientName.get(r.tenantId) ?? "",
      agentId,
      agentName: agentId ? (agentName.get(agentId) ?? null) : null,
      queued: Number(r.queued),
      audited: Number(r.audited),
      problems: Number(r.problems),
      lastAuditedAt: at(r.lastAuditedAt),
    });
    const byName = (a: AuditStat, b: AuditStat) =>
      a.clientName.localeCompare(b.clientName) ||
      (a.agentName ?? "").localeCompare(b.agentName ?? "");
    return {
      clients: byClient.map((r) => line(r, null)).sort(byName),
      agents: byAgent.map((r) => line(r, r.agentId)).sort(byName),
    };
  });

  // ── A reviewer's mark ─────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsMarkRunAudit, async ({ tx, params, body, tenantIds, session, c }) => {
    const [r] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, params.id), inArray(run.tenantId, [...tenantIds])));
    if (!r) throw notFound("run");
    // DECISION (wave 6 review): only live runs are audited; a test run never joins the queue.
    if (r.mode !== "live") {
      throw new HttpError(409, "test_run", "a test run isn't audited; only live runs are");
    }
    if (!FINISHED.has(r.status)) {
      throw new HttpError(409, "run_not_finished", "a run is audited once it has finished");
    }
    // DECISION (wave 6): a run marked without being queued joins the queue by hand, so the queue
    // and the counts hold every audited run.
    await queueByHand(tx, r);
    let inboxItemId: string | null = null;
    if (body.verdict === "problem") {
      // DECISION (wave 6): a problem opens a `review` item for us (operator only, the portal never
      // lists it), on the run as its subject. No `run_id`: the run has finished, and an item with
      // one is read as something the run waits on or must be told about.
      const [item] = await tx
        .insert(inboxItem)
        .values({
          tenantId: r.tenantId,
          kind: "review",
          agentId: r.agentId,
          subjectType: "run",
          subjectId: r.id,
          assigneeRole: "operator",
          title: `Audit found a problem in run ${shortRunId(r.id)}`,
          payload: { reason: "run_audit_problem", runId: r.id, note: body.note ?? "" },
        })
        .returning({ id: inboxItem.id });
      inboxItemId = item?.id ?? null;
    }
    const [row] = await tx
      .insert(runAuditMark)
      .values({
        tenantId: r.tenantId,
        runId: r.id,
        verdict: body.verdict,
        note: body.note ?? null,
        markedBy: session.user.id,
        inboxItemId,
      })
      .returning();
    if (!row) throw new Error("audit mark insert returned nothing");
    // Who marked what (invariant 14): ids and the verdict, never the note.
    await auditInTx(tx, c, {
      ...auditActor(session),
      tenantId: r.tenantId,
      action: "run.audit_mark",
      outcome: "ok",
      target: {
        run: r.id,
        mark: row.id,
        verdict: body.verdict,
        ...(inboxItemId ? { item: inboxItemId } : {}),
      },
    });
    const [u] = await tx
      .select({ name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, session.user.id));
    return {
      mark: markView(row, { name: u?.name ?? null, email: u?.email ?? session.user.email }),
      audit: await runAuditState(tx, r.tenantId, r.id),
    };
  });

  // ── The sampling rule ─────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsAuditSettings, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return settingsView(ctx.tx, ctx.params.id);
  });

  mount(app, routes.opsSetAuditSettings, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const [t] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    const before = runAuditSettingsOf(t.settings);
    const next: RunAuditSettings = { ...before, agents: { ...(before.agents ?? {}) } };
    if (body.rule === null) delete next.rule;
    else if (body.rule) next.rule = body.rule;
    const agentIds = Object.keys(body.agents ?? {});
    if (agentIds.length > 0) {
      const found = await tx
        .select({ id: agent.id })
        .from(agent)
        .where(
          and(
            eq(agent.tenantId, params.id),
            eq(agent.kind, "client"),
            // A test copy only ever has test runs, which are never queued.
            eq(agent.testCopy, false),
            inArray(agent.id, agentIds),
          ),
        );
      const known = new Set(found.map((a) => a.id));
      const unknown = agentIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new HttpError(422, "unknown_agent", "every agent must be one of this client's");
      }
    }
    for (const [id, rule] of Object.entries(body.agents ?? {})) {
      if (!next.agents) next.agents = {};
      if (rule === null) delete next.agents[id];
      else next.agents[id] = rule;
    }
    if (next.agents && Object.keys(next.agents).length === 0) delete next.agents;
    // One key of the client's settings, set in place: nothing else in them is read or rewritten.
    await tx
      .update(tenant)
      .set({
        settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{runAudit}', ${JSON.stringify(next)}::jsonb)`,
      })
      .where(eq(tenant.id, params.id));
    await tx.insert(tenantChange).values({
      tenantId: params.id,
      actorId: session.user.id,
      change: { setting: "runAudit", from: before, to: next },
      reason: "The audit sampling rule changed",
    });
    return settingsView(tx, params.id);
  });

  // ── One run's whole trail as a file ───────────────────────────────────────────────────────────

  // DECISION (wave 6): a slow route (`mountLongFile`): the AI calls' prompts and answers are read
  // from object storage after the database reads commit, never inside the request's transaction.
  mountLongFile(app, routes.opsRunExport, async ({ c, params, query, session, services, inTx }) => {
    const got = await inTx(async (scoped) => {
      const { tx } = scoped;
      const detail = await opsRunDetail({ ...scoped, session, services }, params.id);
      const r = detail.rows.run;
      const finder = stepFinder(detail.rows.workflow?.workflow);
      const checks = await timelineChecks(
        tx,
        detail.rows.steps,
        detail.rows.items,
        r.error,
        finder,
      );
      const calls = await tx
        .select()
        .from(modelCall)
        .where(and(eq(modelCall.runId, r.id), eq(modelCall.tenantId, r.tenantId)))
        .orderBy(modelCall.createdAt, modelCall.id);
      const [t] = await tx
        .select({ name: tenant.name })
        .from(tenant)
        .where(eq(tenant.id, r.tenantId));
      const [u] = await tx
        .select({ name: appUser.name })
        .from(appUser)
        .where(eq(appUser.id, session.user.id));
      return {
        detail,
        checks,
        calls,
        clientName: t?.name ?? "",
        userName: u?.name ?? null,
        ownerChecks: detail.response.ownerChecks ?? (await runOwnerChecks(tx, r.tenantId, r.id)),
        audit: detail.response.audit ?? (await runAuditState(tx, r.tenantId, r.id)),
      };
    });
    const r = got.detail.rows.run;
    const objects = query.modelCalls ? services.deps.objects(services.env) : null;
    const modelCalls: (OpsModelCall & { body?: ModelCallBody | null })[] = [];
    for (const m of got.calls) {
      let body: ModelCallBody | null = null;
      // Only ever under the call's own client's prefix (invariant 1).
      if (objects && m.bodyKey.startsWith(`tenants/${m.tenantId}/model-calls/`)) {
        const stored = await objects.get(m.bodyKey);
        if (stored) {
          const parsed = JSON.parse(
            new TextDecoder().decode(stored.bytes),
          ) as Partial<ModelCallBody>;
          body = {
            request: parsed.request ?? null,
            answer: parsed.answer ?? null,
            error: parsed.error ?? null,
          };
        }
      }
      modelCalls.push({ ...modelCallView(m), ...(query.modelCalls ? { body } : {}) });
    }
    const data = buildRunExport({
      view: got.detail.response,
      stepRows: got.detail.rows.steps,
      checks: got.checks,
      workflow: got.detail.rows.workflow?.workflow,
      ownerChecks: got.ownerChecks,
      audit: got.audit,
      modelCalls,
      client: { id: r.tenantId, name: got.clientName },
      exportedBy: { id: session.user.id, email: session.user.email, name: got.userName },
      exportedAt: new Date(),
      includesModelCalls: query.modelCalls,
    });
    const bytes = query.format === "json" ? runExportJson(data) : runExportHtml(data);
    // Writing the export is itself audited (invariant 14): which run, which format, with or
    // without the AI calls' prompts and answers.
    await inTx(({ tx }) =>
      auditInTx(tx, c, {
        ...auditActor(session),
        tenantId: r.tenantId,
        action: "run.export",
        outcome: "ok",
        target: { run: r.id, format: query.format, modelCalls: query.modelCalls ? "1" : "0" },
      }),
    );
    const day = new Date().toISOString().slice(0, 10);
    return {
      filename: `run-${shortRunId(r.id)}-${day}.${query.format}`,
      contentType:
        query.format === "json"
          ? ("application/json; charset=utf-8" as const)
          : ("text/html; charset=utf-8" as const),
      bytes,
    };
  });
}
