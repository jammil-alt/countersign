// Grants (ARCHITECTURE §6.9, docs/plan.md §1.26): what one client agent may do through one bound
// connection. The binding is the grant; a grant's limits only narrow it, so no limits means no
// narrowing. What a call may do is the strictest of the connection's matrix, the grant, the step's
// approval and the agent's mode (CLAUDE.md invariant 13).

import { z } from "zod";
import {
  DEFAULT_PERMISSIONS,
  EntityPermissions,
  type PermissionEntity,
  PermissionLevel,
  type PermissionMatrix,
  type Verb,
} from "../schemas/permissions";
import { entityProblems, loosenedEntities, readEntities } from "./entities";

export const PERMISSION_VERBS: readonly Verb[] = ["read", "create", "update", "delete"];

/** A ceiling per verb; a verb left out is not narrowed. */
export const GrantVerbs = z.strictObject({
  read: PermissionLevel.optional(),
  create: PermissionLevel.optional(),
  update: PermissionLevel.optional(),
  delete: PermissionLevel.optional(),
});
export type GrantVerbs = z.infer<typeof GrantVerbs>;

/** At most this many tools in a grant's subset. */
export const GRANT_TOOLS_MAX = 200;

export const GrantLimits = z
  .strictObject({
    verbs: GrantVerbs.optional(),
    /** The connector's tools the agent may call; absent = all of them. */
    tools: z.array(z.string().min(1).max(200)).max(GRANT_TOOLS_MAX).optional(),
    // v0.12 W2-A: the same `entities` as a matrix (ARCHITECTURE §6.1): a ceiling per entity and
    // verb, and scopes. An entity left out is not narrowed beyond the grant's verbs.
    entities: EntityPermissions.optional(),
  })
  .meta({ id: "GrantLimits" });
export type GrantLimits = z.infer<typeof GrantLimits>;

/** A revoked grant: every verb off. */
export const REVOKED_GRANT: GrantLimits = {
  verbs: { read: "off", create: "off", update: "off", delete: "off" },
};

const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

/** The stricter of two levels. */
export function stricterLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** Whether `a` lets through more than `b`. */
export function isLooserLevel(a: PermissionLevel, b: PermissionLevel): boolean {
  return STRICTNESS[a] < STRICTNESS[b];
}

/** The level a grant sets for a verb; `auto` (no narrowing) when it sets none. */
export function grantLevel(grant: GrantLimits | null | undefined, verb: Verb): PermissionLevel {
  return grant?.verbs?.[verb] ?? "auto";
}

/**
 * The matrix an agent gets on a connection: per verb the stricter of the connection's matrix and
 * the grant. The matrix's `scope` passes through.
 */
export function effectiveMatrix(
  matrix: Partial<PermissionMatrix> | undefined,
  grant: GrantLimits | null | undefined,
): PermissionMatrix {
  const out: PermissionMatrix = { ...DEFAULT_PERMISSIONS, ...(matrix ?? {}) };
  for (const verb of PERMISSION_VERBS) {
    out[verb] = stricterLevel(matrix?.[verb] ?? DEFAULT_PERMISSIONS[verb], grantLevel(grant, verb));
  }
  return out;
}

/** Whether the grant lets the agent call this tool (no subset = every tool of the connector). */
export function grantAllowsTool(grant: GrantLimits | null | undefined, toolId: string): boolean {
  return !grant?.tools || grant.tools.includes(toolId);
}

/** Whether every verb is off: the agent can do nothing through the connection. */
export function isRevoked(grant: GrantLimits | null | undefined): boolean {
  return (
    PERMISSION_VERBS.every((v) => grantLevel(grant, v) === "off") || grant?.tools?.length === 0
  );
}

/**
 * What a change would loosen: verbs whose ceiling it raises (a verb left out is `auto`), and
 * whether it widens the tool subset (dropping it, or adding a tool). Client roles may only tighten.
 */
export function grantLoosening(
  before: GrantLimits | null | undefined,
  after: GrantLimits,
  // v0.12 W2-A: the connector's entities, to judge a scope change.
  declared?: readonly PermissionEntity[] | undefined,
): { verbs: Verb[]; tools: boolean; entities: string[] } {
  const verbs = PERMISSION_VERBS.filter((v) =>
    isLooserLevel(grantLevel(after, v), grantLevel(before, v)),
  );
  const was = before?.tools;
  const tools =
    was === undefined
      ? false
      : after.tools === undefined || after.tools.some((t) => !was.includes(t));
  // v0.12 W2-A: an entity's own ceiling (its entry, else the grant's verb) made looser, or a
  // scope widened.
  const entities = loosenedEntities(
    before,
    after,
    (g, v) => grantLevel(g as GrantLimits | null | undefined, v),
    declared,
  );
  return { verbs, tools, entities };
}

/**
 * Problems with grant limits the operator sets on a connection: no verb above the connection's
 * matrix (a grant only narrows), and tools only from the connector's own. v0.12 W2-A: entities
 * the connector declares, each no looser than the connection's own level for that entity.
 */
export function grantProblems(
  limits: GrantLimits,
  matrix: Partial<PermissionMatrix> | undefined,
  connectorTools: readonly string[],
  declared?: readonly PermissionEntity[] | undefined,
): string[] {
  const problems: string[] = [];
  for (const verb of PERMISSION_VERBS) {
    const level = limits.verbs?.[verb];
    const ceiling = matrix?.[verb] ?? DEFAULT_PERMISSIONS[verb];
    if (level && isLooserLevel(level, ceiling)) {
      problems.push(`${verb} can't be ${level}: the connection allows ${ceiling} at most`);
    }
  }
  // v0.12 W2-A
  problems.push(...entityProblems(limits.entities, declared));
  const own = readEntities(matrix) ?? {};
  for (const [id, levels] of Object.entries(limits.entities ?? {})) {
    const conn = Object.hasOwn(own, id) ? own[id] : undefined;
    for (const verb of PERMISSION_VERBS) {
      const level = levels[verb];
      const ceiling = conn?.[verb] ?? matrix?.[verb] ?? DEFAULT_PERMISSIONS[verb];
      if (level && isLooserLevel(level, ceiling)) {
        problems.push(`${id} ${verb} can't be ${level}: the connection allows ${ceiling} at most`);
      }
    }
  }
  for (const tool of limits.tools ?? []) {
    if (!connectorTools.includes(tool))
      problems.push(`${tool} is not one of the connector's tools`);
  }
  if (limits.tools && new Set(limits.tools).size !== limits.tools.length) {
    problems.push("tools must be unique");
  }
  return problems;
}

/** Limits with nothing narrowed are stored as `{}`; verbs and tools are kept as given otherwise. */
export function normalizeGrant(limits: GrantLimits): GrantLimits {
  const verbs = Object.fromEntries(
    PERMISSION_VERBS.filter((v) => limits.verbs?.[v] !== undefined).map((v) => [
      v,
      limits.verbs?.[v],
    ]),
  ) as GrantVerbs;
  return {
    ...(Object.keys(verbs).length ? { verbs } : {}),
    ...(limits.tools ? { tools: [...limits.tools] } : {}),
    // v0.12 W2-A: entities are kept as given, left out when there are none.
    ...(limits.entities && Object.keys(limits.entities).length > 0
      ? { entities: JSON.parse(JSON.stringify(limits.entities)) as EntityPermissions }
      : {}),
  };
}

/**
 * The connector a binding key belongs to: the key itself, or what precedes `:` (a browser site's
 * `browser:<site slug>`, from a connector's `bindingKey` hook).
 */
export function bindingConnector(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}
