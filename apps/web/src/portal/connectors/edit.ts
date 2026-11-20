// Connectors C5 (docs/connectors-plan.md §3.2, §5.4): a click on a row of What agents can do, as the
// matrix edit `PUT /api/portal/connections/:id/access` takes. The page holds the rows, not the
// stored matrix, so the edit is built from the rows: each record type's level as shown, sent whole.
import type {
  AccessRowView,
  connectorAccessRoutes,
  PermissionLevel,
  Verb,
} from "@countersign/core";
import type { BodyOf } from "../../api/client";

export type MatrixEditInput = BodyOf<typeof connectorAccessRoutes.portalSetAccess>["permissions"];
type EntityLevels = NonNullable<MatrixEditInput["entities"]>[string];

/** What reading a group's rows says: one level when every row agrees, else null (mixed). */
export function groupLevel(rows: readonly AccessRowView[]): PermissionLevel | null {
  const levels = new Set(rows.map((r) => r.level));
  return levels.size === 1 ? ([...levels][0] as PermissionLevel) : null;
}

/** Every record type's levels and scopes, as the rows show them. */
function entitiesOf(rows: readonly AccessRowView[]): Record<string, EntityLevels> {
  const out: Record<string, EntityLevels> = {};
  for (const r of rows) {
    if (r.entity === null) continue;
    const own: EntityLevels = { ...(out[r.entity] ?? {}) };
    own[r.verb] = r.level;
    if (r.scope) own.scope = { ...(own.scope ?? {}), [r.verb]: r.scope.id };
    out[r.entity] = own;
  }
  return out;
}

const verbRow = (rows: readonly AccessRowView[], verb: Verb) =>
  rows.find((r) => r.entity === null && r.verb === verb);

/**
 * One row set to a level. A record type's row turned on while its verb is off for the whole
 * connection opens the verb too, with every other record type of that verb kept as shown (off),
 * as "Allow what an agent needs" does (core `allowNeeds`).
 */
// DECISION (C5): the edit sends the record types whole, rebuilt from the rows (their levels and
// scopes as shown): the portal's connector page carries rows, not the stored matrix
// (docs/plan.md §1.161).
export function rowEdit(
  rows: readonly AccessRowView[],
  row: Pick<AccessRowView, "verb" | "entity">,
  level: PermissionLevel,
): MatrixEditInput {
  const entities = entitiesOf(rows);
  const edit: MatrixEditInput = {};
  if (row.entity === null) {
    edit[row.verb] = level;
    for (const [id, own] of Object.entries(entities)) {
      const was = own[row.verb];
      if (was !== undefined && !(level === "approval" && was === "auto")) {
        entities[id] = { ...own, [row.verb]: level };
      }
    }
  } else {
    entities[row.entity] = { ...(entities[row.entity] ?? {}), [row.verb]: level };
    if (level !== "off" && verbRow(rows, row.verb)?.level === "off") edit[row.verb] = level;
  }
  if (Object.keys(entities).length > 0) edit.entities = entities;
  return edit;
}

/**
 * A group's control (Read: On or Off; Change: Ask me first or Off) set for every row of the group.
 * A row already On its own stays so when the group is set to Ask me first: only we propose On its
 * own, and the client's own "Ask me first" is no reason to lower one we set with them.
 */
export function groupEdit(
  rows: readonly AccessRowView[],
  group: readonly AccessRowView[],
  level: PermissionLevel,
): MatrixEditInput {
  const entities = entitiesOf(rows);
  const edit: MatrixEditInput = {};
  for (const r of group) {
    const keep = level === "approval" && r.level === "auto";
    const to = keep ? r.level : level;
    if (r.entity === null) edit[r.verb] = to;
    else entities[r.entity] = { ...(entities[r.entity] ?? {}), [r.verb]: to };
  }
  if (Object.keys(entities).length > 0) edit.entities = entities;
  return edit;
}
