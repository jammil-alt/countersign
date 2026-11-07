// An agent's own view on its portal page (Review 1: "inside an agent we can build specific UI around
// reports or anything else we don't have out of the box"). The Overview tab opens with it, before
// what the agent is doing now and its latest work.
//
// A view is code in the web app, registered here and keyed by the agent's template (the slug the
// portal's service route names, `template`) or by a pack the client has enabled. When none is
// registered for an agent, its page shows the default: the reports of the client's packs
// (../packs/registry.ts), then the generic activity report. Nothing here reads a bundle, an
// instruction or a prompt (invariant 11); a view reads the portal's routes like any screen.
import type { ComponentType } from "react";
import { type PackReport, packReportsFor } from "../packs/registry";

export interface AgentViewProps {
  /** The agent's service id (the portal's `/agents/:id`). */
  agentId: string;
}

export interface AgentView {
  /** Which agents it is for: a template's slug, or a pack id (every agent of a client with it). */
  key: { template: string } | { pack: string };
  Component: ComponentType<AgentViewProps>;
}

// DECISION: views are registered in the web app (they are screens), keyed by template first and
// pack second; none are built yet, so every agent shows the default (pack reports, then activity).
export const AGENT_VIEWS: readonly AgentView[] = [];

/** What an agent's page needs to pick its view: the portal service route's own fields. */
export interface AgentViewKey {
  template?: string | null | undefined;
  packs: readonly string[];
}

/**
 * The agent's own views: those registered for its template, else those for its client's packs.
 * Empty means the default (pack reports, then the activity report).
 */
export function viewsFor(agent: AgentViewKey, registry: readonly AgentView[] = AGENT_VIEWS) {
  const byTemplate = registry.filter(
    (v) => "template" in v.key && agent.template != null && v.key.template === agent.template,
  );
  if (byTemplate.length > 0) return byTemplate;
  return registry.filter((v) => "pack" in v.key && agent.packs.includes(v.key.pack));
}

/** The default own view's pack reports: the registered reports of the client's packs. */
export function defaultReports(agent: AgentViewKey): PackReport[] {
  return packReportsFor(agent.packs);
}
