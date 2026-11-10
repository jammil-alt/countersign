// An agent's people and channels (docs/plan.md §1.25): a client agent binds each role its version
// declares (`people` in the bundle) to contacts of its client, with conditions, and binds its
// channels (email, sms, whatsapp, voice) each to a connection of its client. Both are operational
// data on the agent row, like connection bindings: never in a version, so forks and promotions
// never carry anyone's details (invariant 11). Every change goes to `agent_change` with who made it.
// The operator and the client admin both bind people; only the operator binds channels.

import {
  type ChannelBindings,
  channelTool,
  connectorChannels,
  type PeopleBindings,
  type PersonRole,
  PLANNED_CHANNEL_CONNECTORS,
  type ReachChannel,
} from "@countersign/core";
import { agent, agentChange, agentVersion, connection, contact, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { AgentRow } from "./agents";

async function lockClientAgent(tx: Tx, agentId: string, tenantId?: string): Promise<AgentRow> {
  const [row] = await tx.select().from(agent).where(eq(agent.id, agentId)).for("update");
  if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) {
    throw notFound(`agent ${agentId}`);
  }
  if (row.kind !== "client" || !row.tenantId) {
    throw new AgentsError("not_a_client_agent", "only client agents have people and channels");
  }
  return row;
}

/** The roles of the agent's live version, else its latest (what the People section edits). */
export async function agentRoles(tx: Tx, row: AgentRow): Promise<PersonRole[]> {
  const versionId = row.liveVersionId;
  if (versionId) {
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.id, versionId));
    return v?.bundle.people ?? [];
  }
  const [latest] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(eq(agentVersion.agentId, row.id))
    .orderBy(desc(agentVersion.version))
    .limit(1);
  return latest?.bundle.people ?? [];
}

/** Required roles of `roles` with nobody bound in `people`. */
export function missingRoles(roles: readonly PersonRole[], people: PeopleBindings): string[] {
  return roles
    .filter((r) => r.required && !(people[r.role]?.contactIds.length ?? 0))
    .map((r) => r.role);
}

/**
 * Binds people to the agent's roles. Every role must be one the agent declares and every contact
 * one of its client's. Consent and opt-outs stay on the contact: binding never grants either.
 */
export async function setPeople(
  tx: Tx,
  input: {
    agentId: string;
    /** The portal's client, so a client admin can only reach its own agents. */
    tenantId?: string;
    actorId: string | null;
    by: "operator" | "client";
    people: PeopleBindings;
  },
): Promise<AgentRow> {
  const row = await lockClientAgent(tx, input.agentId, input.tenantId);
  const roles = new Set((await agentRoles(tx, row)).map((r) => r.role));
  const unknown = Object.keys(input.people).filter((r) => !roles.has(r));
  if (unknown.length) {
    throw new AgentsError(
      "invalid_state",
      `this agent has no role ${unknown.map((r) => `"${r}"`).join(", ")}`,
    );
  }
  const ids = [...new Set(Object.values(input.people).flatMap((b) => b.contactIds))];
  if (ids.length) {
    const found = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.tenantId, row.tenantId as string), inArray(contact.id, ids)));
    const known = new Set(found.map((c) => c.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      throw new AgentsError("invalid_state", `${missing[0]} is not one of this client's contacts`);
    }
  }
  const people: PeopleBindings = {};
  for (const [role, b] of Object.entries(input.people)) {
    people[role] = { contactIds: [...new Set(b.contactIds)], conditions: b.conditions };
  }
  const [updated] = await tx.update(agent).set({ people }).where(eq(agent.id, row.id)).returning();
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actorId,
    change: { kind: "people", by: input.by, before: row.people, after: people },
  });
  if (!updated) throw new Error("agent update returned nothing");
  return updated;
}

/**
 * Checks channel bindings against a client's connections: each must be one of its own and able to
 * carry the kind. Returns the bindings as stored (kind → connection id, empty kinds left out), or
 * throws `invalid_state` with a plain reason. An agent's own channels and the account's (apps/api,
 * R4) are checked the same way.
 */
export async function checkChannelBindings(
  tx: Tx,
  tenantId: string,
  bindings: ChannelBindings,
): Promise<Record<string, string>> {
  const entries = Object.entries(bindings).filter(
    (e): e is [ReachChannel, string] => typeof e[1] === "string",
  );
  const ids = [...new Set(entries.map(([, id]) => id))];
  const rows = ids.length
    ? await tx
        .select({ id: connection.id, connector: connection.connector })
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), inArray(connection.id, ids)))
    : [];
  const channels: Record<string, string> = {};
  for (const [channel, id] of entries) {
    const conn = rows.find((r) => r.id === id);
    if (!conn)
      throw new AgentsError("invalid_state", `${id} is not one of this client's connections`);
    if (!channelTool(conn.connector, channel)) {
      const planned = PLANNED_CHANNEL_CONNECTORS[conn.connector]?.includes(channel);
      throw new AgentsError(
        "invalid_state",
        planned
          ? `${channel} through ${conn.connector} isn't built yet`
          : `a ${conn.connector} connection can't carry ${channel}`,
      );
    }
    channels[channel] = id;
  }
  return channels;
}

/** Binds the agent's channels to connections of its client that can carry them. Operator only. */
export async function setChannels(
  tx: Tx,
  input: { agentId: string; actorId: string | null; channels: ChannelBindings },
): Promise<AgentRow> {
  const row = await lockClientAgent(tx, input.agentId);
  const channels = await checkChannelBindings(tx, row.tenantId as string, input.channels);
  const [updated] = await tx
    .update(agent)
    .set({ channels })
    .where(eq(agent.id, row.id))
    .returning();
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actorId,
    change: { kind: "channels", before: row.channels, after: channels },
  });
  if (!updated) throw new Error("agent update returned nothing");
  return updated;
}

/** The connections of a client that can carry a channel, with the channels each can. */
export async function channelOptions(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({
      id: connection.id,
      connector: connection.connector,
      status: connection.status,
      account: connection.externalAccountId,
    })
    .from(connection)
    .where(eq(connection.tenantId, tenantId));
  return rows
    .map((r) => ({
      connectionId: r.id,
      connector: r.connector,
      label: r.account ? `${r.connector} (${r.account})` : r.connector,
      status: r.status,
      channels: connectorChannels(r.connector),
    }))
    .filter((o) => o.channels.length > 0);
}
