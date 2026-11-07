// `/commands` (ARCHITECTURE §11.2, §10.8; docs/plan.md §1.38): what `/word` in a message points at.
// In a client thread it names one of the client's active agents by its command name (computed on
// read: the first word of its identity name, else its slug); in the back office, on an agent's
// thread, `/skill` names one of that agent's skills. This module only resolves: starting runs from
// the posted command is the message trigger's (W2-E).

import {
  type CommandCandidate,
  type ParsedCommand,
  type PostedCommand,
  parseSkillRef,
  resolveAgentCommand,
  resolveSkillCommand,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { and, eq, isNotNull } from "drizzle-orm";

/** The client's agents a command may name: active client agents with a live version. */
// DECISION: "active" is `run_status = 'active'` (not test copies): a paused or retired agent answers
// to no command, and its name is free for another agent's.
export async function commandCandidates(tx: Tx, tenantId: string): Promise<CommandCandidate[]> {
  const rows = await tx
    .select({ agentId: agent.id, slug: agent.slug, bundle: agentVersion.bundle })
    .from(agent)
    .innerJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
    )
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        eq(agent.runStatus, "active"),
        isNotNull(agent.liveVersionId),
      ),
    );
  return rows.map((r) => ({
    agentId: r.agentId,
    slug: r.slug,
    identityName: r.bundle.definition.identity.name,
  }));
}

/** The skills of an agent's live version (else its newest version), for `/skill` on its thread. */
async function agentSkillIds(tx: Tx, tenantId: string, agentId: string): Promise<string[]> {
  const [a] = await tx
    .select({ liveVersionId: agent.liveVersionId })
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
  if (!a?.liveVersionId) return [];
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, a.liveVersionId), eq(agentVersion.tenantId, tenantId)));
  return (v?.bundle.definition.skills ?? []).map((s) => parseSkillRef(s.skill).id);
}

export type CommandTarget =
  | { kind: "agent"; command: PostedCommand }
  | { kind: "skill"; command: PostedCommand }
  | { kind: "unknown"; name: string };

/**
 * What a parsed `/word` points at. An operator on an agent's thread names that agent's skill
 * first; everyone else, and anything that is no skill, names an agent of the client.
 */
export async function resolveCommand(
  tx: Tx,
  input: {
    tenantId: string;
    thread: { subjectType: string | null; subjectId: string | null };
    parsed: ParsedCommand;
    operator: boolean;
  },
): Promise<CommandTarget> {
  const { tenantId, thread, parsed } = input;
  if (input.operator && thread.subjectType === "agent" && thread.subjectId) {
    const skill = resolveSkillCommand(
      parsed.name,
      await agentSkillIds(tx, tenantId, thread.subjectId),
    );
    if (skill) {
      return { kind: "skill", command: { name: parsed.name, agentId: thread.subjectId, skill } };
    }
  }
  const target = resolveAgentCommand(parsed.name, await commandCandidates(tx, tenantId));
  if (!target) return { kind: "unknown", name: parsed.name };
  return { kind: "agent", command: { name: parsed.name, agentId: target.agentId } };
}
