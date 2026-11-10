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
// `channelFor` is the one resolver: the agent's own, else the account's. Reach-outs and
// conversations send on what it resolves (`sendingChannels`), and texts to a number start the
// agents listening on it (`agentsListeningOn`), so the channel the portal shows is the one used.

// DECISION: account channels live in `tenant.settings.channels` with `agent.channels`' shape, not in
// a new table: agent channels already are a JSON map on their row, the operator alone changes
// either, and a second store for the same binding would have to be kept in step with the first.

import { checkChannelBindings } from "@countersign/agents";
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
  levelFor,
  type PermissionMatrix,
  REACH_CHANNELS,
  type ReachChannel,
} from "@countersign/core";
import { agent, connection, type Tx, tenant, tenantChange } from "@countersign/db";
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
  /** The connection's matrix, for a channel's `create` level (absent: the defaults). */
  permissions?: unknown;
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

/** The email addresses a line can name instead of its connection's sender (see `pickChannel`). */
export interface ChannelEmails {
  /** The agent's own address (§10.8's `agentAddress`), when it has one. */
  agentEmail?: string | null | undefined;
  /** The account's own address (the client's forwarding address), when it has one. */
  accountEmail?: string | null | undefined;
}

/**
 * The channel `kind` resolves to: the agent's own binding, else the account's binding, else the
 * account's default. Null when nothing can carry it.
 */
// DECISION: a binding (the agent's or the account's) whose connection is gone, not connected, or
// can't carry the kind resolves to nothing; it never falls through to the next. Sending as the
// account when the operator gave the agent its own number would change who the person hears from.
export function pickChannel(
  input: {
    kind: ReachChannel;
    /** `agent.channels`; absent for the account itself. */
    agent?: Record<string, string> | null | undefined;
    account: ChannelBindings;
    connections: readonly ChannelConnection[];
  } & ChannelEmails,
): ChannelLine | null {
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
  const accountLine = (): ChannelLine | null => {
    const set = bound(input.account[kind], "account");
    if (set !== undefined) return set;
    for (const connector of DEFAULT_CHANNEL_CONNECTORS[kind]) {
      const found = connections
        .filter((c) => c.connector === connector && carries(c) && channelAddress(c, kind) !== null)
        .sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
        )[0];
      if (found) return line(found, "default");
    }
    return null;
  };
  const own = bound(input.agent?.[kind], "agent");
  if (own !== undefined) return own;
  const account = accountLine();
  // DECISION: on Mezonas' own sending (Resend) an email line names the agent's §10.8 address, else
  // the account's forwarding address: mail to either reaches the client (the agent's starts its
  // processes) and replies come back there, while the From is Mezonas' sender for the client. The
  // sending connection is the same either way. A bound mailbox (Gmail, Outlook) is its own address.
  if (kind === "email" && account?.connector === RESEND_CONNECTOR_ID) {
    if (input.agentEmail) return { ...account, address: input.agentEmail, source: "agent" };
    if (input.accountEmail) return { ...account, address: input.accountEmail };
  }
  return account;
}

/** Every kind the account resolves, in REACH_CHANNELS order; kinds nothing carries are left out. */
export function accountLines(
  account: ChannelBindings,
  connections: readonly ChannelConnection[],
  accountEmail?: string | null,
): ChannelLine[] {
  return REACH_CHANNELS.flatMap((kind) => {
    const l = pickChannel({ kind, account, connections, accountEmail });
    return l ? [l] : [];
  });
}

/** Every kind an agent resolves (its own, else the account's). */
export function agentLines(
  agentChannels: Record<string, string> | null | undefined,
  account: ChannelBindings,
  connections: readonly ChannelConnection[],
  emails: ChannelEmails = {},
): ChannelLine[] {
  return REACH_CHANNELS.flatMap((kind) => {
    const l = pickChannel({ kind, agent: agentChannels, account, connections, ...emails });
    return l ? [l] : [];
  });
}

/** A channel an agent sends on: its connection and that connection's `create` level. */
export interface SendingChannel {
  id: string;
  connector: string;
  create: string;
}

/**
 * The channels an agent sends reach-outs and conversations on, kind by kind (its own, else the
 * account's), each with its connection's `create` level, which the plan's approval reads.
 */
// DECISION: the account's channel is the agent's when it has none of its own (§10.14), so the
// account connection's matrix decides the plan's approval exactly as an own binding's does, and
// approval stays on by default (invariant 8).
export function sendingChannels(
  agentChannels: Record<string, string> | null | undefined,
  account: ChannelBindings,
  connections: readonly ChannelConnection[],
): Map<ReachChannel, SendingChannel> {
  const out = new Map<ReachChannel, SendingChannel>();
  for (const l of agentLines(agentChannels, account, connections)) {
    const c = connections.find((x) => x.id === l.connectionId);
    out.set(l.kind, {
      id: l.connectionId,
      connector: l.connector,
      create: levelFor(c?.permissions as Partial<PermissionMatrix> | undefined, "create"),
    });
  }
  return out;
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
      permissions: connection.permissions,
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
 * Writes the account's bindings in place (other settings keys kept), checked as an agent's own
 * are (packages/agents' `checkChannelBindings`: each one of the client's connections, able to
 * carry its kind; it throws `invalid_state` otherwise), and records the change with what it was
 * and what it is, as an agent's channel change is recorded.
 */
// DECISION: the history row is a `tenant_change` (`{ setting: "channels", from, to }`), as other
// operator settings of a client are, since the bindings live in `tenant.settings`; the route has
// no reason field, so the reason is fixed text.
export async function setAccountBindings(
  tx: Tx,
  tenantId: string,
  bindings: ChannelBindings,
  actorId: string | null,
): Promise<void> {
  const clean = await checkChannelBindings(tx, tenantId, bindings);
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("update");
  const before = accountBindings(t?.settings);
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb),
        ${`{${ACCOUNT_CHANNELS_SETTING}}`}::text[], ${JSON.stringify(clean)}::jsonb)`,
    })
    .where(eq(tenant.id, tenantId));
  await tx.insert(tenantChange).values({
    tenantId,
    actorId,
    change: { setting: ACCOUNT_CHANNELS_SETTING, from: before, to: clean },
    reason: "The account's channels changed",
  });
}
