// v0.12 W2-B: the automation registry (ARCHITECTURE §10.7; docs/plan.md §1.45). Automations follow
// operator skills exactly: shared (tenant_id null, operator sessions only) or written for one
// client; every edit is a new immutable `automation_version` (draft → publish → rollback by copy),
// a version identical to its parent is refused by hash, and publishing a client agent copies the
// shared automations it uses into that client as `shared:<slug>` (runs see one client only).

import {
  type AgentBundle,
  type AnyAgentBundle,
  type AutomationDefinition,
  AutomationDefinition as AutomationSchema,
  automationRef,
  automationRefs,
  automationRequires,
  hashJson,
  parseAutomationRef,
  processes,
  type SkillDefinition,
  useSteps,
  type ValidationError,
  validateAutomation,
} from "@countersign/core";
import { automation, automationVersion, type Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { RegistryContext } from "./agents";
import { SHARED_COPY_PREFIX, skillContext, snapshotSharedSkills } from "./skills";

type AutomationRow = typeof automation.$inferSelect;
type AutomationVersionRow = typeof automationVersion.$inferSelect;

export type AutomationSource = "client" | "shared";

export interface ResolvedAutomation {
  ref: string;
  definition: AutomationDefinition;
  source: AutomationSource;
  versionId: string;
  version: number;
  status: AutomationVersionRow["status"];
}

/** A bundle's workflows split by schema. R8: the builder saves v4 processes. */
function bySchema(bundle: AnyAgentBundle): {
  v3: AgentBundle["workflows"][number]["workflow"][];
  v4: processes.Process[];
} {
  const v3: AgentBundle["workflows"][number]["workflow"][] = [];
  const v4: processes.Process[] = [];
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 4) v4.push(w.workflow);
    else v3.push(w.workflow);
  }
  return { v3, v4 };
}

/** The automation versions a bundle's use steps (v4: process steps) pin, each once. */
export function bundleAutomationRefs(bundle: AnyAgentBundle): string[] {
  const { v3, v4 } = bySchema(bundle);
  return [...new Set([...automationRefs(v3), ...processes.subProcessRefs(v4)])];
}

/**
 * A bundle that lists only skill references: how the inner steps' skills are resolved and copied
 * with the skills registry's own functions (they read a bundle's references).
 */
function refsBundle(refs: readonly string[]): AgentBundle {
  return {
    definition: { skills: refs.map((skill) => ({ skill })) },
    workflows: [],
  } as unknown as AgentBundle;
}

/** The skills an automation's steps name, resolved for one client (null: shared only). */
async function innerSkills(
  tx: Tx,
  tenantId: string | null,
  defs: readonly AutomationDefinition[],
  ctx: Pick<RegistryContext, "catalog">,
): Promise<{ skills: Record<string, SkillDefinition>; missing: string[] }> {
  const refs = new Set<string>();
  for (const d of defs) {
    for (const s of automationRequires(d, {}).skills) refs.add(s);
  }
  if (refs.size === 0) return { skills: {}, missing: [] };
  return skillContext(tx, { tenantId, bundle: refsBundle([...refs]), catalog: ctx.catalog });
}

/**
 * Parses an automation definition (schema only: a draft may be saved with semantic errors) and
 * computes what it requires; the `requires` sent is never trusted.
 */
export async function prepareAutomation(
  tx: Tx,
  input: { tenantId: string | null; definition: unknown; ctx: RegistryContext },
): Promise<{ definition: AutomationDefinition; errors: ValidationError[] }> {
  const parsed = AutomationSchema.safeParse(input.definition);
  if (!parsed.success) {
    throw new AgentsError("invalid_definition", parsed.error.message, parsed.error.issues);
  }
  const { skills } = await innerSkills(tx, input.tenantId, [parsed.data], input.ctx);
  const typing = { skills, tools: input.ctx.tools.specs(), models: knownModelIds() };
  const connectorIds = new Set(input.ctx.tools.connectors.list().map((c) => c.manifest.id));
  const definition: AutomationDefinition = {
    ...parsed.data,
    requires: automationRequires(parsed.data, typing, connectorIds),
  };
  return { definition, errors: validateAutomation(definition, typing).errors };
}

function tenantIs(tenantId: string | null) {
  return tenantId === null ? isNull(automation.tenantId) : eq(automation.tenantId, tenantId);
}

async function lockAutomation(tx: Tx, automationId: string): Promise<AutomationRow> {
  const [row] = await tx
    .select()
    .from(automation)
    .where(eq(automation.id, automationId))
    .for("update");
  if (!row) throw notFound(`automation ${automationId}`);
  return row;
}

async function nextVersion(tx: Tx, automationId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${automationVersion.version})` })
    .from(automationVersion)
    .where(eq(automationVersion.automationId, automationId));
  return (row?.max ?? 0) + 1;
}

export interface CreateAutomationInput {
  /** Null: shared (operator sessions only); set: written for one client. */
  tenantId: string | null;
  definition: unknown;
  authorId?: string | null;
  changeNote?: string | null;
  ctx: RegistryContext;
}

/** A new automation with its v1 draft, and what would stop it from being published. */
export async function createAutomation(
  tx: Tx,
  input: CreateAutomationInput,
): Promise<{
  automation: AutomationRow;
  version: AutomationVersionRow;
  errors: ValidationError[];
}> {
  const { definition, errors } = await prepareAutomation(tx, input);
  if (definition.slug.startsWith(SHARED_COPY_PREFIX)) {
    throw new AgentsError("invalid_definition", "an automation's slug can't be a shared copy's");
  }
  const [taken] = await tx
    .select({ id: automation.id })
    .from(automation)
    .where(and(tenantIs(input.tenantId), eq(automation.slug, definition.slug)));
  if (taken) {
    throw new AgentsError("invalid_state", `there is already an automation ${definition.slug}`);
  }
  const [row] = await tx
    .insert(automation)
    .values({
      tenantId: input.tenantId,
      slug: definition.slug,
      name: definition.name,
      description: definition.description,
    })
    .returning();
  if (!row) throw new Error("automation insert returned nothing");
  const [v] = await tx
    .insert(automationVersion)
    .values({
      tenantId: input.tenantId,
      automationId: row.id,
      version: 1,
      definition,
      definitionHash: await hashJson(definition),
      status: "draft",
      changeNote: input.changeNote ?? null,
      authorId: input.authorId ?? null,
    })
    .returning();
  if (!v) throw new Error("automation version insert returned nothing");
  return { automation: row, version: v, errors };
}

/** A new draft version. A version identical to the one it was edited from is refused. */
export async function createAutomationVersion(
  tx: Tx,
  input: {
    automationId: string;
    definition: unknown;
    parentVersionId?: string | null;
    authorId?: string | null;
    changeNote?: string | null;
    ctx: RegistryContext;
  },
): Promise<{ version: AutomationVersionRow; errors: ValidationError[] }> {
  const row = await lockAutomation(tx, input.automationId);
  const { definition, errors } = await prepareAutomation(tx, {
    tenantId: row.tenantId,
    definition: input.definition,
    ctx: input.ctx,
  });
  if (definition.slug !== row.slug) {
    throw new AgentsError(
      "invalid_definition",
      `a version of ${row.slug} can't be ${definition.slug}`,
    );
  }
  const hash = await hashJson(definition);
  const [parent] = input.parentVersionId
    ? await tx
        .select()
        .from(automationVersion)
        .where(eq(automationVersion.id, input.parentVersionId))
    : await tx
        .select()
        .from(automationVersion)
        .where(eq(automationVersion.automationId, row.id))
        .orderBy(desc(automationVersion.version))
        .limit(1);
  if (input.parentVersionId && (!parent || parent.automationId !== row.id)) {
    throw notFound(`automation version ${input.parentVersionId} of ${row.slug}`);
  }
  if (parent && parent.definitionHash === hash) {
    throw new AgentsError("no_op", "nothing changed since the version it was edited from");
  }
  const [v] = await tx
    .insert(automationVersion)
    .values({
      tenantId: row.tenantId,
      automationId: row.id,
      version: await nextVersion(tx, row.id),
      definition,
      definitionHash: hash,
      status: "draft",
      changeNote: input.changeNote ?? null,
      authorId: input.authorId ?? null,
      parentVersionId: parent?.id ?? null,
    })
    .returning();
  if (!v) throw new Error("automation version insert returned nothing");
  return { version: v, errors };
}

/**
 * Makes a version live and retires the previous live one, in the caller's transaction. Only a
 * valid version publishes (§10.2). Agents pin versions, so no agent changes here: each moves to
 * the new version by its own new version (invariant 11).
 */
export async function publishAutomation(
  tx: Tx,
  input: { automationId: string; versionId: string; ctx: RegistryContext },
): Promise<AutomationVersionRow> {
  const row = await lockAutomation(tx, input.automationId);
  const [v] = await tx
    .select()
    .from(automationVersion)
    .where(eq(automationVersion.id, input.versionId));
  if (!v || v.automationId !== row.id) throw notFound(`automation version ${input.versionId}`);
  if (v.status === "live") throw new AgentsError("invalid_state", "that version is already live");
  const { skills, missing } = await innerSkills(tx, row.tenantId, [v.definition], input.ctx);
  const result = validateAutomation(v.definition, {
    skills,
    tools: input.ctx.tools.specs(),
    // v0.13 W2-H: an inner step's model is one the platform prices.
    models: knownModelIds(),
  });
  const errors: ValidationError[] = [
    ...result.errors,
    ...missing.map(
      (ref): ValidationError => ({
        stepId: null,
        field: "steps",
        code: "unknown_skill",
        message: `skill ${ref} not found`,
      }),
    ),
  ];
  if (errors.length > 0) {
    throw new AgentsError("invalid_definition", `v${v.version} does not validate`, errors);
  }
  if (row.liveVersionId) {
    await tx
      .update(automationVersion)
      .set({ status: "retired" })
      .where(eq(automationVersion.id, row.liveVersionId));
  }
  const [live] = await tx
    .update(automationVersion)
    .set({ status: "live" })
    .where(eq(automationVersion.id, v.id))
    .returning();
  await tx
    .update(automation)
    .set({
      liveVersionId: v.id,
      name: v.definition.name,
      description: v.definition.description,
    })
    .where(eq(automation.id, row.id));
  if (!live) throw new Error("automation publish updated nothing");
  return live;
}

/** Rollback = copy an older version as a new version and publish it (history stays linear). */
export async function rollbackAutomation(
  tx: Tx,
  input: {
    automationId: string;
    toVersionId: string;
    authorId?: string | null;
    ctx: RegistryContext;
  },
): Promise<AutomationVersionRow> {
  const row = await lockAutomation(tx, input.automationId);
  const [target] = await tx
    .select()
    .from(automationVersion)
    .where(eq(automationVersion.id, input.toVersionId));
  if (!target || target.automationId !== row.id) {
    throw notFound(`automation version ${input.toVersionId}`);
  }
  const { version: copy } = await createAutomationVersion(tx, {
    automationId: row.id,
    definition: target.definition,
    parentVersionId: row.liveVersionId,
    authorId: input.authorId ?? null,
    changeNote: `Rollback to v${target.version}`,
    ctx: input.ctx,
  });
  return publishAutomation(tx, { automationId: row.id, versionId: copy.id, ctx: input.ctx });
}

async function bySlug(tx: Tx, tenantId: string | null, slug: string) {
  const [row] = await tx
    .select()
    .from(automation)
    .where(and(tenantIs(tenantId), eq(automation.slug, slug)));
  return row;
}

async function versionNumbered(tx: Tx, automationId: string, version: number) {
  const [v] = await tx
    .select()
    .from(automationVersion)
    .where(
      and(eq(automationVersion.automationId, automationId), eq(automationVersion.version, version)),
    );
  return v;
}

/**
 * Resolves a pinned reference for one client: the client's own automation of that slug, else the
 * client's copy of the shared one (made when a client agent publishes), else the shared one
 * itself (visible in operator sessions only). `tenantId` null resolves among shared ones only.
 */
export async function resolveAutomation(
  tx: Tx,
  input: { tenantId: string | null; ref: string },
): Promise<ResolvedAutomation | null> {
  const { slug, version } = parseAutomationRef(input.ref);
  if (!Number.isInteger(version)) return null;
  const candidates: [string | null, string, AutomationSource][] =
    input.tenantId === null
      ? [[null, slug, "shared"]]
      : [
          [input.tenantId, slug, "client"],
          [input.tenantId, `${SHARED_COPY_PREFIX}${slug}`, "shared"],
          [null, slug, "shared"],
        ];
  for (const [tenantId, s, source] of candidates) {
    const row = await bySlug(tx, tenantId, s);
    if (row?.status !== "active") continue;
    const v = await versionNumbered(tx, row.id, version);
    if (!v) continue;
    return {
      ref: input.ref,
      definition: v.definition,
      source,
      versionId: v.id,
      version: v.version,
      status: v.status,
    };
  }
  return null;
}

/**
 * What validation needs for a bundle's use steps, resolved for one client: the pinned versions by
 * reference, the skills their steps name, the references that resolve to nothing, and the ones
 * that resolve only to a draft (an agent can't publish on an unpublished automation).
 */
export async function automationContext(
  tx: Tx,
  input: { tenantId: string | null; bundle: AnyAgentBundle; catalog: RegistryContext["catalog"] },
): Promise<{
  automations: Record<string, AutomationDefinition>;
  skills: Record<string, SkillDefinition>;
  missing: string[];
  drafts: string[];
}> {
  const automations: Record<string, AutomationDefinition> = {};
  const missing: string[] = [];
  const drafts: string[] = [];
  for (const ref of bundleAutomationRefs(input.bundle)) {
    const r = await resolveAutomation(tx, { tenantId: input.tenantId, ref });
    if (!r) {
      missing.push(ref);
      continue;
    }
    automations[ref] = r.definition;
    if (r.status === "draft") drafts.push(ref);
  }
  const { skills } = await innerSkills(tx, input.tenantId, Object.values(automations), input);
  return { automations, skills, missing, drafts };
}

/** Publish-time errors for use steps whose automation is missing or still a draft. */
// DECISION: an agent publishes only on published automation versions (live or retired): a pinned
// draft could still change meaning, and only a valid version publishes.
export function automationPublishErrors(
  bundle: AnyAgentBundle,
  found: { drafts: string[] },
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const w of bundle.workflows) {
    // R8: a v4 process pins its processes on `process` steps.
    const pinned =
      w.workflow.schemaVersion === 4
        ? processes
            .subProcessSteps([w.workflow])
            .map((s) => ({ id: s.id, ref: s.process, field: "process" }))
        : useSteps([w.workflow]).map((s) => ({ id: s.id, ref: s.automation, field: "automation" }));
    for (const s of pinned) {
      if (!found.drafts.includes(s.ref)) continue;
      errors.push({
        stepId: s.id,
        field: s.field,
        code: "unknown_automation",
        message: `automation ${s.ref} is a draft: publish it first`,
        workflow: w.slug,
      });
    }
  }
  return errors;
}

/**
 * Copies the shared automations a client agent's bundle uses into that client, as
 * `shared:<slug>` automations with the same version numbers and definitions, and the shared
 * skills their steps name (as skills are copied). Run in the client agent's publish.
 *
 * DECISION: as with shared skills (see snapshotSharedSkills), runs see one client and never a
 * shared row, so publishing snapshots what the agent pins. A copy carries only the definition: no
 * client's data travels with an automation, and a client's copy never leaves it.
 */
export async function snapshotSharedAutomations(
  tx: Tx,
  input: { tenantId: string; bundle: AnyAgentBundle; catalog?: RegistryContext["catalog"] },
): Promise<{ ref: string; versionId: string }[]> {
  const made: { ref: string; versionId: string }[] = [];
  const copiedDefs: AutomationDefinition[] = [];
  for (const ref of bundleAutomationRefs(input.bundle)) {
    const { slug, version } = parseAutomationRef(ref);
    const own = await bySlug(tx, input.tenantId, slug);
    if (own) {
      const v = await versionNumbered(tx, own.id, version);
      if (v) copiedDefs.push(v.definition);
      continue;
    }
    const shared = await bySlug(tx, null, slug);
    if (!shared) {
      throw new AgentsError(
        "invalid_state",
        `automation ${ref} not found (shared automations need an operator session)`,
      );
    }
    const source = await versionNumbered(tx, shared.id, version);
    if (!source) throw new AgentsError("invalid_state", `automation ${ref} has no such version`);
    copiedDefs.push(source.definition);

    const copySlug = `${SHARED_COPY_PREFIX}${slug}`;
    let copy = await bySlug(tx, input.tenantId, copySlug);
    if (!copy) {
      [copy] = await tx
        .insert(automation)
        .values({
          tenantId: input.tenantId,
          slug: copySlug,
          name: shared.name,
          description: shared.description,
        })
        .returning();
      if (!copy) throw new Error("automation copy insert returned nothing");
    }
    const existing = await versionNumbered(tx, copy.id, source.version);
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
          .insert(automationVersion)
          .values({
            tenantId: input.tenantId,
            automationId: copy.id,
            version: source.version,
            definition: source.definition,
            definitionHash: source.definitionHash,
            status: "retired",
            changeNote: `Copy of shared automation ${slug} v${source.version}`,
            authorId: source.authorId,
          })
          .returning()
      )[0];
    if (!copied) throw new Error("automation copy version insert returned nothing");
    made.push({ ref: automationRef(slug, source.version), versionId: copied.id });
  }
  // The shared skills the automations' steps name reach the client as the agent's own do.
  const skillRefs = new Set<string>();
  for (const d of copiedDefs) for (const s of automationRequires(d, {}).skills) skillRefs.add(s);
  if (skillRefs.size > 0) {
    await snapshotSharedSkills(tx, {
      tenantId: input.tenantId,
      bundle: refsBundle([...skillRefs]),
      ...(input.catalog ? { catalog: input.catalog } : {}),
    });
  }
  return made;
}
