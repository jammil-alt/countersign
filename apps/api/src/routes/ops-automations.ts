// v0.12 W2-B: automations in the back office (ARCHITECTURE §10.7, §14 "Automations"; docs/plan.md
// §1.45). Shared automations (tenant_id null) and the clients' own; every edit a new immutable
// `automation_version` (draft → publish → rollback); "used by" from the live versions of agents;
// the clean-run rate from the last 30 days of live runs; and "Save as automation" from an agent's
// steps. Every handler runs inside withOperator(the clients served). The clients' snapshot copies
// of shared automations (`shared:<slug>`) are never listed or edited here.

import {
  type AgentRow,
  automationContext,
  bundleAutomationRefs,
  createAutomation,
  createAutomationVersion,
  createVersion,
  getAgent,
  getVersion,
  publishAutomation,
  resolveAutomation,
  rollbackAutomation,
  SHARED_COPY_PREFIX,
  schemaFields,
  skillContext,
} from "@countersign/agents";
import {
  type AgentBundle,
  AUTOMATION_SKILL_REF_PREFIX,
  type AutomationHealth,
  type AutomationListItem,
  type AutomationUse,
  automationOutputSchema,
  automationRef,
  type BuilderAutomation,
  parseAutomationRef,
  routes,
  type SkillDefinition,
  stepsToAutomation,
  uuidv7,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  automation,
  automationVersion,
  run,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import {
  type AppEnv,
  ensureClient,
  type HandlerCtx,
  HttpError,
  iso,
  mount,
  notFound,
} from "../http";
import type { Platform } from "../platform";

type Scope = Pick<HandlerCtx<never>, "tx" | "tenantIds">;
type AutomationRow = typeof automation.$inferSelect;
type AutomationVersionRow = typeof automationVersion.$inferSelect;

/** How far back the clean-run rate looks (ARCHITECTURE §10.7). */
const HEALTH_DAYS = 30;

export function automationVersionView(v: AutomationVersionRow) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    definition: v.definition,
    changeNote: v.changeNote,
    authorId: v.authorId,
    parentVersionId: v.parentVersionId,
    createdAt: iso(v.createdAt) as string,
  };
}

function scopeFilter(ctx: Scope, client?: string) {
  const tenants = client ? [client] : [...ctx.tenantIds];
  return tenants.length > 0
    ? or(isNull(automation.tenantId), inArray(automation.tenantId, tenants))
    : isNull(automation.tenantId);
}

/** Automations in scope with their versions (newest first), shared copies left out. */
async function automationRows(ctx: Scope, client?: string) {
  const rows = (await ctx.tx.select().from(automation).where(scopeFilter(ctx, client))).filter(
    (r) => !r.slug.startsWith(SHARED_COPY_PREFIX),
  );
  const versions = rows.length
    ? await ctx.tx
        .select()
        .from(automationVersion)
        .where(
          inArray(
            automationVersion.automationId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(desc(automationVersion.version))
    : [];
  return rows.map((row) => {
    const mine = versions.filter((v) => v.automationId === row.id);
    return {
      row,
      versions: mine,
      live: mine.find((v) => v.id === row.liveVersionId) ?? null,
      latest: mine[0] ?? null,
    };
  });
}
type Entry = Awaited<ReturnType<typeof automationRows>>[number];

async function clientNames(ctx: Scope): Promise<Map<string, string>> {
  if (ctx.tenantIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, [...ctx.tenantIds]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** For each slug, the clients with their own automation of that slug (it shadows the shared one). */
function shadowing(entries: readonly Entry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.row.tenantId === null) continue;
    const set = out.get(e.row.slug) ?? new Set<string>();
    set.add(e.row.tenantId);
    out.set(e.row.slug, set);
  }
  return out;
}

/** Whether a use in `tenantId` (null: a template) is of this automation row. */
function usesRow(row: AutomationRow, tenantId: string | null, shadowed: Map<string, Set<string>>) {
  if (row.tenantId !== null) return tenantId === row.tenantId;
  return tenantId === null || !shadowed.get(row.slug)?.has(tenantId);
}

/** Live versions of templates and client agents in scope, with the automations they pin. */
async function liveUses(ctx: Scope) {
  const agents = await ctx.tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.testCopy, false),
        ctx.tenantIds.length > 0
          ? or(isNull(agent.tenantId), inArray(agent.tenantId, [...ctx.tenantIds]))
          : isNull(agent.tenantId),
      ),
    );
  const live = agents.filter((a) => a.liveVersionId);
  if (live.length === 0) return [];
  const versions = await ctx.tx
    .select({ id: agentVersion.id, version: agentVersion.version, bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(
      inArray(
        agentVersion.id,
        live.map((a) => a.liveVersionId as string),
      ),
    );
  const clients = await clientNames(ctx);
  return live.flatMap((a) => {
    const v = versions.find((x) => x.id === a.liveVersionId);
    if (!v) return [];
    return bundleAutomationRefs(v.bundle as AgentBundle).map(
      (ref): AutomationUse & { tenantId: string | null } => ({
        agentId: a.id,
        kind: a.kind,
        slug: a.slug,
        name: a.name,
        clientId: a.tenantId,
        clientName: a.tenantId ? (clients.get(a.tenantId) ?? null) : null,
        ref,
        version: v.version,
        tenantId: a.tenantId,
      }),
    );
  });
}
type Uses = Awaited<ReturnType<typeof liveUses>>;

/**
 * Use steps of live runs in the last 30 days that ended, by client and pinned reference, and how
 * many were clean.
 */
// DECISION: "clean" (ARCHITECTURE §10.7: succeeded with no step retried) is a use step that
// succeeded in a live run that is not a retry of another run, and (v0.14 W4-B) whose own row and
// every inner step's row (`${use}/${inner}`) count one attempt: `step_run.attempts` now counts the
// platform's retries and oversight's (docs/plan.md §1.45 "Clean-run rate"). A use step reused by a
// retry is the first run's, so it counts once.
const innerStep = alias(stepRun, "inner_step");

async function healthRows(ctx: Scope) {
  if (ctx.tenantIds.length === 0) return [];
  const since = new Date(Date.now() - HEALTH_DAYS * 24 * 60 * 60 * 1000);
  return (
    ctx.tx
      .select({
        tenantId: stepRun.tenantId,
        skillRef: stepRun.skillRef,
        uses: sql<number>`count(distinct ${stepRun.id})::int`,
        clean: sql<number>`(count(distinct ${stepRun.id}) filter (where ${stepRun.status} = 'succeeded' and ${run.retryOf} is null and ${stepRun.attempts} <= 1 and ${innerStep.id} is null))::int`,
      })
      .from(stepRun)
      .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
      // v0.14 W4-B: an inner step of this use step tried more than once (a plain join, no subquery
      // in the select list). Prefix compared with left(), not LIKE: step ids may hold `_`.
      .leftJoin(
        innerStep,
        and(
          eq(innerStep.runId, stepRun.runId),
          eq(innerStep.tenantId, stepRun.tenantId),
          sql`left(${innerStep.nodeId}, length(${stepRun.nodeId}) + 1) = ${stepRun.nodeId} || '/'`,
          sql`${innerStep.attempts} > 1`,
        ),
      )
      .where(
        and(
          inArray(stepRun.tenantId, [...ctx.tenantIds]),
          eq(stepRun.nodeType, "use_automation"),
          inArray(stepRun.status, ["succeeded", "failed"]),
          eq(run.mode, "live"),
          gte(run.createdAt, since),
        ),
      )
      .groupBy(stepRun.tenantId, stepRun.skillRef)
  );
}
type Health = Awaited<ReturnType<typeof healthRows>>;

function healthOf(row: AutomationRow, health: Health, shadowed: Map<string, Set<string>>) {
  let uses = 0;
  let clean = 0;
  for (const h of health) {
    const ref = h.skillRef?.startsWith(AUTOMATION_SKILL_REF_PREFIX)
      ? h.skillRef.slice(AUTOMATION_SKILL_REF_PREFIX.length)
      : null;
    if (!ref || parseAutomationRef(ref).slug !== row.slug) continue;
    if (!usesRow(row, h.tenantId, shadowed)) continue;
    uses += h.uses;
    clean += h.clean;
  }
  const out: AutomationHealth = { uses, clean, cleanRunRate: uses > 0 ? clean / uses : null };
  return out;
}

function usedByOf(row: AutomationRow, uses: Uses, shadowed: Map<string, Set<string>>) {
  return uses
    .filter((u) => parseAutomationRef(u.ref).slug === row.slug)
    .filter((u) => usesRow(row, u.tenantId, shadowed))
    .map(({ tenantId: _tenantId, ...u }) => u);
}

function listItem(
  e: Entry,
  input: {
    clients: Map<string, string>;
    uses: Uses;
    health: Health;
    shadowed: Map<string, Set<string>>;
  },
): AutomationListItem | null {
  const shown = e.live ?? e.latest;
  if (!shown) return null;
  const def = shown.definition;
  return {
    id: e.row.id,
    slug: e.row.slug,
    name: def.name,
    description: def.description,
    source: e.row.tenantId === null ? "shared" : "client",
    clientId: e.row.tenantId,
    clientName: e.row.tenantId ? (input.clients.get(e.row.tenantId) ?? null) : null,
    status: e.row.status,
    liveVersion: e.live?.version ?? null,
    latestVersion: e.latest?.version ?? null,
    latestStatus: e.latest?.status ?? null,
    inputs: schemaFields(def.input),
    outputs: Object.keys(def.output),
    requires: def.requires,
    usedBy: new Set(usedByOf(e.row, input.uses, input.shadowed).map((u) => u.agentId)).size,
    health: healthOf(e.row, input.health, input.shadowed),
  };
}

async function context(ctx: Scope) {
  const all = await automationRows(ctx);
  return {
    all,
    clients: await clientNames(ctx),
    uses: await liveUses(ctx),
    health: await healthRows(ctx),
    shadowed: shadowing(all),
  };
}

async function automationInScope(ctx: Scope, id: string): Promise<AutomationRow> {
  const [row] = await ctx.tx.select().from(automation).where(eq(automation.id, id));
  if (!row || row.slug.startsWith(SHARED_COPY_PREFIX)) throw notFound("automation");
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("automation");
  return row;
}

async function itemFor(ctx: Scope, row: AutomationRow) {
  const c = await context(ctx);
  const entry = c.all.find((e) => e.row.id === row.id);
  const item = entry ? listItem(entry, c) : null;
  if (!entry || !item) throw notFound("automation");
  return { item, entry, usedBy: usedByOf(row, c.uses, c.shadowed) };
}

/** The workflow whose top-level steps hold the first selected id. */
function workflowOf(bundle: AgentBundle, stepId: string) {
  return bundle.workflows.find((w) => w.workflow.steps.some((s) => s.id === stepId));
}

async function saveFromSteps(ctx: HandlerCtx<typeof routes.opsAutomationFromSteps>, row: AgentRow) {
  const { tx, body, session, services } = ctx;
  const registry = services.platform.ctx;
  const v = await getVersion(tx, body.versionId);
  if (v.agentId !== row.id) throw notFound("version");
  const bundle = v.bundle as AgentBundle;
  const holder = workflowOf(bundle, body.stepIds[0] as string);
  if (!holder) {
    throw new HttpError(
      422,
      "not_top_level",
      "only steps at the top of a workflow can become an automation",
    );
  }
  const { skills } = await skillContext(tx, {
    tenantId: row.tenantId,
    bundle,
    catalog: registry.catalog,
  });
  const used = await automationContext(tx, {
    tenantId: row.tenantId,
    bundle,
    catalog: registry.catalog,
  });
  const result = stepsToAutomation({
    workflow: holder.workflow,
    stepIds: body.stepIds,
    slug: body.slug,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    newId: () => uuidv7(),
    ctx: {
      skills: { ...used.skills, ...skills },
      tools: registry.tools.specs(),
      ...(registry.events ? { events: registry.events } : {}),
      automations: used.automations,
    },
    clientAgent: row.kind === "client",
  });
  if (!result.ok) throw new HttpError(422, result.code, result.message);
  // DECISION: "Save as automation" always makes a new automation (its slug must be free) at v1,
  // a draft; the agent's new draft pins `slug@1` and publishes once the automation is published.
  // DECISION: a template's steps become a shared automation; a client agent's become that
  // client's own, so one client's steps never reach another (invariant 1).
  const created = await createAutomation(tx, {
    tenantId: row.tenantId,
    definition: result.automation,
    authorId: session.user.id,
    changeNote: `Saved from ${row.name} v${v.version}`,
    ctx: registry,
  });
  const next: AgentBundle = {
    ...bundle,
    workflows: bundle.workflows.map((w) =>
      w.slug === holder.slug ? { ...w, workflow: result.workflow } : w,
    ),
  };
  const agentVersionRow = await createVersion(tx, {
    agentId: row.id,
    bundle: next,
    parentVersionId: v.id,
    authorType: "operator",
    authorId: session.user.id,
    changeNote: `Steps saved as the automation ${body.name}`,
  });
  return { created, agentVersion: { id: agentVersionRow.id, version: agentVersionRow.version } };
}

export function opsAutomationRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsAutomations, async (ctx) => {
    if (ctx.query.client) ensureClient(ctx, ctx.query.client);
    const c = await context(ctx);
    const items = c.all
      .filter(
        (e) => !ctx.query.client || e.row.tenantId === null || e.row.tenantId === ctx.query.client,
      )
      .map((e) => listItem(e, c))
      .filter((i): i is AutomationListItem => i !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { automations: items };
  });

  mount(app, routes.opsCreateAutomation, async (ctx) => {
    const { tx, body, session, services } = ctx;
    if (body.clientId) ensureClient(ctx, body.clientId);
    const created = await createAutomation(tx, {
      tenantId: body.clientId ?? null,
      definition: body.definition,
      authorId: session.user.id,
      changeNote: body.changeNote ?? "Created",
      ctx: services.platform.ctx,
    });
    const { item } = await itemFor(ctx, created.automation);
    return {
      automation: item,
      version: automationVersionView(created.version),
      errors: created.errors,
    };
  });

  mount(app, routes.opsAutomation, async (ctx) => {
    const row = await automationInScope(ctx, ctx.params.id);
    const { item, entry, usedBy } = await itemFor(ctx, row);
    return {
      automation: item,
      versions: entry.versions.map(automationVersionView),
      usedBy,
    };
  });

  mount(app, routes.opsSaveAutomationVersion, async (ctx) => {
    const row = await automationInScope(ctx, ctx.params.id);
    const saved = await createAutomationVersion(ctx.tx, {
      automationId: row.id,
      definition: ctx.body.definition,
      parentVersionId: ctx.body.parentVersionId ?? null,
      authorId: ctx.session.user.id,
      changeNote: ctx.body.changeNote ?? null,
      ctx: ctx.services.platform.ctx,
    });
    return { version: automationVersionView(saved.version), errors: saved.errors };
  });

  mount(app, routes.opsPublishAutomation, async (ctx) => {
    const row = await automationInScope(ctx, ctx.params.id);
    const v = await publishAutomation(ctx.tx, {
      automationId: row.id,
      versionId: ctx.params.vid,
      ctx: ctx.services.platform.ctx,
    });
    return { version: automationVersionView(v) };
  });

  mount(app, routes.opsRollbackAutomation, async (ctx) => {
    const row = await automationInScope(ctx, ctx.params.id);
    const v = await rollbackAutomation(ctx.tx, {
      automationId: row.id,
      toVersionId: ctx.body.versionId,
      authorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    });
    return { version: automationVersionView(v) };
  });

  mount(app, routes.opsAutomationFromSteps, async (ctx) => {
    const row = await getAgent(ctx.tx, ctx.body.agentId);
    if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
    const { created, agentVersion: next } = await saveFromSteps(ctx, row);
    const { item } = await itemFor(ctx, created.automation);
    return {
      automation: item,
      version: automationVersionView(created.version),
      agentVersion: next,
    };
  });
}

/**
 * What the workflow builder can place for an agent (docs/plan.md §1.45): the live version of each
 * automation the agent may use (shared ones, and its client's own, which shadow a shared one of
 * the same slug), and every version its latest version already pins, typed for later steps.
 */
export async function builderAutomations(
  tx: Tx,
  input: {
    tenantId: string | null;
    tenantIds: readonly string[];
    bundle: AgentBundle | null;
    skills: Record<string, SkillDefinition>;
    platform: Platform;
  },
): Promise<BuilderAutomation[]> {
  const typing = { skills: input.skills, tools: input.platform.tools.specs() };
  const out = new Map<string, BuilderAutomation>();
  const add = (
    row: Pick<AutomationRow, "tenantId">,
    v: Pick<AutomationVersionRow, "version" | "status" | "definition">,
  ) => {
    const def = v.definition;
    const ref = automationRef(def.slug, v.version);
    if (out.has(ref)) return;
    out.set(ref, {
      ref,
      slug: def.slug,
      version: v.version,
      name: def.name,
      description: def.description,
      source: row.tenantId === null ? "shared" : "client",
      status: v.status,
      definition: def,
      outputSchema: automationOutputSchema(def, typing),
    });
  };
  const rows = await tx
    .select({ a: automation, v: automationVersion })
    .from(automation)
    .innerJoin(automationVersion, eq(automationVersion.id, automation.liveVersionId))
    .where(
      and(
        eq(automation.status, "active"),
        input.tenantId === null
          ? isNull(automation.tenantId)
          : or(isNull(automation.tenantId), eq(automation.tenantId, input.tenantId)),
      ),
    );
  const own = new Set(rows.filter((r) => r.a.tenantId !== null).map((r) => r.a.slug));
  for (const { a, v } of rows) {
    if (a.slug.startsWith(SHARED_COPY_PREFIX)) continue;
    if (a.tenantId === null && own.has(a.slug)) continue;
    add(a, v);
  }
  if (input.bundle) {
    for (const ref of bundleAutomationRefs(input.bundle)) {
      if (out.has(ref)) continue;
      const r = await resolveAutomation(tx, { tenantId: input.tenantId, ref });
      if (r) {
        add(
          { tenantId: r.source === "client" ? input.tenantId : null },
          { version: r.version, status: r.status, definition: r.definition },
        );
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
}
