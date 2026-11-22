// Getting started's Your tools (docs/setup-plan.md §5; docs/plan.md §1.185, SU3): stream TOOLS.
import type { SetupLeft, ToolConfirmBody, ToolsChapterView } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notBuilt } from "./not-built";

export interface ToolsInput {
  tenantId: string;
  userId: string;
  /** The agents this person sees; null for every agent. */
  agents: readonly string[] | null;
  canEdit: boolean;
}

/** Each tool the agents being set up need, connected or not, with what they do there. */
export async function toolsChapter(_tx: Tx, _input: ToolsInput): Promise<ToolsChapterView> {
  return notBuilt("TOOLS");
}

/** Yes to the account, or to one first-look line. */
export async function confirmTool(
  _tx: Tx,
  _input: ToolsInput & { connector: string; body: ToolConfirmBody; name: string | null },
): Promise<void> {
  notBuilt("TOOLS");
}

/** Ask a colleague to connect a tool: just that card, on their Desk. */
export async function askToolOf(
  _tx: Tx,
  _input: ToolsInput & { connector: string; askUserId: string; name: string | null },
): Promise<void> {
  notBuilt("TOOLS");
}

/**
 * What tools still hold each agent (agent id → lines), for the overview. Until TOOLS is built the
 * overview reads its connect items from the setup checklist alone.
 */
export async function toolsLeft(
  _tx: Tx,
  _input: { tenantId: string; agentIds: readonly string[] },
): Promise<Map<string, SetupLeft[]> | null> {
  return null;
}
