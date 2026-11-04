// Back office: the Builder (ARCHITECTURE §9.6, §14 "Agents"). `POST /api/ops/agents/draft` drafts a
// new template, or a client agent with `clientId`, and saves it as a v1 draft; `POST
// /api/ops/agents/:id/revise` saves a revision of a version as a new draft and answers its diff.
// The Builder's guards (packages/agents/src/builder) run on every answer; this file gathers what
// the Builder knows and saves what it made. Every handler runs inside withOperator.

import {
  type AgentRow,
  type BuilderContext,
  BuilderError,
  type BuilderSkill,
  type BuilderTemplate,
  createClientAgent,
  createTemplate,
  createVersion,
  draftAgent,
  getAgent,
  getVersion,
  listClientAgents,
  listTemplates,
  listVersions,
  reviseAgent,
  validateForPublish,
} from "@countersign/agents";
import { type AgentBundle, diffBundles, routes } from "@countersign/core";
import { connection, inboxItem, tenant, tenantPack } from "@countersign/db";
import { createLlmClient, type LlmTransport } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { workerTransport } from "../runs/execute";
import { agentSummary, versionSummary } from "./mappers";
import { bundleLabels, operatorSkills } from "./ops-lineage";

type Ctx = HandlerCtx<never>;

/** The model transport: the app's (tests pass a FakeModel), else the Worker's live one. */
function transport(ctx: Pick<Ctx, "services">): LlmTransport {
  const { deps, env } = ctx.services;
  return deps.llm?.(env) ?? workerTransport(env);
}

async function agentInScope(ctx: Pick<Ctx, "tx" | "tenantIds">, id: string): Promise<AgentRow> {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  return row;
}

/** What the Builder knows for a template (clientId null) or one client's agent. */
async function builderContext(
  ctx: Pick<Ctx, "tx" | "tenantIds" | "services">,
  clientId: string | null,
  self?: AgentRow,
): Promise<BuilderContext> {
  const { tx, services } = ctx;
  const { platform } = services;
  const skills: BuilderSkill[] = platform.catalog
    .list()
    .map((definition) => ({ ref: definition.id, definition, source: "builtin" }));
  for (const s of await operatorSkills(ctx, clientId)) {
    if (!skills.some((x) => x.ref === s.def.id)) {
      skills.push({ ref: s.def.id, definition: s.def, source: s.source });
    }
  }
  const templates: BuilderTemplate[] = [];
  for (const t of await listTemplates(tx)) {
    if (!t.liveVersionId || t.id === self?.id) continue;
    const b = (await getVersion(tx, t.liveVersionId)).bundle;
    templates.push({
      slug: t.slug,
      name: t.name,
      role: t.role,
      mission: b.definition.identity.mission,
      skills: b.definition.skills.map((s) => s.skill),
      workflows: b.workflows.map((w) => w.name),
    });
  }
  let client: BuilderContext["client"] = null;
  let agentSlugs: string[];
  if (clientId) {
    const [row] = await tx.select().from(tenant).where(eq(tenant.id, clientId));
    if (!row) throw notFound("client");
    const conns = await tx
      .select({ connector: connection.connector, status: connection.status })
      .from(connection)
      .where(eq(connection.tenantId, clientId));
    const packs = await tx
      .select({ pack: tenantPack.pack })
      .from(tenantPack)
      .where(eq(tenantPack.tenantId, clientId));
    client = { id: row.id, name: row.name, connections: conns, packs: packs.map((p) => p.pack) };
    agentSlugs = (await listClientAgents(tx, clientId))
      .filter((a) => !a.testCopy && a.id !== self?.id && a.runStatus !== "retired")
      .map((a) => a.slug);
  } else {
    agentSlugs = templates.map((t) => t.slug);
  }
  return {
    tools: platform.tools.list().map((t) => t.spec),
    skills,
    connectors: platform.connectors
      .list()
      .map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
    packs: [],
    events: platform.events.list(),
    templates,
    client,
    agentSlugs,
  };
}

/** A slug not taken among templates (clientId null) or the client's agents. */
async function freeSlug(ctx: Pick<Ctx, "tx">, clientId: string | null, base: string) {
  const taken = new Set(
    (clientId
      ? await listClientAgents(ctx.tx, clientId, { discarded: true })
      : await listTemplates(ctx.tx, { discarded: true })
    ).map((a) => a.slug),
  );
  const root = base.slice(0, 56) || "agent";
  let slug = root;
  for (let n = 2; taken.has(slug); n += 1) slug = `${root}-${n}`;
  return slug;
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function builderHttpError(error: unknown): never {
  if (error instanceof BuilderError) {
    throw error.code === "model_unavailable"
      ? new HttpError(
          503,
          "builder_unavailable",
          `the Builder could not reach its model: ${error.message}`,
        )
      : new HttpError(422, "builder_failed", error.message, error.details);
  }
  throw error;
}

// DECISION: the Builder's model call runs inside the request's transaction (operator-only and
// rare), so the gathered context, the guards' validation and the saved draft see one snapshot. If
// held connections ever show up, split it into gather → call → save transactions.
export function opsBuilderRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsDraftAgent, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const clientId = body.clientId ?? null;
    if (clientId) ensureClient(ctx, clientId);
    const bctx = await builderContext(ctx, clientId);
    const pseudo = {
      tenantId: clientId,
      kind: clientId ? "client" : "template",
      bindings: {},
    } as const;
    const result = await draftAgent(
      {
        description: body.description,
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ctx: bctx,
      },
      {
        llm: createLlmClient({ transport: transport(ctx) }),
        validate: (bundle) => validateForPublish(tx, pseudo, bundle, services.platform.ctx),
      },
    ).catch(builderHttpError);

    // The operator's name and area win over the model's.
    const bundle: AgentBundle = structuredClone(result.bundle);
    if (body.name?.trim()) bundle.definition.identity.name = body.name.trim();
    if (body.role?.trim()) bundle.definition.identity.role = body.role.trim();
    const slug = await freeSlug(
      ctx,
      clientId,
      body.name?.trim()
        ? slugify(body.name)
        : (result.slug ?? slugify(bundle.definition.identity.name)),
    );
    const changeNote = "Drafted by the Builder";
    const created = clientId
      ? await createClientAgent(tx, {
          tenantId: clientId,
          slug,
          bundle,
          authorType: "builder",
          authorId: session.user.id,
          changeNote,
          ...(result.serviceName ? { serviceName: result.serviceName } : {}),
          ...(result.serviceDescription ? { serviceDescription: result.serviceDescription } : {}),
        })
      : await createTemplate(tx, {
          slug,
          bundle,
          authorType: "builder",
          authorId: session.user.id,
          changeNote,
        });
    // Validated again as saved: the operator's name may have changed the bundle.
    const errors = await validateForPublish(
      tx,
      created.agent,
      created.version.bundle,
      services.platform.ctx,
    );
    const template = result.startFromTemplate
      ? (await listTemplates(tx)).find((t) => t.slug === result.startFromTemplate)
      : undefined;
    return {
      agent: agentSummary(created.agent),
      version: versionSummary(created.version),
      bundle: created.version.bundle,
      summary: result.summary,
      gaps: result.gaps,
      notes: result.notes,
      errors,
      costUsd: result.costUsd,
      startFromTemplate: template
        ? { id: template.id, slug: template.slug, name: template.name }
        : null,
    };
  });

  mount(app, routes.opsReviseAgent, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const from = body.fromVersionId
      ? await getVersion(tx, body.fromVersionId)
      : (await listVersions(tx, row.id))[0];
    if (!from || from.agentId !== row.id) throw notFound("version");

    // A client's change request handed over as the instruction (ARCHITECTURE §9.6).
    let request: string | undefined;
    if (body.requestId) {
      const [item] = await tx
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.id, body.requestId), eq(inboxItem.kind, "change_request")));
      if (!item || item.tenantId !== row.tenantId) throw notFound("request");
      const text = (item.payload as { text?: unknown }).text;
      request = typeof text === "string" && text.trim() ? text : item.title;
    }

    const bctx = await builderContext(ctx, row.tenantId, row);
    const result = await reviseAgent(
      {
        source: from.bundle,
        ...(body.instruction ? { instruction: body.instruction } : {}),
        ...(request ? { request } : {}),
        ctx: bctx,
      },
      {
        llm: createLlmClient({ transport: transport(ctx) }),
        validate: (bundle) => validateForPublish(tx, row, bundle, services.platform.ctx),
      },
    ).catch(builderHttpError);

    const v = await createVersion(tx, {
      agentId: row.id,
      bundle: result.bundle,
      parentVersionId: from.id,
      authorType: "builder",
      authorId: session.user.id,
      changeNote: `Builder: ${result.changeNote}`.slice(0, 300),
    });
    return {
      version: versionSummary(v),
      bundle: v.bundle,
      summary: result.summary,
      gaps: result.gaps,
      notes: result.notes,
      errors: result.errors,
      costUsd: result.costUsd,
      diff: {
        changes: diffBundles(from.bundle, v.bundle),
        labels: bundleLabels(from.bundle, v.bundle),
      },
    };
  });
}
