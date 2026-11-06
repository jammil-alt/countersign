// Permissions per record type (ARCHITECTURE §6.1 "Permissions per record type", docs/plan.md §1.44).
// A connector declares the entities its tools touch (`permissionEntities`) and each tool names one
// (`ToolSpec.entity`, or `entityInput` when its input says which). A connection's matrix and an
// agent's grant keep their verb levels and gain `entities: {[entity]: {read?, create?, update?,
// delete?, scope?: {[verb]: scopeId}}}`. A call's level is the strictest of the connection's verb,
// the connection's entity (and its scope), the grant's verb and the grant's entity (and its scope);
// a missing entity entry, or a matrix saved before v0.12, is the verb's level. Delete stays off for
// every entity. Pure: no database, no connector code.

import { isPlainObject } from "../json";
import {
  DEFAULT_PERMISSIONS,
  EntityPermissions,
  type PermissionEntity,
  type PermissionLevel,
  type PermissionMatrix,
  type PermissionScope,
  type Verb,
} from "../schemas/permissions";

const VERBS: readonly Verb[] = ["read", "create", "update", "delete"];
const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

function stricter(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

function looser(a: PermissionLevel, b: PermissionLevel): boolean {
  return STRICTNESS[a] < STRICTNESS[b];
}

/** An own property only: a key that came from input never reaches an object's built-ins. */
function own<T>(
  record: Readonly<Record<string, T>> | undefined | null,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A matrix or a grant, as far as its `entities` go. */
export type EntitiesHolder = { readonly entities?: unknown; readonly [key: string]: unknown };

/** What the gate needs of a tool to find its entity. */
export interface EntityToolRef {
  id: string;
  verb: Verb;
  entity?: string | undefined;
  entityInput?: { field: string; values: Record<string, string> } | undefined;
}

/** A grant as this module reads it (core's GrantLimits): verb ceilings and entities. */
export interface EntityGrant {
  verbs?: { [V in Verb]?: PermissionLevel | undefined } | undefined;
  entities?: unknown;
}

/**
 * The entities stored on a matrix or a grant: `{}` when there are none (every entity takes the
 * verbs' levels); null when the key is there but doesn't read, which the gate treats as `off`.
 */
// DECISION: unreadable entities narrow to nothing rather than widen (as an unreadable grant row is
// read as every verb off, packages/agents registry/grants.ts). Every write goes through the
// validated routes, so this only guards against a hand-edited row.
export function readEntities(
  holder: { entities?: unknown } | null | undefined,
): EntityPermissions | null {
  const raw = holder?.entities;
  if (raw === undefined || raw === null) return {};
  const parsed = EntityPermissions.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The entity a call works on: the tool's own, or the one its input names. `undefined`: the tool
 * names none (the verb alone governs it); `null`: it reads the entity from its input and this input
 * doesn't name one it maps, so the call is `off`.
 */
export function entityOfCall(
  tool: Pick<EntityToolRef, "entity" | "entityInput">,
  input: unknown,
): string | null | undefined {
  if (tool.entity) return tool.entity;
  const from = tool.entityInput;
  if (!from) return undefined;
  if (!isPlainObject(input) || !Object.hasOwn(input, from.field)) return null;
  const value = input[from.field];
  return typeof value === "string" ? (own(from.values, value) ?? null) : null;
}

/** A declared entity by id. */
export function declaredEntity(
  declared: readonly PermissionEntity[] | undefined,
  entity: string,
): PermissionEntity | undefined {
  return declared?.find((e) => e.id === entity);
}

/** A declared scope of an entity for a verb, by id. */
export function declaredScope(
  declared: readonly PermissionEntity[] | undefined,
  entity: string,
  verb: Verb,
  scopeId: string,
): PermissionScope | undefined {
  return declaredEntity(declared, entity)?.scopes?.find((s) => s.id === scopeId && s.verb === verb);
}

/**
 * The tools a holder's scope lets through for an entity and verb: null when it sets no scope (every
 * tool); the scope's tools otherwise (none when the scope isn't one the connector declares).
 */
function scopeTools(
  entities: EntityPermissions,
  entity: string,
  verb: Verb,
  declared: readonly PermissionEntity[] | undefined,
): readonly string[] | null {
  const scopeId = own(entities, entity)?.scope?.[verb];
  if (scopeId === undefined) return null;
  return declaredScope(declared, entity, verb, scopeId)?.tools ?? [];
}

/**
 * What one holder (a connection's matrix or a grant) adds for an entity and verb beyond its verb
 * level: its entity level, and `off` when its scope leaves the tool out. `auto` = no narrowing.
 */
function holderCeiling(
  entities: EntityPermissions | null,
  entity: string,
  verb: Verb,
  toolId: string,
  declared: readonly PermissionEntity[] | undefined,
): PermissionLevel {
  if (entities === null) return "off";
  const level = own(entities, entity)?.[verb] ?? "auto";
  const tools = scopeTools(entities, entity, verb, declared);
  return tools === null || tools.includes(toolId) ? level : "off";
}

export interface EntityCall {
  tool: EntityToolRef;
  /** The call's input, for a tool that reads its entity from it. */
  input?: unknown;
  /** The connector's `permissionEntities`, for scopes. */
  declared?: readonly PermissionEntity[] | undefined;
}

export interface EffectiveLevelInput extends EntityCall {
  matrix: Partial<PermissionMatrix> | undefined;
  /** The agent's grant on the connection; null or absent = no narrowing. */
  grant?: EntityGrant | null | undefined;
}

/**
 * The part of a call's level that comes from entities: the connection's entity and scope, then the
 * grant's. `auto` when the tool names no entity or nothing narrows it. Delete is off for every
 * entity.
 */
export function entityCeiling(input: EffectiveLevelInput): PermissionLevel {
  const entity = entityOfCall(input.tool, input.input);
  if (entity === undefined) return "auto";
  if (entity === null || input.tool.verb === "delete") return "off";
  const { verb, id } = input.tool;
  const connection = holderCeiling(readEntities(input.matrix), entity, verb, id, input.declared);
  const grant = input.grant
    ? holderCeiling(readEntities(input.grant), entity, verb, id, input.declared)
    : "auto";
  return stricter(connection, grant);
}

/**
 * A call's level through a connection (docs/plan.md §1.44 `effectiveLevel`): the strictest of the
 * connection's verb, the connection's entity and scope, the grant's verb and the grant's entity and
 * scope. The step, the mode and stage, and a person's autonomy come after, in decideToolCall.
 */
export function effectiveLevel(input: EffectiveLevelInput): PermissionLevel {
  const verb = input.tool.verb;
  const matrixLevel = input.matrix?.[verb] ?? DEFAULT_PERMISSIONS[verb];
  const grantLevel = input.grant?.verbs?.[verb] ?? "auto";
  return stricter(stricter(matrixLevel, grantLevel), entityCeiling(input));
}

/**
 * Which setting of one holder asks for approval on an entity: the entity's own level for the verb
 * (not its scope, which only allows or refuses). For the explanation of a wait (explain.ts).
 */
export function entityAsksApproval(
  holder: { entities?: unknown } | null | undefined,
  entity: string | null | undefined,
  verb: Verb,
): boolean {
  if (!entity) return false;
  return own(readEntities(holder), entity)?.[verb] === "approval";
}

// ── Editing: checks over a whole `entities` value ──────────────────────────────────────────────

/**
 * Problems with entities set on a matrix or a grant, against what the connector declares: each
 * entity one of its own, each level for one of the entity's verbs, each scope one it declares for
 * that entity and verb, and delete never anything but off.
 */
export function entityProblems(
  entities: EntityPermissions | undefined,
  declared: readonly PermissionEntity[] | undefined,
): string[] {
  const problems: string[] = [];
  for (const [id, levels] of Object.entries(entities ?? {})) {
    const e = declaredEntity(declared, id);
    if (!e) {
      problems.push(`${id} is not one of this connector's record types`);
      continue;
    }
    if (levels.delete !== undefined && levels.delete !== "off") {
      problems.push(`${e.label}: delete stays off`);
    }
    for (const verb of VERBS) {
      if (verb !== "delete" && levels[verb] !== undefined && !e.verbs.includes(verb)) {
        problems.push(`${e.label} has no ${verb}`);
      }
      const scopeId = levels.scope?.[verb];
      if (scopeId !== undefined && !declaredScope(declared, id, verb, scopeId)) {
        problems.push(`${e.label} has no scope ${scopeId} for ${verb}`);
      }
    }
  }
  return problems;
}

/**
 * Where a change to `entities` loosens (client roles may only tighten): an entity's own level for
 * a verb (its entry, else the verb's level) made looser, or a scope that lets a tool through that
 * was left out before. Each as `entity.verb`, or `entity.verb scope`.
 */
export function loosenedEntities(
  before: EntitiesHolder | null | undefined,
  after: EntitiesHolder,
  /** The holder's own verb level (a matrix's, with defaults; a grant's, `auto` when unset). */
  verbLevel: (holder: EntitiesHolder | null | undefined, verb: Verb) => PermissionLevel,
  declared: readonly PermissionEntity[] | undefined,
): string[] {
  const b = readEntities(before);
  const a = readEntities(after) ?? {};
  const ids = new Set([...Object.keys(b ?? {}), ...Object.keys(a)]);
  const out: string[] = [];
  for (const id of [...ids].sort()) {
    for (const verb of VERBS) {
      // An unreadable `before` was `off` for every entity: anything after is no stricter.
      const was: PermissionLevel =
        b === null ? "off" : (own(b, id)?.[verb] ?? verbLevel(before, verb));
      const now = own(a, id)?.[verb] ?? verbLevel(after, verb);
      if (looser(now, was)) out.push(`${id}.${verb}`);
      if (b === null) continue;
      const toolsBefore = scopeTools(b, id, verb, declared);
      const toolsAfter = scopeTools(a, id, verb, declared);
      const widened =
        toolsBefore !== null &&
        (toolsAfter === null || toolsAfter.some((t) => !toolsBefore.includes(t)));
      if (widened) out.push(`${id}.${verb} scope`);
    }
  }
  return out;
}
