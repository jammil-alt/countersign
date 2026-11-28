// The step model (docs/step-model-plan.md §10c; stream A's wiring of stream E): which connector a
// merged action runs on for one agent. Its connectors are tried in the merge's order (the catalog's,
// `steps.MERGED_CONNECTORS`), among those the agent's pinned version is bound to, skipping any whose
// action the operator switched off (`connector_setting.actions`), so an off action never reaches the
// gate and another bound connector of the merge still runs. Never guessed: with none left the call is
// refused in plain words (off, or not connected), and nothing is written.

import { processes, steps } from "@countersign/core";
import type { ResolvedAction } from "@countersign/workflows";

/** Whether the operator has a connector's action on for agents. */
export type ActionOn = (connector: string, tool: string) => Promise<boolean>;

/** A merged action (Team chat, Spreadsheets), from the agent's bound connectors with it on. */
export async function pickMerged(
  action: string,
  bound: readonly string[],
  on: ActionOn,
  name: (connector: string) => string,
): Promise<ResolvedAction> {
  const merged = steps.mergedAction(action);
  if (!merged) return { refused: `${action} isn't a merged action` };
  const off: string[] = [];
  for (const [connector, tool] of Object.entries(merged.tools)) {
    if (!bound.includes(connector)) continue;
    if (await on(connector, tool)) return { tool, connector };
    off.push(name(connector));
  }
  return {
    refused:
      off.length > 0
        ? `${merged.label} is switched off for ${off.join(" and ")}`
        : `${merged.label}: no connection of it is set up for this agent`,
  };
}

/**
 * An accounting action's candidates: the agent's bound connectors, less those whose tool for it
 * is switched off (`off`, by connector).
 */
export async function boundWithActionOn(
  action: processes.WriteAction,
  bound: readonly string[],
  on: ActionOn,
): Promise<{ bound: string[]; off: string[] }> {
  const out = { bound: [] as string[], off: [] as string[] };
  for (const connector of bound) {
    const tool = processes.actionTool(action, connector);
    if (tool && !(await on(connector, tool))) out.off.push(connector);
    else out.bound.push(connector);
  }
  return out;
}

/**
 * A message action whose channel's tool is switched off: another of its connectors the agent is
 * bound to, with the action on, sends instead (Gmail when Resend's send is off). Null: none.
 */
export async function channelFallback(
  action: processes.WriteAction,
  channel: string,
  bound: readonly string[],
  on: ActionOn,
): Promise<{ tool: string; connector: string } | null> {
  for (const connector of bound) {
    if (connector === channel) continue;
    const tool = processes.actionTool(action, connector);
    if (tool && (await on(connector, tool))) return { tool, connector };
  }
  return null;
}
