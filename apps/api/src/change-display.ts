// How an external action reads on its card ("now / after this change"; core ChangeDisplayView): the
// connector's name as people know it and the tool's display spec, looked up in the registry when a
// response is built, so the inbox and run views of both surfaces read every item the same way,
// including items proposed before their tool declared a display.
import { type ChangeDisplayView, isPlainObject } from "@countersign/core";
import type { Platform } from "./platform";

type Registries = Pick<Platform, "tools" | "connectors">;

/** The view for a write tool, or null when its connector is not registered. */
export function changeDisplay(platform: Registries, toolId: unknown): ChangeDisplayView | null {
  if (typeof toolId !== "string") return null;
  const tool = platform.tools.get(toolId);
  const connectorId = tool?.spec.connector ?? toolId.split(".")[0] ?? toolId;
  const manifest = platform.connectors.get(connectorId)?.manifest;
  if (!manifest) return null;
  return { connectorName: manifest.name, tool: tool?.spec.display ?? null };
}

interface ItemLike {
  kind: string;
  title: string;
  payload: unknown;
}

/** An inbox item's view: external actions only. */
export function itemDisplay(platform: Registries, item: ItemLike): ChangeDisplayView | null {
  if (item.kind !== "external_action" || !isPlainObject(item.payload)) return null;
  return changeDisplay(platform, item.payload.tool);
}

/**
 * An external action's title without the tool id that titles carried until the tools described
 * themselves ("Itemize a QuickBooks bill… (qbo.bill.update_lines)"): tool ids are not for clients.
 */
export function plainTitle(item: ItemLike): string {
  const tool = isPlainObject(item.payload) ? item.payload.tool : undefined;
  if (item.kind !== "external_action" || typeof tool !== "string") return item.title;
  const suffix = ` (${tool})`;
  return item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title;
}
