// Which of a connector's actions are on for agents (docs/step-model-plan.md §10c; owner,
// 2026-11-25). The connector's page in the back office switches each action on or off. A new action
// a developer adds appears off (`offByDefault` in the manifest) and is turned on there; one the
// operator switched off is left out of the catalog and refused by the gate, even in a step stored
// while it was on. It narrows what a connection can do, never widens it: the client's own matrix
// and the step's approval still decide each call (invariant 8).
//
// Pure: the switches are `connector_setting.actions`, read by apps/api.

import type { ConnectorManifest } from "@countersign/core";

/** The operator's choices by action id; null or absent: nothing was ever switched. */
export type ActionSwitches = Readonly<Record<string, boolean>> | null | undefined;

/** Whether an action is on: the operator's choice, else on unless the manifest says it starts off. */
export function actionIsOn(
  manifest: Pick<ConnectorManifest, "offByDefault">,
  toolId: string,
  switches: ActionSwitches,
): boolean {
  const chosen = switches?.[toolId];
  if (chosen !== undefined) return chosen;
  return !(manifest.offByDefault ?? []).includes(toolId);
}

/** The ids of the manifest's tools that are off. */
export function actionsOff(
  manifest: Pick<ConnectorManifest, "offByDefault" | "tools">,
  switches: ActionSwitches,
): Set<string> {
  return new Set(
    manifest.tools.map((t) => t.id).filter((id) => !actionIsOn(manifest, id, switches)),
  );
}
