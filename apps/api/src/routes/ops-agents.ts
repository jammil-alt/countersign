// Back office: templates and client agents (ARCHITECTURE §9.3, §14): create, fork, copy, save
// drafts, publish, roll back, operate, activate, start runs and test runs, and validate workflows
// the way the builder does. Every handler runs inside withOperator(the clients served).

import {
  type AgentRow,
  activate,
  automationContext,
  copyClientAgent,
  createClientAgent,
  createTemplate,
  createVersion,
  discardDraft,
  fork,
  getAgent,
  getVersion,
  listClientAgents,
  listTemplates,
  listVersions,
  type OperationalPatch,
  pause,
  publish,
  requiredConnectors,
  restoreAgent,
  rollback,
  skillContext,
  snapshotSharedSkills,
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
import { connection, tenant } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { type RoutableAgent, type RunRequest, requestRun } from "@countersign/workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { markOperatorPause } from "../lifecycle/pause";
import { afterActivate } from "../lifecycle/stages";
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

/**
 * Binds a test copy's unbound required connectors to its client's connection for each, when the
 * client has one (a client has at most one connection per connector). Logged as any binding is.
 */
// DECISION: a template's test copy is bound to its client's connections on each test run where
// it is not bound yet, so a test run on the Sandbox or a chosen client reaches that client's tools
// without a trip to the copy's Settings. Bindings the operator set are kept (docs/plan.md §1.16).
async function bindTestCopy(
  ctx: Pick<HandlerCtx<never>, "tx" | "services" | "session">,
  copy: AgentRow,
  bundle: AgentBundle,
): Promise<AgentRow> {
  const tenantId = copy.tenantId as string;
  const { skills } = await skillContext(ctx.tx, {
    tenantId,
    bundle,
    catalog: ctx.services.platform.catalog,
  });
  // v0.12 W2-B: and the connectors of the automations it uses.
  const used = await automationContext(ctx.tx, {
    tenantId,
    bundle,
    catalog: ctx.services.platform.catalog,
  });
  const needed = requiredConnectors(
    bundle,
    skills,
    ctx.services.platform.tools,
    used.automations,
  ).filter((c) => !copy.bindings[c]);
  if (needed.length === 0) return copy;
  const rows = await ctx.tx
    .select({ id: connection.id, connector: connection.connector })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), inArray(connection.connector, needed)))
    .orderBy(connection.createdAt);
  const add: Record<string, string> = {};
  for (const r of rows) add[r.connector] ??= r.id;
  if (Object.keys(add).length === 0) return copy;
  return updateOperational(ctx.tx, {
    agentId: copy.id,
    actorId: ctx.session.user.id,
    patch: { bindings: { ...copy.bindings, ...add } },
  });
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
  mount(app, routes.opsTemplates, async ({ tx, query }) => ({
    templates: (await listTemplates(tx, { discarded: query.include === "discarded" })).map(
      agentSummary,
    ),
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
    const agents = await listClientAgents(ctx.tx, ctx.params.id, {
      discarded: ctx.query.include === "discarded",
    });
    return { agents: agents.map(agentSummary) };
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
    const activated = await activate(ctx.tx, {
      agentId: row.id,
      actorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    });
    // v0.12 W1-A: Activate starts the trial (bench → trial, or → live with "no writes"); on a
    // paused agent it resumes it and lifts the pause, whoever made it (ARCHITECTURE §10.9, §11.5).
    const updated =
      activated.kind === "client"
        ? await afterActivate(ctx.tx, {
            before: row,
            actorId: ctx.session.user.id,
            actor: {
              actorKind: "user",
              actorUserId: ctx.session.user.id,
              actorEmail: ctx.session.user.email,
              actorRole: ctx.role,
            },
            ctx: ctx.services.platform.ctx,
          })
        : activated;
    return { agent: agentSummary(updated) };
  });

  mount(app, routes.opsDiscardAgent, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const actorId = ctx.session.user.id;
    return { agent: agentSummary(await discardDraft(ctx.tx, { agentId: row.id, actorId })) };
  });

  mount(app, routes.opsRestoreAgent, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const actorId = ctx.session.user.id;
    return { agent: agentSummary(await restoreAgent(ctx.tx, { agentId: row.id, actorId })) };
  });

  mount(app, routes.opsPause, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const paused = await pause(ctx.tx, { agentId: row.id, actorId: ctx.session.user.id });
    // v0.12 W1-A: the operator's pause is recorded as the operator's: the client can't resume it.
    const updated = await markOperatorPause(ctx.tx, paused, ctx.session.user.id);
    return { agent: agentSummary(updated) };
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
    // Only a valid version can be test-run (ARCHITECTURE §10.2).
    // DECISION: a test run is checked exactly as a publish is, against the agent asked for: a
    // template as a template, a client agent with its bound connections, as the builder checks it
    // before it offers Test run (docs/plan.md §1.5).
    const errors = await validateForPublish(ctx.tx, row, v.bundle, ctx.services.platform.ctx);
    if (errors.length > 0) {
      throw new HttpError(422, "invalid_bundle", `v${v.version} does not validate`, errors);
    }
    const { clientId } = ctx.body;
    if (clientId !== undefined && row.kind === "client" && clientId !== row.tenantId) {
      throw new HttpError(
        422,
        "invalid_request",
        "a client agent test-runs on its own client's data only",
      );
    }
    if (clientId !== undefined) ensureClient(ctx, clientId);
    // DECISION: a template never runs for a client. Test-running a template version runs it as the
    // template's test copy in the Sandbox client, or in a client the operator serves and chose
    // (ARCHITECTURE §10.4): forked on the first test run there, given a new version holding this
    // one's bundle on later ones (docs/plan.md §1.5 "Template test runs", §1.16). The copy is that
    // client's agent, so its run, steps and outputs stay in that client (invariant 1); it is a
    // test run, so it never writes to the client's tools (invariant 8).
    const target =
      row.kind === "client"
        ? { agent: row, version: v }
        : await templateTestCopy(ctx.tx, {
            tenantId: clientId ?? (await sandboxClient(ctx)),
            templateVersionId: v.id,
            actorId: ctx.session.user.id,
          });
    if (target.agent.testCopy) {
      target.agent = await bindTestCopy(ctx, target.agent, target.version.bundle);
    }
    // A run sees only its client's rows, so the shared skills the version uses are copied into the
    // client first, as a publish copies them (a draft or a test copy was never published).
    await snapshotSharedSkills(ctx.tx, {
      tenantId: target.agent.tenantId as string,
      bundle: target.version.bundle,
      catalog: ctx.services.platform.catalog,
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
      models: knownModelIds(),
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
      payload: e.payload,
      sample: e.sample,
    })),
  }));
}
