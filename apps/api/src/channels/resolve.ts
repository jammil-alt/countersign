// R4 channels (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Communications"): every client account
// has a number and an email; an agent may have its own, which is used first.
//
// Nothing new is stored for an agent: its own channels stay `agent.channels` (kind → connection,
// bound by the operator, §1.25), which reach-outs, conversations and inbound texts already read.
// The account's are what was missing:
// - `tenant.settings.channels`: the same shape (kind → connection), set by the operator;
// - else the account's default: its oldest connected connection of Mezonas' own channel
//   infrastructure that has an address for the kind (the client's Twilio subaccount numbers, its
//   WhatsApp sender, Mezonas' sending for the client by Resend).
// `channelFor` is the one resolver: the agent's own, else the account's.

// DECISION: account channels live in `tenant.settings.channels` with `agent.channels`' shape, not in
// a new table: agent channels already are a JSON map on their row, the operator alone changes
// either, and a second store for the same binding would have to be kept in step with the first.

import {
  fromAddress,
  RESEND_CONNECTOR_ID,
  ResendConfig,
  readTwilioConfig,
  readWhatsappMetaConfig,
  TWILIO_CONNECTOR_ID,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  ChannelBindings,
  type ChannelLine,
  channelTool,
  PLANNED_CHANNEL_CONNECTORS,
  REACH_CHANNELS,
  type ReachChannel,
} from "@countersign/core";
import { agent, connection, type Tx, tenant } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";

/** `tenant.settings` key of the account's channels. */
export const ACCOUNT_CHANNELS_SETTING = "channels";

/**
 * The connectors whose connection is the account's own by default, per kind: Mezonas' channel
 * infrastructure for the client, never a person's own mailbox (Gmail, Outlook), which only an
 * explicit binding makes a channel.
 */
// DECISION: in this order; the oldest connected connection of the first connector with an
// address for the kind wins (Twilio's WhatsApp sender before the client's own number on Meta).
export const DEFAULT_CHANNEL_CONNECTORS: Record<ReachChannel, readonly string[]> = {
  email: [RESEND_CONNECTOR_ID],
  sms: [TWILIO_CONNECTOR_ID],
  whatsapp: [TWILIO_CONNECTOR_ID, WHATSAPP_META_CONNECTOR_ID],
  voice: [TWILIO_CONNECTOR_ID],
};

/** The connection columns a channel is resolved from. */
export interface ChannelConnection {
  id: string;
  connector: string;
  status: string;
  config: unknown;
  externalAccountId: string | null;
  createdAt: Date;
}

/** The account's channels as set (`tenant.settings.channels`); anything unreadable is left out. */
export function accountBindings(settings: unknown): ChannelBindings {
  const raw = (settings as Record<string, unknown> | null)?.[ACCOUNT_CHANNELS_SETTING];
  const parsed = ChannelBindings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** The number (E.164) or address a connection sends `kind` from, or null when it has none yet. */
export function channelAddress(conn: ChannelConnection, kind: ReachChannel): string | null {
  switch (conn.connector) {
    case TWILIO_CONNECTOR_ID: {
      const numbers = readTwilioConfig(conn.config)?.numbers ?? [];
      const n = numbers.find((x) =>
        kind === "whatsapp"
          ? x.whatsapp
          : kind === "sms"
            ? x.capabilities.sms
            : kind === "voice"
              ? x.capabilities.voice
              : false,
      );
      return n?.phoneNumber ?? null;
    }
    case RESEND_CONNECTOR_ID: {
      const config = ResendConfig.safeParse(conn.config);
      return config.success ? fromAddress(config.data).address : null;
    }
    case WHATSAPP_META_CONNECTOR_ID:
      return readWhatsappMetaConfig(conn.config)?.phoneNumber ?? null;
    default:
      return conn.externalAccountId;
  }
}

/**
 * The channel `kind` resolves to: the agent's own binding, else the account's binding, else the
 * account's default. Null when nothing can carry it.
 */
// DECISION: a binding (the agent's or the account's) whose connection is gone, not connected, or
// can't carry the kind resolves to nothing; it never falls through to the next. Sending as the
// account when the operator gave the agent its own number would change who the person hears from.
export function pickChannel(input: {
  kind: ReachChannel;
  /** `agent.channels`; absent for the account itself. */
  agent?: Record<string, string> | null | undefined;
  account: ChannelBindings;
  connections: readonly ChannelConnection[];
}): ChannelLine | null {
  const { kind, connections } = input;
  const carries = (c: ChannelConnection | undefined): c is ChannelConnection =>
    c?.status === "connected" && channelTool(c.connector, kind) !== null;
  const line = (c: ChannelConnection, source: ChannelLine["source"]): ChannelLine => ({
    kind,
    connectionId: c.id,
    connector: c.connector,
    address: channelAddress(c, kind),
    source,
  });
  const bound = (id: string | undefined, source: "agent" | "account") => {
    if (!id) return undefined;
    const c = connections.find((x) => x.id === id);
    return carries(c) ? line(c, source) : null;
  };
  const own = bound(input.agent?.[kind], "agent");
  if (own !== undefined) return own;
  const account = bound(input.account[kind], "account");
  if (account !== undefined) return account;
  for (const connector of DEFAULT_CHANNEL_CONNECTORS[kind]) {
    const found = connections
      .filter((c) => c.connector === connector && carries(c) && channelAddress(c, kind) !== null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
    if (found) return line(found, "default");
  }
  return null;
}

/** Every kind the account resolves, in REACH_CHANNELS order; kinds nothing carries are left out. */
export function accountLines(
  account: ChannelBindings,
  connections: readonly ChannelConnection[],
): ChannelLine[] {
  return REACH_CHANNELS.flatMap((kind) => {
    const l = pickChannel({ kind, account, connections });
    return l ? [l] : [];
  });
}

/** Every kind an agent resolves (its own, else the account's). */
export function agentLines(
  agentChannels: Record<string, string> | null | undefined,
  account: ChannelBindings,
  connections: readonly ChannelConnection[],
): ChannelLine[] {
  return REACH_CHANNELS.flatMap((kind) => {
    const l = pickChannel({ kind, agent: agentChannels, account, connections });
    return l ? [l] : [];
  });
}

async function clientConnections(tx: Tx, tenantId: string): Promise<ChannelConnection[]> {
  return tx
    .select({
      id: connection.id,
      connector: connection.connector,
      status: connection.status,
      config: connection.config,
      externalAccountId: connection.externalAccountId,
      createdAt: connection.createdAt,
    })
    .from(connection)
    .where(eq(connection.tenantId, tenantId))
    .orderBy(asc(connection.createdAt));
}

/** What `channelFor` and the routes read in one client's transaction. */
export async function channelState(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return {
    account: accountBindings(t?.settings),
    connections: await clientConnections(tx, tenantId),
  };
}

/**
 * The channel an agent sends `kind` on (its own, else the account's), or the account's own with
 * `agentId` null. Read in the caller's transaction, scoped to the client.
 */
export async function channelFor(
  tx: Tx,
  tenantId: string,
  agentId: string | null,
  kind: ReachChannel,
): Promise<ChannelLine | null> {
  const state = await channelState(tx, tenantId);
  let own: Record<string, string> | null = null;
  if (agentId) {
    const [a] = await tx
      .select({ channels: agent.channels })
      .from(agent)
      .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
    own = (a?.channels ?? null) as Record<string, string> | null;
  }
  return pickChannel({ kind, agent: own, ...state });
}

/**
 * The client agents listening on `connectionId` for `kind`: those whose channel resolves to it
 * (their own binding, or the account's when they have none). Incoming messages on the account's
 * number start the processes whose message trigger listens there; the caller still checks each
 * agent's triggers, and anything nobody takes goes to Sloan and the Desk as today.
 */
export async function agentsListeningOn(
  tx: Tx,
  tenantId: string,
  kind: ReachChannel,
  connectionId: string,
): Promise<string[]> {
  const state = await channelState(tx, tenantId);
  const agents = await tx
    .select({ id: agent.id, channels: agent.channels })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), sql`not ${agent.testCopy}`));
  return agents
    .filter(
      (a) =>
        pickChannel({ kind, agent: a.channels as Record<string, string>, ...state })
          ?.connectionId === connectionId,
    )
    .map((a) => a.id);
}

/**
 * Checks the account's bindings against the client's connections: each must be one of its own
 * and able to carry the kind. Returns a plain-words problem, or null. (Mirrors what
 * packages/agents' `setChannels` checks for an agent's own.)
 */
export function bindingProblem(
  bindings: ChannelBindings,
  connections: readonly ChannelConnection[],
): string | null {
  for (const [kind, id] of Object.entries(bindings) as [ReachChannel, string | undefined][]) {
    if (!id) continue;
    const c = connections.find((x) => x.id === id);
    if (!c) return `${id} is not one of this client's connections`;
    if (!channelTool(c.connector, kind)) {
      return PLANNED_CHANNEL_CONNECTORS[c.connector]?.includes(kind)
        ? `${kind} through ${c.connector} isn't built yet`
        : `a ${c.connector} connection can't carry ${kind}`;
    }
  }
  return null;
}

/** Writes the account's bindings in place (other settings keys kept). */
export async function setAccountBindings(
  tx: Tx,
  tenantId: string,
  bindings: ChannelBindings,
): Promise<void> {
  const clean = Object.fromEntries(Object.entries(bindings).filter(([, v]) => !!v));
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb),
        ${`{${ACCOUNT_CHANNELS_SETTING}}`}::text[], ${JSON.stringify(clean)}::jsonb)`,
    })
    .where(eq(tenant.id, tenantId));
}
