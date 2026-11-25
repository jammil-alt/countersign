// Which tools the pickers offer as actions (docs/step-model-plan.md §10c, §10e): every registered
// tool except the ones the step model folded into another action, and the ones the operator turned
// off on a connector's page. What is left out of the catalog is also refused by the gate
// (`actionIsOn`, checked beside the connection's own matrix in the runtime and again where a connector's tool is invoked), so a step stored
// before an action was turned off stops at the call, never silently runs.
//
// Pure: callers pass the registered specs and the operator's switches.

import {
  type ActionSwitches,
  actionIsOn,
  builtInConnectorOf,
  builtInManifest,
} from "@countersign/connectors";
import type { ToolSpec } from "@countersign/core";
import type { ToolRegistry } from "./tools";

/**
 * Tools the new model no longer offers because another action does their job. They stay registered,
 * unchanged, for the v3 and v4 agents that still name them (invariant 3) until wave 4 deletes both
 * (docs/step-model-plan.md §12).
 */
// DECISION: a list here, not a flag on the tool's spec: the spec is stored and shown in the old
// model's pickers too, and the list is deleted with the tools.
export const SUPERSEDED_ACTIONS: ReadonlySet<string> = new Set([
  // One "Read a document": `docs.read` reads once, records the reading and checks its totals.
  "docs.extract",
  "docs.reading.record",
  "docs.totals.check",
  // The bill check is the rules of the Prepare bill skill.
  "docs.bill.check",
]);

/** The tools a picker may offer: nothing superseded, nothing the operator turned off. */
export function offeredSpecs<T extends Pick<ToolSpec, "id">>(
  specs: readonly T[],
  off: ReadonlySet<string> = new Set(),
): T[] {
  return specs.filter((s) => !SUPERSEDED_ACTIONS.has(s.id) && !off.has(s.id));
}

/**
 * What the action catalog is built from (`steps.buildActionCatalog`): every registered tool the
 * pickers may offer, grouped by whoever owns it. A connector's tool the operator turned off (or that
 * waits to be turned on) is left out; a built-in connector's (Web's) is put under its connector
 * (`source`), a copy made for the catalog only, so the platform's own tools keep running as they were.
 * `switches` is each connector's `connector_setting.actions`, by connector id.
 */
export function catalogSpecs(
  registry: ToolRegistry,
  switches: Readonly<Record<string, ActionSwitches>>,
): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const entry of registry.list()) {
    const spec = entry.spec;
    if (SUPERSEDED_ACTIONS.has(spec.id)) continue;
    if (entry.kind === "connector") {
      if (!actionIsOn(entry.connector.manifest, spec.id, switches[entry.connector.manifest.id])) {
        continue;
      }
      out.push(spec);
      continue;
    }
    const builtIn = builtInConnectorOf(spec.id);
    if (builtIn) {
      if (!actionIsOn(builtInManifest(builtIn), spec.id, switches[builtIn.id])) continue;
      out.push({ ...spec, source: builtIn.id });
      continue;
    }
    out.push(spec);
  }
  return out;
}
