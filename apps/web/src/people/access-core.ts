// The small, always-loaded part of a person's access (docs/plan.md §1.122): the choice's shape,
// the "Works on …" line each row shows, and whether a choice can be saved. The editor itself
// (./Access.tsx) is loaded when it is first opened (./AccessLazy.tsx), so the web app's first load
// stays inside its budget (scripts/web-size.mjs).
import type { AssignableAgent, InvitableRole, MemberAgents } from "@countersign/core";
import type { useI18n } from "../i18n/i18n";

export interface AccessChoice {
  role: InvitableRole;
  canSign: boolean;
  /** Null: every agent. */
  agentIds: MemberAgents;
}

/** "Works on every agent", "Works on Invoices, Collections", or "Works on no agents yet". */
export function agentsLine(
  agentIds: readonly string[] | null | undefined,
  agents: readonly AssignableAgent[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (agentIds === null || agentIds === undefined) return t("access.seesAll");
  const names = agentIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter((n): n is string => !!n);
  return names.length > 0 ? t("access.sees", { agents: names.join(", ") }) : t("access.seesNone");
}

/** Whether a choice can be saved: "only some agents" needs at least one. */
export function accessReady(value: AccessChoice): boolean {
  return value.role === "client_admin" || value.agentIds === null || value.agentIds.length > 0;
}
