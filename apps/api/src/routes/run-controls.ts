// v0.12 W1-E: run controls and model calls (ARCHITECTURE §10.10, §14; docs/plan.md §1.40). The
// back office retries a failed run from its failed step, cancels an open run, replays a run as a
// test run in the same client, downloads the runs list as CSV, reads a run's model calls and keeps
// saved views of the runs list. RunFilter's SQL is here too: both runs lists use it.

import {
  errorGroupKey,
  type ModelCallBody,
  RUNS_CSV_COLUMNS,
  type RunErrorGroup,
  type RunFilter,
  type RunsPerDay,
  routes,
  shortRunId,
  shortRunIdTail,
  startedByEventTypes,
  type ToolAmount,
  type ToolSpec,
  uuidv7,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  modelCall,
  run,
  savedView,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import { resumePoint } from "@countersign/workflows";
import { and, desc, eq, gt, gte, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { csvFile } from "../exports/csv";
import { type AppEnv, ensureClient, HttpError, iso, mount, mountFile, notFound } from "../http";
import { createRunRow } from "../runs/dispatch";
import type { RunParams } from "../runs/instances";

// ── RunFilter as SQL ────────────────────────────────────────────────────────────────────────────

/** `error.key`, else `error.code` (older runs), else `unknown`: what failed runs group by. */
const errorKeySql = sql<string>`coalesce(${run.error}->>'key', ${run.error}->>'code', 'unknown')`;

/** How many times the run's work was tried: the run and the runs it retried, back to the first. */
export const attemptsSql = sql<number>`(
  with recursive chain(id, retry_of) as (
    select r0.id, r0.retry_of from run r0 where r0.id = ${run.id}
    union all
    select p.id, p.retry_of from run p join chain c on p.id = c.retry_of
  ) select count(*)::int from chain
)`;

const triggerType = sql`${run.trigger}->>'type'`;
const eventType = sql`${run.trigger}->>'eventType'`;
const SPECIAL_EVENTS = [
  ...startedByEventTypes("webhook"),
  ...startedByEventTypes("message"),
  ...startedByEventTypes("handoff"),
];

function textList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/** One `startedBy` value as a condition on `run.trigger` (the same mapping as core's runStartedBy). */
function startedBySql(kind: RunFilter["startedBy"] extends (infer K)[] | undefined ? K : never) {
  const clientManual = sql`(${run.trigger}->>'client' = 'true' or ${run.trigger}->'startedBy'->>'role' like 'client\\_%')`;
  switch (kind) {
    case "schedule":
      return sql`${triggerType} = 'schedule'`;
    case "event":
      return sql`(${triggerType} = 'event' and coalesce(${eventType}, '') not in (${textList(SPECIAL_EVENTS)}))`;
    case "manual":
      return sql`(${triggerType} = 'manual' and not ${clientManual})`;
    case "person":
      return sql`(${triggerType} = 'person' or (${triggerType} = 'manual' and ${clientManual}))`;
    case "message":
      return sql`(${triggerType} in ('message', 'command') or (${triggerType} = 'event' and ${eventType} in (${textList(startedByEventTypes("message"))})))`;
    default:
      return sql`(${triggerType} = ${kind} or (${triggerType} = 'event' and ${eventType} in (${textList(startedByEventTypes(kind))})))`;
  }
}

// v0.14 W4-B: RunFilter's `amount` (docs/plan.md §1.49 "Amounts"). A change's amount is where its
// tool declares it (`ToolSpec.amount`), read from the input the change runs with (the signer's
// edit, else the agent's), as core's `amountOf` reads it for approver rules.

/** The tools whose changes carry an amount, from the registry's specs. */
export function amountTools(specs: Readonly<Record<string, ToolSpec>>): AmountTool[] {
  return Object.values(specs)
    .filter((s) => s.sideEffect === "external" && s.amount)
    .map((s) => ({ tool: s.id, ...(s.amount as ToolAmount) }));
}

export type AmountTool = ToolAmount & { tool: string };

/** A JSON path `a.0.b` as a text[] for `#>>`, each segment a parameter. */
function jsonPath(path: string): SQL {
  return sql`array[${sql.join(
    path.split(".").map((p) => sql`${p}`),
    sql`, `,
  )}]::text[]`;
}

/** Decimal text as numeric, or null when it isn't a plain decimal (never a cast error). */
function numericOrNull(text: SQL): SQL {
  return sql`(case when ${text} ~ '^-?[0-9]{1,14}([.][0-9]{1,8})?$' then (${text})::numeric end)`;
}

function amountSql(filter: NonNullable<RunFilter["amount"]>, tools: readonly AmountTool[]): SQL {
  if (tools.length === 0) return sql`false`;
  const input = sql`coalesce(${externalAction.editedInput}, ${externalAction.input})`;
  const perTool = tools.map((t) => {
    const value = numericOrNull(sql`btrim(${input} #>> ${jsonPath(t.path)})`);
    const named = t.currencyPath ? sql`upper(${input} #>> ${jsonPath(t.currencyPath)})` : sql`null`;
    // As amountOf: the input's currency when it names a valid code, else the tool's own.
    const currency = sql`(case when ${named} ~ '^[A-Z]{3}$' then ${named} else ${t.currency ?? null} end)`;
    const bounds = [
      sql`${externalAction.tool} = ${t.tool}`,
      sql`${currency} = ${filter.currency}`,
      ...(filter.over !== undefined ? [sql`${value} > ${filter.over}::numeric`] : []),
      ...(filter.under !== undefined ? [sql`${value} < ${filter.under}::numeric`] : []),
    ];
    return sql`(${sql.join(bounds, sql` and `)})`;
  });
  return sql`exists (select 1 from ${externalAction}
    where ${externalAction.runId} = ${run.id} and ${externalAction.tenantId} = ${run.tenantId}
      and ${externalAction.status} <> 'rejected'
      and (${sql.join(perTool, sql` or `)}))`;
}

/**
 * RunFilter's conditions on `run` (the caller adds the client scope). Every subquery names the
 * run's own client as well as its id (invariant 1). `tools`: the registry's specs, for `amount`
 * (v0.14 W4-B); a filter with an amount and no tool that declares one matches no run.
 */
export function runFilterWhere(
  filter: RunFilter,
  tools: Readonly<Record<string, ToolSpec>>,
): SQL[] {
  const where: SQL[] = [];
  const f = filter;
  if (f.clients?.length) where.push(inArray(run.tenantId, f.clients));
  if (f.agents?.length) where.push(inArray(run.agentId, f.agents));
  if (f.versions?.length) where.push(inArray(run.agentVersionId, f.versions));
  if (f.templates?.length) {
    where.push(
      sql`exists (select 1 from ${agent} where ${agent.id} = ${run.agentId} and ${agent.tenantId} = ${run.tenantId} and ${agent.templateId} in (${textList(f.templates)}))`,
    );
  }
  if (f.statuses?.length) where.push(inArray(run.status, f.statuses));
  if (f.mode) where.push(eq(run.mode, f.mode));
  if (f.since) where.push(gte(run.createdAt, new Date(f.since)));
  if (f.until) where.push(lt(run.createdAt, new Date(f.until)));
  if (f.startedBy?.length) where.push(or(...f.startedBy.map(startedBySql)) as SQL);
  if (f.signedBy) {
    where.push(
      sql`(exists (select 1 from ${externalAction} where ${externalAction.runId} = ${run.id} and ${externalAction.tenantId} = ${run.tenantId} and ${externalAction.approvedBy} = ${f.signedBy})
        or exists (select 1 from ${inboxItem} where ${inboxItem.runId} = ${run.id} and ${inboxItem.tenantId} = ${run.tenantId} and ${inboxItem.resolvedBy} = ${f.signedBy}))`,
    );
  }
  if (f.changedConnector) {
    where.push(
      sql`exists (select 1 from ${externalAction} join ${connection} on ${connection.id} = ${externalAction.connectionId} and ${connection.tenantId} = ${externalAction.tenantId}
        where ${externalAction.runId} = ${run.id} and ${externalAction.tenantId} = ${run.tenantId} and ${externalAction.status} = 'done' and ${connection.connector} = ${f.changedConnector})`,
    );
  }
  if (f.attemptsOver !== undefined) where.push(sql`${attemptsSql} > ${f.attemptsOver}`);
  // v0.14 W4-B
  if (f.amount) where.push(amountSql(f.amount, amountTools(tools)));
  if (f.costOver) where.push(gt(run.costUsd, f.costOver));
  if (f.errorKey) where.push(sql`${errorKeySql} = ${f.errorKey}`);
  if (f.text) {
    const like = `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const tail = shortRunIdTail(f.text);
    where.push(
      or(
        ...(tail ? [sql`right(replace(${run.id}::text, '-', ''), 6) = ${tail}`] : []),
        sql`${run.workflowSlug} ilike ${like}`,
        sql`${run.error}->>'reason' ilike ${like}`,
        sql`exists (select 1 from ${agent} where ${agent.id} = ${run.agentId} and ${agent.tenantId} = ${run.tenantId} and (${agent.name} ilike ${like} or ${agent.serviceName} ilike ${like}))`,
      ) as SQL,
    );
  }
  return where;
}

/** `perDay=1`: runs and failures per UTC day matching `where`, oldest first. */
export async function runsPerDay(tx: Tx, where: SQL[]): Promise<RunsPerDay> {
  const day = sql<string>`to_char(${run.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await tx
    .select({
      day,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${run.status} = 'failed'))::int`,
    })
    .from(run)
    .where(and(...where))
    .groupBy(day)
    .orderBy(day);
  return rows;
}

/** `groupBy=error`: the failed runs matching `where`, by error key, the most frequent first. */
export async function runErrorGroups(tx: Tx, where: SQL[]): Promise<RunErrorGroup[]> {
  const rows = await tx
    .select({
      key: errorKeySql,
      count: sql<number>`count(*)::int`,
      clients: sql<string[]>`jsonb_agg(distinct ${run.tenantId})`,
      agents: sql<string[]>`jsonb_agg(distinct ${run.agentId})`,
      latestRunId: sql<string>`(array_agg(${run.id}::text order by ${run.createdAt} desc))[1]`,
      latestAt: sql<Date>`max(${run.createdAt})`,
    })
    .from(run)
    .where(and(...where, eq(run.status, "failed")))
    .groupBy(errorKeySql)
    .orderBy(sql`count(*) desc`, sql`max(${run.createdAt}) desc`)
    .limit(100);
  const tenantIds = [...new Set(rows.flatMap((r) => r.clients))];
  const names = tenantIds.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name })
        .from(tenant)
        .where(inArray(tenant.id, tenantIds))
    : [];
  const nameOf = new Map(names.map((t) => [t.id, t.name]));
  return rows.map((r) => ({
    key: r.key,
    count: r.count,
    clients: r.clients.map((id) => ({ id, name: nameOf.get(id) ?? "" })),
    agents: r.agents,
    latestRunId: r.latestRunId,
    latestAt: new Date(r.latestAt).toISOString(),
  }));
}

/** The clients a back-office filter names must be among the operator's (404 otherwise). */
export function ensureFilterClients(ctx: { tenantIds: readonly string[] }, filter: RunFilter) {
  for (const id of filter.clients ?? []) ensureClient(ctx, id);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

async function runInScope(tx: Tx, tenantIds: readonly string[], id: string) {
  const [r] = await tx
    .select()
    .from(run)
    .where(and(eq(run.id, id), inArray(run.tenantId, [...tenantIds])));
  if (!r) throw notFound("run");
  return r;
}

/** The run's trigger and payload as they started it, to start the same again. */
function sameTrigger(r: typeof run.$inferSelect) {
  const { payload, ...trigger } = r.trigger as Record<string, unknown>;
  return { trigger, payload: payload ?? {} };
}

function opsModelCall(m: typeof modelCall.$inferSelect) {
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

function viewOut(v: typeof savedView.$inferSelect) {
  return {
    id: v.id,
    surface: v.surface,
    name: v.name,
    filters: v.filters as RunFilter,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

const OPEN_RUN = ["queued", "running", "waiting"] as const;
const OPEN_STEP = ["pending", "running", "waiting"] as const;

/** The most runs one CSV holds, newest first. */
// DECISION: the CSV takes the list's filter but not its page size: up to 5,000 runs, newest first.
export const RUNS_CSV_MAX = 5000;

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export function runControlRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsRetryRun, async (ctx) => {
    const { tx, params, services } = ctx;
    const r = await runInScope(tx, ctx.tenantIds, params.id);
    if (r.mode !== "live") throw new HttpError(409, "not_live", "only live runs are retried");
    if (r.status !== "failed")
      throw new HttpError(409, "not_failed", "only failed runs are retried");
    const [already] = await tx
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.retryOf, r.id), eq(run.tenantId, r.tenantId)))
      .limit(1);
    // DECISION: a run is retried once; a retry that fails is retried in its turn, so the attempts
    // form one line (run → retry → retry) and each retry's carried approvals are unambiguous.
    if (already) {
      throw new HttpError(
        409,
        "already_retried",
        `this run was retried as ${shortRunId(already.id)}; retry that one`,
      );
    }
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId)));
    const wf = v?.bundle.workflows.find((w) => w.slug === r.workflowSlug);
    const failedAt = (r.error as { nodeId?: unknown } | null)?.nodeId;
    const resumeFrom = wf
      ? resumePoint(wf.workflow, typeof failedAt === "string" ? failedAt : null)
      : null;
    const { trigger, payload } = sameTrigger(r);
    const req: RunParams = {
      runId: uuidv7(),
      tenantId: r.tenantId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId,
      workflowSlug: r.workflowSlug,
      mode: "live",
      trigger: trigger as unknown as RunParams["trigger"],
      payload,
      retryOf: r.id,
      resumeFrom,
    };
    // The same checks as any live run: the agent must be active; the gate checks matrix, grant,
    // go-live stage and release again for every write (a trial agent has every write signed).
    await createRunRow(tx, req);
    await tx
      .update(run)
      .set({ retryOf: r.id, resumeFrom })
      .where(and(eq(run.id, req.runId), eq(run.tenantId, r.tenantId)));
    ctx.afterCommit(() => services.instances.start(req));
    return { runId: req.runId, shortId: shortRunId(req.runId), resumeFrom };
  });

  mount(app, routes.opsCancelRun, async (ctx) => {
    const { tx, params, services, session } = ctx;
    const r = await runInScope(tx, ctx.tenantIds, params.id);
    if (!(OPEN_RUN as readonly string[]).includes(r.status)) {
      throw new HttpError(409, "not_open", `this run is ${r.status}`);
    }
    const [writing] = await tx
      .select({ id: externalAction.id })
      .from(externalAction)
      .where(
        and(
          eq(externalAction.runId, r.id),
          eq(externalAction.tenantId, r.tenantId),
          eq(externalAction.status, "executing"),
        ),
      )
      .limit(1);
    // An executing write finishes first (ARCHITECTURE §10.10): the cancel is refused until then.
    if (writing) {
      throw new HttpError(
        409,
        "writing",
        "a change is being made right now; try again in a moment",
      );
    }
    await services.instances.terminate(r.id);
    const now = new Date();
    await tx
      .update(run)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: { reason: "cancelled", code: "run_cancelled", by: session.user.id },
      })
      .where(and(eq(run.id, r.id), eq(run.tenantId, r.tenantId)));
    await tx
      .update(stepRun)
      .set({ status: "cancelled", finishedAt: now })
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
      .set({ status: "rejected", error: { code: "run_cancelled", message: "run cancelled" } })
      .where(
        and(
          eq(externalAction.runId, r.id),
          eq(externalAction.tenantId, r.tenantId),
          eq(externalAction.status, "proposed"),
        ),
      );
    return { runId: r.id, status: "cancelled" as const };
  });

  mount(app, routes.opsReplayRun, async (ctx) => {
    const { tx, params, services } = ctx;
    const r = await runInScope(tx, ctx.tenantIds, params.id);
    const { trigger, payload } = sameTrigger(r);
    // A test run in the run's own client (never the Sandbox: invariant 1); it never writes.
    const req: RunParams = {
      runId: uuidv7(),
      tenantId: r.tenantId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId,
      workflowSlug: r.workflowSlug,
      mode: "test",
      trigger: { ...trigger, replayOf: r.id } as unknown as RunParams["trigger"],
      payload,
    };
    await createRunRow(tx, req);
    ctx.afterCommit(() => services.instances.start(req));
    return { runId: req.runId, shortId: shortRunId(req.runId) };
  });

  mountFile(app, routes.opsRunsCsv, async (ctx) => {
    const { tx, query } = ctx;
    ensureFilterClients(ctx, query.filter);
    const rows = await tx
      .select({
        r: run,
        client: tenant.name,
        agent: sql<string>`coalesce(${agent.serviceName}, ${agent.name})`,
        version: agentVersion.version,
        attempts: attemptsSql,
      })
      .from(run)
      .innerJoin(tenant, eq(tenant.id, run.tenantId))
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
      .innerJoin(
        agentVersion,
        and(eq(agentVersion.id, run.agentVersionId), eq(agentVersion.tenantId, run.tenantId)),
      )
      .where(
        and(
          inArray(run.tenantId, [...ctx.tenantIds]),
          ...runFilterWhere(query.filter, ctx.services.platform.ctx.tools.specs()),
        ),
      )
      .orderBy(desc(run.createdAt))
      .limit(RUNS_CSV_MAX);
    const bytes = csvFile(
      RUNS_CSV_COLUMNS,
      rows.map(({ r, client, agent: name, version, attempts }) => {
        const error = r.error as { nodeId?: unknown } | null;
        return [
          shortRunId(r.id),
          client,
          name,
          `v${version}`,
          iso(r.startedAt ?? r.createdAt),
          r.status,
          r.status === "failed" && typeof error?.nodeId === "string" ? error.nodeId : "",
          r.status === "failed" ? errorGroupKey(r.error) : "",
          attempts,
          r.costUsd,
        ];
      }),
    );
    const day = new Date().toISOString().slice(0, 10);
    return {
      filename: `mezonas-runs-${day}.csv`,
      contentType: "text/csv; charset=utf-8" as const,
      bytes,
    };
  });

  mount(app, routes.opsRunModelCalls, async ({ tx, params, tenantIds }) => {
    const r = await runInScope(tx, tenantIds, params.id);
    const rows = await tx
      .select()
      .from(modelCall)
      .where(and(eq(modelCall.runId, r.id), eq(modelCall.tenantId, r.tenantId)))
      .orderBy(modelCall.createdAt, modelCall.id);
    return { modelCalls: rows.map(opsModelCall) };
  });

  mount(app, routes.opsModelCall, async ({ tx, params, tenantIds, services }) => {
    const [m] = await tx
      .select()
      .from(modelCall)
      .where(and(eq(modelCall.id, params.id), inArray(modelCall.tenantId, [...tenantIds])));
    if (!m) throw notFound("model call");
    let body: ModelCallBody | null = null;
    // Only ever under the call's own client's prefix (invariant 1).
    if (m.bodyKey.startsWith(`tenants/${m.tenantId}/model-calls/`)) {
      const stored = await services.deps.objects(services.env).get(m.bodyKey);
      if (stored) {
        const parsed = JSON.parse(new TextDecoder().decode(stored.bytes)) as Partial<ModelCallBody>;
        body = {
          request: parsed.request ?? null,
          answer: parsed.answer ?? null,
          error: parsed.error ?? null,
        };
      }
    }
    return { modelCall: opsModelCall(m), body };
  });

  mount(app, routes.opsSavedViews, async ({ tx, query, session }) => {
    const rows = await tx
      .select()
      .from(savedView)
      .where(and(eq(savedView.userId, session.user.id), eq(savedView.surface, query.surface)))
      .orderBy(savedView.name);
    return { views: rows.map(viewOut) };
  });

  mount(app, routes.opsCreateSavedView, async ({ tx, body, session }) => {
    const [taken] = await tx
      .select({ id: savedView.id })
      .from(savedView)
      .where(
        and(
          eq(savedView.userId, session.user.id),
          eq(savedView.surface, body.surface),
          eq(savedView.name, body.name),
        ),
      );
    if (taken) throw new HttpError(409, "name_taken", `you already have a view named ${body.name}`);
    const [row] = await tx
      .insert(savedView)
      .values({
        userId: session.user.id,
        surface: body.surface,
        name: body.name,
        filters: body.filters,
      })
      .returning();
    if (!row) throw new Error("saved view insert returned nothing");
    return { view: viewOut(row) };
  });

  mount(app, routes.opsDeleteSavedView, async ({ tx, params, session }) => {
    // Only the user's own view (the table is every operator's: RLS checks operator, this the user).
    const deleted = await tx
      .delete(savedView)
      .where(and(eq(savedView.id, params.id), eq(savedView.userId, session.user.id)))
      .returning({ id: savedView.id });
    if (deleted.length === 0) throw notFound("saved view");
    return { deleted: true };
  });
}
