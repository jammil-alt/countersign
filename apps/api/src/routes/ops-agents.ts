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
  existingBundle,
  fork,
  getAgent,
  getVersion,
  handoffAgents,
  latestVersion,
  listClientAgents,
  listTemplates,
  listVersionHeads,
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
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  processes,
  routes,
  type SkillDefinition,
  validateWorkflow,
} from "@countersign/core";
import { connection, tenant } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import {
  EventPayloadError,
  type EventTypeRegistry,
  UnknownEventTypeError,
} from "@countersign/senses";
import {
  handTrigger,
  type RoutableAgent,
  type RunRange,
  type RunRequest,
  requestRun,
} from "@countersign/workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { markOperatorPause } from "../lifecycle/pause";
import { afterActivate } from "../lifecycle/stages";
import { createRunRow } from "../runs/dispatch";
import type { RunParams } from "../runs/instances";
import { startAfterCommit } from "../runs/reconcile";
import { agentSummary, versionDetail, versionSummary } from "./mappers";

/** The agent, if it is visible to this request (templates, or a client agent of a served client). */
async function agentInScope(ctx: Pick<HandlerCtx<never>, "tx" | "tenantIds">, id: string) {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  return row;
}

function routable(row: AgentRow, liveBundle: AnyAgentBundle | null): RoutableAgent {
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
// DECISION (docs/plan.md §1.165): a client agent drafted by its build is bound the same way, as
// the operator who builds it for that client would bind it: the client has one connection per
// connector, so there is nothing to choose. What the agent may do there is still the connection's
// own settings, the grant and the gate (invariants 8 and 13); a binding gives no access by itself.
export async function bindTestCopy(
  ctx: Pick<HandlerCtx<never>, "tx" | "services" | "session">,
  copy: AgentRow,
  bundle: AnyAgentBundle,
): Promise<AgentRow> {
  const add = await bindingsToAdd(ctx, copy, bundle);
  if (Object.keys(add).length === 0) return copy;
  return updateOperational(ctx.tx, {
    agentId: copy.id,
    actorId: ctx.session.user.id,
    patch: { bindings: { ...copy.bindings, ...add } },
  });
}

/**
 * What `bindTestCopy` would bind, without binding it: the client's connection for each required
 * connector the agent isn't bound to yet (Turn on's preview reads it).
 */
export async function bindingsToAdd(
  ctx: Pick<HandlerCtx<never>, "tx" | "services">,
  copy: Pick<AgentRow, "tenantId" | "bindings">,
  bundle: AnyAgentBundle,
): Promise<Record<string, string>> {
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
  if (needed.length === 0) return {};
  const rows = await ctx.tx
    .select({ id: connection.id, connector: connection.connector })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), inArray(connection.connector, needed)))
    .orderBy(connection.createdAt);
  const add: Record<string, string> = {};
  for (const r of rows) add[r.connector] ??= r.id;
  return add;
}

/**
 * Activate, as the back office's Activate does: the activation check, then the trial's start
 * (bench → trial, or → live for an agent that writes nothing), or a paused agent resumed with its
 * pause lifted (ARCHITECTURE §10.9, §11.5). Turn on passes `requireTestRun: false` only once it
 * has found the passing test run of the same bundle at the client itself.
 */
export async function activateAgent(
  ctx: Pick<HandlerCtx<never>, "tx" | "services" | "session" | "role">,
  row: AgentRow,
  options: { requireTestRun?: boolean } = {},
): Promise<AgentRow> {
  const activated = await activate(ctx.tx, {
    agentId: row.id,
    actorId: ctx.session.user.id,
    ctx: ctx.services.platform.ctx,
    ...(options.requireTestRun === false ? { requireTestRun: false } : {}),
  });
  // v0.12 W1-A: Activate starts the trial (bench → trial, or → live with "no writes"); on a
  // paused agent it resumes it and lifts the pause, whoever made it (ARCHITECTURE §10.9, §11.5).
  return activated.kind === "client"
    ? afterActivate(ctx.tx, {
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
}

/** requestRun's refusals are plain errors: they are the caller's to fix. */
/** `connector:zoho_crm` → `zoho_crm`; the platform's and packs' events have none. */
function connectorOfEvent(registered: string | undefined): string | null {
  return registered?.startsWith("connector:") ? registered.slice("connector:".length) : null;
}

function request(make: () => RunRequest): RunRequest {
  try {
    return make();
  } catch (error) {
    throw new HttpError(409, "cannot_run", error instanceof Error ? error.message : String(error));
  }
}

/**
 * A test run's payload gives what its workflow reads of its trigger: refused (422) before any run
 * is made when the workflow runs as an event and a field it reads (`{{trigger.documentId}}`) is
 * missing or isn't what the event gives there (overnight S3.6: 30 Sandbox runs failed on
 * "Invalid UUID at documentId" after they started).
 */
// DECISION: only the fields the workflow's steps read are checked (a trigger's own filter isn't
// applied to a run started by hand), each against the event's own schema
// (the one its emits are checked with); fields it doesn't read, and extra ones, are left alone, so
// a file tried in the builder (a `document.received` payload) still runs a workflow started by a
// read document. A manual trigger's form and a schedule carry what the operator writes; an
// unknown workflow is left to requestRun's own refusal.
function checkTestPayload(
  events: Pick<EventTypeRegistry, "parsePayload">,
  bundle: AnyAgentBundle,
  workflow: string,
  payload: unknown,
): void {
  const wf = bundle.workflows.find((w) => w.slug === workflow);
  if (!wf) return;
  const on = handTrigger(wf.workflow).on;
  if (on.type !== "event") return;
  const read = new Set(
    [
      ...JSON.stringify(wf.workflow.steps).matchAll(/\{\{\s*trigger\.([A-Za-z_][A-Za-z0-9_]*)/g),
    ].map((m) => m[1] as string),
  );
  if (read.size === 0) return;
  const given = payload !== null && typeof payload === "object" ? payload : {};
  const picked = Object.fromEntries(
    Object.entries(given as Record<string, unknown>).filter(([k]) => read.has(k)),
  );
  try {
    events.parsePayload(on.event, picked);
  } catch (error) {
    if (error instanceof EventPayloadError) {
      const issues = error.issues.filter((i) => read.has(String(i.path[0])));
      if (issues.length === 0) return;
      throw new HttpError(
        422,
        "invalid_payload",
        `the test payload isn't what ${on.event} gives: ${issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        { issues: issues.map((i) => ({ path: i.path.map(String), message: i.message })) },
      );
    }
    // An event no registry knows is the workflow's problem, found when it is validated.
    if (error instanceof UnknownEventTypeError) return;
    throw error;
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
      // PLATFORM_QA TOOL-2: the version must be this template's own, and published.
      templateId: template.id,
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

  // Hand off (owner, 2026-11-11): what the builder's hand-off step picks from and checks against.
  mount(app, routes.opsClientHandoffAgents, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { agents: await handoffAgents(ctx.tx, ctx.params.id, ctx.services.platform.ctx) };
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
    // DECISION: the list of versions comes without bundles, and only the live and latest bundles
    // are read: every agent page (and the /ops/agents/:id redirect) read every version's whole
    // bundle, which made agent pages take seconds as versions piled up.
    const versions = await listVersionHeads(ctx.tx, row.id);
    const latestId = versions[0]?.id ?? null;
    const [live, latest] = await Promise.all([
      row.liveVersionId ? getVersion(ctx.tx, row.liveVersionId) : Promise.resolve(null),
      latestId && latestId !== row.liveVersionId
        ? getVersion(ctx.tx, latestId)
        : Promise.resolve(null),
    ]);
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
    // QA (2026-11-22): the names the agent's page shows come with it, so its Overview never
    // waits on the builder's catalog or the skills list to say "QuickBooks Online".
    // DECISION: every registered connector's manifest name (a few dozen short strings, no
    // bundle walk) and the live and latest versions' skills; this route now builds the platform
    // (lazy, tens of ms in a fresh isolate), as the client page's route already does.
    const { platform } = ctx.services;
    const skillNames: Record<string, string> = {};
    for (const v of [live, latest]) {
      if (!v) continue;
      const { skills } = await skillContext(ctx.tx, {
        tenantId: row.tenantId,
        bundle: v.bundle,
        catalog: platform.catalog,
      });
      for (const [ref, def] of Object.entries(skills)) skillNames[ref] = def.name;
    }
    const names = {
      connectors: Object.fromEntries(
        platform.connectors.list().map((c) => [c.manifest.id, c.manifest.name] as const),
      ),
      skills: skillNames,
    };
    return {
      names,
      agent: agentSummary(row),
      versions: versions.map(versionSummary),
      live: live ? versionDetail(live) : null,
      latest: latest
        ? versionDetail(latest)
        : live && live.id === latestId
          ? versionDetail(live)
          : null,
      update,
      // DECISION (S6.5): the stored draft is checked as its save and its publish check it, so a
      // trigger that can't start (a schedule of "99 99 99 99 99", a zone "Not/AZone") says so on
      // the agent's page, not only in the save's notice. Only a draft: the live version passed.
      ...(latest
        ? {
            latestErrors: await validateForPublish(ctx.tx, row, latest.bundle, platform.ctx, {
              previous: await existingBundle(ctx.tx, latest),
            }),
          }
        : {}),
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
    // Skill model (2026-11-10): what publish will say about new steps, said now.
    const errors = await validateForPublish(tx, row, v.bundle, services.platform.ctx, {
      previous: await existingBundle(tx, v),
    });
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
    return { agent: agentSummary(await activateAgent(ctx, row)) };
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
    ctx.afterCommit(() => startAfterCommit(ctx.services, req));
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
    const errors = await validateForPublish(ctx.tx, row, v.bundle, ctx.services.platform.ctx, {
      previous: await existingBundle(ctx.tx, v),
    });
    if (errors.length > 0) {
      throw new HttpError(422, "invalid_bundle", `v${v.version} does not validate`, errors);
    }
    checkTestPayload(ctx.services.platform.events, v.bundle, ctx.body.workflow, ctx.body.payload);
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
    // Owner, 2026-11-22 (docs/plan.md §1.185): a test of some of the steps. Checked here, so a
    // step never reads nothing where it expects an earlier step's output.
    // DECISION: a range is a test run's alone (it never writes, invariant 8), on a workflow in
    // the new format, and what is given for the steps before it is at most 256 KB.
    const { range } = ctx.body;
    if (range) {
      const wf = target.version.bundle.workflows.find((w) => w.slug === ctx.body.workflow);
      if (wf?.workflow.schemaVersion !== 4) {
        throw new HttpError(
          422,
          "invalid_range",
          "some of the steps can be tested once the workflow is saved in the new format",
        );
      }
      const problems = processes.rangeProblems(
        wf.workflow,
        // What a step reads is in its own words; the tools' shapes are all the typing needs.
        { tools: ctx.services.platform.tools.specs() },
        range,
      );
      if (JSON.stringify(range.given ?? {}).length > 256_000) {
        problems.push("what was given for the earlier steps is too large (256 KB at most)");
      }
      if (problems.length > 0) {
        throw new HttpError(422, "invalid_range", problems.join("; "), { problems });
      }
    }
    // As the run keeps it: only what was said.
    const kept: RunRange | null = range
      ? {
          ...(range.from ? { from: range.from } : {}),
          ...(range.to ? { to: range.to } : {}),
          ...(range.given ? { given: range.given } : {}),
        }
      : null;
    const params: RunParams = kept ? { ...req, range: kept } : req;
    await createRunRow(ctx.tx, params);
    ctx.afterCommit(() => startAfterCommit(ctx.services, params));
    return { runId: req.runId, agentId: target.agent.id, versionId: target.version.id };
  });

  mount(app, routes.opsValidateWorkflow, async (ctx) => {
    const { tx, body, services } = ctx;
    const { platform } = services;
    let skills: Record<string, SkillDefinition> = Object.fromEntries(
      platform.catalog.list().map((s) => [s.id, s]),
    );
    let agentDef: AnyAgentBundle["definition"] | undefined;
    if (body.agentId) {
      const row = await agentInScope(ctx, body.agentId);
      const latest = await latestVersion(tx, row.id);
      const v = row.liveVersionId ? await getVersion(tx, row.liveVersionId) : latest;
      if (v) {
        // Wave 3b: the agent's live (else latest) version may hold v4 processes; only its
        // definition and skills are read here.
        const bundle = AnyAgentBundleSchema.parse(v.bundle);
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
      // UI cleanup: which connector emits it, so the builder hides events of tools not connected.
      connector: connectorOfEvent(services.platform.events.sourceOf(e.type)),
    })),
  }));
}
