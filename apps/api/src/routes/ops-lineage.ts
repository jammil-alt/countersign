// Back office: what the agent pages need beyond create/save/publish (ARCHITECTURE §9.3, §14
// "Agents", "Lineage", "Operation"): retire, the activation check with every reason, the skills an
// agent may use with their settings, a version's diff against its parent, a client agent's
// customizations against its base template version, and a template's "Used by". Every handler
// runs inside withOperator(the clients served), so templates are visible and client agents only of
// served clients.

import {
  type AgentRow,
  type AgentVersionRow,
  activationProblems,
  bundleSkillRefs,
  CUSTOM_PREFIX,
  getAgent,
  getVersion,
  latestVersion,
  lineageReadOptions,
  requiredConnectors,
  resolveCustomSkill,
  retire,
  SHARED_COPY_PREFIX,
  skillContext,
} from "@countersign/agents";
import {
  type AnyAgentBundle,
  type BuilderCatalog,
  type BundleChange,
  connectorShown,
  diffBundles,
  flattenBundle,
  isToolWrapper,
  mergeBundles,
  newStepSkillReason,
  parseSkillRef,
  processes,
  recommendedModel,
  routes,
  type SkillDefinition,
  type SkillToolLookup,
  skillKind,
  skillModelFacts,
  skillMoveImpact,
  toolLookup,
} from "@countersign/core";
import { agent, connection, run, skill, skillVersion, type Tx, tenant } from "@countersign/db";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, HttpError, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { agentSummary, versionSummary } from "./mappers";
// v0.12 W2-B
import { builderAutomations } from "./ops-automations";

type Scope = Pick<HandlerCtx<never>, "tx" | "tenantIds">;

/** The agent, if it is visible to this request (templates, or a client agent of a served client). */
export async function agentInScope(ctx: Scope, id: string): Promise<AgentRow> {
  const row = await getAgent(ctx.tx, id);
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  return row;
}

/** The live version, else the newest one (a draft that was never published). */
async function currentVersion(ctx: Scope, row: AgentRow): Promise<AgentVersionRow | null> {
  if (row.liveVersionId) return getVersion(ctx.tx, row.liveVersionId);
  const latest = await latestVersion(ctx.tx, row.id);
  return latest ?? null;
}

/**
 * A name for every entity either bundle has, so the screens can say "Step Ask Jammil changed"
 * instead of `step:9f…`. Skills are labelled by their reference; otherwise branches "Otherwise".
 */
export function bundleLabels(...bundles: AnyAgentBundle[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bundles) {
    for (const [key, e] of flattenBundle(b).entities) {
      const name = e.content.name;
      out[key] =
        e.kind === "skill"
          ? String(e.content.skill)
          : e.kind === "otherwise"
            ? "Otherwise"
            : typeof name === "string" && name.trim()
              ? name
              : key;
    }
  }
  return out;
}

/**
 * diffBundles, refusing cleanly when a stored draft can't be flattened (duplicate ids). R9: `read`
 * reads v3 workflows as v4 when the two versions are one of each (an agent updated to v4).
 */
function diff(
  a: AnyAgentBundle,
  b: AnyAgentBundle,
  read: ReturnType<typeof lineageReadOptions>,
): { changes: BundleChange[] } {
  try {
    return { changes: diffBundles(a, b, read) };
  } catch (error) {
    throw new HttpError(
      422,
      "invalid_bundle",
      `these versions can't be compared: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function labels(...bundles: AnyAgentBundle[]): Record<string, string> {
  try {
    return bundleLabels(...bundles);
  } catch {
    return {};
  }
}

/**
 * The operator-written skills an agent may use: shared skills (tenant_id null) and, for a client
 * agent, the client's own, which win over a shared one of the same slug (as resolveCustomSkill
 * resolves them). Clients' snapshot copies of shared skills (`shared:<slug>`) are not offered:
 * the shared skill itself is. Only skills with a live version.
 */
export async function operatorSkills(
  ctx: Scope,
  tenantId: string | null,
): Promise<{ def: SkillDefinition; source: "client" | "shared"; version: number }[]> {
  const rows = await ctx.tx
    .select({ skill, version: skillVersion })
    .from(skill)
    .innerJoin(skillVersion, eq(skillVersion.id, skill.liveVersionId))
    .where(
      and(
        eq(skill.status, "active"),
        isNotNull(skill.liveVersionId),
        tenantId === null
          ? isNull(skill.tenantId)
          : or(isNull(skill.tenantId), eq(skill.tenantId, tenantId)),
      ),
    );
  const bySlug = new Map<
    string,
    { def: SkillDefinition; source: "client" | "shared"; version: number }
  >();
  for (const r of rows) {
    if (r.skill.slug.startsWith(SHARED_COPY_PREFIX)) continue;
    const source = r.skill.tenantId === null ? "shared" : "client";
    const existing = bySlug.get(r.skill.slug);
    if (existing?.source === "client") continue;
    bySlug.set(r.skill.slug, {
      def: { ...r.version.definition, id: `${CUSTOM_PREFIX}${r.skill.slug}` },
      source,
      version: r.version.version,
    });
  }
  return [...bySlug.values()];
}

/**
 * Skill model (2026-11-10): the platform's and packs' tools a process may call directly as a read
 * or write step: those a retired tool-wrapper skill wrapped, and every other platform or pack tool
 * (the splits' and the templates' reads and Save to records writes: `docs.reading.record`,
 * `bookkeeping.booking.propose`, …), less the handlers of skills that are steps of their own (a
 * conversation, a reach-out). A connector's tools are offered under the connector, as before.
 */
// DECISION (templates): every platform and pack tool is a step tool, not only what a wrapper
// wrapped, so the operator can build what the new template versions are built from.
// Review: less the hidden AI the splits replaced (`SPLIT_MODEL_TOOLS`) and the account agent's
// handlers (`account.*`), each kept only where the agent's latest version already calls it as a
// step (`used`), so a stored step still types and reads by name.
export function stepTools(platform: Platform, used: ReadonlySet<string> = new Set()): string[] {
  const stepOnly = new Set(
    processes.STEP_ONLY_SKILLS.map((id) => platform.catalog.get(id)?.handler).filter(
      (h): h is string => h !== undefined,
    ),
  );
  const connectors = new Set(platform.connectors.list().map((c) => c.manifest.id));
  const out = new Set<string>();
  for (const def of platform.catalog.list()) {
    if (isToolWrapper(def) && def.handler && !stepOnly.has(def.handler)) out.add(def.handler);
  }
  for (const t of Object.values(platform.tools.specs())) {
    if (stepOnly.has(t.id) || connectors.has(t.connector ?? t.source)) continue;
    out.add(t.id);
  }
  for (const id of out) {
    if ((SPLIT_MODEL_TOOLS.has(id) || id.startsWith(ACCOUNT_TOOL_PREFIX)) && !used.has(id)) {
      out.delete(id);
    }
  }
  return [...out].sort();
}

/**
 * Skill model (2026-11-10, review): tools that call a model inside (`usesModel`) and were split
 * into an AI skill, a deterministic check and a Save to records step. They stay registered for
 * the agents whose stored versions call them (invariant 3); a new step uses the split instead:
 * Read document → Check totals → record the reading (`docs.extract`, `docs.read`); Look up
 * existing → Match the unmatched → Check matches → record the matches (`materials.match_line`,
 * `materials.match_lines`, and `materials.catalog.create_item`, which reads a new item's name
 * with a model).
 */
// DECISION (review): the list is named here, where the platform and the packs are wired together,
// rather than as a new field on every tool spec; a tool that calls a model and has no split
// (web search and fetch, translate) stays offered, labelled AI in the builder and the run view.
export const SPLIT_MODEL_TOOLS: ReadonlySet<string> = new Set([
  "docs.extract",
  "docs.read",
  "materials.match_line",
  "materials.match_lines",
  "materials.catalog.create_item",
]);

/** The account agent's (Sloan's) handlers: steps of its own processes, never general tools. */
export const ACCOUNT_TOOL_PREFIX = "account.";

/** The tools an agent's processes call as read or write steps (core's `processTools`). */
export function bundleStepTools(bundle: AnyAgentBundle | null | undefined): Set<string> {
  if (!bundle) return new Set();
  const v4 = bundle.workflows
    .map((w) => w.workflow)
    .filter((w): w is processes.Process => w.schemaVersion === 4);
  return new Set(processes.processTools(v4));
}

function skillOption(
  def: SkillDefinition,
  source: "builtin" | "client" | "shared",
  version: number | null,
  lookup?: SkillToolLookup,
) {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    source,
    version,
    settings: def.settings.map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      default: s.default,
      ...(s.options ? { options: s.options } : {}),
      clientSpecific: s.clientSpecific,
    })),
    requiresConnectors: def.requiresConnectors,
    // Skill model (2026-11-10), wave A: the agent's per-skill section (parameters, model).
    kind: skillKind(def, lookup),
    parameters: def.parameters ?? [],
    recommendedModel: recommendedModel(def),
  };
}

/**
 * The test-only connectors (the testkit) an agent's builder doesn't offer: all of them, unless the
 * agent is in the Sandbox client or a template's test copy, or its client has a connection to it,
 * or its latest version already names one of its tools.
 */
// DECISION: "names one of its tools" reads the bundle as text for the tool ids (a step's tool, an
// extra tool, a rule): a version that already uses the testkit keeps typing in the builder.
async function hiddenTestConnectors(
  tx: Tx,
  row: AgentRow,
  bundle: AnyAgentBundle | null,
  platform: Platform,
): Promise<Set<string>> {
  const testOnly = platform.connectors.list().filter((c) => c.manifest.testOnly === true);
  if (testOnly.length === 0) return new Set();
  let sandbox = false;
  let connected = new Set<string>();
  if (row.tenantId) {
    const [t] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, row.tenantId));
    sandbox = t?.settings.sandbox === true;
    const conns = await tx
      .select({ connector: connection.connector })
      .from(connection)
      .where(eq(connection.tenantId, row.tenantId));
    connected = new Set(conns.map((c) => c.connector));
  }
  const text = bundle ? JSON.stringify(bundle) : "";
  return new Set(
    testOnly
      .filter(
        (c) =>
          !connectorShown(c.manifest, {
            sandbox,
            testCopy: row.testCopy,
            inUse:
              connected.has(c.manifest.id) ||
              c.manifest.tools.some((t) => text.includes(JSON.stringify(t.id))),
          }),
      )
      .map((c) => c.manifest.id),
  );
}

export function opsLineageRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsRetire, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const updated = await retire(ctx.tx, { agentId: row.id, actorId: ctx.session.user.id });
    return { agent: agentSummary(updated) };
  });

  mount(app, routes.opsActivation, async (ctx) => {
    const { tx, services } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const problems = await activationProblems(tx, { agentId: row.id, ctx: services.platform.ctx });
    const v = await currentVersion(ctx, row);
    let required: string[] = [];
    if (v) {
      const { skills } = await skillContext(tx, {
        tenantId: row.tenantId,
        bundle: v.bundle,
        catalog: services.platform.catalog,
      });
      required = requiredConnectors(v.bundle, skills, services.platform.tools);
    }
    // DECISION: the activation check answers the latest test run of the live version, so the
    // agent page polls while it is going instead of reporting "no passing test run" until a
    // reload (docs/plan.md §1.16).
    const [latestTest] =
      row.kind === "client" && row.tenantId && row.liveVersionId
        ? await tx
            .select({ id: run.id, status: run.status, createdAt: run.createdAt })
            .from(run)
            .where(
              and(
                eq(run.tenantId, row.tenantId),
                eq(run.agentId, row.id),
                eq(run.agentVersionId, row.liveVersionId),
                eq(run.mode, "test"),
              ),
            )
            .orderBy(desc(run.createdAt), desc(run.id))
            .limit(1)
        : [];
    return {
      ready: problems.length === 0,
      problems,
      requiredConnectors: required,
      testRun: latestTest
        ? {
            id: latestTest.id,
            status: latestTest.status,
            createdAt: latestTest.createdAt.toISOString(),
          }
        : null,
    };
  });

  mount(app, routes.opsAgentSkills, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    // Skill model (2026-11-10): a skill that only wraps a tool is offered only where the agent
    // already lists it (a process uses the tool directly as a read or write step).
    const latest = await latestVersion(ctx.tx, row.id);
    const listed = new Set(
      (latest ? bundleSkillRefs(latest.bundle) : []).map((r) => parseSkillRef(r).id),
    );
    const lookup = toolLookup(ctx.services.platform.tools.specs());
    const builtins = ctx.services.platform.catalog
      .list()
      .filter((def) => !isToolWrapper(def) || listed.has(def.id))
      .map((def) => skillOption(def, "builtin", null, lookup));
    const custom = (await operatorSkills(ctx, row.tenantId)).map((s) =>
      skillOption(s.def, s.source, s.version, lookup),
    );
    return {
      skills: [...builtins, ...custom].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  mount(app, routes.opsBuilderCatalog, async (ctx) => {
    const { tx, services } = ctx;
    const { platform } = services;
    const row = await agentInScope(ctx, ctx.params.id);
    type Entry = BuilderCatalog["skills"][number];
    const lookup = toolLookup(platform.tools.specs());
    // Instructions stay out: the builder places skills, it doesn't read their prompts.
    // Skill model (2026-11-10): each entry says its kind, and whether the palette offers it for a
    // new step (never a tool wrapper, an agent-mode or a `rules_then_ai` skill, or one that writes).
    const entry = (
      ref: string,
      def: SkillDefinition,
      source: Entry["source"],
      version: number | null,
    ): Entry => {
      const { instructions: _instructions, ...definition } = def;
      return {
        ref,
        source,
        version,
        definition,
        kind: skillKind(def, lookup),
        palette: !isToolWrapper(def) && newStepSkillReason(def, lookup) === null,
      };
    };
    const latest = await latestVersion(tx, row.id);
    // A tool wrapper is listed only where the agent's latest version already names it, so a
    // stored step still types; a process uses the tool directly.
    const named = new Set(
      (latest ? bundleSkillRefs(latest.bundle) : []).map((r) => parseSkillRef(r).id),
    );
    const skills = new Map<string, Entry>();
    for (const def of platform.catalog.list()) {
      if (isToolWrapper(def) && !named.has(def.id)) continue;
      skills.set(def.id, entry(def.id, def, "builtin", null));
    }
    for (const s of await operatorSkills(ctx, row.tenantId)) {
      if (!skills.has(s.def.id)) skills.set(s.def.id, entry(s.def.id, s.def, s.source, s.version));
    }
    // DECISION: the builder validates with the skills the server would: a reference the latest
    // version already makes (a pinned `@version`, a client's snapshot of a shared skill) resolves
    // as validateForPublish resolves it, and is offered under that reference.
    if (latest) {
      const resolved = await skillContext(tx, {
        tenantId: row.tenantId,
        bundle: latest.bundle,
        catalog: platform.catalog,
      });
      for (const [ref, def] of Object.entries(resolved.skills)) {
        if (!skills.has(ref)) skills.set(ref, entry(ref, def, "pinned", null));
      }
    }
    // Test-only connectors (the testkit) and their tools only for the Sandbox and test copies, or
    // where the agent or its client already uses them (core's connectorShown).
    const hidden = await hiddenTestConnectors(tx, row, latest?.bundle ?? null, platform);
    const toolHidden = (id: string) => {
      const owner = platform.connectors.findTool(id)?.connector.manifest.id;
      return owner !== undefined && hidden.has(owner);
    };
    return {
      skills: [...skills.values()].sort((a, b) =>
        a.definition.name.localeCompare(b.definition.name),
      ),
      tools: platform.tools
        .list()
        .map((t) => t.spec)
        .filter((t) => !toolHidden(t.id)),
      // Skill model (2026-11-10): the tools a step may call directly, which the retired wrappers
      // wrapped (a conversation's or a reach-out's handler is a step of its own, not a tool step).
      stepTools: stepTools(platform, bundleStepTools(latest?.bundle)).filter(
        (id) => !toolHidden(id),
      ),
      connectors: platform.connectors
        .list()
        .filter((c) => !hidden.has(c.manifest.id))
        .map((c) => ({
          id: c.manifest.id,
          name: c.manifest.name,
          icon: c.manifest.icon || null,
        })),
      // v0.12 W2-B: automations a use step can pin (ARCHITECTURE §10.7).
      automations: await builderAutomations(tx, {
        tenantId: row.tenantId,
        tenantIds: ctx.tenantIds,
        bundle: latest?.bundle ?? null,
        skills: Object.fromEntries([...skills.values()].map((s) => [s.ref, s.definition])),
        platform,
      }),
    };
  });

  // Skill model (2026-11-10): what moves if a skill step goes to another version of its skill.
  mount(app, routes.opsSkillStepMove, async (ctx) => {
    const { tx, services, body } = ctx;
    const { platform } = services;
    const row = await agentInScope(ctx, ctx.params.id);
    const parsed = processes.Process.safeParse(body.process);
    if (!parsed.success) {
      throw new HttpError(422, "invalid_process", "the process doesn't read as a v4 process");
    }
    const process = parsed.data;
    const step = processes.findStep(process, body.stepId)?.step;
    if (step?.kind !== "skill") {
      throw new HttpError(422, "not_a_skill_step", `no skill step "${body.stepId}" in the process`);
    }
    if (parseSkillRef(step.skill).id !== parseSkillRef(body.to).id) {
      throw new HttpError(
        422,
        "not_the_same_skill",
        "a step moves only between versions of its skill",
      );
    }
    // Every skill the process names, and the one it moves to, as the server resolves them.
    const resolve = async (ref: string): Promise<SkillDefinition | null> => {
      const builtin = platform.catalog.get(parseSkillRef(ref).id);
      if (builtin) return builtin;
      return (await resolveCustomSkill(tx, { tenantId: row.tenantId, ref }))?.definition ?? null;
    };
    const skills: Record<string, SkillDefinition> = {};
    const refs = new Set<string>();
    processes.walkSteps(process, ({ step: s }) => {
      if (s.kind === "skill") refs.add(s.skill);
    });
    for (const ref of refs) {
      const def = await resolve(ref);
      if (def) skills[ref] = def;
    }
    const to = await resolve(body.to);
    if (!to) throw notFound(`skill ${body.to}`);
    const lookup = toolLookup(platform.tools.specs());
    const impact = skillMoveImpact(process, body.stepId, body.to, to, {
      skills,
      tools: platform.tools.specs(),
      ...(platform.ctx.events ? { events: platform.ctx.events } : {}),
    });
    if (!impact) throw new HttpError(422, "not_a_skill_step", "that step is not a skill step");
    const { instructions: _instructions, ...definition } = to;
    return { ...impact, definition, facts: skillModelFacts(to, lookup) };
  });

  mount(app, routes.opsVersionDiff, async (ctx) => {
    const { tx, params, query } = ctx;
    const row = await agentInScope(ctx, params.id);
    const to = await getVersion(tx, params.vid);
    if (to.agentId !== row.id) throw notFound("version");
    const fromId = query.against ?? to.parentVersionId;
    const from = fromId ? await getVersion(tx, fromId) : null;
    if (from && from.agentId !== row.id) throw notFound("version");
    // The first version has nothing to compare against: no changes, `from` null.
    const read = lineageReadOptions(ctx.services.platform.ctx);
    const { changes } = from ? diff(from.bundle, to.bundle, read) : { changes: [] };
    return {
      from: from ? versionSummary(from) : null,
      to: versionSummary(to),
      changes,
      labels: from ? labels(from.bundle, to.bundle) : labels(to.bundle),
    };
  });

  mount(app, routes.opsCustomizations, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    if (row.kind !== "client") {
      throw new HttpError(422, "not_a_client_agent", "only client agents have customizations");
    }
    const v = await currentVersion(ctx, row);
    const base = v?.basedOnTemplateVersionId
      ? await getVersion(ctx.tx, v.basedOnTemplateVersionId)
      : null;
    if (!v || !base) {
      return {
        base: null,
        version: v ? versionSummary(v) : null,
        changes: [],
        labels: v ? labels(v.bundle) : {},
      };
    }
    return {
      base: versionSummary(base),
      version: versionSummary(v),
      ...diff(base.bundle, v.bundle, lineageReadOptions(ctx.services.platform.ctx)),
      labels: labels(base.bundle, v.bundle),
    };
  });

  mount(app, routes.opsUsedBy, async (ctx) => {
    const { tx, tenantIds } = ctx;
    const template = await agentInScope(ctx, ctx.params.id);
    if (template.kind !== "template") {
      throw new HttpError(422, "not_a_template", "not a template");
    }
    const templateLive = template.liveVersionId
      ? await getVersion(tx, template.liveVersionId)
      : null;
    // DECISION: "Used by" lists the client agents forked from the template in the clients this
    // operator serves; a template's test copies in the Sandbox client are not uses of it.
    const rows = tenantIds.length
      ? await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.templateId, template.id),
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              inArray(agent.tenantId, [...tenantIds]),
            ),
          )
          .orderBy(agent.createdAt)
      : [];
    const clientIds = [...new Set(rows.map((r) => r.tenantId as string))];
    const clients = clientIds.length
      ? await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, clientIds))
      : [];

    const agents = [];
    // R9: a v3 client agent against a template version of v4 processes.
    const read = lineageReadOptions(ctx.services.platform.ctx);
    for (const row of rows) {
      const v = await currentVersion(ctx, row);
      const base = v?.basedOnTemplateVersionId
        ? await getVersion(tx, v.basedOnTemplateVersionId)
        : null;
      const behind =
        row.linked && base && templateLive ? Math.max(0, templateLive.version - base.version) : 0;
      let customizations = 0;
      let conflicts: number | null = null;
      if (v && base) {
        try {
          customizations = diffBundles(base.bundle, v.bundle, read).length;
          if (behind > 0 && templateLive) {
            conflicts = mergeBundles(base.bundle, v.bundle, templateLive.bundle, [], read).conflicts
              .length;
          }
        } catch {
          // A draft with duplicate ids can't be compared; the agent page says why.
        }
      }
      agents.push({
        agent: agentSummary(row),
        client: {
          id: row.tenantId as string,
          name: clients.find((c) => c.id === row.tenantId)?.name ?? "",
        },
        version: v?.version ?? null,
        baseVersion: base?.version ?? null,
        behind,
        customizations,
        conflicts,
      });
    }
    return { templateLiveVersion: templateLive?.version ?? null, agents };
  });
}
