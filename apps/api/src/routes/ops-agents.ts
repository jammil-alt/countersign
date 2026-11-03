// Back office: templates and client agents (ARCHITECTURE §9.3, §14): create, fork, copy, save
// drafts, publish, roll back, operate, activate, start runs and test runs, and validate workflows
// the way the builder does. Every handler runs inside withOperator(the clients served).

import {
  type AgentRow,
  activate,
  copyClientAgent,
  createClientAgent,
  createTemplate,
  createVersion,
  fork,
  getAgent,
  getVersion,
  listClientAgents,
  listTemplates,
  listVersions,
  type OperationalPatch,
  pause,
  publish,
  rollback,
  skillContext,
  templateTestCopy,
  updateInfo,
  updateOperational,
  validateForPublish,
} from "@countersign/agents";
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  routes,
  type SkillDefinition,
  validateWorkflow,
} from "@countersign/core";
import { tenant } from "@countersign/db";
import { type RoutableAgent, type RunRequest, requestRun } from "@countersign/workflows";
import { and, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { createRunRow } from "../runs/dispatch";
import { agentSummary, versionDetail, versionSummary } from "./mappers";

/** The agent, if it is visible to this request (templates, or a client agent of a served client). */
async function agentInScope(ctx: Pick<HandlerCtx<never>, "tx" | "tenantIds">, id: string) {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  return row;
}

function routable(row: AgentRow, liveBundle: AgentBundle | null): RoutableAgent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    status: row.status,
    runStatus: row.runStatus,
    liveVersionId: row.liveVersionId,
    liveBundle,
  };
}

/** The Sandbox client (settings.sandbox) this operator serves: where templates are test-run. */
async function sandboxClient(ctx: Pick<HandlerCtx<never>, "tx" | "tenantIds">): Promise<string> {
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

/** requestRun's refusals are plain errors: they are the caller's to fix. */
function request(make: () => RunRequest): RunRequest {
  try {
    return make();
  } catch (error) {
    throw new HttpError(409, "cannot_run", error instanceof Error ? error.message : String(error));
  }
}

/** Drops keys whose value is undefined (exactOptionalPropertyTypes: absent, not undefined). */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
const defined = <T extends object>(o: T): Defined<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;

export function opsAgentRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsTemplates, async ({ tx }) => ({
    templates: (await listTemplates(tx)).map(agentSummary),
  }));

  mount(app, routes.opsCreateTemplate, async ({ tx, body, session }) => {
    const created = await createTemplate(tx, {
      slug: body.slug,
      bundle: body.bundle,
      ...defined({ name: body.name, changeNote: body.changeNote, releaseNote: body.releaseNote }),
      authorType: "operator",
      authorId: session.user.id,
    });
    return { agent: agentSummary(created.agent), version: versionSummary(created.version) };
  });

  mount(app, routes.opsFork, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, body.clientId);
    const template = await agentInScope(ctx, params.id);
    if (template.kind !== "template") throw new HttpError(422, "not_a_template", "not a template");
    const versionId = body.versionId ?? template.liveVersionId;
    if (!versionId) throw new HttpError(409, "no_live_version", "publish the template first");
    const created = await fork(tx, {
      tenantId: body.clientId,
      slug: body.slug ?? template.slug,
      templateVersionId: versionId,
      actorId: session.user.id,
      ...defined({
        serviceName: body.serviceName,
        serviceDescription: body.serviceDescription,
      }),
    });
    return { agent: agentSummary(created.agent), version: versionSummary(created.version) };
  });

  mount(app, routes.opsClientAgents, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { agents: (await listClientAgents(ctx.tx, ctx.params.id)).map(agentSummary) };
  });

  mount(app, routes.opsCreateClientAgent, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    ensureClient(ctx, params.id);
    const fields = {
      tenantId: params.id,
      slug: body.slug,
      ...defined({
        name: body.name,
        serviceName: body.serviceName,
        serviceDescription: body.serviceDescription,
      }),
    };
    const created = body.copyFrom
      ? await (async () => {
          await agentInScope(ctx, body.copyFrom as string);
          return copyClientAgent(tx, {
            ...fields,
            sourceAgentId: body.copyFrom as string,
            actorId: session.user.id,
            ctx: { catalog: services.platform.catalog },
          });
        })()
      : await createClientAgent(tx, {
          ...fields,
          bundle: body.bundle,
          authorType: "operator",
          authorId: session.user.id,
          ...defined({ changeNote: body.changeNote }),
        });
    return { agent: agentSummary(created.agent), version: versionSummary(created.version) };
  });

  mount(app, routes.opsAgent, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const versions = await listVersions(ctx.tx, row.id);
    const live = versions.find((v) => v.id === row.liveVersionId) ?? null;
    const latest = versions[0] ?? null;
    let update = null;
    if (row.kind === "client" && row.templateId) {
      const info = await updateInfo(ctx.tx, { agentId: row.id });
      update = {
        available: info.available,
        behind: info.behind,
        baseVersionId: info.base?.id ?? null,
        templateLiveVersionId: info.templateLive?.id ?? null,
        releaseNote: info.releaseNote,
      };
    }
    return {
      agent: agentSummary(row),
      versions: versions.map(versionSummary),
      live: live ? versionDetail(live) : null,
      latest: latest ? versionDetail(latest) : null,
      update,
    };
  });

  mount(app, routes.opsAgentVersion, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const v = await getVersion(ctx.tx, ctx.params.vid);
    if (v.agentId !== row.id) throw notFound("version");
    return { version: versionDetail(v) };
  });

  mount(app, routes.opsSaveVersion, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const v = await createVersion(tx, {
      agentId: row.id,
      bundle: body.bundle,
      authorType: "operator",
      authorId: session.user.id,
      ...defined({
        parentVersionId: body.parentVersionId,
        changeNote: body.changeNote,
        releaseNote: body.releaseNote,
      }),
    });
    // Drafts may be saved with errors (§10.2); the editor shows what would stop a publish.
    const errors = await validateForPublish(tx, row, v.bundle, services.platform.ctx);
    return { version: versionSummary(v), errors };
  });

  mount(app, routes.opsPublish, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const v = await publish(ctx.tx, {
      agentId: row.id,
      versionId: ctx.params.vid,
      actorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    });
    return { version: versionSummary(v) };
  });

  mount(app, routes.opsRollback, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const v = await rollback(ctx.tx, {
      agentId: row.id,
      toVersionId: ctx.body.versionId,
      actorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    });
    return { version: versionSummary(v) };
  });

  mount(app, routes.opsOperation, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const patch = defined({ ...ctx.body }) as OperationalPatch;
    const updated = await updateOperational(ctx.tx, {
      agentId: row.id,
      actorId: ctx.session.user.id,
      patch,
    });
    return { agent: agentSummary(updated) };
  });

  mount(app, routes.opsActivate, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const updated = await activate(ctx.tx, {
      agentId: row.id,
      actorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    });
    return { agent: agentSummary(updated) };
  });

  mount(app, routes.opsPause, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    return {
      agent: agentSummary(await pause(ctx.tx, { agentId: row.id, actorId: ctx.session.user.id })),
    };
  });

  mount(app, routes.opsRunAgent, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const live = row.liveVersionId ? await getVersion(ctx.tx, row.liveVersionId) : null;
    const req = request(() =>
      requestRun({
        agent: routable(row, live?.bundle ?? null),
        workflowSlug: ctx.body.workflow,
        payload: ctx.body.input ?? {},
      }),
    );
    await createRunRow(ctx.tx, req);
    ctx.afterCommit(() => ctx.services.instances.start(req));
    return { runId: req.runId };
  });

  mount(app, routes.opsTestRun, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const v = await getVersion(ctx.tx, ctx.params.vid);
    if (v.agentId !== row.id) throw notFound("version");
    // DECISION: a template never runs for a client. Test-running a template version runs it as the
    // template's test copy in the Sandbox client: forked on the first test run, given a new
    // version holding this one's bundle on later ones (docs/plan.md §1.5 "Template test runs").
    const target =
      row.kind === "client"
        ? { agent: row, version: v }
        : await templateTestCopy(ctx.tx, {
            tenantId: await sandboxClient(ctx),
            templateVersionId: v.id,
            actorId: ctx.session.user.id,
          });
    const req = request(() =>
      requestRun({
        agent: routable(target.agent, null),
        workflowSlug: ctx.body.workflow,
        payload: ctx.body.payload ?? {},
        mode: "test",
        versionId: target.version.id,
        bundle: target.version.bundle,
      }),
    );
    await createRunRow(ctx.tx, req);
    ctx.afterCommit(() => ctx.services.instances.start(req));
    return { runId: req.runId, agentId: target.agent.id, versionId: target.version.id };
  });

  mount(app, routes.opsValidateWorkflow, async (ctx) => {
    const { tx, body, services } = ctx;
    const { platform } = services;
    let skills: Record<string, SkillDefinition> = Object.fromEntries(
      platform.catalog.list().map((s) => [s.id, s]),
    );
    let agentDef: AgentBundle["definition"] | undefined;
    if (body.agentId) {
      const row = await agentInScope(ctx, body.agentId);
      const [latest] = await listVersions(tx, row.id);
      const v = row.liveVersionId ? await getVersion(tx, row.liveVersionId) : latest;
      if (v) {
        const bundle = AgentBundleSchema.parse(v.bundle);
        agentDef = bundle.definition;
        const resolved = await skillContext(tx, {
          tenantId: row.tenantId,
          bundle,
          catalog: platform.catalog,
        });
        skills = { ...skills, ...resolved.skills };
      }
    }
    const result = validateWorkflow(body.workflow, {
      skills,
      tools: platform.tools.specs(),
      events: platform.events.byType(),
      ...(agentDef ? { agent: agentDef } : {}),
    });
    return { valid: result.valid, errors: result.errors };
  });

  mount(app, routes.opsEventCatalog, async ({ services }) => ({
    events: services.platform.events.list().map((e) => ({
      type: e.type,
      description: e.description,
      subjectType: e.subjectType ?? null,
      sample: e.sample,
    })),
  }));
}
