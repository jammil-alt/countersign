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
  CUSTOM_PREFIX,
  getAgent,
  getVersion,
  listVersions,
  requiredConnectors,
  retire,
  SHARED_COPY_PREFIX,
  skillContext,
} from "@countersign/agents";
import {
  type AgentBundle,
  type BuilderCatalog,
  type BundleChange,
  diffBundles,
  flattenBundle,
  mergeBundles,
  routes,
  type SkillDefinition,
} from "@countersign/core";
import { agent, skill, skillVersion, tenant } from "@countersign/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { agentSummary, versionSummary } from "./mappers";

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
  const [latest] = await listVersions(ctx.tx, row.id);
  return latest ?? null;
}

/**
 * A name for every entity either bundle has, so the screens can say "Step Ask Jammil changed"
 * instead of `step:9f…`. Skills are labelled by their reference; otherwise branches "Otherwise".
 */
export function bundleLabels(...bundles: AgentBundle[]): Record<string, string> {
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

/** diffBundles, refusing cleanly when a stored draft can't be flattened (duplicate ids). */
function diff(a: AgentBundle, b: AgentBundle): { changes: BundleChange[] } {
  try {
    return { changes: diffBundles(a, b) };
  } catch (error) {
    throw new HttpError(
      422,
      "invalid_bundle",
      `these versions can't be compared: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function labels(...bundles: AgentBundle[]): Record<string, string> {
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
async function operatorSkills(
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

function skillOption(
  def: SkillDefinition,
  source: "builtin" | "client" | "shared",
  version: number | null,
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
  };
}

export function opsLineageRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsRetire, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    return {
      agent: agentSummary(await retire(ctx.tx, { agentId: row.id, actorId: ctx.session.user.id })),
    };
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
    return {
      ready: problems.length === 0,
      problems,
      requiredConnectors: required,
    };
  });

  mount(app, routes.opsAgentSkills, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const builtins = ctx.services.platform.catalog
      .list()
      .map((def) => skillOption(def, "builtin", null));
    const custom = (await operatorSkills(ctx, row.tenantId)).map((s) =>
      skillOption(s.def, s.source, s.version),
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
    // Instructions stay out: the builder places skills, it doesn't read their prompts.
    const entry = (
      ref: string,
      def: SkillDefinition,
      source: Entry["source"],
      version: number | null,
    ): Entry => {
      const { instructions: _instructions, ...definition } = def;
      return { ref, source, version, definition };
    };
    const skills = new Map<string, Entry>();
    for (const def of platform.catalog.list())
      skills.set(def.id, entry(def.id, def, "builtin", null));
    for (const s of await operatorSkills(ctx, row.tenantId)) {
      if (!skills.has(s.def.id)) skills.set(s.def.id, entry(s.def.id, s.def, s.source, s.version));
    }
    // DECISION: the builder validates with the skills the server would: a reference the latest
    // version already makes (a pinned `@version`, a client's snapshot of a shared skill) resolves
    // as validateForPublish resolves it, and is offered under that reference.
    const [latest] = await listVersions(tx, row.id);
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
    return {
      skills: [...skills.values()].sort((a, b) =>
        a.definition.name.localeCompare(b.definition.name),
      ),
      tools: platform.tools.list().map((t) => t.spec),
      connectors: platform.connectors.list().map((c) => ({
        id: c.manifest.id,
        name: c.manifest.name,
        icon: c.manifest.icon || null,
      })),
    };
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
    const { changes } = from ? diff(from.bundle, to.bundle) : { changes: [] };
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
      ...diff(base.bundle, v.bundle),
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
          customizations = diffBundles(base.bundle, v.bundle).length;
          if (behind > 0 && templateLive) {
            conflicts = mergeBundles(base.bundle, v.bundle, templateLive.bundle).conflicts.length;
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
