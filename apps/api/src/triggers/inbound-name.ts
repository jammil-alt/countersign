// The name an operator gives the first part of a Sandbox agent's address (Sandbox inbound,
// 2026-11-27): `ap-inbox.<client>-<id>@…` in place of the name read from the agent's name. Kept in
// `agent.stage_state.inbound` (operational, never in a version; no new column), read by
// `commandCandidates` and so by every address and `/command` (packages/core `agentCommandNames`).
// A name another of the client's agents has, or would have once it is on again, is refused, and so
// is one that would move another agent's address or command: an address in use never changes.

import { type AgentRow, getAgent } from "@countersign/agents";
import {
  type AgentAddressAnswer,
  agentCommandNames,
  type CommandCandidate,
  readInboundName,
} from "@countersign/core";
import { agent, agentChange, type Tx } from "@countersign/db";
import { commandCandidates } from "@countersign/threads";
import { and, eq, ne, sql } from "drizzle-orm";
import { HttpError } from "../http";
import { agentAddresses } from "./list";

/** Refuses `name` for the agent when it would clash, with 409 `name_taken` in plain words. */
async function refuseClash(tx: Tx, row: AgentRow & { tenantId: string }, name: string) {
  const taken = () =>
    new HttpError(409, "name_taken", `another of this client's agents answers to ${name}`);
  // Agents that aren't on now still keep their slug and any name they were given.
  const others = await tx
    .select({ slug: agent.slug, stageState: agent.stageState })
    .from(agent)
    .where(and(eq(agent.tenantId, row.tenantId), ne(agent.id, row.id)));
  if (others.some((o) => o.slug === name || readInboundName(o.stageState) === name)) throw taken();
  const candidates = await commandCandidates(tx, row.tenantId);
  const before = agentCommandNames(candidates);
  const self: CommandCandidate = candidates.find((c) => c.agentId === row.id) ?? {
    agentId: row.id,
    slug: row.slug,
    identityName: row.name,
  };
  const after = agentCommandNames([
    ...candidates.filter((c) => c.agentId !== row.id),
    { ...self, inboundName: name },
  ]);
  if (after.get(row.id) !== name) throw taken();
  for (const c of candidates) {
    if (c.agentId !== row.id && before.get(c.agentId) !== after.get(c.agentId)) {
      throw new HttpError(
        409,
        "name_taken",
        `${c.identityName} answers to ${before.get(c.agentId)} now: pick another name`,
      );
    }
  }
}

/** Sets (or, with null, clears) the agent's address name and logs the change. */
export async function setInboundName(
  tx: Tx,
  input: {
    agentId: string;
    name: string | null;
    actorId: string;
    domain: string | null | undefined;
    now: Date;
  },
): Promise<AgentAddressAnswer> {
  const row = await getAgent(tx, input.agentId);
  if (!row.tenantId) throw new HttpError(422, "not_a_client_agent", "not a client agent");
  const tenantId = row.tenantId;
  // One name change per client at a time, so two can't both take the same name.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inbound:${tenantId}`}, 0))`,
  );
  const was = readInboundName(row.stageState);
  if (input.name !== null && input.name !== was) {
    await refuseClash(tx, { ...row, tenantId }, input.name);
  }
  if (input.name !== was) {
    const value = input.name
      ? { name: input.name, by: input.actorId, at: input.now.toISOString() }
      : null;
    await tx
      .update(agent)
      .set({
        stageState: value
          ? sql`jsonb_set(coalesce(${agent.stageState}, '{}'::jsonb), '{inbound}', ${JSON.stringify(value)}::jsonb)`
          : sql`coalesce(${agent.stageState}, '{}'::jsonb) - 'inbound'`,
      })
      .where(and(eq(agent.id, row.id), eq(agent.tenantId, tenantId)));
    await tx.insert(agentChange).values({
      tenantId,
      agentId: row.id,
      actorId: input.actorId,
      change: {
        kind: "operational",
        before: { inboundName: was },
        after: { inboundName: input.name },
      },
    });
  }
  const names = agentCommandNames(await commandCandidates(tx, tenantId));
  const address = (await agentAddresses(tx, tenantId, input.domain, names)).get(row.id) ?? null;
  return { inboundName: input.name, commandName: names.get(row.id) ?? null, address };
}
