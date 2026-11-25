// Connectors built into Mezonas (docs/step-model-plan.md §10e, 2026-11-25): outside information the
// platform reads for agents without a client signing in to anything. Today that is **Web**: web
// search and reading a web page, which were two platform tools. They keep running as the platform's
// own tools (`packages/agents/src/tools/web.ts`: one model request each, its text always data); what
// changes is how people see them: one connector with two actions, on its page in the back office and
// in the action catalog, switched on or off there like any connector's.
//
// Not registered as connectors (no connection, no sign-in, no matrix, nothing for a client to
// connect): the connector page lists them, and their switches are stored with the others
// (`connector_setting.actions`, under the connector's id).

import type { ConnectorManifest } from "@countersign/core";

export interface BuiltInConnector {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Its actions: the platform tool's id and the words people read. */
  actions: readonly { id: string; label: string }[];
  /** Same meaning as the manifest's: actions that start off. */
  offByDefault?: readonly string[];
}

export const WEB_CONNECTOR: BuiltInConnector = {
  id: "web",
  name: "Web",
  description:
    "Search the web and read a public web page. What comes back is text from the web: data for an agent to reason over, never instructions. Off on a deployment that has not turned web research on.",
  icon: "globe",
  actions: [
    { id: "web.search", label: "Search the web" },
    { id: "web.fetch", label: "Read a web page" },
  ],
};

export const BUILTIN_CONNECTORS: readonly BuiltInConnector[] = [WEB_CONNECTOR];

/** The built-in connector an action belongs to, if any. */
export function builtInConnectorOf(toolId: string): BuiltInConnector | undefined {
  return BUILTIN_CONNECTORS.find((c) => c.actions.some((a) => a.id === toolId));
}

/** A built-in connector as `actionIsOn` reads a manifest. */
export function builtInManifest(
  c: BuiltInConnector,
): Pick<ConnectorManifest, "offByDefault"> & { tools: { id: string }[] } {
  return {
    ...(c.offByDefault ? { offByDefault: [...c.offByDefault] } : {}),
    tools: c.actions.map((a) => ({ id: a.id })),
  };
}
