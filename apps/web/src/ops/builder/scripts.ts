// Wave 4 (docs/plan.md §1.86 "Scripts (wave 4)"): a client agent's palette offers its client's
// published scripts under the browser connector, each a read or a write step on
// `browser.script.read` / `browser.script.submit` with the script already named in its input. A
// write step starts with its approval on, as every write does (invariant 8).
import type { BrowserScriptTool } from "@countersign/core";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { BuilderData } from "./catalog";
import type { PaletteItem } from "./model";

/** The client's published scripts, for a client agent's builder; none for a template. */
export function useClientScriptTools(agent: {
  kind: string;
  tenantId?: string | null | undefined;
}): readonly BrowserScriptTool[] | undefined {
  const state = useApi(
    apiRoutes.opsClientBrowserScriptTools,
    agent.kind === "client" && agent.tenantId ? { params: { id: agent.tenantId } } : null,
  );
  return state.data?.tools;
}

/** The scripts as palette items: a read or a write on the script tool, its input preset. */
export function scriptPaletteItems(data: BuilderData): PaletteItem[] {
  return (data.scripts ?? []).flatMap((s): PaletteItem[] => {
    const tool = data.catalog.tools.find((t) => t.id === s.tool);
    if (!tool) return [];
    const reads = s.sideEffect === "none";
    return [
      {
        type: reads ? "read" : "write",
        key: `${reads ? "read" : "write"}:${s.tool}:${s.site}:${s.script}`,
        title: s.name,
        detail: `${reads ? "Reads" : "Sends a form on"} ${s.siteName} · recorded script`,
        tool,
        group: s.siteName,
        input: { site: s.site, script: s.script, inputs: {} },
      },
    ];
  });
}
