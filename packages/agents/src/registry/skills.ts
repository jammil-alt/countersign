// The skill registry (ARCHITECTURE §9.2): built-in skills from code (platform and packs, versioned
// with their package) and operator-written skills from `skill_version` rows, shared by every agent
// (tenant_id null) or written for one client. Operator skills follow the agents' draft → publish →
// rollback rules: every edit is a new immutable version.

import {
  type AgentBundle,
  hashJson,
  isToolWrapper,
  parseSkillRef,
  type processes,
  SkillDefinition,
  Slug,
  skillTools,
  walkSteps,
} from "@countersign/core";
import { skill, skillVersion, type Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { ToolRegistry } from "./tools";

/** Where a resolved skill came from. */
export type SkillSource = "builtin" | "client" | "shared";

export interface ResolvedSkill {
  /** The reference as written in the bundle (`docs.extract`, `custom:x@3`). */
  ref: string;
  definition: SkillDefinition;
  source: SkillSource;
  /** The `skill_version` row; null for built-ins. */
  versionId: string | null;
  version: number | null;
}

/** Built-in skills (code). apps/api registers the platform's and each enabled pack's. */
export class SkillCatalog {
  private readonly byId = new Map<string, SkillDefinition>();

  constructor(builtins: readonly SkillDefinition[] = [], tools?: ToolRegistry) {
    const problems: string[] = [];
    for (const raw of builtins) {
      const parsed = SkillDefinition.safeParse(raw);
      if (!parsed.success) {
        problems.push(`${String((raw as { id?: unknown }).id)}: ${parsed.error.message}`);
        continue;
      }
      const def = parsed.data;
      if (def.id.startsWith("custom:")) problems.push(`${def.id}: built-ins are not custom:`);
      if (this.byId.has(def.id)) problems.push(`${def.id} is registered twice`);
      if (tools) {
        for (const t of skillTools(def)) {
          if (!tools.has(t)) problems.push(`${def.id}: unknown tool ${t}`);
        }
        for (const p of readProblems(def, tools)) problems.push(`${def.id}: ${p}`);
      }
      this.byId.set(def.id, def);
    }
    if (problems.length > 0) {
      throw new AgentsError("invalid_definition", `skill catalog: ${problems.join("; ")}`);
    }
  }

  get(id: string): SkillDefinition | undefined {
    return this.byId.get(id);
  }

  list(): SkillDefinition[] {
    return [...this.byId.values()];
  }
}

// ── R2: skills read, never write (docs/plan.md §1.86, §9) ───────────────────────────────────────

/** A skill's declared `reads` must be registered tools that only read (side effect `none`). */
export function readProblems(
  def: Pick<SkillDefinition, "reads">,
  tools: Pick<ToolRegistry, "get">,
): string[] {
  const problems: string[] = [];
  for (const id of def.reads ?? []) {
    const tool = tools.get(id);
    if (!tool) problems.push(`unknown read tool ${id}`);
    else if (tool.spec.sideEffect !== "none") {
      problems.push(`${id} is not a read tool (${tool.spec.sideEffect}); a skill never writes`);
    }
  }
  return problems;
}

/**
 * What `processes.fromWorkflowV3` needs from the registries: the tool a tool-wrapper skill wraps
 * (built-ins only; operator skills are never `tool` mode) and each tool's side effect. Unknown ids
 * answer null, which the converter treats as a skill step or an external write (the safe side).
 */
export function convertLookup(
  skills: Pick<SkillCatalog, "get">,
  tools: Pick<ToolRegistry, "get">,
): processes.ConvertLookup {
  return {
    wrappedTool(skillId) {
      const def = skills.get(skillId);
      return def && isToolWrapper(def) ? (def.handler ?? null) : null;
    },
    sideEffect(toolId) {
      return tools.get(toolId)?.spec.sideEffect ?? null;
    },
  };
}

// ── Operator-written skills (rows) ───────────────────────────────────────────────────────────────

export const CUSTOM_PREFIX = "custom:";
/**
 * A client's copy of a shared skill is stored under this prefix (`shared:<slug>`): a colon can't
 * appear in a real slug, so a copy never collides with the client's own skills.
 */
export const SHARED_COPY_PREFIX = "shared:";

export function isCustomSkill(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

export function customSlug(id: string): string {
  return id.slice(CUSTOM_PREFIX.length);
}

/**
 * Parses an operator-written skill: Zod, `task` or `agent` mode (v0.13; never `tool`, which is
 * code), a task's model one the platform prices, tools that exist (§9.2).
 */
export function parseOperatorSkill(input: unknown, tools?: ToolRegistry): SkillDefinition {
  const parsed = SkillDefinition.safeParse(input);
  if (!parsed.success) {
    throw new AgentsError("invalid_definition", parsed.error.message, parsed.error.issues);
  }
  const def = parsed.data;
  const problems: string[] = [];
  if (!isCustomSkill(def.id) || !Slug.safeParse(customSlug(def.id)).success) {
    problems.push(`an operator skill's id is custom:<slug>, not ${def.id}`);
  }
  if (def.mode === "tool") problems.push("operator skills are task or agent mode, not tool");
  if (def.model && !knownModelIds().includes(def.model.id)) {
    problems.push(`unknown model ${def.model.id}`);
  }
  if (tools) {
    for (const t of def.tools) if (!tools.has(t)) problems.push(`unknown tool ${t}`);
    problems.push(...readProblems(def, tools));
  }
  if (problems.length > 0) {
    throw new AgentsError("invalid_definition", problems.join("; "), problems);
  }
  return def;
}

type SkillRow = typeof skill.$inferSelect;
type SkillVersionRow = typeof skillVersion.$inferSelect;

function tenantIs(tenantId: string | null) {
  return tenantId === null ? isNull(skill.tenantId) : eq(skill.tenantId, tenantId);
}

async function lockSkill(tx: Tx, skillId: string): Promise<SkillRow> {
  const [row] = await tx.select().from(skill).where(eq(skill.id, skillId)).for("update");
  if (!row) throw notFound(`skill ${skillId}`);
  return row;
}

async function nextSkillVersion(tx: Tx, skillId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${skillVersion.version})` })
    .from(skillVersion)
    .where(eq(skillVersion.skillId, skillId));
  return (row?.max ?? 0) + 1;
}

export interface CreateSkillInput {
  /** Null: shared by every agent (operator sessions only); set: written for one client. */
  tenantId: string | null;
  definition: unknown;
  authorId?: string | null;
  changeNote?: string | null;
  tools?: ToolRegistry;
}

/** A new operator skill with its v1 draft. */
export async function createSkill(
  tx: Tx,
  input: CreateSkillInput,
): Promise<{ skill: SkillRow; version: SkillVersionRow }> {
  const def = parseOperatorSkill(input.definition, input.tools);
  const [row] = await tx
    .insert(skill)
    .values({ tenantId: input.tenantId, slug: customSlug(def.id), name: def.name })
    .returning();
  if (!row) throw new Error("skill insert returned nothing");
  const [v] = await tx
    .insert(skillVersion)
    .values({
      tenantId: input.tenantId,
      skillId: row.id,
      version: 1,
      definition: def,
      definitionHash: await hashJson(def),
      status: "draft",
      changeNote: input.changeNote ?? null,
      authorId: input.authorId ?? null,
    })
    .returning();
  if (!v) throw new Error("skill version insert returned nothing");
  return { skill: row, version: v };
}

/** A new draft version of an operator skill. A version identical to its parent is refused. */
export async function createSkillVersion(
  tx: Tx,
  input: {
    skillId: string;
    definition: unknown;
    parentVersionId?: string | null;
    authorId?: string | null;
    changeNote?: string | null;
    tools?: ToolRegistry;
  },
): Promise<SkillVersionRow> {
  const row = await lockSkill(tx, input.skillId);
  const def = parseOperatorSkill(input.definition, input.tools);
  if (customSlug(def.id) !== row.slug) {
    throw new AgentsError("invalid_definition", `a version of ${row.slug} can't be ${def.id}`);
  }
  const hash = await hashJson(def);
  const [parent] = input.parentVersionId
    ? await tx.select().from(skillVersion).where(eq(skillVersion.id, input.parentVersionId))
    : await tx
        .select()
        .from(skillVersion)
        .where(eq(skillVersion.skillId, row.id))
        .orderBy(desc(skillVersion.version))
        .limit(1);
  if (input.parentVersionId && (!parent || parent.skillId !== row.id)) {
    throw notFound(`skill version ${input.parentVersionId} of ${row.slug}`);
  }
  if (parent && parent.definitionHash === hash) {
    throw new AgentsError("no_op", "nothing changed since the version it was edited from");
  }
  const [v] = await tx
    .insert(skillVersion)
    .values({
      tenantId: row.tenantId,
      skillId: row.id,
      version: await nextSkillVersion(tx, row.id),
      definition: def,
      definitionHash: hash,
      status: "draft",
      changeNote: input.changeNote ?? null,
      authorId: input.authorId ?? null,
      parentVersionId: parent?.id ?? null,
    })
    .returning();
  if (!v) throw new Error("skill version insert returned nothing");
  return v;
}

/** Makes a version live and retires the previous live one, in the caller's transaction. */
export async function publishSkill(
  tx: Tx,
  input: { skillId: string; versionId: string },
): Promise<SkillVersionRow> {
  const row = await lockSkill(tx, input.skillId);
  const [v] = await tx.select().from(skillVersion).where(eq(skillVersion.id, input.versionId));
  if (!v || v.skillId !== row.id) throw notFound(`skill version ${input.versionId}`);
  if (v.status === "live") throw new AgentsError("invalid_state", "that version is already live");
  if (row.liveVersionId) {
    await tx
      .update(skillVersion)
      .set({ status: "retired" })
      .where(eq(skillVersion.id, row.liveVersionId));
  }
  const [live] = await tx
    .update(skillVersion)
    .set({ status: "live" })
    .where(eq(skillVersion.id, v.id))
    .returning();
  await tx.update(skill).set({ liveVersionId: v.id }).where(eq(skill.id, row.id));
  if (!live) throw new Error("skill publish updated nothing");
  return live;
}

/** Rollback = copy an older version as a new version and publish it (history stays linear). */
export async function rollbackSkill(
  tx: Tx,
  input: { skillId: string; toVersionId: string; authorId?: string | null },
): Promise<SkillVersionRow> {
  const row = await lockSkill(tx, input.skillId);
  const [target] = await tx
    .select()
    .from(skillVersion)
    .where(eq(skillVersion.id, input.toVersionId));
  if (!target || target.skillId !== row.id) throw notFound(`skill version ${input.toVersionId}`);
  const copy = await createSkillVersion(tx, {
    skillId: row.id,
    definition: target.definition,
    parentVersionId: row.liveVersionId,
    authorId: input.authorId ?? null,
    changeNote: `Rollback to v${target.version}`,
  });
  return publishSkill(tx, { skillId: row.id, versionId: copy.id });
}

async function versionOf(
  tx: Tx,
  row: SkillRow,
  version: number | null,
): Promise<SkillVersionRow | undefined> {
  if (version === null) {
    if (!row.liveVersionId) return undefined;
    const [v] = await tx.select().from(skillVersion).where(eq(skillVersion.id, row.liveVersionId));
    return v;
  }
  const [v] = await tx
    .select()
    .from(skillVersion)
    .where(and(eq(skillVersion.skillId, row.id), eq(skillVersion.version, version)));
  return v;
}

async function skillBySlug(tx: Tx, tenantId: string | null, slug: string) {
  const [row] = await tx
    .select()
    .from(skill)
    .where(and(tenantIs(tenantId), eq(skill.slug, slug)));
  return row;
}

/**
 * Resolves a `custom:` reference for one client: the client's own skill of that slug, else the
 * client's copy of the shared one (made at publish, below), else the shared skill itself (visible
 * in operator sessions only). Unpinned references take the live version; `@N` takes version N.
 * `tenantId` null resolves among shared skills only (templates).
 */
export async function resolveCustomSkill(
  tx: Tx,
  input: { tenantId: string | null; ref: string },
): Promise<ResolvedSkill | null> {
  const { id, version } = parseSkillRef(input.ref);
  if (!isCustomSkill(id)) return null;
  const slug = customSlug(id);
  const candidates: [string | null, string, SkillSource][] =
    input.tenantId === null
      ? [[null, slug, "shared"]]
      : [
          [input.tenantId, slug, "client"],
          [input.tenantId, `${SHARED_COPY_PREFIX}${slug}`, "shared"],
          [null, slug, "shared"],
        ];
  for (const [tenantId, s, source] of candidates) {
    const row = await skillBySlug(tx, tenantId, s);
    if (row?.status !== "active") continue;
    const v = await versionOf(tx, row, version);
    if (!v) continue;
    return {
      ref: input.ref,
      definition: v.definition,
      source,
      versionId: v.id,
      version: v.version,
    };
  }
  return null;
}

/** Every skill reference in a bundle: the agent's skills and every skill step. */
export function bundleSkillRefs(bundle: AgentBundle): string[] {
  const refs = new Set(bundle.definition.skills.map((s) => s.skill));
  for (const w of bundle.workflows) {
    walkSteps(w.workflow, ({ step }) => {
      if (step.kind === "skill") refs.add(step.skill);
    });
  }
  return [...refs];
}

/**
 * The definitions a bundle's references resolve to, keyed by reference: core's TypingContext
 * `skills` for validation, and the skill map for promotion's stripping. Unresolved refs are listed.
 */
export async function skillContext(
  tx: Tx,
  input: { tenantId: string | null; bundle: AgentBundle; catalog: SkillCatalog },
): Promise<{ skills: Record<string, SkillDefinition>; missing: string[] }> {
  const skills: Record<string, SkillDefinition> = {};
  const missing: string[] = [];
  for (const ref of bundleSkillRefs(input.bundle)) {
    const { id } = parseSkillRef(ref);
    const builtin = input.catalog.get(id);
    if (builtin) {
      skills[ref] = builtin;
      continue;
    }
    const resolved = await resolveCustomSkill(tx, { tenantId: input.tenantId, ref });
    if (resolved) skills[ref] = resolved.definition;
    else missing.push(ref);
  }
  return { skills, missing };
}

/**
 * Copies the shared skills a client agent's bundle uses into that client, as `shared:<slug>`
 * skills with the same version numbers and definitions.
 *
 * DECISION: shared skills and templates are visible only in operator sessions, and runs set one
 * client and no operator flag (CLAUDE.md invariant 1), so a run cannot read a shared skill. Instead,
 * publishing a client agent (an operator session) snapshots the shared skills it references into
 * the client. The client then runs the shared skill as it was at that publish; a newer shared
 * version reaches the client with the agent's next publish, so a client agent changes only by its
 * own new version (invariant 11). The client's own skill of the same slug always wins.
 */
export async function snapshotSharedSkills(
  tx: Tx,
  input: { tenantId: string; bundle: AgentBundle; catalog?: SkillCatalog },
): Promise<{ ref: string; versionId: string }[]> {
  const made: { ref: string; versionId: string }[] = [];
  for (const ref of bundleSkillRefs(input.bundle)) {
    const { id, version } = parseSkillRef(ref);
    if (!isCustomSkill(id) || input.catalog?.get(id)) continue;
    const slug = customSlug(id);
    if (await skillBySlug(tx, input.tenantId, slug)) continue;
    const shared = await skillBySlug(tx, null, slug);
    if (!shared) {
      throw new AgentsError(
        "unknown_skill",
        `skill ${ref} not found (shared skills need an operator session)`,
      );
    }
    const source = await versionOf(tx, shared, version);
    if (!source) throw new AgentsError("unknown_skill", `skill ${ref} has no such version`);

    const copySlug = `${SHARED_COPY_PREFIX}${slug}`;
    let copy = await skillBySlug(tx, input.tenantId, copySlug);
    if (!copy) {
      [copy] = await tx
        .insert(skill)
        .values({ tenantId: input.tenantId, slug: copySlug, name: shared.name })
        .returning();
      if (!copy) throw new Error("skill copy insert returned nothing");
    }
    const [existing] = await tx
      .select()
      .from(skillVersion)
      .where(and(eq(skillVersion.skillId, copy.id), eq(skillVersion.version, source.version)));
    if (existing && existing.definitionHash !== source.definitionHash) {
      throw new AgentsError(
        "invalid_state",
        `the client's copy of ${ref} differs from the shared one`,
      );
    }
    const copied =
      existing ??
      (
        await tx
          .insert(skillVersion)
          .values({
            tenantId: input.tenantId,
            skillId: copy.id,
            version: source.version,
            definition: source.definition,
            definitionHash: source.definitionHash,
            status: "retired",
            changeNote: `Copy of shared skill ${slug} v${source.version}`,
            authorId: source.authorId,
          })
          .returning()
      )[0];
    if (!copied) throw new Error("skill copy version insert returned nothing");
    // Unpinned references follow the shared skill's live version as of this publish.
    if (version === null && copy.liveVersionId !== copied.id) {
      if (copy.liveVersionId) {
        await tx
          .update(skillVersion)
          .set({ status: "retired" })
          .where(eq(skillVersion.id, copy.liveVersionId));
      }
      await tx.update(skillVersion).set({ status: "live" }).where(eq(skillVersion.id, copied.id));
      await tx.update(skill).set({ liveVersionId: copied.id }).where(eq(skill.id, copy.id));
    }
    made.push({ ref, versionId: copied.id });
  }
  return made;
}
