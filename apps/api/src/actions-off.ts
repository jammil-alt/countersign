// Which actions are switched off on their connector's page (docs/step-model-plan.md §10c): read for
// the Uses picker (`routes/ops-lineage.ts`) and for the step model's publish checks
// (`RegistryContext.actionsOff`), so an action the gate would refuse is a publish issue too.

import {
  actionsOff,
  BUILTIN_CONNECTORS,
  builtInManifest,
  type ConnectorRegistry,
} from "@countersign/connectors";
import { connectorSetting, type Tx } from "@countersign/db";

/**
 * The actions (tool ids) switched off on their connector's page, or waiting there to be turned on:
 * every registered connector's and the built-in ones' (Web).
 */
export async function offActionIds(
  tx: Tx,
  platform: { connectors: Pick<ConnectorRegistry, "list"> },
): Promise<Set<string>> {
  const settings = await tx.select().from(connectorSetting);
  const byConnector = new Map(settings.map((r) => [r.connector, r.actions]));
  const off = new Set<string>();
  for (const c of platform.connectors.list()) {
    for (const id of actionsOff(c.manifest, byConnector.get(c.manifest.id))) off.add(id);
  }
  for (const b of BUILTIN_CONNECTORS) {
    for (const id of actionsOff(builtInManifest(b), byConnector.get(b.id))) off.add(id);
  }
  return off;
}
