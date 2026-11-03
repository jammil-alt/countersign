import {
  type ConnectorManifest,
  DEFAULT_PERMISSIONS,
  deepEqual,
  levelFor,
  loosenedVerbs,
  type PermissionLevel,
  PermissionMatrix,
  type SideEffect,
  type Verb,
} from "@countersign/core";

export const VERBS: readonly Verb[] = ["read", "create", "update", "delete"];

const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

/** The stricter of two levels: `off` beats `approval` beats `auto`. */
export function stricter(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** A complete matrix: missing verbs take the platform defaults; scope is kept as given. */
export function normalizeMatrix(matrix: Partial<PermissionMatrix> | undefined): PermissionMatrix {
  const out: PermissionMatrix = {
    read: levelFor(matrix, "read"),
    create: levelFor(matrix, "create"),
    update: levelFor(matrix, "update"),
    delete: levelFor(matrix, "delete"),
  };
  if (matrix?.scope !== undefined) out.scope = matrix.scope;
  return PermissionMatrix.parse(out);
}

/**
 * Problems with a connector's declared starting matrix. A manifest may start a connection stricter
 * than the platform defaults, never looser: approval is on by default (invariant 8) and delete is
 * off.
 */
export function manifestDefaultProblems(manifest: Pick<ConnectorManifest, "defaultPermissions">) {
  if (!manifest.defaultPermissions) return [];
  return loosenedVerbs(DEFAULT_PERMISSIONS, manifest.defaultPermissions).map(
    (v) =>
      `defaultPermissions.${v} is ${levelFor(manifest.defaultPermissions, v)}, looser than the platform default ${DEFAULT_PERMISSIONS[v]}`,
  );
}

/** The matrix a new connection starts with: the connector's defaults, else the platform's. */
export function connectionDefaults(
  manifest?: Pick<ConnectorManifest, "defaultPermissions">,
): PermissionMatrix {
  const problems = manifest ? manifestDefaultProblems(manifest) : [];
  if (problems.length > 0) throw new Error(problems.join("; "));
  return normalizeMatrix(manifest?.defaultPermissions ?? DEFAULT_PERMISSIONS);
}

/** Who is changing the matrix. Operators set it; client admins may only tighten it. */
export type MatrixEditor = "operator" | "client";

export type MatrixChangeRefusal =
  | { reason: "loosening"; verbs: Verb[]; message: string }
  | { reason: "scope"; message: string }
  | { reason: "delete_not_off"; message: string };

export type MatrixChangeResult =
  | {
      ok: true;
      matrix: PermissionMatrix;
      /** False when nothing changed: callers skip writing a `connection_change` row. */
      changed: boolean;
      /** What to store in `connection_change.change`. */
      change: MatrixChange;
    }
  | ({ ok: false } & MatrixChangeRefusal);

export interface MatrixChange {
  kind: "permissions";
  by: MatrixEditor;
  before: PermissionMatrix;
  after: PermissionMatrix;
  loosened: Verb[];
  tightened: Verb[];
}

/**
 * Applies an edit to a connection's matrix (plan §1.2 "Permission matrix"). Verbs missing from
 * `proposed` keep their current level, so a client can send just `{ update: 'off' }`.
 *
 * - Client edits are tighten-only: any verb made looser refuses the whole change.
 * - `scope` is the connector's business and passed through untouched: the operator may set it;
 *   a client edit that changes it is refused, because the platform can't tell whether a
 *   connector-specific scope got narrower.
 * - `delete` stays `off` for everyone in v1 (invariant 8: delete is off; v1 has no delete tools).
 */
// DECISION: clients cannot edit scope (the platform can't judge "narrower" for an opaque scope);
// they tighten per verb. Operators set scope.
// DECISION: delete is pinned to `off` for every editor in v1, not just by default.
export function applyMatrixChange(input: {
  current: Partial<PermissionMatrix> | undefined;
  proposed: Partial<PermissionMatrix>;
  by: MatrixEditor;
}): MatrixChangeResult {
  const before = normalizeMatrix(input.current);
  const merged: Partial<PermissionMatrix> = { ...before };
  for (const v of VERBS) {
    const level = input.proposed[v];
    if (level !== undefined) merged[v] = level;
  }
  if (Object.hasOwn(input.proposed, "scope")) {
    if (input.proposed.scope === undefined) delete merged.scope;
    else merged.scope = input.proposed.scope;
  }
  const after = normalizeMatrix(merged);

  if (after.delete !== "off") {
    return { ok: false, reason: "delete_not_off", message: "delete stays off in v1" };
  }
  const loosened = loosenedVerbs(before, after);
  const tightened = VERBS.filter((v) => STRICTNESS[after[v]] > STRICTNESS[before[v]]);
  if (input.by === "client") {
    if (loosened.length > 0) {
      return {
        ok: false,
        reason: "loosening",
        verbs: loosened,
        message: `clients can only tighten permissions; ${loosened.join(", ")} would be loosened`,
      };
    }
    if (!deepEqual(before.scope, after.scope)) {
      return { ok: false, reason: "scope", message: "only the operator can change a scope" };
    }
  }
  const changed = loosened.length > 0 || tightened.length > 0 || !deepEqual(before, after);
  return {
    ok: true,
    matrix: after,
    changed,
    change: { kind: "permissions", by: input.by, before, after, loosened, tightened },
  };
}

/**
 * Tightens `current` towards `limit`, per verb, never loosening: the result is the stricter of the
 * two for every verb. Scope is the current one.
 */
export function tightenMatrix(
  current: Partial<PermissionMatrix> | undefined,
  limit: Partial<PermissionMatrix>,
): PermissionMatrix {
  const base = normalizeMatrix(current);
  const out: PermissionMatrix = { ...base };
  for (const v of VERBS) out[v] = stricter(base[v], levelFor(limit, v));
  return out;
}

export interface ToolAccess {
  toolId: string;
  description: string;
  verb: Verb;
  sideEffect: SideEffect;
  level: PermissionLevel;
  /**
   * For the Connections page: reads run; writes ask first, and on `auto` a step may be set to run
   * without asking; `off` is not allowed.
   */
  access: "runs" | "asks_first" | "steps_may_skip_approval" | "not_allowed";
}

/**
 * What a connection lets agents do, tool by tool (the portal's and back office's Connections
 * screens). `auto` on a write is a ceiling, not a promise: every step still asks unless the
 * operator set it to skip approval.
 */
export function describeAccess(
  manifest: Pick<ConnectorManifest, "tools">,
  matrix: Partial<PermissionMatrix> | undefined,
): ToolAccess[] {
  return manifest.tools.map((t) => {
    const level = levelFor(matrix, t.verb);
    const access: ToolAccess["access"] =
      level === "off"
        ? "not_allowed"
        : t.sideEffect !== "external" || t.verb === "read"
          ? "runs"
          : level === "auto"
            ? "steps_may_skip_approval"
            : "asks_first";
    return {
      toolId: t.id,
      description: t.description,
      verb: t.verb,
      sideEffect: t.sideEffect,
      level,
      access,
    };
  });
}
