// §1.97: Microsoft Teams channels and the clients they belong to (docs/plan.md §1.97), as Google
// Chat's spaces (../gchat/spaces.ts). The bot is one for every client, so an activity names a
// channel, never a client: a code finds the client it was made for, and a channel's binding is
// looked up in each client's Teams connection in turn (each in its own withTenant: no table outside
// RLS learns which client uses which channel). A channel is bound to at most one client; a code
// binds only the client and connection it was made for, once, within 15 minutes.

import {
  BINDING_CODES_PER_HOUR,
  BindAttemptLimiter,
  bindTeamsChannel,
  checkTeamsBindingCode,
  findTeamsBindingCode,
  makeTeamsBindingCode,
  normalizeBindingCode,
  readTeamsConfig,
  readTeamsCredentials,
  renameInTeamsConfig,
  TEAMS_CONNECTOR_ID,
  type TeamsActivity,
  type TeamsConfig,
  type TeamsConnector,
  type TeamsReplyKey,
  teamsChannelLabel,
  unbindTeamsChannel,
  unbindTeamsTeam,
} from "@countersign/connectors";
import type { JsonObject, PortalTeamsSetup } from "@countersign/core";
import {
  connection,
  connectionChange,
  type Db,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { connectionCredentials } from "../secrets";

type Row = typeof connection.$inferSelect;
type Env = Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;

/** `connection_change.change.kind` of each Teams change. */
export const TEAMS_CHANGES = {
  code: "teams_code",
  bound: "teams_channel_bound",
  unbound: "teams_channel_unbound",
  renamed: "teams_channel_renamed",
} as const;

/** Wrong codes per channel, in this isolate (gchat/codes.ts says why that is enough). */
const attempts = new BindAttemptLimiter();

async function teamsRows(tx: Tx, tenantId: string): Promise<Row[]> {
  return tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, TEAMS_CONNECTOR_ID)));
}

async function pendingOf(tx: Tx, env: Env, row: Row) {
  if (!row.credentialsEncrypted) return null;
  return (
    readTeamsCredentials(await (await connectionCredentials(tx, env, row)).get()).pendingCode ??
    null
  );
}

async function codeIsRow(tx: Tx, env: Env, row: Row, canonical: string, now: Date) {
  if (row.status !== "connected") return null;
  const pending = await pendingOf(tx, env, row);
  const check = await checkTeamsBindingCode(pending, row.tenantId, row.id, canonical, now);
  return check === "ok" ? { createdBy: pending?.createdBy ?? null } : null;
}

async function saveConfig(tx: Tx, row: Row, next: TeamsConfig) {
  const config = { ...(row.config as Record<string, unknown>), channels: next.channels };
  await tx
    .update(connection)
    .set({ config })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
}

async function recordChange(tx: Tx, row: Row, actorId: string | null, change: JsonObject) {
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change,
  });
}

/** Changes every client's config that the activity concerns (removal, deletion, rename). */
async function everyClient(
  db: Db,
  change: (config: TeamsConfig) => { config: TeamsConfig; record: JsonObject | null },
): Promise<void> {
  for (const client of await db.select({ id: tenant.id }).from(tenant)) {
    await withTenant(db, client.id, async (tx) => {
      for (const row of await teamsRows(tx, client.id)) {
        const r = change(readTeamsConfig(row.config));
        if (!r.record) continue;
        await saveConfig(tx, row, r.config);
        await recordChange(tx, row, null, r.record);
      }
    });
  }
}

/**
 * One verified activity from the Bot Connector. Only a code is read from a message; nothing of it
 * is stored. Returns the fixed line the bot answers in the thread, or null for none.
 */
export async function handleTeamsActivity(
  db: Db,
  env: Env,
  connector: Pick<TeamsConnector, "lookupNames">,
  activity: TeamsActivity,
  now = new Date(),
): Promise<TeamsReplyKey | null> {
  const teamId = activity.team?.id;
  const channelId = activity.channel?.id;
  if (activity.type === "removed" || activity.type === "team_deleted") {
    if (!teamId) return null;
    await everyClient(db, (config) => {
      const r = unbindTeamsTeam(config, teamId);
      return {
        config: r.config,
        record: r.removed.length
          ? {
              kind: TEAMS_CHANGES.unbound,
              by: "microsoft_teams",
              teamId,
              channels: r.removed.length,
            }
          : null,
      };
    });
    return null;
  }
  if (activity.type === "channel_deleted") {
    if (!channelId) return null;
    await everyClient(db, (config) => {
      const r = unbindTeamsChannel(config, channelId);
      return {
        config: r.config,
        record: r.removed.length
          ? { kind: TEAMS_CHANGES.unbound, by: "microsoft_teams", channelId }
          : null,
      };
    });
    return null;
  }
  if (activity.type === "channel_renamed" || activity.type === "team_renamed") {
    await everyClient(db, (config) => {
      const r = renameInTeamsConfig(config, {
        ...(teamId ? { teamId, teamName: activity.team?.name ?? null } : {}),
        ...(activity.type === "channel_renamed" && channelId
          ? { channelId, channelName: activity.channel?.name ?? null }
          : {}),
      });
      return {
        config: r.config,
        record: r.changed ? { kind: TEAMS_CHANGES.renamed, by: "microsoft_teams" } : null,
      };
    });
    return null;
  }
  if (activity.type !== "message") return null;
  // A bot's message never binds (another app repeating a code it saw).
  if (activity.from && !activity.from.human) return null;

  const code = findTeamsBindingCode(activity.text);
  if (!code) return "onlyPosts";
  if (activity.conversation.kind !== "channel" || !channelId) return "channelOnly";
  const canonical = normalizeBindingCode(code);
  if (!canonical) return "badCode";
  if (!attempts.allowed(channelId, now.getTime())) return "tooManyTries";

  // Which client the code is for, and which client (if any) has the channel already.
  const seen: { owner: Row | null; boundTo: string | null } = { owner: null, boundTo: null };
  for (const client of await db.select({ id: tenant.id }).from(tenant)) {
    await withTenant(db, client.id, async (tx) => {
      for (const row of await teamsRows(tx, client.id)) {
        if (readTeamsConfig(row.config).channels.some((c) => c.channelId === channelId)) {
          seen.boundTo = client.id;
        }
        if (!seen.owner && (await codeIsRow(tx, env, row, canonical, now))) seen.owner = row;
      }
    });
  }
  const found = seen.owner;
  if (!found) {
    attempts.failed(channelId, now.getTime());
    return "badCode";
  }
  if (seen.boundTo !== null && seen.boundTo !== found.tenantId) return "takenByAnother";

  // Activities often carry ids only: the names come from Teams' own team metadata, best effort.
  let named = activity;
  if (activity.team && activity.channel && (!activity.team.name || !activity.channel.name)) {
    try {
      const names = await connector.lookupNames({
        serviceUrl: activity.serviceUrl,
        teamId: activity.team.id,
        channelId: activity.channel.id,
      });
      named = {
        ...activity,
        team: { ...activity.team, name: activity.team.name ?? names.teamName },
        channel: { ...activity.channel, name: activity.channel.name ?? names.channelName },
      };
    } catch {
      // The channel binds without its names; the portal shows the ids it has.
    }
  }

  // DECISION: as Google Chat's: the binding is written in the code's own client only, under that
  // connection's row lock, after checking the code again there.
  return withTenant(db, found.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, found.id), eq(connection.tenantId, found.tenantId)))
      .for("update");
    const valid = row ? await codeIsRow(tx, env, row, canonical, now) : null;
    if (!row || !valid) return "badCode";
    const bound = bindTeamsChannel(readTeamsConfig(row.config), named, now);
    if (!bound.ok && bound.reason === "full") return "tooManyChannels";
    if (!bound.ok && (bound.reason === "not_channel" || bound.reason === "service_url")) {
      return "channelOnly";
    }
    // Used once: the code goes whether the channel was new or already this client's.
    await (await connectionCredentials(tx, env, row)).set({ pendingCode: null });
    if (!bound.ok) return "alreadyConnected";
    await saveConfig(tx, row, bound.config);
    await recordChange(tx, row, valid.createdBy, {
      kind: TEAMS_CHANGES.bound,
      by: "client",
      channelId: bound.channel.channelId,
      label: teamsChannelLabel(bound.channel),
    });
    return "connected";
  });
}

// --- The portal ---------------------------------------------------------------------------------

/** The client's Teams connection, connected, or 404/409. */
export async function teamsConnection(tx: Tx, tenantId: string, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)));
  if (!row || row.connector !== TEAMS_CONNECTOR_ID) {
    throw new HttpError(404, "not_found", "no such Microsoft Teams connection");
  }
  if (row.status !== "connected")
    throw new HttpError(409, "not_connected", "connect Microsoft Teams first");
  return row;
}

export async function teamsView(
  tx: Tx,
  env: Env,
  row: Row,
  newCode: string | null = null,
): Promise<PortalTeamsSetup> {
  const pending = await pendingOf(tx, env, row);
  const live = pending && Date.parse(pending.expiresAt) > Date.now() ? pending : null;
  return {
    channels: readTeamsConfig(row.config).channels.map((c) => ({
      channelId: c.channelId,
      teamName: c.teamName,
      channelName: c.channelName,
      label: teamsChannelLabel(c),
      boundAt: c.boundAt,
      boundBy: c.boundBy,
    })),
    pendingCodeExpiresAt: live?.expiresAt ?? null,
    newCode,
  };
}

/**
 * A new code for this connection (replacing any not yet used): shown once, kept only as its hash
 * in the encrypted credentials. At most BINDING_CODES_PER_HOUR an hour per connection.
 */
export async function makeTeamsCode(
  tx: Tx,
  env: Env,
  row: Row,
  actorId: string,
  now = new Date(),
): Promise<string> {
  const [made] = await tx
    .select({ n: count() })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, row.tenantId),
        eq(connectionChange.connectionId, row.id),
        sql`${connectionChange.change}->>'kind' = ${TEAMS_CHANGES.code}`,
        gt(connectionChange.createdAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  if ((made?.n ?? 0) >= BINDING_CODES_PER_HOUR) {
    throw new HttpError(429, "too_many_codes", "too many codes this hour; try again later");
  }
  const { code, pending } = await makeTeamsBindingCode({
    tenantId: row.tenantId,
    connectionId: row.id,
    createdBy: actorId,
    now,
  });
  await (await connectionCredentials(tx, env, row)).set({
    pendingCode: pending,
  } as unknown as JsonObject);
  // The record says a code was made, never the code.
  await recordChange(tx, row, actorId, {
    kind: TEAMS_CHANGES.code,
    by: "client",
    expiresAt: pending.expiresAt,
  });
  return code;
}

/** The client admin disconnects one channel. */
export async function unbindTeamsFromPortal(
  tx: Tx,
  row: Row,
  channelId: string,
  actorId: string,
): Promise<Row> {
  const r = unbindTeamsChannel(readTeamsConfig(row.config), channelId);
  if (r.removed.length === 0) throw new HttpError(404, "not_found", "that channel isn't connected");
  await saveConfig(tx, row, r.config);
  await recordChange(tx, row, actorId, {
    kind: TEAMS_CHANGES.unbound,
    by: "client",
    channelId,
    label: teamsChannelLabel(
      r.removed[0] as { teamName: string | null; channelName: string | null },
    ),
  });
  return {
    ...row,
    config: { ...(row.config as Record<string, unknown>), channels: r.config.channels },
  };
}
