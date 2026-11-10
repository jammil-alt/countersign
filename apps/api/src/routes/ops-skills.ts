// Back office: the skills library and the operator skill editor (ARCHITECTURE §9.2, §14 "Skills",
// design screen 3). Built-in skills (code) are listed read-only; operator-written skills are rows,
// shared by every agent (tenant_id null) or written for one client, and every edit is a new
// immutable `skill_version` (draft → publish → rollback, as agents). Every handler runs inside
// withOperator(the clients served).

import {
  bundleSkillRefs,
  createSkill,
  createSkillVersion,
  publishSkill,
  rollbackSkill,
  SHARED_COPY_PREFIX,
  schemaFields,
} from "@countersign/agents";
import {
  isToolWrapper,
  parseSkillRef,
  routes,
  type SkillDefinition,
  type SkillListItem,
  type SkillUse,
  skillMethod,
  skillTools,
} from "@countersign/core";
import { agent, agentVersion, skill, skillVersion, tenant } from "@countersign/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, iso, mount, notFound } from "../http";
import type { Platform } from "../platform";
// v0.12 W2-C: the publish gate
import { assertSkillTestsPass } from "../testbench/gate";

type Scope = Pick<HandlerCtx<never>, "tx" | "tenantIds">;
type SkillRow = typeof skill.$inferSelect;
type SkillVersionRow = typeof skillVersion.$inferSelect;

export function skillVersionView(v: SkillVersionRow) {
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

/** The connectors a skill needs: those it declares and those its tools act through. */
function skillConnectors(def: SkillDefinition, platform: Platform): string[] {
  const out = new Set(def.requiresConnectors);
  const specs = platform.tools.specs();
  for (const t of skillTools(def)) {
    const spec = specs[t];
    if (spec?.connector) out.add(spec.connector);
    else if (spec && platform.connectors.list().some((c) => c.manifest.id === spec.source)) {
      out.add(spec.source);
    }
  }
  return [...out].sort();
}

/**
 * What each agent in scope uses: its live, else latest, version's skill references. Test copies
 * and discarded drafts use nothing.
 */
async function agentUses(ctx: Scope) {
  const agents = await ctx.tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.testCopy, false),
        eq(agent.status, "active"),
        ctx.tenantIds.length > 0
          ? or(isNull(agent.tenantId), inArray(agent.tenantId, [...ctx.tenantIds]))
          : isNull(agent.tenantId),
      ),
    );
  if (agents.length === 0) return [];
  const versions = await ctx.tx
    .select({
      id: agentVersion.id,
      agentId: agentVersion.agentId,
      version: agentVersion.version,
      bundle: agentVersion.bundle,
    })
    .from(agentVersion)
    .where(
      inArray(
        agentVersion.agentId,
        agents.map((a) => a.id),
      ),
    )
    .orderBy(desc(agentVersion.version));
  const clients = await clientNames(ctx);
  return agents.flatMap((a) => {
    const v =
      versions.find((x) => x.id === a.liveVersionId) ?? versions.find((x) => x.agentId === a.id);
    if (!v) return [];
    return [
      {
        agent: a,
        clientName: a.tenantId ? (clients.get(a.tenantId) ?? null) : null,
        version: v.version,
        refs: bundleSkillRefs(v.bundle),
      },
    ];
  });
}

async function clientNames(ctx: Scope): Promise<Map<string, string>> {
  if (ctx.tenantIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, [...ctx.tenantIds]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

type Uses = Awaited<ReturnType<typeof agentUses>>;

/**
 * The library's count: the client agents among a skill's uses, each once, with their names. A
 * template is where a skill is written into, not a use of it.
 */
export function clientUses(uses: readonly SkillUse[]): { usedBy: number; usedByNames: string[] } {
  const seen = new Map<string, string>();
  for (const u of uses) {
    if (u.kind !== "client" || seen.has(u.agentId)) continue;
    seen.set(u.agentId, u.clientName ? `${u.name} · ${u.clientName}` : u.name);
  }
  return { usedBy: seen.size, usedByNames: [...seen.values()] };
}

/**
 * The agents a skill is used by. A built-in by its id; a shared skill by `custom:<slug>`
 * everywhere except in clients that have their own skill of that slug (it shadows the shared
 * one); a client's skill only by that client's agents.
 */
function usesOf(
  target: { ref: string; tenantId: string | null; builtin: boolean },
  uses: Uses,
  shadowedIn: ReadonlySet<string>,
): SkillUse[] {
  const out: SkillUse[] = [];
  for (const u of uses) {
    if (!target.builtin) {
      if (target.tenantId !== null && u.agent.tenantId !== target.tenantId) continue;
      if (target.tenantId === null && u.agent.tenantId && shadowedIn.has(u.agent.tenantId)) {
        continue;
      }
    }
    const ref = u.refs.find((r) => parseSkillRef(r).id === target.ref);
    if (!ref) continue;
    out.push({
      agentId: u.agent.id,
      kind: u.agent.kind,
      slug: u.agent.slug,
      name: u.agent.name,
      clientId: u.agent.tenantId,
      clientName: u.clientName,
      ref,
      version: u.version,
    });
  }
  return out;
}

function listItem(
  input: {
    id: string;
    def: SkillDefinition;
    source: SkillListItem["source"];
    clientId: string | null;
    clientName: string | null;
    status: string;
    live: SkillVersionRow | null;
    latest: SkillVersionRow | null;
    uses: readonly SkillUse[];
  },
  platform: Platform,
): SkillListItem {
  const { def } = input;
  return {
    id: input.id,
    ref: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    source: input.source,
    clientId: input.clientId,
    clientName: input.clientName,
    status: input.status,
    liveVersion: input.live?.version ?? null,
    latestVersion: input.latest?.version ?? null,
    latestStatus: input.latest?.status ?? null,
    inputs: schemaFields(def.input),
    outputs: schemaFields(def.output),
    tools: skillTools(def),
    connectors: skillConnectors(def, platform),
    ...clientUses(input.uses),
    // R8: the Library's facts (docs/plan.md §1.86).
    method: skillMethod(def),
    reads: def.reads ?? [],
    browse: def.browse ?? null,
    retired: isToolWrapper(def),
    wraps: isToolWrapper(def) ? (def.handler ?? null) : null,
  };
}

/** Operator skills in scope (the clients' snapshot copies of shared skills are not listed). */
async function skillRows(ctx: Scope, clientFilter?: string) {
  const tenants = clientFilter ? [clientFilter] : [...ctx.tenantIds];
  const rows = await ctx.tx
    .select()
    .from(skill)
    .where(
      tenants.length > 0
        ? or(isNull(skill.tenantId), inArray(skill.tenantId, tenants))
        : isNull(skill.tenantId),
    );
  const own = rows.filter((r) => !r.slug.startsWith(SHARED_COPY_PREFIX));
  const versions = own.length
    ? await ctx.tx
        .select()
        .from(skillVersion)
        .where(
          inArray(
            skillVersion.skillId,
            own.map((r) => r.id),
          ),
        )
        .orderBy(desc(skillVersion.version))
    : [];
  return own.map((row) => {
    const mine = versions.filter((v) => v.skillId === row.id);
    return {
      row,
      versions: mine,
      live: mine.find((v) => v.id === row.liveVersionId) ?? null,
      latest: mine[0] ?? null,
    };
  });
}

async function skillInScope(ctx: Scope, id: string): Promise<SkillRow> {
  const [row] = await ctx.tx.select().from(skill).where(eq(skill.id, id));
  if (!row || row.slug.startsWith(SHARED_COPY_PREFIX)) throw notFound("skill");
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("skill");
  return row;
}

async function itemFor(ctx: Scope & { platform: Platform }, row: SkillRow) {
  const [entry] = (await skillRows(ctx)).filter((e) => e.row.id === row.id);
  if (!entry?.latest) throw notFound("skill");
  const uses = await agentUses(ctx);
  const shadowed = await shadowingClients(ctx);
  const ref = entry.latest.definition.id;
  const usedBy = usesOf(
    { ref, tenantId: row.tenantId, builtin: false },
    uses,
    shadowed.get(row.slug) ?? new Set(),
  );
  const clients = await clientNames(ctx);
  return {
    item: listItem(
      {
        id: row.id,
        def: (entry.live ?? entry.latest).definition,
        source: row.tenantId === null ? "shared" : "client",
        clientId: row.tenantId,
        clientName: row.tenantId ? (clients.get(row.tenantId) ?? null) : null,
        status: row.status,
        live: entry.live,
        latest: entry.latest,
        uses: usedBy,
      },
      ctx.platform,
    ),
    versions: entry.versions,
    usedBy,
  };
}

/** For each slug, the clients that have their own skill of that slug. */
async function shadowingClients(ctx: Scope): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const e of await skillRows(ctx)) {
    if (e.row.tenantId === null) continue;
    const set = out.get(e.row.slug) ?? new Set<string>();
    set.add(e.row.tenantId);
    out.set(e.row.slug, set);
  }
  return out;
}

export function opsSkillRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsSkills, async (ctx) => {
    const { platform } = ctx.services;
    if (ctx.query.client) ensureClient(ctx, ctx.query.client);
    const uses = await agentUses(ctx);
    const clients = await clientNames(ctx);
    const rows = await skillRows(ctx, ctx.query.client);
    const shadowed = await shadowingClients(ctx);
    const items: SkillListItem[] = [];
    for (const def of platform.catalog.list()) {
      items.push(
        listItem(
          {
            id: def.id,
            def,
            source: "builtin",
            clientId: null,
            clientName: null,
            status: "active",
            live: null,
            latest: null,
            uses: usesOf({ ref: def.id, tenantId: null, builtin: true }, uses, new Set()),
          },
          platform,
        ),
      );
    }
    for (const e of rows) {
      const shown = e.live ?? e.latest;
      if (!shown) continue;
      items.push(
        listItem(
          {
            id: e.row.id,
            def: shown.definition,
            source: e.row.tenantId === null ? "shared" : "client",
            clientId: e.row.tenantId,
            clientName: e.row.tenantId ? (clients.get(e.row.tenantId) ?? null) : null,
            status: e.row.status,
            live: e.live,
            latest: e.latest,
            uses: usesOf(
              { ref: shown.definition.id, tenantId: e.row.tenantId, builtin: false },
              uses,
              shadowed.get(e.row.slug) ?? new Set(),
            ),
          },
          platform,
        ),
      );
    }
    items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return {
      skills: items,
      tools: platform.tools.list().map((t) => t.spec),
      connectors: platform.connectors
        .list()
        .map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
    };
  });

  mount(app, routes.opsCreateSkill, async (ctx) => {
    const { tx, body, session, services } = ctx;
    if (body.clientId) ensureClient(ctx, body.clientId);
    const created = await createSkill(tx, {
      tenantId: body.clientId ?? null,
      definition: body.definition,
      authorId: session.user.id,
      changeNote: body.changeNote ?? "Created",
      tools: services.platform.tools,
    });
    const { item } = await itemFor({ ...ctx, platform: services.platform }, created.skill);
    return { skill: item, version: skillVersionView(created.version) };
  });

  mount(app, routes.opsSkill, async (ctx) => {
    const row = await skillInScope(ctx, ctx.params.id);
    const { item, versions, usedBy } = await itemFor(
      { ...ctx, platform: ctx.services.platform },
      row,
    );
    return { skill: item, versions: versions.map(skillVersionView), usedBy };
  });

  mount(app, routes.opsSaveSkillVersion, async (ctx) => {
    const row = await skillInScope(ctx, ctx.params.id);
    const v = await createSkillVersion(ctx.tx, {
      skillId: row.id,
      definition: ctx.body.definition,
      parentVersionId: ctx.body.parentVersionId ?? null,
      authorId: ctx.session.user.id,
      changeNote: ctx.body.changeNote ?? null,
      tools: ctx.services.platform.tools,
    });
    return { version: skillVersionView(v) };
  });

  mount(app, routes.opsPublishSkill, async (ctx) => {
    const row = await skillInScope(ctx, ctx.params.id);
    // v0.12 W2-C: the publish gate. With `require_tests`, the latest suite run of this version
    // must have passed every required case (422 tests_failing).
    await assertSkillTestsPass(ctx.tx, row, ctx.params.vid);
    const v = await publishSkill(ctx.tx, { skillId: row.id, versionId: ctx.params.vid });
    return { version: skillVersionView(v) };
  });

  mount(app, routes.opsRollbackSkill, async (ctx) => {
    const row = await skillInScope(ctx, ctx.params.id);
    const v = await rollbackSkill(ctx.tx, {
      skillId: row.id,
      toVersionId: ctx.body.versionId,
      authorId: ctx.session.user.id,
    });
    return { version: skillVersionView(v) };
  });
}
