// Template updates and promotion, the data side (ARCHITECTURE §9.3, docs/plan.md §1.2 "Updates
// and promotion"). Both are core's three-way merge over whole bundles:
// - update:    base = the client's base template version, ours = the client's live version,
//              theirs = the template's live version → a client draft (author_type 'merge');
// - promotion: base = the client's base template version, ours = the template's live version,
//              theirs = the client version with client-specific values stripped → a template
//              draft (author_type 'promote').
// Neither publishes: the operator reviews, test-runs and publishes as usual. No update is applied
// automatically (DECISION in plan §1.2).

import {
  type AnyAgentBundle,
  type AnyStep,
  cloneJson,
  eachBundleStep,
  holdsProcess,
  isPlainObject,
  type MergeResult,
  mergeBundles,
  parseSkillRef,
  processes,
  type Resolution,
  type SkillDefinition,
  selectChanges,
  validateBundle,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { aliasedTable, and, eq, inArray } from "drizzle-orm";
import { AgentsError } from "../errors";
import {
  type AgentRow,
  type AgentVersionRow,
  createVersion,
  getAgent,
  getVersion,
  type RegistryContext,
  resolveVersion,
} from "./agents";
import { convertLookup, skillContext } from "./skills";

export interface UpdateInfo {
  linked: boolean;
  /** The client live version's base template version. */
  base: AgentVersionRow | null;
  /** The template's live version. */
  templateLive: AgentVersionRow | null;
  /** Template versions published since the base (by version number). */
  behind: number;
  available: boolean;
  releaseNote: string | null;
}

async function clientAgent(tx: Tx, agentId: string): Promise<AgentRow> {
  const row = await getAgent(tx, agentId);
  if (row.kind !== "client")
    throw new AgentsError("not_a_client_agent", `${row.slug} is a template`);
  return row;
}

async function templateLive(tx: Tx, row: AgentRow): Promise<AgentVersionRow | null> {
  if (!row.templateId) return null;
  const template = await getAgent(tx, row.templateId);
  return template.liveVersionId ? getVersion(tx, template.liveVersionId) : null;
}

/**
 * "Update available": a linked client agent whose live version's base template version is older
 * than the template's live version (operator sessions: templates are visible only there).
 */
export async function updateInfo(tx: Tx, input: { agentId: string }): Promise<UpdateInfo> {
  const row = await clientAgent(tx, input.agentId);
  const live = row.liveVersionId ? await getVersion(tx, row.liveVersionId) : null;
  const base = live?.basedOnTemplateVersionId
    ? await getVersion(tx, live.basedOnTemplateVersionId)
    : null;
  const tLive = await templateLive(tx, row);
  const behind = base && tLive ? Math.max(0, tLive.version - base.version) : 0;
  return {
    linked: row.linked,
    base,
    templateLive: tLive,
    behind,
    available: row.linked && behind > 0,
    releaseNote: tLive?.releaseNote ?? null,
  };
}

/**
 * `updateInfo`'s `behind` for many client agents in one query: for each linked agent whose
 * template has moved on since its live version's base, how many versions. Agents with no update
 * (up to date, detached, no live version or no base) are left out.
 */
// DECISION: the command center shows "N versions behind" for its whole agents table; asking
// updateInfo per agent was four queries each, loading whole bundles for two numbers (§1.84).
export async function versionsBehind(
  tx: Tx,
  agentIds: readonly string[],
): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();
  const live = aliasedTable(agentVersion, "live");
  const base = aliasedTable(agentVersion, "base");
  const template = aliasedTable(agent, "template");
  const templateLive = aliasedTable(agentVersion, "template_live");
  const rows = await tx
    .select({ id: agent.id, base: base.version, latest: templateLive.version })
    .from(agent)
    .innerJoin(live, eq(live.id, agent.liveVersionId))
    .innerJoin(base, eq(base.id, live.basedOnTemplateVersionId))
    .innerJoin(template, eq(template.id, agent.templateId))
    .innerJoin(templateLive, eq(templateLive.id, template.liveVersionId))
    .where(and(inArray(agent.id, [...agentIds]), eq(agent.kind, "client"), eq(agent.linked, true)));
  return new Map(
    rows.filter((r) => r.latest > r.base).map((r) => [r.id, r.latest - r.base] as const),
  );
}

export interface MergePreview {
  base: AgentVersionRow;
  ours: AgentVersionRow;
  theirs: AgentVersionRow;
  result: MergeResult<AnyAgentBundle>;
}

/**
 * R9 (docs/plan.md §1.86, §9): how a merge reads stored v3 workflows as v4 when the template's
 * versions hold processes and the client's (or its base) don't, with the registries as they are.
 */
export function lineageReadOptions(ctx: Pick<RegistryContext, "catalog" | "tools">): {
  lookup: processes.ConvertLookup;
} {
  return { lookup: convertLookup(ctx.catalog, ctx.tools) };
}

/** The merged result of applying the template's live version to a client agent, with conflicts. */
export async function previewUpdate(
  tx: Tx,
  input: {
    agentId: string;
    resolutions?: readonly Resolution[];
    /**
     * R9: the registries, for a template whose live version holds v4 processes while the client
     * agent's are v3 workflows (the merged draft is then all v4). Without it, such a merge throws.
     */
    ctx?: Pick<RegistryContext, "catalog" | "tools">;
  },
): Promise<MergePreview> {
  const row = await clientAgent(tx, input.agentId);
  if (!row.linked) throw new AgentsError("not_linked", `${row.slug} is detached from its template`);
  const info = await updateInfo(tx, { agentId: row.id });
  const ours = await resolveVersion(tx, { agentId: row.id });
  if (!info.base || !info.templateLive) {
    throw new AgentsError("no_update", `${row.slug} has no template version to update from`);
  }
  if (!info.available) throw new AgentsError("no_update", `${row.slug} is up to date`);
  const result = mergeBundles(
    info.base.bundle,
    ours.bundle,
    info.templateLive.bundle,
    input.resolutions ?? [],
    input.ctx ? lineageReadOptions(input.ctx) : {},
  );
  return { base: info.base, ours, theirs: info.templateLive, result };
}

async function requireMergeable(
  tx: Tx,
  tenantId: string | null,
  result: MergeResult<AnyAgentBundle>,
  ctx: RegistryContext,
): Promise<void> {
  if (!result.clean) {
    throw new AgentsError(
      "merge_conflicts",
      `${result.conflicts.length} conflicts are unresolved`,
      result.conflicts,
    );
  }
  const { skills } = await skillContext(tx, {
    tenantId,
    bundle: result.bundle,
    catalog: ctx.catalog,
  });
  // R9: a merge with a template's v4 version is all v4, validated as such (an all-v3 one exactly
  // as before).
  const validate = holdsProcess(result.bundle) ? processes.validateAnyBundle : validateBundle;
  const valid = validate(result.bundle, {
    skills,
    tools: ctx.tools.specs(),
    models: knownModelIds(),
    ...(ctx.events ? { events: ctx.events } : {}),
  });
  if (!valid.valid) {
    throw new AgentsError("invalid_bundle", "the merged bundle does not validate", valid.errors);
  }
}

/**
 * Saves the update as a client draft (author_type 'merge', based on the template's live version).
 * Every conflict must be resolved and the merged bundle must validate.
 */
export async function createUpdateDraft(
  tx: Tx,
  input: {
    agentId: string;
    resolutions?: readonly Resolution[];
    actorId?: string | null;
    changeNote?: string | null;
    ctx: RegistryContext;
  },
): Promise<{ version: AgentVersionRow; preview: MergePreview }> {
  const preview = await previewUpdate(tx, input);
  const row = await getAgent(tx, input.agentId);
  await requireMergeable(tx, row.tenantId, preview.result, input.ctx);
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle: preview.result.bundle,
    parentVersionId: preview.ours.id,
    authorType: "merge",
    authorId: input.actorId ?? null,
    changeNote: input.changeNote ?? `Update from template v${preview.theirs.version}`,
    basedOnTemplateVersionId: preview.theirs.id,
    mergedFromVersionIds: [preview.theirs.id],
  });
  return { version, preview };
}

// ── Promotion ────────────────────────────────────────────────────────────────────────────────────

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Whether a value names one of the client's records: a uuid anywhere outside `{{…}}` references
 * (which may name step ids, generated as uuids, and are not client data).
 */
// DECISION: templates refer to records only through {{refs}}, so any literal uuid in a client
// version's step inputs or settings is treated as the client's record or connection id and is not
// promoted (ARCHITECTURE §9.3 "Client-specific values ... are left out").
export function holdsRecordId(value: unknown): boolean {
  if (typeof value === "string") return UUID_IN_TEXT.test(value.replace(/\{\{[^{}]*\}\}/g, ""));
  if (Array.isArray(value)) return value.some(holdsRecordId);
  if (isPlainObject(value)) return Object.values(value).some(holdsRecordId);
  return false;
}

type Bag = Record<string, unknown>;

/** Replaces client-specific keys of `bag` with the base's value for the key, or drops them. */
function scrub(bag: Bag | undefined, base: Bag | undefined, clientSpecific: Set<string>): void {
  if (!bag) return;
  for (const key of Object.keys(bag)) {
    if (!clientSpecific.has(key) && !holdsRecordId(bag[key])) continue;
    if (base && Object.hasOwn(base, key)) bag[key] = cloneJson(base[key]);
    else delete bag[key];
  }
}

function stepsById(bundle: AnyAgentBundle): Map<string, AnyStep> {
  const out = new Map<string, AnyStep>();
  eachBundleStep(bundle, (step) => out.set(step.id, step));
  return out;
}

/**
 * A client version as it may go into a template: settings marked `clientSpecific` and literal
 * record ids are replaced by the base template's value where it has one (so promotion doesn't
 * delete them from the template), else removed. Bindings never are in a bundle. Wave 3b: a v4
 * process's steps the same way (a skill step's `customize.settings` too); the client and base
 * versions may be v3 and v4 apiece, and their steps line up by id (the converter keeps them).
 */
export function stripForPromotion<B extends AnyAgentBundle>(
  client: B,
  /** The base template version's bundle; null (no template) drops every such value. */
  base: AnyAgentBundle | null,
  skills: Record<string, Pick<SkillDefinition, "settings">>,
): B {
  // Same rule as core's stripClientSpecificSettings, but the base's value is kept where it has one.
  const out = cloneJson(client);
  const specificKeys = (ref: string) =>
    new Set(
      (skills[ref] ?? skills[parseSkillRef(ref).id])?.settings
        .filter((s) => s.clientSpecific)
        .map((s) => s.key) ?? [],
    );
  const baseSkills = new Map(
    (base?.definition.skills ?? []).map((s) => [parseSkillRef(s.skill).id, s]),
  );
  for (const s of out.definition.skills) {
    scrub(s.settings, baseSkills.get(parseSkillRef(s.skill).id)?.settings, specificKeys(s.skill));
  }
  const baseSteps = base ? stepsById(base) : new Map<string, AnyStep>();
  /** A step's settings wherever they live: v3's `settings`, v4's and `customize.settings`. */
  const settingsOf = (step: AnyStep | undefined): Bag | undefined => {
    if (step?.kind !== "skill") return undefined;
    const own = step.settings as Bag | undefined;
    const customized = (step as { customize?: { settings?: Bag } }).customize?.settings;
    return own || customized ? { ...customized, ...own } : undefined;
  };
  eachBundleStep(out, (step) => {
    const b = baseSteps.get(step.id);
    const bag = b as (AnyStep & Bag) | undefined;
    if (step.kind === "skill") {
      const keys = specificKeys(step.skill);
      scrub(step.settings as Bag | undefined, settingsOf(b), keys);
      const customize = (step as { customize?: { settings?: Bag } }).customize;
      scrub(customize?.settings, settingsOf(b), keys);
    }
    const s = step as AnyStep & Bag;
    for (const field of ["input", "payload"] as const) {
      scrub(s[field] as Bag | undefined, bag?.[field] as Bag | undefined, new Set());
    }
  });
  return out;
}

export interface PromotionPreview extends MergePreview {
  /** The client version promoted (before stripping). */
  client: AgentVersionRow;
  /** The client version's bundle with client-specific values stripped (every change offered). */
  stripped: AnyAgentBundle;
  /** The "theirs" side merged: `stripped` with only the selected changes (all when none given). */
  selected: AnyAgentBundle;
}

/**
 * The template draft a promotion would make: base = the client's base template version, ours =
 * the template's live version, theirs = the client version (live by default), stripped. Needs an
 * operator session that serves the client.
 */
export async function previewPromotion(
  tx: Tx,
  input: {
    agentId: string;
    versionId?: string | null;
    /** Ids from core's `selectableBetween(base, stripped)`; omitted: every change. */
    changes?: readonly string[] | null;
    resolutions?: readonly Resolution[];
    ctx: RegistryContext;
  },
): Promise<PromotionPreview> {
  const row = await clientAgent(tx, input.agentId);
  const client = await resolveVersion(tx, { agentId: row.id, versionId: input.versionId ?? null });
  if (!row.templateId || !client.basedOnTemplateVersionId) {
    throw new AgentsError("not_linked", `${row.slug} has no template to promote into`);
  }
  const base = await getVersion(tx, client.basedOnTemplateVersionId);
  const ours = await templateLive(tx, row);
  if (!ours) throw new AgentsError("no_live_version", "the template has no live version");
  const { skills } = await skillContext(tx, {
    tenantId: row.tenantId,
    bundle: client.bundle,
    catalog: input.ctx.catalog,
  });
  const stripped = stripForPromotion(client.bundle, base.bundle, skills);
  // R9: a client version and a template version may be v3 and v4 apiece.
  const read = lineageReadOptions(input.ctx);
  const selected = input.changes
    ? selectChanges(base.bundle, stripped, input.changes, read)
    : stripped;
  const result = mergeBundles(base.bundle, ours.bundle, selected, input.resolutions ?? [], read);
  // The "theirs" side is the stripped client bundle; report it against the client version row.
  return { base, ours, theirs: client, client, stripped, selected, result };
}

/** Saves a promotion as a template draft (author_type 'promote'). */
export async function createPromotionDraft(
  tx: Tx,
  input: {
    agentId: string;
    versionId?: string | null;
    changes?: readonly string[] | null;
    resolutions?: readonly Resolution[];
    actorId?: string | null;
    changeNote?: string | null;
    releaseNote?: string | null;
    ctx: RegistryContext;
  },
): Promise<{ version: AgentVersionRow; preview: PromotionPreview }> {
  const preview = await previewPromotion(tx, input);
  await requireMergeable(tx, null, preview.result, input.ctx);
  const version = await createVersion(tx, {
    agentId: preview.ours.agentId,
    bundle: preview.result.bundle,
    parentVersionId: preview.ours.id,
    authorType: "promote",
    authorId: input.actorId ?? null,
    changeNote: input.changeNote ?? `Promoted from a client's v${preview.client.version}`,
    releaseNote: input.releaseNote ?? null,
    mergedFromVersionIds: [preview.client.id],
  });
  return { version, preview };
}
