// Back office: the Builder (ARCHITECTURE §9.6, §14 "Agents"). `POST /api/ops/agents/draft` drafts a
// new template, or a client agent with `clientId`, and saves it as a v1 draft; `POST
// /api/ops/agents/:id/revise` saves a revision of a version as a new draft and answers its diff.
// The Builder's guards (packages/agents/src/builder) run on every answer; this file gathers what
// the Builder knows and saves what it made. Every handler runs inside withOperator. Wave 3b: the
// Builder drafts and edits v4 processes (docs/plan.md §1.86): a stored v3 version, and a session's
// draft saved before the Builder learned v4, are read through the converter (every id kept), and
// what it saves is a v4 version; the stored version is never changed (invariant 3).

import {
  type AgentRow,
  agentTurn,
  type BuilderContext,
  BuilderError,
  type BuilderSkill,
  type BuilderTemplate,
  blankAgentDraft,
  builderSlug,
  bundleSkillRefs,
  bundleStepsToAutomation,
  convertLookup,
  createAutomation,
  createClientAgent,
  createSkill,
  createSkillVersion,
  createTemplate,
  createVersion,
  draftAgent,
  EMPTY_SKILL_DRAFT,
  type ExistingSteps,
  entryKey,
  existingBundle,
  getAgent,
  getVersion,
  guardBundle,
  labelledChanges,
  latestVersion,
  listClientAgents,
  listTemplates,
  readCommand,
  reviseAgent,
  SkillDraft,
  skillChanges,
  skillTurn,
  undoChange,
  undoneEntries,
  undoSkillChange,
  validateForPublish,
} from "@countersign/agents";
import {
  type AgentBundle,
  AnyAgentBundle,
  type BuilderChange,
  type ClosestTemplate,
  closestBundles,
  diffBundles,
  isToolWrapper,
  newStepSkillReason,
  type ProcessAgentBundle,
  parseCommand,
  parseSkillRef,
  routes,
  type SkillDefinition,
  skillTools,
  toolLookup,
  toProcessBundle,
  uuidv7,
  type ValidationError,
} from "@countersign/core";
import {
  builderSession,
  builderTurn,
  connection,
  contact,
  inboxItem,
  skill,
  skillVersion,
  tenant,
  tenantPack,
  testCase,
} from "@countersign/db";
import { createLlmClient, knownModelIds, type LlmTransport } from "@countersign/llm";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import {
  addTurn,
  bundleBefore,
  checkErrors,
  clientName,
  lastSavedVersion,
  lockSession,
  readSession,
  refuseClosed,
  type SessionRow,
  sessionSummary,
  turnsOf,
  turnView,
  turnViews,
  updateSession,
} from "../builder/sessions";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { workerTransport } from "../runs/execute";
import { agentSummary, versionSummary } from "./mappers";
import { builderAutomations } from "./ops-automations";
import {
  ACCOUNT_TOOL_PREFIX,
  bundleLabels,
  bundleStepTools,
  operatorSkills,
  SPLIT_MODEL_TOOLS,
} from "./ops-lineage";

type Ctx = HandlerCtx<never>;

/** The model transport: the app's (tests pass a FakeModel), else the Worker's live one. */
function transport(ctx: Pick<Ctx, "services">): LlmTransport {
  const { deps, env } = ctx.services;
  return deps.llm?.(env) ?? workerTransport(env);
}

/**
 * Wave 3b: a stored bundle (a version, a session's draft or a turn's) as the Builder edits it: v3
 * workflows read as v4 processes with the registries' lookup, every id kept; v4 as it is.
 */
// DECISION: the Builder reads a v3 version through the converter at the start of a session (and a
// session's v3 draft each time it is read), never upgrades a conversation on its own (the
// converter's `keep`), and what it saves is v4. Reading changes nothing stored (invariant 3).
function asProcesses(ctx: Pick<Ctx, "services">, raw: unknown): ProcessAgentBundle {
  const { platform } = ctx.services;
  return toProcessBundle(
    AnyAgentBundle.parse(raw),
    convertLookup(platform.catalog, platform.tools),
  );
}

/** A v4 bundle where the registry's (v3-typed) readers take a stored bundle: they read either. */
const stored = (bundle: ProcessAgentBundle): AgentBundle => bundle as unknown as AgentBundle;

async function agentInScope(ctx: Pick<Ctx, "tx" | "tenantIds">, id: string): Promise<AgentRow> {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  return row;
}

/**
 * What the Builder knows for a template (clientId null) or one client's agent. `source` is the
 * version being revised (else `self`'s latest): what it already uses stays offered.
 */
// DECISION (review): the Builder is offered what the builder's palette offers for a new step: no
// tool wrapper, no skill of a retired kind or that writes (core's `newStepSkillReason`), and no
// tool the splits replaced or account handler (`stepTools`' rule), each kept where the version
// being revised already uses it, so a revision keeps its stored steps.
async function builderContext(
  ctx: Pick<Ctx, "tx" | "tenantIds" | "services">,
  clientId: string | null,
  self?: AgentRow,
  source?: AnyAgentBundle | null,
): Promise<BuilderContext> {
  const { tx, services } = ctx;
  const { platform } = services;
  const from =
    source !== undefined
      ? source
      : self
        ? ((await latestVersion(tx, self.id))?.bundle ?? null)
        : null;
  const usedSkills = new Set(
    (from ? bundleSkillRefs(from) : []).map((ref) => parseSkillRef(ref).id),
  );
  const usedTools = new Set([...bundleStepTools(from), ...(from?.definition.extraTools ?? [])]);
  const lookup = toolLookup(platform.tools.specs());
  const offered = (def: SkillDefinition) =>
    usedSkills.has(def.id) || (!isToolWrapper(def) && newStepSkillReason(def, lookup) === null);
  const skills: BuilderSkill[] = platform.catalog
    .list()
    .filter(offered)
    .map((definition) => ({ ref: definition.id, definition, source: "builtin" }));
  for (const s of await operatorSkills(ctx, clientId)) {
    if (!offered(s.def)) continue;
    if (!skills.some((x) => x.ref === s.def.id)) {
      skills.push({ ref: s.def.id, definition: s.def, source: s.source });
    }
  }
  // A skill the version already uses keeps the tools it calls, so its steps still type.
  for (const s of skills) {
    if (!usedSkills.has(s.ref)) continue;
    for (const t of [...skillTools(s.definition), ...(s.definition.reads ?? [])]) usedTools.add(t);
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
    tools: platform.tools
      .list()
      .map((t) => t.spec)
      .filter(
        (t) =>
          usedTools.has(t.id) ||
          !(SPLIT_MODEL_TOOLS.has(t.id) || t.id.startsWith(ACCOUNT_TOOL_PREFIX)),
      ),
    skills,
    connectors: platform.connectors
      .list()
      .map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
    // P-9: the packs this deployment registers (docs/plan.md §1.71); a client's own are in `client`.
    packs: platform.packs.map((p) => ({ id: p.manifest.id, name: p.manifest.name })),
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

// v0.12 W3-A: an index loop in place of `/^-+|-+$/g` (no backtracking regex over the text).
const slugify = (text: string) => builderSlug(text);

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
  // v0.12 W3-A: the conversation routes.
  builderSessionRoutes(app);
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
        // Review: a new agent from the Builder is a first version: every step is new.
        validate: (bundle) =>
          validateForPublish(tx, pseudo, stored(bundle), services.platform.ctx, {
            previous: "none",
          }),
      },
    ).catch(builderHttpError);

    // The operator's name and area win over the model's.
    const bundle: ProcessAgentBundle = structuredClone(result.bundle);
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
      { previous: await existingBundle(tx, created.version) },
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
      : ((await latestVersion(tx, row.id)) ?? undefined);
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

    const bctx = await builderContext(ctx, row.tenantId, row, from.bundle);
    const previous = await existingUnder(tx, from.id);
    const lookup = convertLookup(services.platform.catalog, services.platform.tools);
    const result = await reviseAgent(
      {
        source: asProcesses(ctx, from.bundle),
        ...(body.instruction ? { instruction: body.instruction } : {}),
        ...(request ? { request } : {}),
        ctx: bctx,
      },
      {
        llm: createLlmClient({ transport: transport(ctx) }),
        validate: (bundle) =>
          validateForPublish(tx, row, stored(bundle), services.platform.ctx, { previous }),
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
        // A v3 version and its v4 revision differ only where they really do.
        changes: diffBundles(from.bundle, v.bundle, { lookup }),
        labels: bundleLabels(from.bundle, v.bundle),
      },
    };
  });
}

// ── v0.12 W3-A: the Builder as a conversation (ARCHITECTURE §9.6; docs/plan.md §1.51) ────────────
// A session keeps the working draft of one agent or skill; each turn asks the model once
// (`submit_turn` / `submit_skill`) with the guards and one repair round, and records the labelled
// changes; undo reverts one change by three-way merge; save writes an ordinary draft version.
// Nothing is published from a conversation. The model call runs inside the request's transaction,
// as the Builder's other routes do (operator only, rare).

type SessionCtx = Pick<Ctx, "tx" | "tenantIds" | "services" | "session">;

/** What a conversation also knows: automations, the priced models and the client's people. */
async function conversationContext(
  ctx: SessionCtx,
  clientId: string | null,
  working: ProcessAgentBundle | null,
  self?: AgentRow,
): Promise<BuilderContext> {
  const base = await builderContext(ctx, clientId, self);
  const skills = Object.fromEntries(base.skills.map((s) => [s.ref, s.definition]));
  const automations = (
    await builderAutomations(ctx.tx, {
      tenantId: clientId,
      tenantIds: ctx.tenantIds,
      bundle: working ? stored(working) : null,
      skills,
      platform: ctx.services.platform,
    })
  ).map((a) => ({
    ref: a.ref,
    slug: a.slug,
    name: a.name,
    description: a.description,
    input: a.definition.input,
    output: a.definition.output,
  }));
  // DECISION: the client's people reach the model by name and relationship only (no phone, email
  // or notes), at most 50: enough to name a person step's assignee, nothing to contact them by.
  const people = clientId
    ? (
        await ctx.tx
          .select({ name: contact.name, relationship: contact.relationship })
          .from(contact)
          .where(eq(contact.tenantId, clientId))
          .orderBy(contact.name)
          .limit(50)
      ).map((p) => ({ name: p.name, relationship: p.relationship ?? null }))
    : [];
  return { ...base, automations, models: knownModelIds(), people };
}

/** The agent a session is about, or the pseudo row a new draft is validated as. */
async function sessionAgent(
  ctx: SessionCtx,
  s: SessionRow,
): Promise<{ row: AgentRow | null; validateAs: Pick<AgentRow, "tenantId" | "kind" | "bindings"> }> {
  if (s.agentId) {
    const row = await getAgent(ctx.tx, s.agentId);
    return { row, validateAs: row };
  }
  return {
    row: null,
    validateAs: { tenantId: s.tenantId, kind: s.tenantId ? "client" : "template", bindings: {} },
  };
}

/**
 * Review: what a draft saved as a child of `parentId` is checked against as already there
 * (`existingBundle`); with no parent, a first version (`"none"`: every step new).
 */
async function existingUnder(tx: Ctx["tx"], parentId: string | null): Promise<ExistingSteps> {
  if (!parentId) return "none";
  const parent = await getVersion(tx, parentId);
  return existingBundle(tx, {
    parentVersionId: parent.id,
    basedOnTemplateVersionId: parent.basedOnTemplateVersionId,
  });
}

/** Review: what a conversation's draft is checked against: the version it would be saved under. */
async function sessionExisting(
  ctx: SessionCtx,
  s: SessionRow,
  turns: Parameters<typeof lastSavedVersion>[1],
): Promise<ExistingSteps> {
  const parentId =
    lastSavedVersion(s, turns) ??
    (s.agentId ? ((await latestVersion(ctx.tx, s.agentId))?.id ?? null) : null);
  return existingUnder(ctx.tx, parentId);
}

/** The operator's version the conversation started from (its rules hold across turns). */
async function originOf(ctx: SessionCtx, s: SessionRow): Promise<ProcessAgentBundle | null> {
  return s.kind === "agent" && s.baseVersionId
    ? asProcesses(ctx, (await getVersion(ctx.tx, s.baseVersionId)).bundle)
    : null;
}

/** Live templates like the draft, best first (core's bundleSimilarity). */
async function closestTemplates(
  ctx: SessionCtx,
  bundle: AnyAgentBundle,
  selfId: string | null,
): Promise<ClosestTemplate[]> {
  const candidates: {
    key: string;
    bundle: AnyAgentBundle;
    id: string;
    name: string;
    version: number;
  }[] = [];
  for (const t of await listTemplates(ctx.tx)) {
    if (!t.liveVersionId || t.id === selfId) continue;
    const v = await getVersion(ctx.tx, t.liveVersionId);
    candidates.push({ key: t.slug, bundle: v.bundle, id: t.id, name: t.name, version: v.version });
  }
  // DECISION: three at most, from 20% alike: below that a template is no head start.
  return closestBundles(bundle, candidates, { limit: 3, min: 0.2 }).map((c) => ({
    agentId: c.id,
    slug: c.key,
    name: c.name,
    version: c.version,
    score: c.similarity.score,
  }));
}

/** The session as the routes answer it, with its turns. */
async function sessionDetail(ctx: SessionCtx, s: SessionRow) {
  const turns = await turnsOf(ctx.tx, s.id);
  let errors: ReturnType<typeof checkErrors> = [];
  let closest: ClosestTemplate[] = [];
  let shown: unknown = s.bundle;
  if (s.kind === "agent") {
    const bundle = asProcesses(ctx, s.bundle);
    // Wave 3b: the draft as the Builder edits it (a session saved before v4 holds a v3 draft).
    shown = bundle;
    const { validateAs } = await sessionAgent(ctx, s);
    errors = checkErrors(
      await validateForPublish(ctx.tx, validateAs, stored(bundle), ctx.services.platform.ctx, {
        previous: await sessionExisting(ctx, s, turns),
      }),
    );
    closest = await closestTemplates(ctx, bundle, s.agentId);
  } else {
    const draft = SkillDraft.parse(s.bundle);
    if (!draft.definition) {
      errors = [
        {
          stepId: null,
          field: "definition",
          message: "no skill drafted yet",
          code: "no_definition",
        },
      ];
    }
  }
  return {
    session: {
      ...sessionSummary(s, await clientName(ctx.tx, s.tenantId)),
      bundle: shown,
      errors,
      closest,
    },
    turns: turnViews(turns),
  };
}

const skillErrors = (problems: readonly string[]) =>
  problems.map((message) => ({ stepId: null, field: "skill", message, code: "invalid_skill" }));

/** A client's change request of the agent's own client, handed over as data (§9.6). */
async function requestText(ctx: SessionCtx, s: SessionRow, requestId: string): Promise<string> {
  const [item] = await ctx.tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, requestId), eq(inboxItem.kind, "change_request")));
  if (!item || s.tenantId === null || item.tenantId !== s.tenantId) throw notFound("request");
  const text = (item.payload as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text : item.title;
}

const UNDO_CONFLICT = "a later change touched what this one changed, so it can't be undone alone";

function builderSessionRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsBuilderSessions, async (ctx) => {
    const { tx, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const scope =
      ctx.tenantIds.length > 0
        ? or(isNull(builderSession.tenantId), inArray(builderSession.tenantId, [...ctx.tenantIds]))
        : isNull(builderSession.tenantId);
    const rows = await tx
      .select({ s: builderSession, clientName: tenant.name })
      .from(builderSession)
      .leftJoin(tenant, eq(tenant.id, builderSession.tenantId))
      .where(
        and(
          scope,
          query.agent ? eq(builderSession.agentId, query.agent) : undefined,
          query.skill ? eq(builderSession.skillId, query.skill) : undefined,
          query.client ? eq(builderSession.tenantId, query.client) : undefined,
          query.status ? eq(builderSession.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(builderSession.updatedAt))
      .limit(100);
    return { sessions: rows.map((r) => sessionSummary(r.s, r.clientName ?? null)) };
  });

  mount(app, routes.opsStartBuilderSession, async (ctx) => {
    const { tx, body, session } = ctx;
    let tenantId: string | null = body.clientId ?? null;
    if (tenantId) ensureClient(ctx, tenantId);
    let bundle: unknown;
    let agentId: string | null = null;
    let skillId: string | null = null;
    let baseVersionId: string | null = null;
    let text: string;
    if (body.kind === "agent") {
      if (body.agentId) {
        const row = await agentInScope(ctx, body.agentId);
        if (body.clientId && body.clientId !== row.tenantId) {
          throw new HttpError(422, "invalid_request", "that agent belongs to another client");
        }
        const from = body.fromVersionId
          ? await getVersion(tx, body.fromVersionId)
          : ((await latestVersion(tx, row.id)) ?? undefined);
        if (!from || from.agentId !== row.id) throw notFound("version");
        tenantId = row.tenantId;
        agentId = row.id;
        baseVersionId = from.id;
        // Wave 3b: a v3 version starts the conversation read as processes, every id kept.
        bundle = asProcesses(ctx, from.bundle);
        text = `Started from ${row.name} v${from.version}.`;
      } else {
        bundle = blankAgentDraft({
          name: body.name ?? "New agent",
          ...(body.role ? { role: body.role } : {}),
        });
        text = tenantId ? "Started a new agent for this client." : "Started a new template.";
      }
    } else if (body.skillId) {
      const [row] = await tx.select().from(skill).where(eq(skill.id, body.skillId));
      if (!row || (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId))) {
        throw notFound("skill");
      }
      if (body.clientId && body.clientId !== row.tenantId) {
        throw new HttpError(422, "invalid_request", "that skill belongs to another client");
      }
      const [v] = body.fromVersionId
        ? await tx.select().from(skillVersion).where(eq(skillVersion.id, body.fromVersionId))
        : await tx
            .select()
            .from(skillVersion)
            .where(eq(skillVersion.skillId, row.id))
            .orderBy(desc(skillVersion.version))
            .limit(1);
      if (!v || v.skillId !== row.id) throw notFound("skill version");
      tenantId = row.tenantId;
      skillId = row.id;
      baseVersionId = v.id;
      bundle = { definition: v.definition, cases: [] };
      text = `Started from ${row.name} v${v.version}.`;
    } else {
      bundle = EMPTY_SKILL_DRAFT;
      text = tenantId ? "Started a new skill for this client." : "Started a new shared skill.";
    }
    const [row] = await tx
      .insert(builderSession)
      .values({
        tenantId,
        kind: body.kind,
        agentId,
        skillId,
        baseVersionId,
        bundle,
        createdBy: session.user.id,
      })
      .returning();
    if (!row) throw new Error("builder session insert returned nothing");
    // The first turn keeps the starting draft, so the first change can be undone.
    await addTurn(tx, row, { role: "operator", text, command: "/start", bundle });
    return sessionDetail(ctx, row);
  });

  mount(app, routes.opsBuilderSession, async (ctx) =>
    sessionDetail(ctx, await readSession(ctx, ctx.params.id)),
  );

  mount(app, routes.opsBuilderTurn, async (ctx) => {
    const { tx, body, services } = ctx;
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    const turns = await turnsOf(tx, s.id);
    const history = turns
      .filter((t) => t.command !== "/start")
      .map((t) => ({ role: t.role, text: t.text }));
    const llm = createLlmClient({ transport: transport(ctx) });
    const builderTurnId = uuidv7();

    if (s.kind === "skill") {
      if (parseCommand(body.text)) {
        throw new HttpError(
          422,
          "invalid_command",
          "/skill, /automation and /trigger change an agent, not a skill",
        );
      }
      const current = SkillDraft.parse(s.bundle);
      const bctx = await builderContext(ctx, s.tenantId);
      const result = await skillTurn(
        {
          current,
          history,
          message: body.text,
          examples: body.examples ?? [],
          ctx: { ...bctx, models: knownModelIds() },
          turnId: builderTurnId,
        },
        { llm, validate: async () => [] },
      ).catch(builderHttpError);
      const changes = skillChanges(current, result.draft);
      await addTurn(tx, s, { role: "operator", text: body.text });
      const turn = await addTurn(tx, s, {
        id: builderTurnId,
        role: "builder",
        text: result.text,
        changes,
        bundle: changes.length > 0 ? result.draft : null,
        meta: {
          questions: result.questions,
          gaps: result.gaps,
          notes: result.notes,
          errors: skillErrors(result.problems),
        },
        costUsd: result.costUsd,
      });
      if (changes.length > 0) await updateSession(tx, s.id, { bundle: result.draft });
      const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
      return { ...detail, turn: turnView(turn, new Set()) };
    }

    if (body.examples?.length) {
      throw new HttpError(422, "invalid_request", "examples go with a skill conversation");
    }
    const working = asProcesses(ctx, s.bundle);
    const { row, validateAs } = await sessionAgent(ctx, s);
    const bctx = await conversationContext(ctx, s.tenantId, working, row ?? undefined);
    const previous = await sessionExisting(ctx, s, turns);
    const read = readCommand(body.text, { bundle: working, automations: bctx.automations ?? [] });
    if (!read.ok) throw new HttpError(422, read.code, read.message);
    const command = read.command;
    const request = body.requestId ? await requestText(ctx, s, body.requestId) : undefined;
    const result = await agentTurn(
      {
        working,
        origin: await originOf(ctx, s),
        history,
        message: body.text,
        command,
        ...(request ? { request } : {}),
        ctx: bctx,
      },
      {
        llm,
        validate: (bundle) =>
          validateForPublish(tx, validateAs, stored(bundle), services.platform.ctx, { previous }),
      },
    ).catch(builderHttpError);
    await addTurn(tx, s, {
      role: "operator",
      text: body.text,
      command: command ? `/${command.name}` : null,
      meta: command
        ? {
            command: {
              name: command.name,
              target:
                command.name === "skill"
                  ? command.skill
                  : command.name === "automation"
                    ? command.ref
                    : command.trigger,
              args: command.args,
            },
          }
        : {},
    });
    const model = result.calls[0]?.model;
    const turn = await addTurn(tx, s, {
      id: builderTurnId,
      role: "builder",
      text: result.text,
      changes: result.changes,
      bundle: result.changes.length > 0 ? result.bundle : null,
      meta: {
        questions: result.questions,
        gaps: result.gaps,
        notes: result.notes,
        errors: checkErrors(result.errors),
        ...(model ? { model } : {}),
      },
      costUsd: result.costUsd,
    });
    if (result.changes.length > 0) await updateSession(tx, s.id, { bundle: result.bundle });
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    return { ...detail, turn: turnView(turn, new Set()) };
  });

  mount(app, routes.opsBuilderUndo, async (ctx) => {
    const { tx, body } = ctx;
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    const turns = await turnsOf(tx, s.id);
    const target = turns.find((t) => t.id === body.turnId);
    if (!target) throw notFound("turn");
    const entry = target.changes.find((c) => c.id === body.changeId);
    if (!entry || target.bundle === null) throw notFound("change");
    if (undoneEntries(turns).has(entryKey(target.id, entry.id))) {
      throw new HttpError(409, "already_undone", "that change is already undone");
    }
    let next: unknown;
    if (s.kind === "agent") {
      // Wave 3b: each side read as processes (a turn saved before v4 holds a v3 draft), ids kept.
      const r = undoChange({
        before: asProcesses(ctx, bundleBefore(turns, target.seq)),
        after: asProcesses(ctx, target.bundle),
        working: asProcesses(ctx, s.bundle),
        changeId: entry.id,
      });
      if (!r.ok) {
        throw new HttpError(409, "undo_conflict", UNDO_CONFLICT, { conflicts: r.conflicts });
      }
      const undone = asProcesses(ctx, r.bundle);
      // The guards hold after an undo too (approvals, mode), keeping every id the merge brought.
      const { row } = await sessionAgent(ctx, s);
      const bctx = await conversationContext(ctx, s.tenantId, undone, row ?? undefined);
      next = guardBundle(undone, bctx, {
        mode: "revise",
        source: undone,
        origin: await originOf(ctx, s),
      }).bundle;
    } else {
      const r = undoSkillChange(SkillDraft.parse(s.bundle), entry);
      if (!r.ok) {
        throw new HttpError(409, "undo_conflict", UNDO_CONFLICT, { conflicts: r.conflicts });
      }
      next = r.draft;
    }
    const undoEntry: BuilderChange = {
      id: entry.id,
      label: `Undid: ${entry.label}`.slice(0, 500),
      ...(entry.after !== undefined ? { before: entry.after } : {}),
      ...(entry.before !== undefined ? { after: entry.before } : {}),
      undoes: { turnId: target.id, changeId: entry.id },
    };
    const turn = await addTurn(tx, s, {
      role: "operator",
      text: `Undo: ${entry.label}`,
      command: "/undo",
      changes: [undoEntry],
      bundle: next,
    });
    await updateSession(tx, s.id, { bundle: next });
    // A turn is marked undone once every one of its changes is (and unmarked by a redo).
    const nowUndone = undoneEntries([...turns, turn]);
    const allUndone = target.changes.every((c) => nowUndone.has(entryKey(target.id, c.id)));
    if (allUndone !== (target.undoneAt !== null)) {
      await tx
        .update(builderTurn)
        .set({ undoneAt: allUndone ? new Date() : null })
        .where(eq(builderTurn.id, target.id));
    }
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    return { ...detail, turn: turnView(turn, nowUndone) };
  });

  mount(app, routes.opsBuilderSaveAutomation, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const registry = services.platform.ctx;
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    if (s.kind !== "agent") {
      throw new HttpError(422, "invalid_request", "steps are saved as an automation from an agent");
    }
    // Wave 3b: the draft is a v4 process bundle, so the steps become a v4 automation (process
    // steps) and a process step takes their place.
    const working = asProcesses(ctx, s.bundle);
    const result = await bundleStepsToAutomation(tx, {
      tenantId: s.tenantId,
      bundle: working,
      stepIds: body.stepIds,
      slug: body.slug,
      name: body.name,
      description: body.description,
      newId: () => uuidv7(),
      clientAgent: s.tenantId !== null,
      ctx: registry,
    });
    if (!result.ok) throw new HttpError(422, result.code, result.message);
    // DECISION: as "Save as automation" in the workflow builder (plan §1.45): a new automation at
    // v1, a draft; shared from a template's conversation, the client's own from a client's.
    const created = await createAutomation(tx, {
      tenantId: s.tenantId,
      definition: result.automation,
      authorId: session.user.id,
      changeNote: "Saved from a Builder conversation",
      ctx: registry,
    });
    const next = asProcesses(ctx, result.bundle);
    const n = body.stepIds.length;
    const turn = await addTurn(tx, s, {
      role: "operator",
      text: `Saved ${n} step${n === 1 ? "" : "s"} as the automation ${body.name}.`,
      command: "/save-automation",
      changes: labelledChanges(working, next),
      bundle: next,
    });
    await updateSession(tx, s.id, { bundle: next });
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    return {
      ...detail,
      turn: turnView(turn, new Set()),
      automation: {
        id: created.automation.id,
        slug: created.automation.slug,
        ref: `${created.automation.slug}@${created.version.version}`,
      },
      automationVersion: { id: created.version.id, version: created.version.version },
    };
  });

  mount(app, routes.opsBuilderSave, async (ctx) => {
    const { tx, body, session, services } = ctx;
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    const turns = await turnsOf(tx, s.id);
    const changeNote = body.changeNote ?? "Drafted in a Builder conversation";
    let agentOut: { id: string; slug: string } | null = null;
    let skillOut: { id: string; slug: string; ref: string } | null = null;
    let version: { id: string; version: number };
    let errors: ValidationError[] = [];
    const casesOut: { id: string; name: string; clientId: string | null }[] = [];

    if (s.kind === "agent") {
      const bundle = asProcesses(ctx, s.bundle);
      let row: AgentRow;
      let saved: Parameters<typeof existingBundle>[1];
      if (!s.agentId) {
        const slug = await freeSlug(
          ctx,
          s.tenantId,
          body.slug ?? slugify(bundle.definition.identity.name),
        );
        const created = s.tenantId
          ? await createClientAgent(tx, {
              tenantId: s.tenantId,
              slug,
              bundle,
              authorType: "builder",
              authorId: session.user.id,
              changeNote,
            })
          : await createTemplate(tx, {
              slug,
              bundle,
              authorType: "builder",
              authorId: session.user.id,
              changeNote,
            });
        row = created.agent;
        version = { id: created.version.id, version: created.version.version };
        saved = created.version;
      } else {
        row = await getAgent(tx, s.agentId);
        const v = await createVersion(tx, {
          agentId: row.id,
          bundle,
          parentVersionId: lastSavedVersion(s, turns),
          authorType: "builder",
          authorId: session.user.id,
          changeNote: `Builder: ${changeNote}`.slice(0, 300),
        });
        version = { id: v.id, version: v.version };
        saved = v;
      }
      errors = await validateForPublish(tx, row, stored(bundle), services.platform.ctx, {
        previous: await existingBundle(tx, saved),
      });
      agentOut = { id: row.id, slug: row.slug };
      await updateSession(tx, s.id, { agentId: row.id, status: "saved" });
    } else {
      const draft = SkillDraft.parse(s.bundle);
      if (!draft.definition) throw new HttpError(422, "no_definition", "no skill drafted yet");
      let skillRow: { id: string; slug: string };
      if (!s.skillId) {
        const created = await createSkill(tx, {
          tenantId: s.tenantId,
          definition: draft.definition,
          authorId: session.user.id,
          changeNote,
          tools: services.platform.tools,
        });
        skillRow = created.skill;
        version = { id: created.version.id, version: created.version.version };
      } else {
        const [existing] = await tx.select().from(skill).where(eq(skill.id, s.skillId));
        if (!existing) throw notFound("skill");
        const v = await createSkillVersion(tx, {
          skillId: existing.id,
          definition: draft.definition,
          parentVersionId: lastSavedVersion(s, turns),
          authorId: session.user.id,
          changeNote,
          tools: services.platform.tools,
        });
        skillRow = existing;
        version = { id: v.id, version: v.version };
      }
      // DECISION: a conversation's cases carry its scope: a client's conversation's cases are that
      // client's (they come from its examples) and never reach a shared skill's gate; a shared
      // conversation's are shared, from the operator's synthetic examples (§9.10, invariant 1).
      const saved = new Set(
        (
          await tx
            .select({ ref: testCase.sourceRef })
            .from(testCase)
            .where(and(eq(testCase.targetKind, "skill"), eq(testCase.targetId, skillRow.id)))
        ).map((r) => r.ref),
      );
      for (const c of draft.cases) {
        const sourceRef = `builder:${s.id}:${c.key}`;
        if (saved.has(sourceRef)) continue;
        const [tc] = await tx
          .insert(testCase)
          .values({
            tenantId: s.tenantId,
            targetKind: "skill",
            targetId: skillRow.id,
            name: c.name,
            input: c.input ?? null,
            fixtures: [],
            expected: c.expected ?? null,
            matcher: c.matcher,
            required: c.required,
            source: "builder",
            sourceRef,
            createdBy: session.user.id,
          })
          .returning();
        if (tc) casesOut.push({ id: tc.id, name: tc.name, clientId: tc.tenantId });
      }
      skillOut = { id: skillRow.id, slug: skillRow.slug, ref: `custom:${skillRow.slug}` };
      await updateSession(tx, s.id, { skillId: skillRow.id, status: "saved" });
    }
    const what = s.kind === "agent" ? "version" : "skill version";
    const n = casesOut.length;
    const turn = await addTurn(tx, s, {
      role: "operator",
      text: `Saved as ${what} ${version.version}${n ? ` with ${n} test case${n === 1 ? "" : "s"}` : ""}.`,
      command: "/save",
      savedVersionId: version.id,
      meta: { errors: checkErrors(errors) },
    });
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    return {
      ...detail,
      turn: turnView(turn, new Set()),
      agent: agentOut,
      skill: skillOut,
      version,
      cases: casesOut,
      errors: checkErrors(errors),
    };
  });

  mount(app, routes.opsCloseBuilderSession, async (ctx) => {
    const s = await lockSession(ctx, ctx.params.id);
    await updateSession(ctx.tx, s.id, { status: "closed" });
    return sessionDetail(ctx, await readSession(ctx, s.id));
  });
}
