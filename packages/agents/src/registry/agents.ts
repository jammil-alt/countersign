// The agent registry (ARCHITECTURE §9.3, docs/plan.md §1.2 "Bundles and lineage"): templates and
// client agents share one table and one versioning path. Every edit inserts a new immutable
// `agent_version` (draft); publishing makes it live in one transaction; rollback copies an older
// version as a new one. Forking copies a template version into a client, ids and all. Operational
// fields (bindings, approver, service name, run status) live on the client agent row, with every
// change in the append-only `agent_change` log.
//
// Every function runs in the caller's transaction: back-office calls open it with withOperator()
// (templates are visible only there), so the registry never widens what a session can see.

import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  type AnyAutomationDefinition,
  // v0.12 W2-D: the account agent's publish guard
  accountAgentProblems,
  automationRefs,
  bindingConnector,
  bundleHash,
  type EventTypeSpec,
  GrantLimits,
  holdsProcess,
  isExternalTool,
  type PermissionEntity,
  type PermissionMatrix,
  parseSkillRef,
  processes,
  REVOKED_GRANT,
  type SkillDefinition,
  skillTools,
  type ValidationError,
  validateBundle,
  walkSteps,
} from "@countersign/core";
import {
  agent,
  agentChange,
  agentGrant,
  agentVersion,
  connection,
  run,
  type Tx,
  tenantPack,
} from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
// v0.12 W2-B: automations
import {
  automationContext,
  automationPublishErrors,
  snapshotSharedAutomations,
} from "./automations";
// lineage imports this module too; only functions cross, so the cycle is safe at load time.
import { stripForPromotion } from "./lineage";
import { type SkillCatalog, skillContext, snapshotSharedSkills } from "./skills";
import type { ToolRegistry } from "./tools";

export type AgentRow = typeof agent.$inferSelect;
export type AgentVersionRow = typeof agentVersion.$inferSelect;
export type AuthorType = AgentVersionRow["authorType"];
export type AgentRunStatus = NonNullable<AgentRow["runStatus"]>;

/** What validation needs from the registries: tools, skills and (optionally) event types. */
export interface RegistryContext {
  tools: ToolRegistry;
  catalog: SkillCatalog;
  events?: Record<string, EventTypeSpec>;
}

/** Parses a bundle (schema only: drafts may be saved with semantic errors, §10.2). */
export function parseBundle(input: unknown): AgentBundle {
  const parsed = AgentBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentsError("invalid_bundle", parsed.error.message, parsed.error.issues);
  }
  return parsed.data;
}

/**
 * R8 (docs/plan.md §1.86, §9): a bundle as a new version may hold it: v3 workflows, v4 processes
 * (what the workflow builder saves) or both. A v3 bundle parses to the same value, so the same
 * canonical JSON and hash, as `parseBundle` gives it.
 */
// DECISION (wave 3b): the version row's `bundle` column is typed `AnyAgentBundle`, its true shape;
// every reader checks `schemaVersion` or reads through core (`allTriggers`, `toProcessBundle`).
// Stored versions are never rewritten (invariant 3): a v3 version stays v3, and the builder's next
// save is a new version.
export function parseVersionBundle(input: unknown): AnyAgentBundle {
  const parsed = AnyAgentBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentsError("invalid_bundle", parsed.error.message, parsed.error.issues);
  }
  return parsed.data;
}

async function lockAgent(tx: Tx, agentId: string): Promise<AgentRow> {
  const [row] = await tx.select().from(agent).where(eq(agent.id, agentId)).for("update");
  if (!row) throw notFound(`agent ${agentId}`);
  return row;
}

export async function getAgent(tx: Tx, agentId: string): Promise<AgentRow> {
  const [row] = await tx.select().from(agent).where(eq(agent.id, agentId));
  if (!row) throw notFound(`agent ${agentId}`);
  return row;
}

export async function getVersion(tx: Tx, versionId: string): Promise<AgentVersionRow> {
  const [row] = await tx.select().from(agentVersion).where(eq(agentVersion.id, versionId));
  if (!row) throw notFound(`agent version ${versionId}`);
  return row;
}

/** A client agent's (or template's) live version, or the given one of that agent. */
export async function resolveVersion(
  tx: Tx,
  input: { agentId: string; versionId?: string | null },
): Promise<AgentVersionRow> {
  const row = await getAgent(tx, input.agentId);
  const id = input.versionId ?? row.liveVersionId;
  if (!id) throw new AgentsError("no_live_version", `agent ${row.slug} has no live version`);
  const v = await getVersion(tx, id);
  if (v.agentId !== row.id) throw notFound(`version ${id} of agent ${row.slug}`);
  return v;
}

export async function listVersions(tx: Tx, agentId: string): Promise<AgentVersionRow[]> {
  return tx
    .select()
    .from(agentVersion)
    .where(eq(agentVersion.agentId, agentId))
    .orderBy(desc(agentVersion.version));
}

/** An agent's newest version (its latest draft or live one), or null when it has none. */
export async function latestVersion(tx: Tx, agentId: string): Promise<AgentVersionRow | null> {
  const [row] = await tx
    .select()
    .from(agentVersion)
    .where(eq(agentVersion.agentId, agentId))
    .orderBy(desc(agentVersion.version))
    .limit(1);
  return row ?? null;
}

/** A version row without its bundle: what a list of versions shows. */
export type AgentVersionHead = Omit<AgentVersionRow, "bundle">;

/**
 * An agent's versions, newest first, without their bundles. A page lists every version but reads
 * one or two bundles, and bundles are the large part of the row.
 */
export async function listVersionHeads(tx: Tx, agentId: string): Promise<AgentVersionHead[]> {
  const { bundle: _bundle, ...columns } = getTableColumns(agentVersion);
  return tx
    .select(columns)
    .from(agentVersion)
    .where(eq(agentVersion.agentId, agentId))
    .orderBy(desc(agentVersion.version));
}

async function insertAgentChange(
  tx: Tx,
  row: Pick<AgentRow, "id" | "tenantId">,
  actorId: string | null | undefined,
  change: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(agentChange)
    .values({ tenantId: row.tenantId, agentId: row.id, actorId: actorId ?? null, change });
}

// ── Versions ─────────────────────────────────────────────────────────────────────────────────────

export interface CreateVersionInput {
  agentId: string;
  bundle: unknown;
  /** The version it was edited from; defaults to the agent's latest version. */
  parentVersionId?: string | null;
  authorType?: AuthorType;
  authorId?: string | null;
  changeNote?: string | null;
  releaseNote?: string | null;
  /** Client versions: defaults to the parent's base template version. */
  basedOnTemplateVersionId?: string | null;
  mergedFromVersionIds?: string[] | null;
}

/**
 * Inserts a new draft version. Refused as a no-op when its bundle hashes the same as its parent's
 * and it keeps the parent's base template version (re-basing alone is a real change: re-linking).
 */
export async function createVersion(tx: Tx, input: CreateVersionInput): Promise<AgentVersionRow> {
  const row = await lockAgent(tx, input.agentId);
  const bundle = parseVersionBundle(input.bundle);
  const hash = await bundleHash(bundle);
  const [parent] = input.parentVersionId
    ? await tx.select().from(agentVersion).where(eq(agentVersion.id, input.parentVersionId))
    : await tx
        .select()
        .from(agentVersion)
        .where(eq(agentVersion.agentId, row.id))
        .orderBy(desc(agentVersion.version))
        .limit(1);
  if (input.parentVersionId && (!parent || parent.agentId !== row.id)) {
    throw notFound(`version ${input.parentVersionId} of agent ${row.slug}`);
  }
  const basedOn =
    row.kind === "client"
      ? input.basedOnTemplateVersionId !== undefined
        ? input.basedOnTemplateVersionId
        : (parent?.basedOnTemplateVersionId ?? null)
      : null;
  if (parent && parent.bundleHash === hash && parent.basedOnTemplateVersionId === basedOn) {
    throw new AgentsError("no_op", "nothing changed since the version it was edited from");
  }
  const [max] = await tx
    .select({ max: sql<number | null>`max(${agentVersion.version})` })
    .from(agentVersion)
    .where(eq(agentVersion.agentId, row.id));
  const [v] = await tx
    .insert(agentVersion)
    .values({
      tenantId: row.tenantId,
      agentId: row.id,
      version: (max?.max ?? 0) + 1,
      bundle,
      bundleHash: hash,
      status: "draft",
      changeNote: input.changeNote ?? null,
      releaseNote: row.kind === "template" ? (input.releaseNote ?? null) : null,
      authorType: input.authorType ?? "operator",
      authorId: input.authorId ?? null,
      parentVersionId: parent?.id ?? null,
      basedOnTemplateVersionId: basedOn,
      mergedFromVersionIds: input.mergedFromVersionIds ?? null,
    })
    .returning();
  if (!v) throw new Error("agent version insert returned nothing");
  return v;
}

/** The connection matrices a client agent's bindings point at, by connector id. */
export async function boundMatrices(
  tx: Tx,
  row: Pick<AgentRow, "tenantId" | "bindings">,
): Promise<Record<string, Partial<PermissionMatrix> | undefined>> {
  const out: Record<string, Partial<PermissionMatrix> | undefined> = {};
  const ids = Object.values(row.bindings);
  if (!row.tenantId || ids.length === 0) return out;
  const rows = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, row.tenantId), inArray(connection.id, ids)));
  for (const [key, id] of Object.entries(row.bindings)) {
    const c = rows.find((r) => r.id === id && r.connector === bindingConnector(key));
    if (c) out[key] = c.permissions;
  }
  return out;
}

// v0.14 W4-B (docs/plan.md §1.44 "Off at publish"): the agent's grants on its bound connections
// and each bound connector's declared entities, so publish refuses an entity turned off.
/** A client agent's grants by binding key (null: no grant row, no narrowing). */
export async function boundGrants(
  tx: Tx,
  row: Pick<AgentRow, "tenantId" | "bindings"> & { id?: string },
): Promise<Record<string, GrantLimits | null>> {
  const ids = Object.values(row.bindings);
  if (!row.tenantId || !row.id || ids.length === 0) return {};
  const rows = await tx
    .select()
    .from(agentGrant)
    .where(
      and(
        eq(agentGrant.tenantId, row.tenantId),
        eq(agentGrant.agentId, row.id),
        inArray(agentGrant.connectionId, ids),
      ),
    );
  // Built with fromEntries (binding keys are data): no assignment by key.
  return Object.fromEntries(
    Object.entries(row.bindings).map(([key, id]): [string, GrantLimits | null] => {
      const g = rows.find((r) => r.connectionId === id);
      if (!g) return [key, null];
      // As grantOf reads a row: one that no longer parses is every verb off and narrows everything.
      const parsed = GrantLimits.safeParse(g.limits);
      return [key, parsed.success ? parsed.data : REVOKED_GRANT];
    }),
  );
}

/** The declared entities of each bound connector, from the registered manifests. */
function boundEntities(
  bindings: Record<string, string>,
  tools: ToolRegistry,
): Record<string, readonly PermissionEntity[] | undefined> {
  return Object.fromEntries(
    Object.keys(bindings).map((key) => [
      key,
      tools.connectors.get(bindingConnector(key))?.manifest.permissionEntities,
    ]),
  );
}

/** Validates a version's bundle as it would be published (client agents: against their bindings). */
export async function validateForPublish(
  tx: Tx,
  // v0.12 W2-D: `slug`, for the account agent's guard (rows without one skip it).
  // v0.14 W4-B: `id`, for the agent's grants (a row without one, a draft not yet saved, has none).
  row: Pick<AgentRow, "tenantId" | "kind" | "bindings"> & { slug?: string; id?: string },
  bundle: AnyAgentBundle,
  ctx: RegistryContext,
  // Skill model (2026-11-10): the version this one was made from. A skill step it doesn't have is
  // new, and a new step may not use a retired kind of skill (`rules_then_ai`, agent mode).
  options: { previous?: AnyAgentBundle | null } = {},
): Promise<ValidationError[]> {
  const { skills, missing } = await skillContext(tx, {
    tenantId: row.tenantId,
    bundle,
    catalog: ctx.catalog,
  });
  // v0.12 W2-B: the automations its use steps pin, and the skills their steps name.
  const used = await automationContext(tx, {
    tenantId: row.tenantId,
    bundle,
    catalog: ctx.catalog,
  });
  // R8: a bundle that holds v4 processes is validated as one (core's `validateAnyBundle`, which
  // validates an all-v3 bundle exactly as `validateBundle` does).
  const existing = options.previous ? processes.bundleNodeIds(options.previous) : undefined;
  const validate = holdsProcess(bundle)
    ? (b: unknown, c: Parameters<typeof validateBundle>[1]) =>
        processes.validateAnyBundle(b, { ...c, ...(existing ? { existingStepIds: existing } : {}) })
    : validateBundle;
  const result = validate(bundle, {
    skills: { ...used.skills, ...skills },
    // v0.14 W4-A: a client agent's shared ids (`whatsapp.send`) are checked against the connector
    // its bindings name (Twilio or Meta).
    tools: ctx.tools.specs(row.kind === "client" ? row.bindings : undefined),
    models: knownModelIds(),
    ...(ctx.events ? { events: ctx.events } : {}),
    ...(row.kind === "client"
      ? {
          publish: {
            matrices: await boundMatrices(tx, row),
            // v0.14 W4-B
            grants: await boundGrants(tx, row),
            entities: boundEntities(row.bindings, ctx.tools),
          },
        }
      : {}),
    // v0.12 W2-G: a client agent's pack panels must name packs its client has enabled.
    ...(row.kind === "client" && row.tenantId
      ? {
          packs: (
            await tx
              .select({ pack: tenantPack.pack })
              .from(tenantPack)
              .where(eq(tenantPack.tenantId, row.tenantId))
          ).map((p) => p.pack),
        }
      : {}),
    // v0.12 W2-B
    automations: used.automations,
    clientAgent: row.kind === "client",
  });
  // v4's codes are v3's and more; the API answers `code` as a string either way.
  const errors = [
    ...(result.errors as ValidationError[]),
    ...automationPublishErrors(bundle, used),
  ];
  // v0.12 W2-D: the account agent (the supervisor and its forks) never reaches a client's tool:
  // no connector or external tool, no binding (docs/plan.md §1.47 "Guards").
  errors.push(
    ...accountAgentProblems({
      slug: row.slug,
      bundle,
      skills: { ...used.skills, ...skills },
      tools: ctx.tools.specs(),
      bindings: row.kind === "client" ? row.bindings : undefined,
      automations: used.automations,
    }),
  );
  for (const ref of missing) {
    // Workflow steps are reported by validateBundle; the agent's own skill list is checked here.
    if (!errors.some((e) => e.code === "unknown_skill" && e.message.includes(ref))) {
      errors.push({
        stepId: null,
        field: "definition.skills",
        code: "unknown_skill",
        message: `skill ${ref} not found`,
      });
    }
  }
  return errors;
}

/**
 * Skill model (2026-11-10): the bundle of the version this one was edited from, which says which
 * of its steps are new (`validateForPublish`'s `previous`).
 */
// DECISION: a version's steps are new when its parent version (the one it was edited from) lacks
// them; a first version (a template's, a fork's, a seed's) has none, so nothing in it counts as
// new: its steps come from code or a template already published.
export async function parentBundle(
  tx: Tx,
  v: Pick<AgentVersionRow, "parentVersionId">,
): Promise<AnyAgentBundle | null> {
  if (!v.parentVersionId) return null;
  const [parent] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(eq(agentVersion.id, v.parentVersionId));
  return parent ? parseVersionBundle(parent.bundle) : null;
}

/**
 * Publishes a version: validation must pass (§10.2), the previous live version is retired, the new
 * one goes live and becomes `live_version_id`, all in the caller's transaction. Publishing a
 * template changes no client agent (invariant 11). Client agents also snapshot the shared skills
 * they use (see snapshotSharedSkills).
 */
export async function publish(
  tx: Tx,
  input: { agentId: string; versionId: string; actorId?: string | null; ctx: RegistryContext },
): Promise<AgentVersionRow> {
  const row = await lockAgent(tx, input.agentId);
  const v = await getVersion(tx, input.versionId);
  if (v.agentId !== row.id) throw notFound(`version ${input.versionId} of agent ${row.slug}`);
  if (v.status === "live") throw new AgentsError("invalid_state", "that version is already live");
  if (row.status === "disabled") {
    throw new AgentsError("invalid_state", "it was discarded: restore it before publishing");
  }
  const errors = await validateForPublish(tx, row, v.bundle, input.ctx, {
    previous: await parentBundle(tx, v),
  });
  if (errors.length > 0) {
    throw new AgentsError("invalid_bundle", `v${v.version} does not validate`, errors);
  }
  if (row.kind === "client" && row.tenantId) {
    await snapshotSharedSkills(tx, {
      tenantId: row.tenantId,
      bundle: v.bundle,
      catalog: input.ctx.catalog,
    });
    // v0.12 W2-B: and the shared automations its use steps pin (with their skills).
    await snapshotSharedAutomations(tx, {
      tenantId: row.tenantId,
      bundle: v.bundle,
      catalog: input.ctx.catalog,
    });
  }
  if (row.liveVersionId) {
    await tx
      .update(agentVersion)
      .set({ status: "retired" })
      .where(eq(agentVersion.id, row.liveVersionId));
  }
  const [live] = await tx
    .update(agentVersion)
    .set({ status: "live" })
    .where(eq(agentVersion.id, v.id))
    .returning();
  if (!live) throw new Error("publish updated nothing");
  await tx.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, row.id));
  await insertAgentChange(tx, row, input.actorId, {
    kind: "publish",
    versionId: v.id,
    version: v.version,
    previousVersionId: row.liveVersionId,
  });
  return live;
}

/** Rollback: the older version's bundle copied as a new version and published. */
export async function rollback(
  tx: Tx,
  input: { agentId: string; toVersionId: string; actorId?: string | null; ctx: RegistryContext },
): Promise<AgentVersionRow> {
  const row = await getAgent(tx, input.agentId);
  const target = await getVersion(tx, input.toVersionId);
  if (target.agentId !== row.id) throw notFound(`version ${input.toVersionId} of ${row.slug}`);
  const copy = await createVersion(tx, {
    agentId: row.id,
    bundle: target.bundle,
    parentVersionId: row.liveVersionId,
    authorType: "operator",
    authorId: input.actorId ?? null,
    changeNote: `Rollback to v${target.version}`,
    releaseNote: target.releaseNote,
    basedOnTemplateVersionId: target.basedOnTemplateVersionId,
  });
  return publish(tx, {
    agentId: row.id,
    versionId: copy.id,
    actorId: input.actorId ?? null,
    ctx: input.ctx,
  });
}

// ── Templates and client agents ──────────────────────────────────────────────────────────────────

export interface NewAgentInput {
  slug: string;
  name?: string;
  role?: string | null;
  bundle: unknown;
  authorType?: AuthorType;
  authorId?: string | null;
  changeNote?: string | null;
}

/** A template (tenant_id null; operator sessions) with its v1 draft. */
export async function createTemplate(
  tx: Tx,
  input: NewAgentInput & { releaseNote?: string | null },
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  const bundle = parseVersionBundle(input.bundle); // Wave 3b: a Builder draft holds v4 processes.
  const [row] = await tx
    .insert(agent)
    .values({
      tenantId: null,
      kind: "template",
      slug: input.slug,
      name: input.name ?? bundle.definition.identity.name,
      role: input.role ?? bundle.definition.identity.role,
    })
    .returning();
  if (!row) throw new Error("agent insert returned nothing");
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle,
    authorType: input.authorType ?? "operator",
    authorId: input.authorId ?? null,
    changeNote: input.changeNote ?? "Created",
    releaseNote: input.releaseNote ?? null,
  });
  return { agent: row, version };
}

export interface ClientAgentFields {
  tenantId: string;
  slug: string;
  name?: string;
  serviceName?: string | null;
  serviceDescription?: string | null;
}

async function insertClientAgent(
  tx: Tx,
  fields: ClientAgentFields & {
    role: string | null;
    templateId: string | null;
    testCopy?: boolean;
  },
  bundle: AnyAgentBundle,
): Promise<AgentRow> {
  const [row] = await tx
    .insert(agent)
    .values({
      tenantId: fields.tenantId,
      kind: "client",
      slug: fields.slug,
      name: fields.name ?? bundle.definition.identity.name,
      role: fields.role,
      templateId: fields.templateId,
      linked: fields.templateId !== null,
      serviceName: fields.serviceName ?? null,
      serviceDescription: fields.serviceDescription ?? null,
      runStatus: "draft",
      testCopy: fields.testCopy ?? false,
    })
    .returning();
  if (!row) throw new Error("agent insert returned nothing");
  return row;
}

/** A client agent written for one client from scratch (no template), with its v1 draft. */
export async function createClientAgent(
  tx: Tx,
  input: ClientAgentFields & Omit<NewAgentInput, "slug">,
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  const bundle = parseVersionBundle(input.bundle); // Wave 3b: a Builder draft holds v4 processes.
  const row = await insertClientAgent(
    tx,
    { ...input, role: input.role ?? bundle.definition.identity.role, templateId: null },
    bundle,
  );
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle,
    authorType: input.authorType ?? "operator",
    authorId: input.authorId ?? null,
    changeNote: input.changeNote ?? "Created",
    basedOnTemplateVersionId: null,
  });
  return { agent: row, version };
}

/**
 * Forks template version T into client C (ARCHITECTURE §9.3): a client agent whose v1 is a copy
 * of T's bundle, step and path ids kept, `based_on_template_version_id = T`. Nothing of any other
 * client comes along: a template carries no memory, records or connections.
 */
export async function fork(
  tx: Tx,
  input: ClientAgentFields & {
    templateVersionId: string;
    actorId?: string | null;
    /** A template's test copy (see `templateTestCopy`). */
    testCopy?: boolean;
  },
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  const tv = await getVersion(tx, input.templateVersionId);
  const template = await getAgent(tx, tv.agentId);
  if (template.kind !== "template") {
    throw new AgentsError("not_a_template", `${template.slug} is not a template`);
  }
  const row = await insertClientAgent(
    tx,
    { ...input, role: template.role, templateId: template.id },
    tv.bundle,
  );
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle: tv.bundle,
    authorType: "operator",
    authorId: input.actorId ?? null,
    changeNote: `Forked from ${template.slug} v${tv.version}`,
    basedOnTemplateVersionId: tv.id,
  });
  await insertAgentChange(tx, row, input.actorId, {
    kind: "fork",
    templateId: template.id,
    templateVersionId: tv.id,
  });
  return { agent: row, version };
}

/** The slug of a template's test copy. */
export const testCopySlug = (templateSlug: string): string => `${templateSlug}-test-copy`;

/**
 * The client agent a template version is test-run as, in the Sandbox client (docs/plan.md §1.5
 * "Template test runs"). The first test run forks the template into `tenantId` as its test copy
 * (`test_copy`, never activated); later ones reuse that copy, with its bindings, and give it a new
 * version holding the template version's bundle unless it already has one. Step ids are copied as
 * they are, never regenerated. The template itself never runs for a client.
 */
// DECISION: one test copy per template and client, kept and updated rather than forked afresh, so
// the Sandbox connections bound to it once stay bound for every later test run.
export async function templateTestCopy(
  tx: Tx,
  input: { tenantId: string; templateVersionId: string; actorId?: string | null },
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  const tv = await getVersion(tx, input.templateVersionId);
  const template = await getAgent(tx, tv.agentId);
  if (template.kind !== "template") {
    throw new AgentsError("not_a_template", `${template.slug} is not a template`);
  }
  const [existing] = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, input.tenantId),
        eq(agent.templateId, template.id),
        eq(agent.testCopy, true),
      ),
    )
    .for("update");
  if (!existing) {
    return fork(tx, {
      tenantId: input.tenantId,
      slug: testCopySlug(template.slug),
      name: `${template.name} (test copy)`,
      templateVersionId: tv.id,
      actorId: input.actorId ?? null,
      testCopy: true,
    });
  }
  const [same] = await tx
    .select()
    .from(agentVersion)
    .where(
      and(
        eq(agentVersion.agentId, existing.id),
        eq(agentVersion.basedOnTemplateVersionId, tv.id),
        eq(agentVersion.bundleHash, tv.bundleHash),
      ),
    )
    .orderBy(desc(agentVersion.version))
    .limit(1);
  if (same) return { agent: existing, version: same };
  const version = await createVersion(tx, {
    agentId: existing.id,
    bundle: tv.bundle,
    authorType: "operator",
    authorId: input.actorId ?? null,
    changeNote: `Test copy of ${template.slug} v${tv.version}`,
    basedOnTemplateVersionId: tv.id,
  });
  return { agent: existing, version };
}

/**
 * Copies another client's agent into client C: its live bundle (ids kept) and template lineage,
 * but no bindings, memory or learned data (§9.3). Settings marked `clientSpecific` and literal
 * record ids are replaced by the base template's value (or dropped), as for a promotion, so the
 * source client's records never reach C (ARCHITECTURE §14). The copy is re-bound to C's
 * connections later.
 */
export async function copyClientAgent(
  tx: Tx,
  input: ClientAgentFields & {
    sourceAgentId: string;
    actorId?: string | null;
    ctx: Pick<RegistryContext, "catalog">;
  },
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  const source = await getAgent(tx, input.sourceAgentId);
  if (source.kind !== "client") {
    throw new AgentsError("not_a_client_agent", `${source.slug} is not a client agent`);
  }
  const sv = await resolveVersion(tx, { agentId: source.id });
  const base =
    source.linked && sv.basedOnTemplateVersionId
      ? (await getVersion(tx, sv.basedOnTemplateVersionId)).bundle
      : null;
  const { skills } = await skillContext(tx, {
    tenantId: source.tenantId,
    bundle: sv.bundle,
    catalog: input.ctx.catalog,
  });
  const bundle = stripForPromotion(sv.bundle, base, skills);
  const row = await insertClientAgent(
    tx,
    { ...input, role: source.role, templateId: source.linked ? source.templateId : null },
    bundle,
  );
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle,
    authorType: "operator",
    authorId: input.actorId ?? null,
    changeNote: `Copied from another client's ${source.slug} v${sv.version}`,
    basedOnTemplateVersionId: source.linked ? sv.basedOnTemplateVersionId : null,
  });
  await insertAgentChange(tx, row, input.actorId, { kind: "copy", sourceAgentId: source.id });
  return { agent: row, version };
}

// ── Operational fields ───────────────────────────────────────────────────────────────────────────

export interface OperationalPatch {
  /** connector id → connection id of this client. */
  bindings?: Record<string, string>;
  approver?: "client_admin" | "operator" | null;
  serviceName?: string | null;
  serviceDescription?: string | null;
}

/** Changes operational fields of a client agent (not a new version) and logs the change. */
export async function updateOperational(
  tx: Tx,
  input: { agentId: string; actorId?: string | null; patch: OperationalPatch },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client" || !row.tenantId) {
    throw new AgentsError("not_a_client_agent", "only client agents have bindings and approvers");
  }
  const { patch } = input;
  if (patch.bindings) {
    const ids = Object.values(patch.bindings);
    const rows = ids.length
      ? await tx
          .select()
          .from(connection)
          .where(and(eq(connection.tenantId, row.tenantId), inArray(connection.id, ids)))
      : [];
    for (const [key, id] of Object.entries(patch.bindings)) {
      // DECISION: a binding key is a connector id or `<connector>:<name>` (a connector's
      // `bindingKey`, docs/plan.md §1.26); either way it binds a connection of that connector.
      const connector = bindingConnector(key);
      if (!rows.some((c) => c.id === id && c.connector === connector)) {
        throw new AgentsError(
          "invalid_state",
          `${id} is not this client's ${connector} connection`,
        );
      }
    }
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof OperationalPatch)[]) {
    if (patch[key] === undefined) continue;
    before[key] = row[key];
    after[key] = patch[key];
  }
  if (Object.keys(after).length === 0) return row;
  const [updated] = await tx
    .update(agent)
    .set(after as Partial<AgentRow>)
    .where(eq(agent.id, row.id))
    .returning();
  await insertAgentChange(tx, row, input.actorId, { kind: "operational", before, after });
  if (!updated) throw new Error("agent update returned nothing");
  return updated;
}

/** Detaches a client agent from its template: it keeps its history, takes no more updates. */
export async function detach(
  tx: Tx,
  input: { agentId: string; actorId?: string | null },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client") throw new AgentsError("not_a_client_agent", "templates can't detach");
  const [updated] = await tx
    .update(agent)
    .set({ linked: false })
    .where(eq(agent.id, row.id))
    .returning();
  await insertAgentChange(tx, row, input.actorId, { kind: "detach" });
  if (!updated) throw new Error("agent update returned nothing");
  return updated;
}

/**
 * Re-links a client agent to a template version as its new base: a new draft version (same bundle,
 * new `based_on_template_version_id`), so the next update merges from that base.
 */
export async function relink(
  tx: Tx,
  input: { agentId: string; templateVersionId: string; actorId?: string | null },
): Promise<AgentVersionRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client") throw new AgentsError("not_a_client_agent", "templates can't link");
  const tv = await getVersion(tx, input.templateVersionId);
  const template = await getAgent(tx, tv.agentId);
  if (template.kind !== "template") throw new AgentsError("not_a_template", "not a template");
  const current = await resolveVersion(tx, { agentId: row.id });
  await tx.update(agent).set({ linked: true, templateId: template.id }).where(eq(agent.id, row.id));
  await insertAgentChange(tx, row, input.actorId, {
    kind: "relink",
    templateId: template.id,
    templateVersionId: tv.id,
  });
  return createVersion(tx, {
    agentId: row.id,
    bundle: current.bundle,
    parentVersionId: current.id,
    authorId: input.actorId ?? null,
    changeNote: `Re-linked to ${template.slug} v${tv.version}`,
    basedOnTemplateVersionId: tv.id,
  });
}

// ── Activation ───────────────────────────────────────────────────────────────────────────────────

/**
 * The connectors a bundle needs bound: those its skills require, and the connectors of every
 * connector tool it can call (skills' tools, extra tools, action steps; v4: read and write steps).
 */
export function requiredConnectors(
  bundle: AnyAgentBundle,
  skills: Record<string, SkillDefinition>,
  tools: ToolRegistry,
  // v0.12 W2-B: the automations its use steps pin (their `requires.connectors` count too).
  automations: Record<string, AnyAutomationDefinition> = {},
  // v0.14 W4-A: a client agent's bindings, so a shared id needs the connector it is bound to
  // (Twilio or Meta for `whatsapp.send`); without them, the first that supplies it.
  bindings?: Readonly<Record<string, string>>,
): string[] {
  const out = new Set<string>();
  for (const w of bundle.workflows) {
    if (!w.enabled) continue;
    // Wave 3b: a v4 process pins its automations on `process` steps.
    const refs =
      w.workflow.schemaVersion === 4
        ? processes.subProcessRefs([w.workflow])
        : automationRefs([w.workflow]);
    for (const ref of refs) {
      for (const c of automations[ref]?.requires.connectors ?? []) out.add(c);
    }
  }
  const toolIds = new Set(bundle.definition.extraTools);
  const addSkill = (ref: string) => {
    const def = skills[ref] ?? skills[parseSkillRef(ref).id];
    if (!def) return;
    for (const c of def.requiresConnectors) out.add(c);
    for (const t of skillTools(def)) toolIds.add(t);
  };
  for (const s of bundle.definition.skills) addSkill(s.skill);
  for (const w of bundle.workflows) {
    if (!w.enabled) continue;
    // Wave 3b: a v4 process's read and write steps name their tool, as an action step does.
    if (w.workflow.schemaVersion === 4) {
      processes.walkSteps(w.workflow, ({ step }) => {
        if (step.kind === "skill") addSkill(step.skill);
        if (step.kind === "read" || step.kind === "write") toolIds.add(step.tool);
      });
      continue;
    }
    walkSteps(w.workflow, ({ step }) => {
      if (step.kind === "skill") addSkill(step.skill);
      if (step.kind === "action") toolIds.add(step.tool);
    });
  }
  for (const id of toolIds) {
    const t = tools.get(id);
    if (t?.kind === "connector") out.add(tools.connectorFor(id, bindings));
    else if (t && isExternalTool(t.spec) && t.spec.connector) out.add(t.spec.connector);
  }
  return [...out].sort();
}

/**
 * Why a client agent can't become active (docs/plan.md §1.2 "Client agent activation"): every
 * required connector bound to a usable connection of this client, the skills' packs enabled, a
 * live version that validates against the bindings, and a passing test run of that live version.
 */
// DECISION: "a passing test run since its last publish" is checked as a succeeded test run of the
// live version itself. A version is immutable, so a test of it before publishing (as an update
// merge requires, §10.4) proves the same thing as one after.
export async function activationProblems(
  tx: Tx,
  input: { agentId: string; ctx: RegistryContext },
): Promise<string[]> {
  const row = await getAgent(tx, input.agentId);
  if (row.kind !== "client" || !row.tenantId) return ["only client agents run"];
  if (row.testCopy) return ["a template's test copy only test-runs: fork the template to run it"];
  if (row.runStatus === "retired") return ["the agent is retired"];
  if (row.status === "disabled") return ["it was discarded: restore it first"];
  if (!row.liveVersionId) return ["it has no live version: publish one first"];
  const live = await getVersion(tx, row.liveVersionId);
  const problems: string[] = [];

  const { skills, missing } = await skillContext(tx, {
    tenantId: row.tenantId,
    bundle: live.bundle,
    catalog: input.ctx.catalog,
  });
  for (const ref of missing) problems.push(`skill ${ref} is not available to this client`);
  // v0.12 W2-B: the automations it pins, in this client (its own, or its copies of shared ones).
  const used = await automationContext(tx, {
    tenantId: row.tenantId,
    bundle: live.bundle,
    catalog: input.ctx.catalog,
  });
  for (const ref of used.missing)
    problems.push(`automation ${ref} is not available to this client`);

  const connectors = requiredConnectors(
    live.bundle,
    skills,
    input.ctx.tools,
    used.automations,
    row.bindings,
  );
  const bound = Object.values(row.bindings);
  const rows = bound.length
    ? await tx
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, row.tenantId), inArray(connection.id, bound)))
    : [];
  for (const c of connectors) {
    const id = row.bindings[c];
    const conn = rows.find((r) => r.id === id && r.connector === c);
    if (!id || !conn) {
      problems.push(`connector ${c} is not bound`);
      continue;
    }
    const auth = input.ctx.tools.connectors.get(c)?.manifest.auth;
    const usable = conn.status === "connected" || (conn.status === "pending" && auth === "none");
    if (!usable) problems.push(`the ${c} connection is ${conn.status}`);
  }

  const packs = new Set(Object.values(skills).flatMap((s) => s.requiresPacks));
  if (packs.size > 0) {
    const enabled = await tx
      .select({ pack: tenantPack.pack })
      .from(tenantPack)
      .where(eq(tenantPack.tenantId, row.tenantId));
    for (const p of packs) {
      if (!enabled.some((e) => e.pack === p)) problems.push(`pack ${p} is not enabled`);
    }
  }

  // A required role with nobody bound (docs/plan.md §1.25).
  for (const r of live.bundle.people ?? []) {
    if (r.required && !(row.people[r.role]?.contactIds.length ?? 0)) {
      problems.push(`nobody is bound to the required role ${r.role}`);
    }
  }

  for (const e of await validateForPublish(tx, row, live.bundle, input.ctx)) {
    problems.push(`v${live.version}${e.stepId ? ` step ${e.stepId}` : ""}: ${e.message}`);
  }

  const [passed] = await tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, row.tenantId),
        eq(run.agentId, row.id),
        eq(run.agentVersionId, live.id),
        eq(run.mode, "test"),
        eq(run.status, "succeeded"),
      ),
    )
    .limit(1);
  if (!passed) problems.push(`v${live.version} has no passing test run on this client`);
  return problems;
}

async function setRunStatus(
  tx: Tx,
  row: AgentRow,
  runStatus: AgentRunStatus,
  actorId: string | null | undefined,
): Promise<AgentRow> {
  const [updated] = await tx
    .update(agent)
    .set({ runStatus })
    .where(eq(agent.id, row.id))
    .returning();
  await insertAgentChange(tx, row, actorId, {
    kind: "run_status",
    before: row.runStatus,
    after: runStatus,
  });
  if (!updated) throw new Error("agent update returned nothing");
  return updated;
}

/** Activates a client agent, or refuses with every reason it can't run yet. */
export async function activate(
  tx: Tx,
  input: { agentId: string; actorId?: string | null; ctx: RegistryContext },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  const problems = await activationProblems(tx, { agentId: row.id, ctx: input.ctx });
  if (problems.length > 0) {
    throw new AgentsError("activation_refused", problems.join("; "), problems);
  }
  if (row.runStatus === "active") return row;
  return setRunStatus(tx, row, "active", input.actorId);
}

/** Pausing stops new runs; runs already going finish. */
export async function pause(
  tx: Tx,
  input: { agentId: string; actorId?: string | null },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.runStatus !== "active") {
    throw new AgentsError(
      "invalid_state",
      `only an active agent can pause (it is ${row.runStatus})`,
    );
  }
  return setRunStatus(tx, row, "paused", input.actorId);
}

export async function retire(
  tx: Tx,
  input: { agentId: string; actorId?: string | null },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client") throw new AgentsError("not_a_client_agent", "templates don't run");
  return setRunStatus(tx, row, "retired", input.actorId);
}

/** Templates, newest first (operator sessions). */
/** Templates; discarded drafts only when asked for. */
export async function listTemplates(
  tx: Tx,
  options: { discarded?: boolean; published?: boolean } = {},
): Promise<AgentRow[]> {
  return tx
    .select()
    .from(agent)
    .where(
      and(
        isNull(agent.tenantId),
        eq(agent.kind, "template"),
        options.discarded ? undefined : eq(agent.status, "active"),
        options.published ? isNotNull(agent.liveVersionId) : undefined,
      ),
    )
    .orderBy(agent.slug);
}

/**
 * The templates the back office counts as templates (Agent lab's list, Billing's prices): active
 * and published. A draft never published (a test such as "Staging check") is a draft, not one.
 */
// DECISION: one definition for every count of templates, so Billing and Agent lab agree.
export function publishedTemplates(tx: Tx): Promise<AgentRow[]> {
  return listTemplates(tx, { published: true });
}

/** A client's agents; discarded drafts only when asked for. */
export async function listClientAgents(
  tx: Tx,
  tenantId: string,
  options: { discarded?: boolean } = {},
): Promise<AgentRow[]> {
  return tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        options.discarded ? undefined : eq(agent.status, "active"),
      ),
    )
    .orderBy(agent.slug);
}

// ── Discarding drafts ────────────────────────────────────────────────────────────────────────────

/**
 * Discards an agent that was never published (a Builder draft the operator doesn't want, or any
 * other unpublished draft): it leaves the lists and can't be activated or routed, its versions
 * stay (invariant 3), and `restoreAgent` brings it back.
 */
// DECISION: discarding sets `agent.status = 'disabled'` (the routers already skip disabled agents)
// instead of deleting: versions are immutable and never deleted, so the agent row stays too. Only
// agents with no live version can be discarded; a published client agent is retired instead, and
// a published template stays (clients' agents may be based on it). The slug stays taken.
export async function discardDraft(
  tx: Tx,
  input: { agentId: string; actorId?: string | null },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.status === "disabled") throw new AgentsError("invalid_state", "it is already discarded");
  if (row.liveVersionId) {
    throw new AgentsError(
      "invalid_state",
      row.kind === "client"
        ? "it has been published: retire it instead"
        : "it has been published, so it stays",
    );
  }
  if (row.testCopy) throw new AgentsError("invalid_state", "a test copy is not a draft");
  const [updated] = await tx
    .update(agent)
    .set({ status: "disabled" })
    .where(eq(agent.id, row.id))
    .returning();
  if (!updated) throw new Error("discard updated nothing");
  await insertAgentChange(tx, row, input.actorId, { kind: "discard" });
  return updated;
}

/** Brings a discarded draft back. */
export async function restoreAgent(
  tx: Tx,
  input: { agentId: string; actorId?: string | null },
): Promise<AgentRow> {
  const row = await lockAgent(tx, input.agentId);
  if (row.status !== "disabled") throw new AgentsError("invalid_state", "it is not discarded");
  const [updated] = await tx
    .update(agent)
    .set({ status: "active" })
    .where(eq(agent.id, row.id))
    .returning();
  if (!updated) throw new Error("restore updated nothing");
  await insertAgentChange(tx, row, input.actorId, { kind: "restore" });
  return updated;
}
