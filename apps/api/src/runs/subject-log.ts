// What each run was about, kept as it happens (docs/reporting-plan.md §3 R1, docs/plan.md §1.188):
// the wiring of packages/agents' writer (`writeStepSubjectsTx`) into the executor's step log, with
// the registry's tool specs and whether the client's timeline shows the step; and the backfill of
// the last 90 days of runs, batched per client inside withTenant (invariant 1).

import {
  keepSubjects,
  type SubjectToolLookup,
  writeStepSubjectsTx,
  writeTriggerSubjectsTx,
} from "@countersign/agents";
import { type AnyAgentBundle, checkKindOf, shownOnTimeline } from "@countersign/core";
import { agentVersion, type Db, run, stepRun, type Tx, tenant, withTenant } from "@countersign/db";
import { and, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { stepFinder, stepOfRow } from "../routes/run-checks";

type StoredWorkflow = AnyAgentBundle["workflows"][number]["workflow"];

/** The registry's spec for a tool id (packs' tools included), for the writer. */
export function subjectTools(platform: Pick<Platform, "tools">): SubjectToolLookup {
  return (id) => platform.tools.get(id)?.spec;
}

/**
 * Whether the client's timeline shows a step row, by its node id: as the portal reads it (its
 * step's `client` setting, else its kind). The portal searches only these rows (R2).
 */
// DECISION: a check row (`:confer:`, `:notify:`…) is never the client's here, though the portal
// shows a confer's verdict: the row's sources are the check's, and the portal leaves them out.
export function clientShowsNode(workflow: StoredWorkflow | undefined): (nodeId: string) => boolean {
  const find = stepFinder(workflow);
  return (nodeId) => {
    if (checkKindOf(nodeId)) return false;
    const step = stepOfRow(find, nodeId);
    return !!step && shownOnTimeline(step);
  };
}

/**
 * Keeps what a finished step was about, in the step log's transaction but in its own savepoint:
 * a failure is reported and never undoes the step's row.
 */
export async function keepStepSubjects(
  tx: Tx,
  input: {
    tenantId: string;
    stepRunId: string;
    tools: SubjectToolLookup;
    visible: (nodeId: string) => boolean;
  },
): Promise<number> {
  return keepSubjects(
    tx,
    (sp) => writeStepSubjectsTx(sp, input),
    (error) =>
      reportHandled(`keeping what step ${input.stepRunId} was about failed`, error, {
        job: "run_subject",
        client: input.tenantId,
      }),
  );
}

// ── The backfill ────────────────────────────────────────────────────────────────────────────────

/** The hourly minute the backfill runs at (apart from the other hourly passes). */
export const RUN_SUBJECT_BACKFILL_MINUTE = 47;
/** How far back it reaches. */
export const RUN_SUBJECT_BACKFILL_DAYS = 90;
/** Runs per client per transaction, and per client per tick. */
const BATCH = 200;
const PER_TICK = 1000;

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** A step output whose `sources` hold a uuid (a jsonpath literal: `like_regex` takes no variable). */
const SOURCES_PATH = `'$.sources[*] ? (@.type() == "string" && @ like_regex "${UUID_RE}")'::jsonpath`;

/**
 * A client's finished runs in the window that have nothing kept yet, though something would be:
 * a trigger that names a document or message, a change that was done, or a step's `sources`.
 * Each of these always keeps a row, so a run done once is never picked again.
 */
// DECISION: the backfill is a pass that stops finding work, not a script run by hand (docs/plan.md
// §1.188): it runs in the cron, so it has the registry's tool specs, and once the window's runs
// are kept each tick is one query per client. A tool call's `about` is kept too when the step's
// other subjects bring the run in, but alone it doesn't (a run picked only for it might keep
// nothing, and be picked again every hour).
// Overnight S3.2: and the runs kept before writes named their counterparty: a done change of a
// tool that names one, whose change names it, with no row for it on its step yet. Once kept,
// the row is there, so such a run too is picked once.
async function runsToFill(
  tx: Tx,
  tenantId: string,
  since: Date,
  limit: number,
  missing: SQL | null,
) {
  return tx
    .select({
      id: run.id,
      trigger: run.trigger,
      mode: run.mode,
      agentVersionId: run.agentVersionId,
      workflowSlug: run.workflowSlug,
    })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        gte(run.createdAt, since),
        inArray(run.status, ["succeeded", "failed", "cancelled"]),
        sql`((not exists (select 1 from run_subject s where s.tenant_id = ${run.tenantId} and s.run_id = ${run.id})
        and (
          coalesce(${run.trigger}->'payload'->>'documentId', ${run.trigger}->>'documentId', '') ~ ${UUID_RE}
          or coalesce(${run.trigger}->'payload'->>'messageId', ${run.trigger}->>'messageId', '') ~ ${UUID_RE}
          or (${run.trigger}->>'type' = 'message'
            and coalesce(${run.trigger}->'payload'->>'rawRecordId', ${run.trigger}->>'rawRecordId', '') ~ ${UUID_RE})
          or exists (select 1 from external_action a
            join step_run sr on sr.id = a.step_run_id and sr.tenant_id = a.tenant_id
            where a.tenant_id = ${run.tenantId} and a.run_id = ${run.id}
              and a.status = 'done' and sr.status in ('succeeded', 'failed'))
          or exists (select 1 from step_run sr
            where sr.tenant_id = ${run.tenantId} and sr.run_id = ${run.id}
              and sr.status in ('succeeded', 'failed')
              and jsonb_path_exists(sr.output, ${sql.raw(SOURCES_PATH)}))
        ))${
          missing
            ? sql` or exists (select 1 from external_action a
            join step_run sr on sr.id = a.step_run_id and sr.tenant_id = a.tenant_id
            where a.tenant_id = ${run.tenantId} and a.run_id = ${run.id}
              and a.status = 'done' and sr.status in ('succeeded', 'failed') and ${missing})`
            : sql``
        })`,
      ),
    )
    .orderBy(desc(run.createdAt), run.id)
    .limit(limit);
}

/**
 * Over a done change `a` (in `runsToFill`): its tool names a counterparty, the change names one
 * there, and its step keeps no row for it. Null when no registered tool names one.
 */
export function counterpartyMissing(platform: Pick<Platform, "tools">): SQL | null {
  const conds = platform.tools.list().flatMap(({ spec }) => {
    const c = spec.counterparty;
    if (!c) return [];
    const [root, ...keys] = c.path.split(".");
    const doc = root === "before" ? sql`a.before` : sql`coalesce(a.edited_input, a.input)`;
    const at = `{${keys.join(",")}}`;
    const idAt = `{${[...keys, "id"].join(",")}}`;
    // The id as `counterpartyOf` reads it: the object's `id`, else the value itself.
    const id = sql`btrim(coalesce(${doc} #>> ${idAt}::text[],
      case when jsonb_typeof(${doc} #> ${at}::text[]) in ('string', 'number')
        then ${doc} #>> ${at}::text[] end))`;
    return [
      sql`(a.tool = ${spec.id} and coalesce(${id}, '') <> ''
        and not exists (select 1 from run_subject s
          where s.tenant_id = a.tenant_id and s.run_id = a.run_id and s.step_run_id = a.step_run_id
            and s.kind = ${c.kind} and s.role = 'read' and s.connector is not null
            and s.external_id = left(${id}, 200)))`,
    ];
  });
  return conds.length > 0 ? sql`(${sql.join(conds, sql` or `)})` : null;
}

/** The workflow each (version, slug) ran, read once per pair. */
async function workflowsOf(
  tx: Tx,
  tenantId: string,
  pairs: readonly { agentVersionId: string; workflowSlug: string }[],
): Promise<Map<string, StoredWorkflow | undefined>> {
  const out = new Map<string, StoredWorkflow | undefined>();
  for (const p of pairs) {
    const key = `${p.agentVersionId}:${p.workflowSlug}`;
    if (out.has(key)) continue;
    const [row] = await tx
      .select({
        workflow: sql<unknown>`jsonb_path_query_first(${agentVersion.bundle}, '$.workflows[*] ? (@.slug == $slug).workflow', jsonb_build_object('slug', ${p.workflowSlug}::text))`,
      })
      .from(agentVersion)
      .where(and(eq(agentVersion.id, p.agentVersionId), eq(agentVersion.tenantId, tenantId)));
    const w = row?.workflow;
    out.set(
      key,
      (typeof w === "string" ? JSON.parse(w) : (w ?? undefined)) as StoredWorkflow | undefined,
    );
  }
  return out;
}

/** Fills one batch of a client's runs; returns how many runs it looked at. */
export async function backfillClientRunSubjects(
  db: Db,
  platform: Pick<Platform, "tools">,
  tenantId: string,
  options: { now: Date; limit?: number },
): Promise<number> {
  const since = new Date(options.now.getTime() - RUN_SUBJECT_BACKFILL_DAYS * 86_400_000);
  const tools = subjectTools(platform);
  return withTenant(db, tenantId, async (tx) => {
    const runs = await runsToFill(
      tx,
      tenantId,
      since,
      options.limit ?? BATCH,
      counterpartyMissing(platform),
    );
    if (runs.length === 0) return 0;
    const workflows = await workflowsOf(tx, tenantId, runs);
    const steps = await tx
      .select({ id: stepRun.id, runId: stepRun.runId })
      .from(stepRun)
      .where(
        and(
          eq(stepRun.tenantId, tenantId),
          inArray(
            stepRun.runId,
            runs.map((r) => r.id),
          ),
          inArray(stepRun.status, ["succeeded", "failed"]),
        ),
      )
      .orderBy(stepRun.startedAt, stepRun.id);
    for (const r of runs) {
      const visible = clientShowsNode(workflows.get(`${r.agentVersionId}:${r.workflowSlug}`));
      await keepSubjects(
        tx,
        async (sp) => {
          let n = await writeTriggerSubjectsTx(sp, {
            tenantId,
            runId: r.id,
            trigger: r.trigger,
            mode: r.mode,
          });
          for (const s of steps) {
            if (s.runId !== r.id) continue;
            n += await writeStepSubjectsTx(sp, { tenantId, stepRunId: s.id, tools, visible });
          }
          return n;
        },
        (error) =>
          reportHandled(`backfilling what run ${r.id} was about failed`, error, {
            job: "run_subject",
            client: tenantId,
          }),
      );
    }
    return runs.length;
  });
}

/**
 * Hourly: each client's runs of the last 90 days that keep nothing yet, up to a thousand per
 * client per tick, in batches of two hundred.
 */
export async function runSubjectBackfillTick(
  db: Db,
  platform: Pick<Platform, "tools">,
  scheduledTime: Date,
): Promise<void> {
  if (scheduledTime.getUTCMinutes() !== RUN_SUBJECT_BACKFILL_MINUTE) return;
  const clients = await db.select({ id: tenant.id, retiredAt: tenant.retiredAt }).from(tenant);
  for (const c of clients) {
    if (c.retiredAt !== null) continue;
    try {
      for (let done = 0; done < PER_TICK; ) {
        const n = await backfillClientRunSubjects(db, platform, c.id, { now: scheduledTime });
        done += n;
        if (n < BATCH) break;
      }
    } catch (error) {
      reportHandled(`backfilling what runs were about failed for client ${c.id}`, error, {
        job: "run_subject",
        client: c.id,
      });
    }
  }
}
