// Back office: clients, their connections, runs across clients, and the operator inbox
// (ARCHITECTURE §14). Every handler runs inside withOperator(the clients this operator serves).

import type { Approver, RegistryContext } from "@countersign/agents";
import { applyMatrixChange } from "@countersign/connectors";
import {
  type AnyAgentBundle,
  complianceOf,
  connectorShown,
  findNodeStep,
  type GoLive,
  GoLivePayload,
  type OpsAgentActivity,
  parseCoveredProcessors,
  processingRefusal,
  processorsForOffer,
  type RouteSpec,
  type RunWait,
  readPause,
  readStageState,
  routes,
  stepNodeOf,
  trialProgress,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  externalAction,
  inboxItem,
  membership,
  modelCall,
  run,
  stepRun,
  type Tx,
  tenant,
  toolCall,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, count, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { sloanByDefault, withSloan } from "../account/sloan";
// P-4
import { runConversations } from "../converse/views";
import {
  type AppEnv,
  ensureClient,
  type HandlerCtx,
  HttpError,
  iso,
  mount,
  notFound,
  type Services,
} from "../http";
import { resolveInboxItem, sendResolution } from "../inbox";
import { isInternal } from "../internal-client";
import { bundleWritesWith, stageOf, writesContext } from "../lifecycle/stages";
// v0.13 W2-I
import { runOversight } from "../oversight/views";
import { runAuditState, runOwnerChecks } from "../run-audit/store";
import { dispatchEvents } from "../runs/dispatch";
import { daysOf, runsByDay } from "../runs/figures";
import { opsStatusWhere, reachContext, runWaits } from "../runs/run-wait";
import { runSubjects, sourceNames } from "../runs/subject";
import { stepModelFacts } from "../skill-facts";
import { lastActivityOf, sourceActivity, usedByWith } from "./built-in-sources";
import { needsUs, needsUsContext } from "./command-center";
import { connectNoAuth } from "./connections";
import { withLanguage } from "./language";
import {
  agentSummary,
  matrixEdit,
  opsAction,
  opsConnection,
  opsInboxItem,
  opsRun,
  opsStep,
  opsToolCall,
} from "./mappers";
import { inviteToClient, withApprovals } from "./onboarding";
import { canSignIn, sourcesOf } from "./portal";
import { stepOutcomes } from "./run-checks";
import { ensureFilterClients, runErrorGroups, runFilterWhere, runsPerDay } from "./run-controls";
import { turnOnSloan } from "./supervisor";

/** The Sandbox client: `tenant.settings.sandbox` (docs/plan.md §1.2). */
export function isSandbox(settings: Record<string, unknown>): boolean {
  return settings.sandbox === true;
}

/**
 * The Sandbox client, for the routes that act in it from the back office as its client would
 * (connect its tools, upload its documents): 404 unless this operator serves the client, 403
 * `not_sandbox` for any other client.
 */
// DECISION: the operator connects tools only in the Sandbox client, their own test client with no
// client users (docs/plan.md §1.5): its no-sign-in tools, and since 2026-11-05 its OAuth tools with
// the operator's own sign-in. In a real client the client signs in from the portal, and the
// operator never connects on their behalf (ARCHITECTURE §6.1).
export async function sandboxClient(
  ctx: { tx: Tx; tenantIds: readonly string[] },
  id: string,
  refusal = "only the Sandbox client's tools are connected from the back office",
) {
  ensureClient(ctx, id);
  const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, id));
  if (!t) throw notFound("client");
  if (!isSandbox(t.settings)) throw new HttpError(403, "not_sandbox", refusal);
  return t;
}

/** Which of these clients is the Sandbox, read from their settings. */
async function sandboxIds(tx: Tx, tenantIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(tenantIds)];
  const rows = ids.length
    ? await tx
        .select({ id: tenant.id, settings: tenant.settings })
        .from(tenant)
        .where(inArray(tenant.id, ids))
    : [];
  return new Set(rows.filter((t) => isSandbox(t.settings)).map((t) => t.id));
}

/**
 * The signed-in operator as the one resolving these clients' inbox items, per client. In the
 * Sandbox they resolve every item (packages/agents' `mayResolve`); which client is the Sandbox is
 * read from its settings here, never taken from a request.
 */
export async function operatorApprovers(
  tx: Tx,
  userId: string,
  tenantIds: readonly string[],
): Promise<(tenantId: string) => Approver> {
  const sandboxes = await sandboxIds(tx, tenantIds);
  return (tenantId) => ({
    userId,
    role: "operator",
    ...(sandboxes.has(tenantId) ? { sandbox: true } : {}),
  });
}

/** `tenant.settings.connectors_offered`, as connector ids. */
export function offeredConnectors(settings: Record<string, unknown>): string[] {
  const v = settings.connectors_offered;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UI cleanup (design pass): each client agent's work at a glance for the client page: live runs
 * started in the last 7 days, runs waiting for approval now (as Runs filters them), its last run
 * (any mode) and its runs each day (UTC, test runs included, as the command center counts them).
 */
// DECISION (speed run 6.7): three reads asked together in the request's transaction, which the
// driver pipelines (docs/plan.md §1.82): one count per agent (the week's live runs, the waiting
// ones and, for an agent on trial, its finished live runs since the trial began, for `goLive`),
// each agent's last run by a lateral `limit 1` (with whether it waits), and the runs per day.
// It was five reads in a row, one over every run of the client to find each agent's last.
async function agentActivity(
  tx: Tx,
  tenantId: string,
  agentIds: string[],
  now: Date,
  trialSince: ReadonlyMap<string, Date> = new Map(),
): Promise<{ activity: OpsAgentActivity[]; trialRuns: Map<string, number> }> {
  if (agentIds.length === 0) return { activity: [], trialRuns: new Map() };
  const scope = and(eq(run.tenantId, tenantId), inArray(run.agentId, agentIds)) as SQL;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const waitingNow = and(eq(run.mode, "live"), ...opsStatusWhere(["waiting"])) as SQL;
  // An agent on trial counts its finished live runs from its own start (`finishedLiveRuns`).
  const since = [...trialSince].filter(([id]) => agentIds.includes(id));
  const trialStart = since.length
    ? sql`case ${run.agentId} ${sql.join(
        since.map(([id, at]) => sql`when ${id}::uuid then ${at.toISOString()}::timestamptz`),
        sql` `,
      )} end`
    : null;
  const ids = sql.join(
    agentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [counts, lastRuns, days] = await Promise.all([
    tx
      .select({
        agentId: run.agentId,
        week: sql<number>`(count(*) filter (where ${run.mode} = 'live' and ${run.createdAt} >= ${weekAgo.toISOString()}::timestamptz))::int`,
        waiting: sql<number>`(count(*) filter (where ${waitingNow}))::int`,
        trial: trialStart
          ? sql<number>`(count(*) filter (where ${run.mode} = 'live' and ${run.status} in ('succeeded', 'failed') and ${run.createdAt} >= ${trialStart}))::int`
          : sql<number>`0`,
      })
      .from(run)
      .where(scope)
      .groupBy(run.agentId),
    tx.execute<{ agent_id: string; id: string; status: string; at: string; waiting: boolean }>(
      sql`select a.id as agent_id, last.id, last.status, last.at, last.waiting
        from unnest(array[${ids}]) as a(id)
        cross join lateral (
          select ${run.id} as id, ${run.status} as status,
            to_char(${run.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
            coalesce(${and(...opsStatusWhere(["waiting"]))}, false) as waiting
          from ${run}
          where ${run.tenantId} = ${tenantId} and ${run.agentId} = a.id
          order by ${run.createdAt} desc, ${run.id} desc
          limit 1
        ) as last`,
    ),
    runsByDay(tx, [scope], { timezone: "UTC", now }),
  ]);
  const last = new Map([...lastRuns].map((r) => [r.agent_id, r]));
  const activity = agentIds.map((agentId) => {
    const c = counts.find((w) => w.agentId === agentId);
    const l = last.get(agentId);
    return {
      agentId,
      runs7d: c?.week ?? 0,
      waitingRuns: c?.waiting ?? 0,
      lastRun: l ? { id: l.id, status: l.status, at: l.at, waiting: l.waiting === true } : null,
      perDay: daysOf(days.byAgent, agentId),
    };
  });
  return {
    activity,
    trialRuns: new Map(since.map(([id]) => [id, counts.find((c) => c.agentId === id)?.trial ?? 0])),
  };
}

/**
 * Speed run 6.7: every agent's go-live stage for the client page, as `goLiveView`
 * (lifecycle/stages.ts) answers it for one agent, without a read per agent: the trial's runs come
 * from `agentActivity`'s count, the sign-off items in one read, the versions `writes` is read from
 * in one read, and their skills and automations once for all of them (`writesContext`).
 * src/ops-client-views.test.ts pins it to `goLiveView` for each kind of agent.
 */
async function goLiveViews(
  tx: Tx,
  tenantId: string,
  rows: (typeof agent.$inferSelect)[],
  // Asked alongside these reads: `agentActivity` counts the trial's runs.
  trialRunsOf: Promise<ReadonlyMap<string, number>>,
  ctx: RegistryContext,
  now: Date,
): Promise<{ agentId: string; goLive: GoLive }[]> {
  if (rows.length === 0) return [];
  const states = new Map(rows.map((r) => [r.id, readStageState(r.stageState)]));
  const signoffIds = [...states.values()].flatMap((s) =>
    s.signoff ? [s.signoff.inboxItemId] : [],
  );
  // The version the page describes: the live one, else the latest (`shownVersionWrites`).
  const [items, versions] = await Promise.all([
    signoffIds.length
      ? tx
          .select({ id: inboxItem.id, status: inboxItem.status, payload: inboxItem.payload })
          .from(inboxItem)
          .where(and(eq(inboxItem.tenantId, tenantId), inArray(inboxItem.id, signoffIds)))
      : [],
    tx
      .selectDistinctOn([agentVersion.agentId], {
        agentId: agentVersion.agentId,
        bundle: agentVersion.bundle,
      })
      .from(agentVersion)
      .innerJoin(
        agent,
        and(eq(agent.id, agentVersion.agentId), eq(agent.tenantId, agentVersion.tenantId)),
      )
      .where(
        and(
          eq(agentVersion.tenantId, tenantId),
          inArray(
            agentVersion.agentId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(
        agentVersion.agentId,
        sql`(${agentVersion.id} = ${agent.liveVersionId}) is true desc`,
        desc(agentVersion.version),
      ),
  ]);
  const item = new Map(items.map((i) => [i.id, i]));
  const bundles = new Map(versions.map((v) => [v.agentId, v.bundle]));
  // The skills and automations every bundle names, read once for all of them.
  const shown = rows.filter((r) => r.kind === "client").flatMap((r) => bundles.get(r.id) ?? []);
  const [context, trialRuns] = await Promise.all([
    writesContext(tx, tenantId, shown, ctx),
    trialRunsOf,
  ]);
  const writes = rows.map((r) => {
    const bundle = bundles.get(r.id);
    return r.kind === "client" && bundle ? bundleWritesWith(bundle, context, ctx) : false;
  });
  return rows.map((row, i) => {
    const stage = stageOf(row);
    const state = states.get(row.id) ?? readStageState(row.stageState);
    let trial: GoLive["trial"] = null;
    if (state.trial && stage === "trial") {
      trial = trialProgress(state.trial, trialRuns.get(row.id) ?? 0, now);
    } else if (state.trial && stage !== "live") {
      trial = trialProgress(state.trial, 0, now);
    }
    let signoff: GoLive["signoff"] = null;
    if (state.signoff) {
      const it = item.get(state.signoff.inboxItemId);
      const p = GoLivePayload.safeParse(it?.payload);
      signoff = {
        inboxItemId: state.signoff.inboxItemId,
        askedAt: state.signoff.askedAt,
        status: it?.status ?? null,
        summary: p.success ? p.data.goLive.summary : null,
      };
    }
    const pause = readPause(row.pause);
    return {
      agentId: row.id,
      goLive: {
        stage,
        writes: writes[i] === true,
        liveVersion: row.liveVersionId !== null,
        trial,
        signoff,
        skipped: state.skipped ?? [],
        rejections: state.rejections ?? [],
        pause: pause
          ? {
              side: pause.side,
              reason: pause.reason,
              at: pause.at,
              until: pause.until ?? null,
              all: pause.all === true,
            }
          : null,
      },
    };
  });
}

async function clientSummaries(
  tx: Tx,
  ids: readonly string[],
  services: Pick<Services, "auth" | "env" | "platform">,
  view: "full" | "names" = "full",
) {
  if (ids.length === 0) return [];
  // §1.84: `names` (the back office's picker) leaves out the costly counts; its badges come from
  // the command center or GET /api/ops/counts.
  const counts = view === "full";
  // DECISION: the six reads are asked at once, in the request's transaction, which the driver
  // pipelines (docs/plan.md §1.82): the back office loads this list on every visit.
  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const [rows, agents, open, escalations, waiting, recent] = await Promise.all([
    tx
      .select()
      .from(tenant)
      .where(inArray(tenant.id, [...ids]))
      .orderBy(tenant.name),
    tx
      .select({ tenantId: agent.tenantId, n: count() })
      .from(agent)
      .where(
        and(
          inArray(agent.tenantId, [...ids]),
          eq(agent.kind, "client"),
          eq(agent.status, "active"),
        ),
      )
      .groupBy(agent.tenantId),
    tx
      .select({ tenantId: inboxItem.tenantId, n: count() })
      .from(inboxItem)
      .where(and(inArray(inboxItem.tenantId, [...ids]), eq(inboxItem.status, "open")))
      .groupBy(inboxItem.tenantId),
    // UI cleanup (stream A): Needs us and runs waiting for approval, per client, from the same
    // definitions the command center and the runs list use, so every count agrees.
    counts ? needsUs(tx, ids, new Date(), needsUsContext(services)) : null,
    counts
      ? tx
          .select({ tenantId: run.tenantId, n: count() })
          .from(run)
          .where(
            and(
              inArray(run.tenantId, [...ids]),
              eq(run.mode, "live"),
              ...opsStatusWhere(["waiting"]),
            ),
          )
          .groupBy(run.tenantId)
      : null,
    // The client cards' last-day figures: live runs created in the last 24 hours, and the failed.
    counts
      ? tx
          .select({
            tenantId: run.tenantId,
            total: count(),
            failed: sql<number>`count(*) filter (where ${run.status} = 'failed')`.mapWith(Number),
          })
          .from(run)
          .where(
            and(
              inArray(run.tenantId, [...ids]),
              eq(run.mode, "live"),
              sql`${run.createdAt} >= ${dayAgo.toISOString()}`,
            ),
          )
          .groupBy(run.tenantId)
      : null,
  ]);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    timezone: t.timezone,
    createdAt: t.createdAt.toISOString(),
    agents: agents.find((a) => a.tenantId === t.id)?.n ?? 0,
    openInbox: open.find((o) => o.tenantId === t.id)?.n ?? 0,
    ...(escalations && waiting
      ? {
          needsUs: escalations.filter((e) => e.client.id === t.id).length,
          waitingRuns: waiting.find((w) => w.tenantId === t.id)?.n ?? 0,
        }
      : {}),
    ...(recent
      ? (() => {
          const r = recent.find((x) => x.tenantId === t.id);
          return { runs24h: { total: r?.total ?? 0, failed: r?.failed ?? 0 } };
        })()
      : {}),
    sandbox: isSandbox(t.settings as Record<string, unknown>),
    // §1.73: one of our own (Mezonas), for the back office's Marketing entry.
    internal: isInternal(t.settings as Record<string, unknown>),
  }));
}

/** The agents runs and inbox items name, for the back office's lists. */
export async function agentRefs(tx: Tx, tenantIds: readonly string[], ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select()
    .from(agent)
    .where(and(inArray(agent.id, wanted), inArray(agent.tenantId, [...tenantIds])));
  return rows.map((a) => ({
    id: a.id,
    tenantId: a.tenantId,
    slug: a.slug,
    name: a.name,
    serviceName: a.serviceName,
  }));
}

/** The `run` columns the back office's run lists show (`opsRun`'s): never `config`. */
export const runListColumns = {
  id: run.id,
  tenantId: run.tenantId,
  agentId: run.agentId,
  agentVersionId: run.agentVersionId,
  workflowSlug: run.workflowSlug,
  mode: run.mode,
  status: run.status,
  trigger: run.trigger,
  costUsd: run.costUsd,
  error: run.error,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdAt: run.createdAt,
};
export type RunListRow = Pick<typeof run.$inferSelect, keyof typeof runListColumns>;

type BundleWorkflow = AnyAgentBundle["workflows"][number];
/** A run's workflow as its list row needs it: the name, and the steps only to name a failed one. */
type RunWorkflow = { name: string | null; workflow: BundleWorkflow["workflow"] | null };
const workflowKey = (versionId: string, slug: string) => `${versionId}|${slug}`;

/** The node a failed run stopped at, or null. */
function failedNode(r: Pick<RunListRow, "status" | "error">): string | null {
  const nodeId =
    r.status === "failed" && r.error && typeof r.error === "object"
      ? (r.error as { nodeId?: unknown }).nodeId
      : undefined;
  // A step in a loop runs as `<loop>:<index>:<step>`, and a run can stop on one of a step's
  // checks (`<step>:confer:<n>`, `<step>:notify:<n>`…): the step is the node before the check.
  // Wave 3c: the check's suffix was read as the step's id, so a v4 run that stopped on a confer
  // or an urgent notice named no step.
  return typeof nodeId === "string" ? stepNodeOf(nodeId).node : null;
}

/**
 * The workflows a list's runs ran, by version and slug. Speed run 6.3: read from each version
 * with a JSON path, the name only, and the steps only where a failed run needs its step's name;
 * it selected every version's whole bundle.
 */
async function runWorkflows(
  tx: Tx,
  rows: readonly RunListRow[],
): Promise<Map<string, RunWorkflow>> {
  const out = new Map<string, RunWorkflow>();
  if (rows.length === 0) return out;
  const steps = [
    ...new Set(
      rows.filter((r) => failedNode(r)).map((r) => workflowKey(r.agentVersionId, r.workflowSlug)),
    ),
  ];
  const list = (values: readonly string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );
  const found = await tx.execute<{
    id: string;
    slug: string;
    name: string | null;
    workflow: BundleWorkflow["workflow"] | null;
  }>(sql`select ${agentVersion.id} as id, w ->> 'slug' as slug, w ->> 'name' as name,
      ${
        steps.length
          ? sql`case when ${agentVersion.id}::text || '|' || (w ->> 'slug') in (${list(steps)})
              then w -> 'workflow' end`
          : sql`null::jsonb`
      } as workflow
    from ${agentVersion}
    cross join lateral jsonb_array_elements(${agentVersion.bundle} -> 'workflows') as w
    where ${agentVersion.id} in (${list([...new Set(rows.map((r) => r.agentVersionId))])})
      and ${agentVersion.tenantId} in (${list([...new Set(rows.map((r) => r.tenantId))])})
      and w ->> 'slug' in (${list([...new Set(rows.map((r) => r.workflowSlug))])})`);
  for (const f of found) {
    const key = workflowKey(f.id, f.slug);
    // The first workflow with the slug, as `workflows.find` reads it.
    if (!out.has(key)) out.set(key, { name: f.name, workflow: f.workflow });
  }
  return out;
}

/** One run as the back office lists it, from its wait and its workflow. */
function runListView(r: RunListRow, wait: RunWait | null, wf: RunWorkflow | undefined) {
  const node = failedNode(r);
  const step = wf?.workflow && node ? findNodeStep(wf.workflow, node) : undefined;
  return {
    ...opsRun(r),
    waiting: wait,
    workflowName: wf?.name ?? null,
    errorStep: step ? step.name : null,
  };
}

/**
 * Runs as the back office lists them (UI cleanup, stream A): each with its wait (who a run waiting
 * for approval waits on, since when), its workflow's name and, failed, the name of the step it
 * failed at, both read from the run's version.
 */
export async function opsRunViews(
  tx: Tx,
  rows: RunListRow[],
  services: Pick<Services, "auth" | "env">,
) {
  const [waits, workflows] = await Promise.all([
    runWaits(tx, rows, reachContext(services)),
    runWorkflows(tx, rows),
  ]);
  return rows.map((r) =>
    runListView(
      r,
      waits.get(r.id) ?? null,
      workflows.get(workflowKey(r.agentVersionId, r.workflowSlug)),
    ),
  );
}

/**
 * The tables a back-office run page shows rows of, by `run_id` (each read through an index that
 * leads with it). `tool_call` is reached through its steps.
 */
const RUN_PAGE_TABLES = [
  "step_run",
  "model_call",
  "external_action",
  "inbox_item",
  "oversight_decision",
  "owner_check",
  "run_audit",
  "run_audit_mark",
  "reach_out",
] as const;

/** One table's rows for the run, as one hash (empty: no rows). */
const rowsHash = (from: SQL) =>
  sql`(select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) ${from})`;

/**
 * Speed run 6.2: a run's status and a key that changes whenever anything its page shows changes,
 * in one statement, so the run page can poll this and reload the full view only on a change.
 */
// DECISION (review of #265): the key is built from content, not timestamps: an md5 of the run's
// row and of every row of each table the page shows, its conversations' translations included
// (a whole row's text, so a tool call finishing, a cost added, a step waiting, a reply, its
// translation, a snooze or a write reset all change it, though none of them moves a timestamp).
// Names the page looks up elsewhere (documents, vendors, people) are left out: they do not change
// with the run.
async function opsRunStatus(tx: Tx, tenantIds: readonly string[], id: string) {
  // Qualified by hand: a one-table select leaves its columns unqualified (`waitsOnPerson`).
  const mine = sql.raw(`x.run_id = "run"."id" and x.tenant_id = "run"."tenant_id"`);
  const parts = [
    sql`md5("run"::text)`,
    ...RUN_PAGE_TABLES.map((t) => rowsHash(sql`from ${sql.raw(t)} x where ${mine}`)),
    rowsHash(
      sql`from tool_call x join step_run s on s.id = x.step_run_id and s.tenant_id = x.tenant_id
        where s.run_id = "run"."id" and s.tenant_id = "run"."tenant_id"`,
    ),
    // The translations of the run's conversations: of a reach-out, or of a reply's raw record
    // (`runConversations` → `translationsFor`). A reply's id is checked before it is cast.
    rowsHash(
      sql`from message_translation x where x.tenant_id = "run"."tenant_id" and (
        x.reach_out_id in (select ro.id from reach_out ro
          where ro.run_id = "run"."id" and ro.tenant_id = "run"."tenant_id")
        or x.raw_record_id in (select (ro.reply ->> 'rawRecordId')::uuid from reach_out ro
          where ro.run_id = "run"."id" and ro.tenant_id = "run"."tenant_id"
            and ro.reply ->> 'rawRecordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))`,
    ),
  ];
  const [row] = await tx
    .select({
      id: run.id,
      status: run.status,
      waiting: sql<boolean>`coalesce(${and(...opsStatusWhere(["waiting"]))}, false)`,
      key: sql<string>`md5(concat_ws('|', ${sql.join(parts, sql`, `)}))`,
    })
    .from(run)
    .where(and(eq(run.id, id), inArray(run.tenantId, [...tenantIds])));
  if (!row) throw notFound("run");
  return { ...row, waiting: row.waiting === true };
}

async function connectionInScope(tx: Tx, tenantIds: readonly string[], id: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), inArray(connection.tenantId, [...tenantIds])));
  if (!row) throw notFound("connection");
  return row;
}

export function opsClientRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClients, async (ctx) => ({
    clients: await clientSummaries(ctx.tx, ctx.tenantIds, ctx.services, ctx.query.view),
  }));

  mount(app, routes.opsCreateClient, async (ctx) => {
    const { tx, body, session, tenantIds, services } = ctx;
    const timezone = body.timezone ?? "UTC";
    if (!validTimezone(timezone)) throw new HttpError(422, "invalid_timezone", timezone);
    const offered = body.connectorsOffered ?? [];
    for (const id of offered) {
      if (!services.platform.connectors.has(id)) {
        throw new HttpError(422, "unknown_connector", `no connector ${id}`);
      }
    }
    const [row] = await tx
      .insert(tenant)
      .values({
        name: body.name,
        timezone,
        // Approval stays with the client's admin unless the operator delegates it (ARCHITECTURE §4);
        // unset reads as the client admin.
        settings: withSloan(
          withLanguage(
            body.approvals
              ? withApprovals({ connectors_offered: offered }, body.approvals)
              : { connectors_offered: offered },
            body.language,
          ),
          body.supervisor !== false,
        ),
      })
      .returning();
    if (!row) throw new Error("tenant insert returned nothing");
    // DECISION: the operator who creates a client serves it. The new client is added to this
    // transaction's scope so its first membership passes row-level security in the same commit;
    // the id is the one just inserted, never taken from the request.
    await tx.execute(
      sql`select set_config('app.tenant_ids', ${`{${[...tenantIds, row.id].join(",")}}`}, true)`,
    );
    await tx
      .insert(membership)
      .values({ tenantId: row.id, userId: session.user.id, role: "operator" });
    // The client admin, invited in the same transaction (the email follows the commit).
    const invited = body.admin
      ? await inviteToClient(
          ctx,
          row.id,
          { ...body.admin, role: "client_admin" },
          { surface: "ops" },
        )
      : null;
    // Sloan, the account agent, is on from the start unless the operator unticked it (§1.47).
    if (sloanByDefault(row.settings)) {
      await turnOnSloan(tx, {
        tenantId: row.id,
        actorId: session.user.id,
        actor: {
          actorKind: "user",
          actorUserId: session.user.id,
          actorEmail: session.user.email,
          actorRole: ctx.role,
        },
        platform: services.platform,
      });
    }
    const [summary] = await clientSummaries(tx, [row.id], services);
    if (!summary) throw new Error("the new client is not visible");
    return { client: summary, admin: invited };
  });

  mount(app, routes.opsClient, async (ctx) => {
    const { tx, params, services } = ctx;
    ensureClient(ctx, params.id);
    // DECISION (speed run 6.7): the client page's reads are asked together in the request's
    // transaction (docs/plan.md §1.82), then its agents' activity and go-live stages together.
    const [[t], agents, connections, members] = await Promise.all([
      tx.select().from(tenant).where(eq(tenant.id, params.id)),
      tx
        .select()
        .from(agent)
        .where(
          and(eq(agent.tenantId, params.id), eq(agent.kind, "client"), eq(agent.status, "active")),
        )
        .orderBy(agent.slug),
      tx
        .select()
        .from(connection)
        .where(eq(connection.tenantId, params.id))
        .orderBy(connection.connector),
      tx
        .select({
          userId: membership.userId,
          email: appUser.email,
          name: appUser.name,
          role: membership.role,
        })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(eq(membership.tenantId, params.id))
        .orderBy(appUser.email),
    ]);
    if (!t) throw notFound("client");
    const now = new Date();
    const shown = agents.filter((a) => !a.testCopy);
    const trialSince = new Map<string, Date>();
    for (const a of shown) {
      const trial = readStageState(a.stageState).trial;
      if (trial && stageOf(a) === "trial") trialSince.set(a.id, new Date(trial.startedAt));
    }
    const pending = agentActivity(
      tx,
      t.id,
      shown.map((a) => a.id),
      now,
      trialSince,
    );
    // `goLiveViews` awaits the trial counts last; until then a failed `pending` is caught here,
    // so it never surfaces as an unhandled rejection (the handler still fails through `pending`).
    const trialRuns = pending.then((a) => a.trialRuns);
    trialRuns.catch(() => {});
    const [{ activity }, goLive] = await Promise.all([
      pending,
      goLiveViews(tx, t.id, shown, trialRuns, services.platform.ctx, now),
    ]);
    return {
      client: {
        id: t.id,
        name: t.name,
        timezone: t.timezone,
        settings: t.settings,
        createdAt: t.createdAt.toISOString(),
      },
      agents: agents.map(agentSummary),
      connections: connections.map(opsConnection),
      members,
      activity,
      goLive,
    };
  });

  mount(app, routes.opsClientConnections, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, params, services } = ctx;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    const rows = await tx
      .select()
      .from(connection)
      .where(eq(connection.tenantId, params.id))
      .orderBy(connection.connector);
    const agents = await tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.tenantId, params.id), eq(agent.kind, "client"), eq(agent.status, "active")),
      );
    // Upload and forwarding: their last document, and the agents their documents start.
    const activity = await sourceActivity(tx, params.id, rows);
    const usedBy: Record<string, { id: string; name: string }[]> = {};
    for (const c of rows) {
      const bound = agents
        .filter((a) => a.runStatus !== "retired" && Object.values(a.bindings).includes(c.id))
        .map((a) => ({ id: a.id, name: a.serviceName ?? a.name }));
      usedBy[c.id] = usedByWith(c, bound, activity);
    }
    return {
      connections: rows.map((c) => ({
        ...opsConnection(c),
        lastActivityAt: iso(lastActivityOf(c, activity)),
      })),
      offered: offeredConnectors(t.settings),
      // Test-only connectors only in the Sandbox, or where the client already has a connection.
      connectors: services.platform.connectors
        .list()
        .filter((c) =>
          connectorShown(c.manifest, {
            sandbox: isSandbox(t.settings),
            inUse: rows.some((r) => r.connector === c.manifest.id),
          }),
        )
        .map((c) => ({
          id: c.manifest.id,
          name: c.manifest.name,
          description: c.manifest.description,
          icon: c.manifest.icon ?? null,
          auth: c.manifest.auth,
          available: canSignIn(c),
          tools: c.manifest.tools.map((tool) => ({
            id: tool.id,
            description: tool.description,
            verb: tool.verb,
            sideEffect: tool.sideEffect,
          })),
        })),
      usedBy,
      sandbox: isSandbox(t.settings),
    };
  });

  mount(app, routes.opsConnectSandbox, async (ctx) => {
    const { tx, params, services, session } = ctx;
    const t = await sandboxClient(ctx, params.id);
    const id = await connectNoAuth(tx, {
      tenantId: t.id,
      connector: params.connector,
      platform: services.platform,
      actorId: session.user.id,
      by: "operator",
    });
    if (!offeredConnectors(t.settings).includes(params.connector)) {
      await tx
        .update(tenant)
        .set({
          settings: {
            ...t.settings,
            connectors_offered: [...offeredConnectors(t.settings), params.connector],
          },
        })
        .where(eq(tenant.id, t.id));
    }
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, id), eq(connection.tenantId, t.id)));
    if (!row) throw notFound("connection");
    return { connection: opsConnection(row) };
  });

  mount(app, routes.opsOfferConnectors, async (ctx) => {
    const { tx, params, body, services } = ctx;
    ensureClient(ctx, params.id);
    const offered = [...new Set(body.offered)];
    for (const id of offered) {
      if (!services.platform.connectors.has(id)) {
        throw new HttpError(422, "unknown_connector", `no connector ${id}`);
      }
    }
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    if (t.retiredAt) throw new HttpError(409, "retired", "this client is retired");
    // HIPAA mode (docs/plan.md §1.35): a connector that sends data to a vendor without a signed BAA
    // is never offered. Already offered ones stay offered only if they were covered when HIPAA mode
    // was turned on (it can't be turned on otherwise).
    const profile = complianceOf(t.settings);
    const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
    for (const id of offered) {
      const refusal = processingRefusal(
        profile,
        covered,
        processorsForOffer(id),
        `The ${id} connector`,
      );
      if (refusal) throw new HttpError(409, "hipaa", refusal);
    }
    // DECISION: withdrawing an offer leaves an existing connection as it is (the client still sees
    // and can disconnect it); it only stops new sign-ins.
    await tx
      .update(tenant)
      .set({ settings: { ...t.settings, connectors_offered: offered } })
      .where(eq(tenant.id, t.id));
    return { offered };
  });

  mount(app, routes.opsUpdateConnection, async (ctx) => {
    const { tx, params, body, tenantIds, session, services } = ctx;
    const row = await connectionInScope(tx, tenantIds, params.id);
    const set: Partial<typeof connection.$inferInsert> = {};
    const changes: Record<string, unknown>[] = [];
    if (body.permissions) {
      const r = applyMatrixChange({
        current: row.permissions,
        proposed: matrixEdit(body.permissions),
        by: "operator",
        // v0.12 W2-A: the connector's entities, for the entity levels and scopes.
        declared: services.platform.connectors.get(row.connector)?.manifest.permissionEntities,
      });
      if (!r.ok) throw new HttpError(422, r.reason, r.message);
      if (r.changed) {
        set.permissions = r.matrix;
        changes.push({ ...r.change });
      }
    }
    if (body.config) {
      set.config = body.config;
      changes.push({ kind: "config", before: row.config, after: body.config });
    }
    if (changes.length === 0) return { connection: opsConnection(row) };
    const [updated] = await tx
      .update(connection)
      .set(set)
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)))
      .returning();
    for (const change of changes) {
      await tx.insert(connectionChange).values({
        tenantId: row.tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change,
      });
    }
    if (!updated) throw new Error("connection update returned nothing");
    return { connection: opsConnection(updated) };
  });

  // ── Runs ───────────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsRuns, async (ctx) => {
    const { tx, query } = ctx;
    // v0.12 W1-E: RunFilter, counts per day and groups by error (docs/plan.md §1.40).
    ensureFilterClients(ctx, query.filter);
    const where: SQL[] = [
      inArray(run.tenantId, [...ctx.tenantIds]),
      ...runFilterWhere(query.filter, ctx.services.platform.ctx.tools.specs()),
    ];
    // DECISION (speed run 6.3): the list's reads are asked together in the request's transaction
    // (docs/plan.md §1.82): the rows with the groups and the days, then what the rows name.
    const [rows, groups, perDay] = await Promise.all([
      tx
        .select(runListColumns)
        .from(run)
        .where(and(...where))
        .orderBy(desc(run.createdAt))
        .limit(query.limit),
      query.groupBy === "error" ? runErrorGroups(tx, where) : undefined,
      query.perDay ? runsPerDay(tx, where) : undefined,
    ]);
    const [subjects, views, agents] = await Promise.all([
      runSubjects(tx, ctx.tenantIds, rows, ctx.services.platform),
      opsRunViews(tx, rows, ctx.services),
      agentRefs(tx, ctx.tenantIds, [
        ...rows.map((r) => r.agentId),
        ...(groups ?? []).flatMap((g) => g.agents),
      ]),
    ]);
    return {
      runs: views.map((v) => ({ ...v, subject: subjects.get(v.id) })),
      agents,
      ...(perDay ? { perDay } : {}),
      ...(groups ? { groups } : {}),
    };
  });

  mount(app, routes.opsRun, async (ctx) => (await opsRunDetail(ctx, ctx.params.id)).response);

  mount(app, routes.opsRunStatus, async (ctx) =>
    opsRunStatus(ctx.tx, ctx.tenantIds, ctx.params.id),
  );

  // ── Inbox ──────────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsInbox, async (ctx) => {
    const { tx, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const where: SQL[] = [
      inArray(inboxItem.tenantId, [...ctx.tenantIds]),
      eq(inboxItem.status, query.status),
    ];
    if (query.client) where.push(eq(inboxItem.tenantId, query.client));
    if (query.assigned === "operator") {
      // DECISION: "Assigned to you" also lists every item of the Sandbox, which the operator
      // resolves whoever it is assigned to (docs/plan.md §1.5 "Sandbox inbox").
      const sandboxes = [...(await sandboxIds(tx, ctx.tenantIds))];
      const mine = eq(inboxItem.assigneeRole, "operator");
      where.push(
        sandboxes.length ? (or(mine, inArray(inboxItem.tenantId, sandboxes)) as SQL) : mine,
      );
    }
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(and(...where))
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    const operatorIn = await operatorApprovers(
      tx,
      ctx.session.user.id,
      rows.map((i) => i.tenantId),
    );
    return {
      items: rows.map((i) => opsInboxItem(i, operatorIn(i.tenantId), ctx.services.platform)),
      agents: await agentRefs(
        tx,
        ctx.tenantIds,
        rows.map((i) => i.agentId),
      ),
    };
  });

  mount(app, routes.opsResolveInbox, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    const [item] = await tx
      .select({ tenantId: inboxItem.tenantId })
      .from(inboxItem)
      .where(and(eq(inboxItem.id, params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    // Recorded as the operator, as everywhere; in the Sandbox they may resolve any item.
    const by = (await operatorApprovers(tx, session.user.id, [item.tenantId]))(item.tenantId);
    const collect: EventRow[] = [];
    const outcome = await resolveInboxItem(tx, {
      tenantId: item.tenantId,
      itemId: params.id,
      by,
      body,
      registry: services.platform.events,
      collect,
      // R5: a late no is offered an undo when its write's tool says how.
      tools: services.platform.tools,
    });
    // R7: and a conversation's own event beside it, for a v4 conversation step.
    if (outcome.resume || outcome.conversation) {
      ctx.afterCommit(() => sendResolution(services.instances, outcome));
    }
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    return { item: opsInboxItem(outcome.item, by, services.platform) };
  });
}

/**
 * The back office's run view (`opsRun`): steps, tool calls, writes, inbox items, oversight, the
 * owner's checks and the audit state; with the rows it was built from, for the run's export.
 */
export async function opsRunDetail(
  {
    tx,
    tenantIds,
    session,
    services,
  }: Pick<HandlerCtx<RouteSpec>, "tx" | "tenantIds" | "session" | "services">,
  id: string,
) {
  const [r] = await tx
    .select()
    .from(run)
    .where(and(eq(run.id, id), inArray(run.tenantId, [...tenantIds])));
  if (!r) throw notFound("run");
  // DECISION (speed run 6.2): with the run read, everything else is asked together in the
  // request's transaction (docs/plan.md §1.82), and the version's bundle is read once and passed
  // down (it was read again for the list view's workflow name and failed step).
  const ofRun = { runId: r.id, tenantId: r.tenantId };
  const [
    steps,
    calls,
    actions,
    modelRows,
    items,
    [version],
    [ref],
    operatorIn,
    waits,
    subjects,
    conversations,
    oversight,
    ownerChecks,
    audit,
  ] = await Promise.all([
    tx
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, ofRun.runId), eq(stepRun.tenantId, ofRun.tenantId)))
      .orderBy(stepRun.startedAt, stepRun.id),
    // The columns the view shows (`opsToolCall`), for the run's steps.
    tx
      .select({
        id: toolCall.id,
        stepRunId: toolCall.stepRunId,
        tool: toolCall.tool,
        input: toolCall.input,
        output: toolCall.output,
        status: toolCall.status,
        durationMs: toolCall.durationMs,
        externalActionId: toolCall.externalActionId,
      })
      .from(toolCall)
      .where(
        and(
          eq(toolCall.tenantId, ofRun.tenantId),
          inArray(
            toolCall.stepRunId,
            tx
              .select({ id: stepRun.id })
              .from(stepRun)
              .where(and(eq(stepRun.runId, ofRun.runId), eq(stepRun.tenantId, ofRun.tenantId))),
          ),
        ),
      )
      .orderBy(toolCall.createdAt),
    tx
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.runId, r.id), eq(externalAction.tenantId, r.tenantId)))
      .orderBy(externalAction.createdAt),
    // v0.13 W2-H: which models each step ran on (a task skill's own, the agent's, or a step's).
    tx
      .select({ stepRunId: modelCall.stepRunId, model: modelCall.model })
      .from(modelCall)
      .where(and(eq(modelCall.runId, r.id), eq(modelCall.tenantId, r.tenantId)))
      .orderBy(modelCall.createdAt, modelCall.id),
    tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, r.id), eq(inboxItem.tenantId, r.tenantId)))
      .orderBy(inboxItem.createdAt),
    tx
      .select({ version: agentVersion.version, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId))),
    agentRefs(tx, tenantIds, [r.agentId]),
    operatorApprovers(tx, session.user.id, [r.tenantId]),
    runWaits(tx, [r], reachContext(services)),
    runSubjects(tx, [r.tenantId], [r], services.platform),
    // P-4: each conversation step's transcript, with its turns' models and cost (§1.66).
    runConversations(tx, r.tenantId, r.id),
    // v0.13 W2-I: each oversight decision with its note, input change, model and cost.
    runOversight(tx, r.tenantId, r.id),
    // Wave 6: the owner's check on each attempt, and the run's place in the audit queue.
    runOwnerChecks(tx, r.tenantId, r.id),
    runAuditState(tx, r.tenantId, r.id),
  ]);
  const modelsByStep = new Map<string, string[]>();
  for (const c of modelRows) {
    const list = modelsByStep.get(c.stepRunId) ?? [];
    if (!list.includes(c.model)) list.push(c.model);
    modelsByStep.set(c.stepRunId, list);
  }
  const wf = version?.bundle.workflows.find((w) => w.slug === r.workflowSlug);
  const view = runListView(
    r,
    waits.get(r.id) ?? null,
    wf ? { name: wf.name, workflow: wf.workflow } : undefined,
  );
  const cited = steps.flatMap((s) => sourcesOf(s.output));
  const [names, stepFacts] = await Promise.all([
    sourceNames(tx, [r.tenantId], cited),
    // Skill model (2026-11-10), wave A: each step's kind (Deterministic or AI) and write label.
    wf ? stepModelFacts(tx, r.tenantId, wf.workflow, services.platform) : {},
  ]);
  const outcomes = stepOutcomes(steps, items);
  const response = {
    run: { ...view, subject: subjects.get(r.id) },
    steps: steps.map((s) => ({
      ...opsStep(s),
      models: modelsByStep.get(s.id) ?? [],
      ...(conversations.has(s.id) ? { conversation: conversations.get(s.id) } : {}),
      // Wave 5: how the step ended, the word a later `if` routes on.
      ...(outcomes.has(s.id) ? { outcome: outcomes.get(s.id) } : {}),
    })),
    toolCalls: calls.map(opsToolCall),
    actions: actions.map((a) => opsAction(a, services.platform)),
    inbox: items.map((i) => opsInboxItem(i, operatorIn(i.tenantId), services.platform)),
    agent: ref ?? null,
    version: version?.version ?? null,
    workflow: wf ? { slug: wf.slug, name: wf.name, definition: wf.workflow } : null,
    oversight,
    sourceNames: names,
    ownerChecks,
    audit,
    stepFacts,
  };
  return { response, rows: { run: r, steps, items, version, workflow: wf ?? null } };
}
