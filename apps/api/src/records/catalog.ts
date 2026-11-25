// The record actions a builder's Uses picker offers (docs/step-model-plan.md §10f): each record
// type's Find, Get by id, Create and Update, typed with the client's custom fields so they are
// picked, wired and translated like built-in fields; a template's with the shared fields only.

import {
  type AgentData,
  type AgentBundle,
  accessFor,
  effectiveRecordGrants,
  recordActionSpecs,
  type ToolSpec,
  visibleCustomFields,
} from "@countersign/core";
import { narrowToTenant, type Tx } from "@countersign/db";
import { customFieldsFor, sharedCustomFields } from "./fields";
import type { RecordCatalog } from "./registry";

/**
 * The record actions offered to an agent: only those its version's grants and data sets allow
 * (§10f: data sets "are what the builder's pickers offer").
 */
// DECISION: offered as granted, not all with a warning: a step using an action outside the grant
// would only be refused at run time, so the picker shows what the agent can run and the agent's
// Data section is where more is granted.
export async function recordActionsFor(
  tx: Tx,
  catalog: RecordCatalog,
  tenantId: string | null,
  bundle: AgentBundle | null | undefined,
): Promise<ToolSpec[]> {
  const data = (bundle?.definition as { data?: AgentData } | undefined)?.data;
  const granted = effectiveRecordGrants(data);
  if (granted.size === 0) return [];
  const defs = tenantId
    ? await narrowToTenant(tx, tenantId, (one) => customFieldsFor(one, tenantId))
    : await sharedCustomFields(tx);
  const out: ToolSpec[] = [];
  for (const type of catalog.types) {
    const access = granted.get(type.id);
    if (!access) continue;
    for (const spec of recordActionSpecs(type, visibleCustomFields(defs, type.id))) {
      const action = spec.record?.action;
      if (action && access[accessFor(action)]) out.push(spec);
    }
  }
  return out;
}
