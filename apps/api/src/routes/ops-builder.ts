// Back office: the Builder (ARCHITECTURE §9.6, §14 "Agents"). `POST /api/ops/agents/draft` drafts a
// new template, or a client agent with `clientId`, and saves it as a v1 draft; `POST
// /api/ops/agents/:id/revise` saves a revision of a version as a new draft and answers its diff.
// The Builder's guards (packages/agents/src/builder) run on every answer; this file gathers what
// the Builder knows and saves what it made. Every handler runs inside withOperator. The Builder
// drafts and edits v5 workflows (docs/step-model-plan.md); a stored version is never changed
// (invariant 3).

import {
  type AgentRow,
  agentStepSkillPrefix,
  type BuilderContext,
  BuilderError,
  type BuilderSkill,
  type BuilderTemplate,
  blankStepAgentDraft,
  builderSlug,
  bundleSkillRefs,
  createClientAgent,
  createSkill,
  createSkillVersion,
  createTemplate,
  createVersion,
  customSlug,
  documentInputFields,
  draftStepAgent,
  EMPTY_SKILL_DRAFT,
  type ExistingSteps,
  entryKey,
  existingBundle,
  getAgent,
  getVersion,
  guardStepBundle,
  latestVersion,
  listClientAgents,
  listTemplates,
  readCommand,
  reviseStepAgent,
  runSkillCase,
  SkillDraft,
  STEP_ONLY_SKILLS,
  StepAgentBundle,
  skillChanges,
  skillTurn,
  stepAgentTurn,
  storeStepSkills,
  undoChange,
  undoneEntries,
  undoSkillChange,
  validateForPublish,
  type WrittenElsewhere,
  writtenSteps,
} from "@countersign/agents";
import {
  type AgentBundle,
  type BuilderChange,
  BuilderTurnMeta,
  type ClosestTemplate,
  classifyChange,
  closestBundles,
  connectorTitle,
  diffBundles,
  isToolWrapper,
  newStepSkillReason,
  parseCommand,
  parseSkillRef,
  routes,
  type SkillDefinition,
  SkillDefinition as SkillDefinitionSchema,
  type SkillTryView,
  skillTools,
  steps,
  type ToolSpec,
  TRY_ROWS_MAX,
  toolLookup,
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
import { knownModelIds, type LlmTransport } from "@countersign/llm";
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
import { clientModels } from "../compliance/models";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { meteredLlm, tokensMeta } from "../metering";
import { reportHandled } from "../observability/report";
import { agentSummary, versionSummary } from "./mappers";
import { builderAutomations } from "./ops-automations";
import {
  ACCOUNT_TOOL_PREFIX,
  actionCatalogFor,
  actionCatalogOf,
  bundleLabels,
  bundleStepTools,
  operatorSkills,
  SPLIT_MODEL_TOOLS,
} from "./ops-lineage";
import { readSkillSample } from "./skill-sample";

type Ctx = HandlerCtx<never>;

/**
 * The model transport, held to the client's HIPAA mode (§1.35) when the work is a client's; a
 * template or a shared skill is no client's data. Called inside the request's transaction.
 */
function transport(ctx: Pick<Ctx, "services" | "tx">, clientId: string | null): LlmTransport {
  return clientModels(ctx.services, { clients: [clientId], read: ctx.tx });
}

/** A conversation's draft: an agent's bundle, its workflows in the step model. */
type Draft = StepAgentBundle;

/**
 * Stream F (docs/step-model-plan.md §5): the rules and AI written in a v5 draft's steps, stored
 * behind them as the agent's own step skills (a new draft version only when the text changed) and
 * pinned in its skills, as the workflow builder saves them: the executor runs a written step only
 * through its pin.
 */
// DECISION (step model, build item 9): the Builder's saves pin as the workflow builder's do, so a
// draft it made runs (a test, the POC) without a save by hand first; its older pins for this agent
// are replaced by these.
async function pinWrittenSteps<B extends Draft>(
  ctx: Pick<Ctx, "tx" | "services">,
  agent: { id: string; tenantId: string | null },
  bundle: B,
  authorId: string | null,
): Promise<B> {
  const pins: string[] = [];
  for (const w of bundle.workflows) {
    const stored = await storeStepSkills(ctx.tx, {
      agentId: agent.id,
      tenantId: agent.tenantId,
      workflow: w.workflow,
      authorId,
      tools: ctx.services.platform.tools,
    });
    pins.push(...stored.map((p) => p.pin));
  }
  const own = `custom:${agentStepSkillPrefix(agent.id)}`;
  const kept = bundle.definition.skills.filter((x) => !x.skill.startsWith(own));
  if (pins.length === 0 && kept.length === bundle.definition.skills.length) return bundle;
  return {
    ...bundle,
    definition: {
      ...bundle.definition,
      skills: [...kept, ...pins.map((skill) => ({ skill, settings: {} }))],
    },
  } as B;
}

/** A stored bundle as the Builder edits it. */
function asDraft(raw: unknown): Draft {
  return StepAgentBundle.parse(raw);
}

/** v0.18: the working draft's step by id, as a turn's focus (its id and its name now). */
function focusedStep(working: Draft, stepId: string): { stepId: string; name: string } | null {
  for (const w of working.workflows) {
    const step = steps.findStep(w.workflow.steps, stepId);
    if (step) return { stepId, name: step.name };
  }
  return null;
}

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
export async function builderContext(
  ctx: Pick<Ctx, "tx" | "tenantIds" | "services">,
  clientId: string | null,
  self?: AgentRow,
  source?: AgentBundle | null,
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
  const base = platformBuilderContext(platform, { usedSkills, usedTools });
  const offered = base.offered;
  const skills: BuilderSkill[] = base.skills;
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
  // Step model (build item 9): what other agents write in their steps, for Save as skill.
  const written: WrittenElsewhere[] = [];
  const writtenIn = (agent: WrittenElsewhere["agent"], bundle: AgentBundle) => {
    for (const w of writtenSteps(bundle)) written.push({ agent, ...w });
  };
  for (const t of await listTemplates(tx)) {
    if (!t.liveVersionId || t.id === self?.id) continue;
    const b = (await getVersion(tx, t.liveVersionId)).bundle;
    writtenIn({ slug: t.slug, name: t.name, template: true }, b);
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
    const others = (await listClientAgents(tx, clientId)).filter(
      (a) => !a.testCopy && a.id !== self?.id && a.runStatus !== "retired",
    );
    agentSlugs = others.map((a) => a.slug);
    for (const a of others) {
      const latest = await latestVersion(tx, a.id);
      if (latest) writtenIn({ slug: a.slug, name: a.name, template: false }, latest.bundle);
    }
  } else {
    agentSlugs = templates.map((t) => t.slug);
  }
  // Saved Loops: the built-in ones and the operator's live ones (a Loop step's, never a Do's).
  const loops: BuilderSkill[] = [
    ...platform.catalog
      .list()
      .filter((def) => def.loop !== undefined)
      .map((definition) => ({ ref: definition.id, definition, source: "builtin" as const })),
    ...(await operatorSkills(ctx, clientId))
      .filter((s) => s.def.loop !== undefined)
      .map((s) => ({ ref: s.def.id, definition: s.def, source: s.source })),
  ];
  return {
    ...base.context,
    tools: builderTools(platform, usedTools),
    skills,
    templates,
    client,
    agentSlugs,
    stepModel: {
      // DECISION (step model, build item 9): the Builder's catalog is the Uses picker's, with the
      // actions the operator turned off left out, but a test-only connector stays offered, as the
      // Builder's tools offered it.
      actions: await actionCatalogFor(
        ctx,
        { tenantId: clientId, testCopy: self?.testCopy ?? false },
        from,
        { testConnectors: "shown" },
      ),
      profiles: platform.packs.flatMap((p) => p.manifest.matchProfiles),
      loops,
      written,
    },
  };
}

/**
 * The tools the Builder may name in a read or write step: all of them, less the hidden AI the
 * splits replaced, the account agent's handlers, and the handlers of the skills that run only as a
 * step of their own (a version that already calls one keeps it, so its steps still type).
 */
export function builderTools(
  platform: Ctx["services"]["platform"],
  used: ReadonlySet<string> = new Set(),
): ToolSpec[] {
  const stepOnlyTools = new Set(
    STEP_ONLY_SKILLS.map((id) => platform.catalog.get(id)?.handler).filter(
      (h): h is string => h !== undefined,
    ),
  );
  return platform.tools
    .list()
    .map((t) => t.spec)
    .filter(
      (t) =>
        used.has(t.id) ||
        !(
          SPLIT_MODEL_TOOLS.has(t.id) ||
          t.id.startsWith(ACCOUNT_TOOL_PREFIX) ||
          stepOnlyTools.has(t.id)
        ),
    );
}

/**
 * What the Builder knows from the platform alone (no database): the skills a new step may use,
 * the tools, connectors, packs and events. The Builder's test cases read the catalog this way
 * (src/evals); `builderContext` adds the operator's skills, templates and a client.
 */
export function platformBuilderContext(
  platform: Ctx["services"]["platform"],
  used: { usedSkills?: ReadonlySet<string>; usedTools?: ReadonlySet<string> } = {},
): {
  context: BuilderContext;
  skills: BuilderSkill[];
  offered: (def: SkillDefinition) => boolean;
} {
  const usedSkills = used.usedSkills ?? new Set<string>();
  const usedTools = used.usedTools ?? new Set<string>();
  const lookup = toolLookup(platform.tools.specs());
  // DECISION (owner, 2026-11-24, "there were multiple steps that it was not aware of"): the skills
  // that run only as a step of their own (Request info, Reach out, Converse) are offered as skills
  // and their handler tools are not, as the workflow builder's catalog does (`stepTools`). The
  // Builder was shown the tools and told to use a tool-wrapping skill's tool, which refuses to run
  // outside its step: it couldn't send a form and wait for it.
  const stepOnly = new Set<string>(STEP_ONLY_SKILLS);
  const offered = (def: SkillDefinition) =>
    usedSkills.has(def.id) ||
    stepOnly.has(def.id) ||
    (!isToolWrapper(def) && newStepSkillReason(def, lookup, platform.superseded) === null);
  const skills: BuilderSkill[] = platform.catalog
    .list()
    .filter(offered)
    .map((definition) => ({ ref: definition.id, definition, source: "builtin" }));
  return {
    offered,
    skills,
    context: {
      tools: builderTools(platform, usedTools),
      skills,
      // With each one's description: it names the service behind it (the bank feed's says Plaid).
      connectors: platform.connectors.list().map((c) => ({
        id: c.manifest.id,
        name: connectorTitle(c.manifest),
        description: c.manifest.description,
      })),
      // P-9: the packs this deployment registers (docs/plan.md §1.71); a client's own are in
      // `client`.
      packs: platform.packs.map((p) => ({ id: p.manifest.id, name: p.manifest.name })),
      events: platform.events.list(),
      templates: [],
      client: null,
      agentSlugs: [],
      // Step model (build item 9): the Uses picker's catalog with no connector's switches read
      // (`builderContext` reads them), the areas' match profiles and the built-in Loops.
      stepModel: {
        actions: actionCatalogOf(platform, {}),
        profiles: platform.packs.flatMap((p) => p.manifest.matchProfiles),
        loops: platform.catalog
          .list()
          .filter((def) => def.loop !== undefined)
          .map((definition) => ({ ref: definition.id, definition, source: "builtin" as const })),
        written: [],
      },
    },
  };
}

/**
 * A skill id (`custom:<slug>`) not taken in its scope, a client's skills or the shared ones, as
 * `freeSlug` finds an agent's (BUILDER_QA INPUT-4): two skills whose names give the same slug (any
 * name with no Latin letters gives "skill") are saved as "<slug>" and "<slug>-2".
 */
// DECISION: the id is made free at the first save, not when the skill is drafted: the scope's
// taken ids are only certain then, and the draft's id is the Builder's guess until it is saved.
async function freeSkillId(ctx: Pick<Ctx, "tx">, tenantId: string | null, id: string) {
  const taken = new Set(
    (
      await ctx.tx
        .select({ slug: skill.slug })
        .from(skill)
        .where(tenantId ? eq(skill.tenantId, tenantId) : isNull(skill.tenantId))
    ).map((r) => r.slug),
  );
  const root = customSlug(id) || "skill";
  let slug = root;
  for (let n = 2; taken.has(slug); n += 1) slug = `${root}-${n}`;
  return `custom:${slug}`;
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

/**
 * A Builder failure as the answer: reported (Sentry; a 4xx is not reported on its own), and said in
 * plain words with whether trying again helps. The internals (the model's error, the tool's name)
 * go to the report and the details, never into the words on screen.
 */
// DECISION (QA on staging, 2026-11-17): the screen showed "the answer was cut off at max_tokens
// partway through submit_draft" and Sentry had nothing, across two builds and four errors.
export function builderHttpError(error: unknown): never {
  if (error instanceof BuilderError) {
    const cause = (error.details as { code?: unknown } | undefined)?.code;
    const failure = typeof cause === "string" ? cause : error.code;
    reportHandled("a Builder answer could not be used", error, { kind: "builder", failure });
    if (error.code === "model_unavailable") {
      throw new HttpError(
        503,
        "builder_unavailable",
        "The Builder couldn't reach its model just now, so nothing changed. Try again in a minute.",
        { failure },
      );
    }
    // BUILDER_QA AI-7: a refusal is the model declining, not an answer in the wrong form.
    if (error.code === "refusal") {
      throw new HttpError(
        422,
        "builder_refused",
        "The Builder's model declined to answer this one, so nothing changed. Try saying it another way; we've logged it.",
        { failure },
      );
    }
    throw new HttpError(
      422,
      "builder_failed",
      failure === "max_tokens"
        ? "The Builder's answer was too long to finish, even as a smaller first draft, so nothing changed. Try again; if it stops again, take some rows out of the fit-gap to add to the draft later."
        : "The Builder's answer came back in a form we couldn't use, so nothing changed. Trying again usually works; we've logged it.",
      { failure },
    );
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
    // Every new draft is a v5 agent.
    const result = await draftStepAgent(
      {
        description: body.description,
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.worksFirst ? { worksFirst: true } : {}),
        ctx: bctx,
      },
      {
        // §1.210: the draft's calls are ours, recorded whether or not it is saved.
        llm: meteredLlm(
          { db: services.db, defer: ctx.defer },
          { transport: transport(ctx, clientId), tenantId: clientId, source: "builder" },
        ).llm,
        // Review: a new agent from the Builder is a first version: every step is new.
        shortlist: services.env.BUILDER_SHORTLIST !== "off",
        validate: (bundle) =>
          validateForPublish(tx, pseudo, bundle, services.platform.ctx, {
            previous: "none",
          }),
      },
    ).catch(builderHttpError);

    // The operator's name and area win over the model's.
    const bundle: StepAgentBundle = structuredClone(result.bundle);
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
    // The agent's id first, so its written steps are stored under it and v1 pins them.
    const agentId = uuidv7();
    const pinned = await pinWrittenSteps(
      ctx,
      { id: agentId, tenantId: clientId },
      bundle,
      session.user.id,
    );
    const created = clientId
      ? await createClientAgent(tx, {
          id: agentId,
          tenantId: clientId,
          slug,
          bundle: pinned,
          authorType: "builder",
          authorId: session.user.id,
          changeNote,
          ...(result.serviceName ? { serviceName: result.serviceName } : {}),
          ...(result.serviceDescription ? { serviceDescription: result.serviceDescription } : {}),
        })
      : await createTemplate(tx, {
          id: agentId,
          slug,
          bundle: pinned,
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
      decisions: result.decisions,
      gapSteps: result.gapSteps,
      saveAsSkill: result.saveAsSkill,
      loops: result.loops,
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
    const options = {
      // §1.210: the revision's calls are ours, recorded whether or not it is saved.
      llm: meteredLlm(
        { db: services.db, defer: ctx.defer },
        { transport: transport(ctx, row.tenantId), tenantId: row.tenantId, source: "builder" },
      ).llm,
      shortlist: services.env.BUILDER_SHORTLIST !== "off",
    };
    const instruction = {
      ...(body.instruction ? { instruction: body.instruction } : {}),
      ...(request ? { request } : {}),
      ctx: bctx,
    };
    const result = await reviseStepAgent(
      { source: asDraft(from.bundle), ...instruction },
      {
        ...options,
        validate: (bundle) =>
          validateForPublish(tx, row, bundle, services.platform.ctx, { previous }),
      },
    ).catch(builderHttpError);

    const v = await createVersion(tx, {
      agentId: row.id,
      bundle: await pinWrittenSteps(ctx, row, result.bundle, session.user.id),
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
      // v0.19 (§10.15): what the draft would do, by code: a process change to approve, or one
      // that loosens or widens (an owner never drafts those; the operator decides).
      changeClass: classifyChange(from.bundle, v.bundle),
      ...(result.saveAsSkill ? { saveAsSkill: result.saveAsSkill } : {}),
      ...(result.loops ? { loops: result.loops } : {}),
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
  working: Draft | null,
  self?: AgentRow,
): Promise<BuilderContext> {
  const base = await builderContext(ctx, clientId, self);
  const skills = Object.fromEntries(base.skills.map((s) => [s.ref, s.definition]));
  const automations = (
    await builderAutomations(ctx.tx, {
      tenantId: clientId,
      tenantIds: ctx.tenantIds,
      bundle: working ? working : null,
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
async function originOf(ctx: SessionCtx, s: SessionRow): Promise<Draft | null> {
  return s.kind === "agent" && s.baseVersionId
    ? asDraft((await getVersion(ctx.tx, s.baseVersionId)).bundle)
    : null;
}

/** Live templates like the draft, best first (core's bundleSimilarity). */
async function closestTemplates(
  ctx: SessionCtx,
  bundle: AgentBundle,
  selfId: string | null,
): Promise<ClosestTemplate[]> {
  const candidates: {
    key: string;
    bundle: AgentBundle;
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
    const bundle = asDraft(s.bundle);
    shown = bundle;
    const { validateAs } = await sessionAgent(ctx, s);
    errors = checkErrors(
      await validateForPublish(ctx.tx, validateAs, bundle, ctx.services.platform.ctx, {
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
        bundle = asDraft(from.bundle);
        text = `Started from ${row.name} v${from.version}.`;
      } else {
        bundle = blankStepAgentDraft({
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
    // §1.210: a turn's cost is saved on its Builder row; a turn that fails saves none, so its
    // calls are recorded as ours once the request ends, unless the turn was saved (`settled`).
    const metered = meteredLlm(
      { db: services.db, defer: ctx.defer },
      { transport: transport(ctx, s.tenantId), tenantId: s.tenantId, source: "builder" },
    );
    const llm = metered.llm;
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
      // A sample of what the skill gets: read here, seen by the Builder, never stored.
      const sample = body.sample ? readSkillSample(body.sample) : null;
      if (sample && !sample.forBuilder) {
        throw new HttpError(
          422,
          "sample_unreadable",
          sample.view.failure ?? `${body.sample?.filename} couldn't be read`,
        );
      }
      const result = await skillTurn(
        {
          current,
          history,
          message: body.text,
          examples: body.examples ?? [],
          ctx: { ...bctx, models: knownModelIds() },
          turnId: builderTurnId,
          ...(sample?.forBuilder ? { sample: sample.forBuilder } : {}),
        },
        { llm },
      ).catch(builderHttpError);
      const changes = skillChanges(current, result.draft);
      await addTurn(tx, s, {
        role: "operator",
        text: body.text,
        // The sample's name and kind only: the file itself is never kept.
        ...(sample
          ? { meta: { sample: { filename: sample.view.filename, kind: sample.view.kind } } }
          : {}),
      });
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
          ...tokensMeta(result.calls),
        },
        costUsd: result.costUsd,
      });
      if (changes.length > 0) await updateSession(tx, s.id, { bundle: result.draft });
      const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
      metered.settled();
      return { ...detail, turn: turnView(turn, new Set()) };
    }

    if (body.examples?.length) {
      throw new HttpError(422, "invalid_request", "examples go with a skill conversation");
    }
    if (body.sample) {
      throw new HttpError(422, "invalid_request", "a sample file goes with a skill conversation");
    }
    const working = asDraft(s.bundle);
    const { row, validateAs } = await sessionAgent(ctx, s);
    const bctx = await conversationContext(ctx, s.tenantId, working, row ?? undefined);
    const previous = await sessionExisting(ctx, s, turns);
    const read = readCommand(body.text, { bundle: working, automations: bctx.automations ?? [] });
    if (!read.ok) throw new HttpError(422, read.code, read.message);
    const command = read.command;
    const request = body.requestId ? await requestText(ctx, s, body.requestId) : undefined;
    // v0.18: a focus on a step the working draft no longer has is dropped (the turn is about the
    // whole draft); the turn keeps the step's name as it was, for the chat.
    const focus = body.focusStepId ? focusedStep(working, body.focusStepId) : null;
    // Two rounds: the shortlist an earlier turn made, kept on that turn's meta.
    const madeBefore =
      [...turns]
        .reverse()
        .map((t) => BuilderTurnMeta.parse(t.meta ?? {}).shortlist)
        .find(Boolean) ?? null;
    const origin = await originOf(ctx, s);
    const turnInput = {
      shortlist: madeBefore,
      history,
      message: body.text,
      command,
      ...(request ? { request } : {}),
      // v0.18 (docs/plan.md §1.105): the step the operator has open, when the turn is about one.
      ...(focus ? { focusStepId: focus.stepId } : {}),
      ctx: bctx,
    };
    const turnOptions = {
      llm,
      shortlist: services.env.BUILDER_SHORTLIST !== "off",
      validate: (bundle: Draft) =>
        validateForPublish(tx, validateAs, bundle, services.platform.ctx, { previous }),
    };
    const result = await stepAgentTurn({ ...turnInput, working, origin }, turnOptions).catch(
      builderHttpError,
    );
    // A shortlist this turn made is kept on its operator turn, for the turns after it.
    const madeNow = !madeBefore && result.shortlist ? { shortlist: result.shortlist } : {};
    await addTurn(tx, s, {
      role: "operator",
      text: body.text,
      command: command ? `/${command.name}` : null,
      meta: {
        ...madeNow,
        ...(command
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
          : {}),
        ...(focus ? { focus } : {}),
      },
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
        ...tokensMeta(result.calls),
      },
      costUsd: result.costUsd,
    });
    if (result.changes.length > 0) await updateSession(tx, s.id, { bundle: result.bundle });
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    metered.settled();
    return { ...detail, turn: turnView(turn, new Set()) };
  });

  // Check the skill (owner, 2026-11-24): the operator's own change to a skill draft, recorded as
  // an operator turn with labelled changes, so each can be undone like the Builder's.
  mount(app, routes.opsBuilderSkillEdit, async (ctx) => {
    const { tx, body } = ctx;
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    if (s.kind !== "skill") {
      throw new HttpError(
        422,
        "invalid_request",
        "a skill draft is changed in a skill conversation",
      );
    }
    const current = SkillDraft.parse(s.bundle);
    if (!current.definition) {
      throw new HttpError(409, "nothing_drafted", "there is no draft to change yet");
    }
    const { addCase, ...parts } = body;
    const merged = SkillDefinitionSchema.safeParse({ ...current.definition, ...parts });
    if (!merged.success) {
      throw new HttpError(
        422,
        "invalid_skill",
        merged.error.issues.map((i) => `${i.path.join(".") || "skill"}: ${i.message}`).join("; "),
      );
    }
    for (const side of ["input", "output"] as const) {
      const schema = merged.data[side] as { type?: unknown };
      if (schema.type !== "object") {
        throw new HttpError(
          422,
          "invalid_skill",
          `what it ${side === "input" ? "gets" : "gives back"} is a set of named fields`,
        );
      }
    }
    const next = {
      definition: merged.data,
      cases: addCase
        ? [
            ...current.cases,
            {
              key: uuidv7(),
              name: addCase.name,
              input: addCase.input,
              expected: addCase.expected,
              matcher: { kind: "subset" as const },
              required: true,
            },
          ]
        : current.cases,
    };
    const draft = SkillDraft.parse(next);
    const changes = skillChanges(current, draft);
    if (changes.length === 0) {
      throw new HttpError(409, "no_change", "that is what the draft says already");
    }
    const what = [
      parts.input ? "what it gets" : null,
      parts.instructions ? "what it does" : null,
      parts.output ? "what it gives back" : null,
      parts.name || parts.description ? "its name" : null,
      addCase ? `a test (${addCase.name})` : null,
    ].filter(Boolean);
    const turn = await addTurn(tx, s, {
      role: "operator",
      text: `${addCase && what.length === 1 ? "Kept" : "Changed by hand"}: ${what.join(", ")}.`,
      command: "/edit",
      changes,
      bundle: draft,
    });
    await updateSession(tx, s.id, { bundle: draft });
    const detail = await sessionDetail(ctx, await readSession(ctx, s.id));
    return { ...detail, turn: turnView(turn, new Set()) };
  });

  // Check the skill (owner, 2026-11-24): the draft tried once, on the test bench (in memory, every
  // write refused). A sample spreadsheet's rows, a sample PDF or image (read from memory, never
  // stored), or a JSON input. The model calls are ours, as the Builder's are.
  mount(app, routes.opsBuilderSkillTry, async (ctx): Promise<SkillTryView> => {
    const { body, services } = ctx;
    const s = await readSession(ctx, ctx.params.id);
    if (s.kind !== "skill") {
      throw new HttpError(422, "invalid_request", "only a skill draft is tried here");
    }
    const def = SkillDraft.parse(s.bundle).definition;
    if (!def) throw new HttpError(409, "nothing_drafted", "there is no draft to try yet");
    let input: unknown = body.input;
    let from: string | null = null;
    let keepable = true;
    const files: { documentId: string; filename: string; mimeType: string; bytes: Uint8Array }[] =
      [];
    if (body.sample) {
      const sample = readSkillSample(body.sample);
      if (sample.view.failure && sample.rows.length === 0) {
        throw new HttpError(422, "sample_unreadable", sample.view.failure);
      }
      const fields =
        (def.input as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
      if (sample.document) {
        const field = documentInputFields(def)[0];
        if (!field) {
          throw new HttpError(
            422,
            "not_a_document_skill",
            "this skill doesn't take a document: give what it gets a document field, or try it on JSON",
          );
        }
        files.push({ documentId: "sample", filename: body.sample.filename, ...sample.document });
        input = { [field]: "sample" };
        from = body.sample.filename;
        keepable = false;
      } else {
        // The rows go to the skill's list field: `rows` as Read table gives them, else its first.
        const list =
          "rows" in fields
            ? "rows"
            : Object.entries(fields).find(([, f]) => f?.type === "array")?.[0];
        if (!list) {
          throw new HttpError(
            422,
            "not_a_rows_skill",
            "this skill doesn't take a list of rows: give what it gets a list field, or try it on JSON",
          );
        }
        const rows = sample.rows.slice(0, TRY_ROWS_MAX);
        input = { [list]: rows };
        from =
          sample.rows.length > rows.length
            ? `the first ${rows.length} of ${sample.rows.length} rows of ${body.sample.filename}`
            : `the ${rows.length} ${rows.length === 1 ? "row" : "rows"} of ${body.sample.filename}`;
      }
    }
    const result = await runSkillCase(
      { tools: services.platform.tools, transport: transport(ctx, s.tenantId) },
      { definition: def, tenantId: s.tenantId, input, fixtures: [], files },
    );
    return {
      status: result.status,
      input,
      from,
      output: result.output,
      error: result.error,
      costUsd: result.costUsd,
      modelCalls: result.modelCalls,
      toolCalls: result.toolCalls,
      keepable,
    };
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
      const r = undoChange({
        before: asDraft(bundleBefore(turns, target.seq)),
        after: asDraft(target.bundle),
        working: asDraft(s.bundle),
        changeId: entry.id,
      });
      if (!r.ok) {
        throw new HttpError(409, "undo_conflict", UNDO_CONFLICT, { conflicts: r.conflicts });
      }
      const undone = asDraft(r.bundle);
      // The guards hold after an undo too (approvals, mode), keeping every id the merge brought.
      const { row } = await sessionAgent(ctx, s);
      const bctx = await conversationContext(ctx, s.tenantId, undone, row ?? undefined);
      const origin = await originOf(ctx, s);
      next = guardStepBundle(undone, bctx, { mode: "revise", source: undone, origin }).bundle;
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
      const draft = asDraft(s.bundle);
      // The agent's id first (a new one's made here), so a v5 draft's written steps are stored
      // under it and the version pins them.
      const agentId = s.agentId ?? uuidv7();
      const bundle = await pinWrittenSteps(
        ctx,
        { id: agentId, tenantId: s.tenantId },
        draft,
        session.user.id,
      );
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
              id: agentId,
              tenantId: s.tenantId,
              slug,
              bundle,
              authorType: "builder",
              authorId: session.user.id,
              changeNote,
            })
          : await createTemplate(tx, {
              id: agentId,
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
      errors = await validateForPublish(tx, row, bundle, services.platform.ctx, {
        previous: await existingBundle(tx, saved),
      });
      agentOut = { id: row.id, slug: row.slug };
      await updateSession(tx, s.id, { agentId: row.id, status: "saved" });
    } else {
      const draft = SkillDraft.parse(s.bundle);
      if (!draft.definition) throw new HttpError(422, "no_definition", "no skill drafted yet");
      let skillRow: { id: string; slug: string };
      if (!s.skillId) {
        // BUILDER_QA INPUT-4: an id free in the skill's scope; the conversation keeps it from here.
        const id = await freeSkillId(ctx, s.tenantId, draft.definition.id);
        const definition =
          id === draft.definition.id ? draft.definition : { ...draft.definition, id };
        if (definition !== draft.definition) {
          await updateSession(tx, s.id, { bundle: { ...draft, definition } });
        }
        const created = await createSkill(tx, {
          tenantId: s.tenantId,
          definition,
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

  // Feedback, 2026-11-26: "the Builder does not keep the history of the conversation". The step
  // builder started a new conversation whenever the chart had moved on from the conversation's
  // draft (any edit there), and a new conversation starts with no turns. Now the same
  // conversation picks up the version the operator saved: its draft becomes that version's, and a
  // turn says so, so the Builder reads on with every earlier turn. Undo of an earlier change still
  // merges against the draft as it now is (`undo_conflict` when it can't).
  mount(app, routes.opsSyncBuilderSession, async (ctx) => {
    const s = await lockSession(ctx, ctx.params.id);
    refuseClosed(s);
    if (s.kind !== "agent" || !s.agentId) {
      throw new HttpError(
        422,
        "invalid_request",
        "only an existing agent's conversation follows a saved version",
      );
    }
    const v = await getVersion(ctx.tx, ctx.body.fromVersionId);
    if (v.agentId !== s.agentId) throw notFound("version");
    const bundle = asDraft(v.bundle);
    await updateSession(ctx.tx, s.id, { bundle });
    await addTurn(ctx.tx, s, {
      role: "builder",
      text: `You changed the draft yourself (saved as v${v.version}). I'm working from that now.`,
      bundle,
      savedVersionId: v.id,
    });
    return sessionDetail(ctx, await readSession(ctx, s.id));
  });

  mount(app, routes.opsCloseBuilderSession, async (ctx) => {
    const s = await lockSession(ctx, ctx.params.id);
    await updateSession(ctx.tx, s.id, { status: "closed" });
    return sessionDetail(ctx, await readSession(ctx, s.id));
  });
}
