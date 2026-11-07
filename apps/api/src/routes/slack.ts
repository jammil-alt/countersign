// v0.14 W4-C: the client admin's channel picker for the Slack connection (docs/plan.md §1.56). The
// channel list is read live from Slack with the bot token from the client's vault (the token is
// never in a response); the picks are the channels agents may post to, kept in the connection's
// config with the workspace they belong to. Names come from Slack, never from the request: a pick
// of an id Slack doesn't list is refused. Each change of the picks is recorded with who made it.
// Sign-in and disconnect are the generic OAuth routes (routes/connections.ts).

import {
  type ConnectionRef,
  isSlackConnector,
  noopLogger,
  ReconnectRequiredError,
  SLACK_CONNECTOR_ID,
  SlackApiError,
  type SlackChannelListing,
  type SlackChannelRef,
  slackPickedChannels,
  withSlackPicks,
} from "@countersign/connectors";
import { routes, type SlackChannelsView } from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, type Services } from "../http";
import { reportHandled } from "../observability/report";
import { connectionCredentials } from "../secrets";

/** `connection_change.change.kind` of the client admin's change of picked channels. */
export const SLACK_CHANNELS_CHANGE = "slack_channels";

type Row = typeof connection.$inferSelect;

/** The client's Slack connection, connected, locked when it is about to change. */
async function slackConnection(tx: Tx, tenantId: string, lock: boolean): Promise<Row> {
  const query = tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, SLACK_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (row?.status !== "connected" || !row.credentialsEncrypted) {
    throw new HttpError(409, "not_connected", "Slack isn't connected");
  }
  return row;
}

/** Slack's public channels, read with the connection's own token. */
async function listed(tx: Tx, services: Services, row: Row): Promise<SlackChannelListing[]> {
  const connector = services.platform.connectors.get(SLACK_CONNECTOR_ID);
  if (!isSlackConnector(connector)) {
    throw new HttpError(409, "not_available", "Slack is not available here");
  }
  if (!services.env.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "connecting tools is not set up here yet");
  }
  try {
    return await connector.listChannels({
      tenantId: row.tenantId,
      connection: {
        id: row.id,
        tenantId: row.tenantId,
        connector: row.connector,
        status: row.status,
        externalAccountId: row.externalAccountId,
        config: row.config as ConnectionRef["config"],
        permissions: row.permissions,
      },
      credentials: await connectionCredentials(tx, services.env, row),
      logger: noopLogger,
      now: () => new Date(),
    });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      throw new HttpError(
        409,
        "not_connected",
        "Slack disconnected this account; connect Slack again",
      );
    }
    if (error instanceof SlackApiError) {
      throw new HttpError(502, "connector_failed", "Slack didn't list the channels; try again");
    }
    reportHandled("listing Slack channels failed", error, { connector: SLACK_CONNECTOR_ID });
    throw new HttpError(502, "connector_failed", "Slack didn't list the channels; try again");
  }
}

function view(row: Row, channels: SlackChannelListing[]): SlackChannelsView {
  const picked = slackPickedChannels(row.config);
  const ids = new Set(picked.map((p) => p.id));
  const config = row.config as { teamName?: unknown };
  return {
    connectionId: row.id,
    workspace: typeof config.teamName === "string" ? config.teamName : "",
    channels: channels.map((c) => ({ ...c, picked: ids.has(c.id) })),
    picked,
  };
}

export function slackRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalSlackChannels, async ({ tx, tenantIds, services }) => {
    const row = await slackConnection(tx, tenantIds[0] as string, false);
    return view(row, await listed(tx, services, row));
  });

  mount(app, routes.portalSlackPick, async ({ tx, tenantIds, body, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const row = await slackConnection(tx, tenantId, true);
    const channels = await listed(tx, services, row);
    const byId = new Map(channels.map((c) => [c.id, c]));
    const before = slackPickedChannels(row.config);
    const kept = new Map(before.map((p) => [p.id, p]));
    const picks: SlackChannelRef[] = [];
    for (const id of body.channels) {
      // DECISION: a pick must be a channel Slack lists now (public, not archived), except one
      // already picked, which may stay while Slack no longer lists it (renamed or archived): the
      // admin can still remove it, and the post itself says why it fails.
      const found = byId.get(id) ?? kept.get(id);
      if (!found) {
        throw new HttpError(
          422,
          "unknown_channel",
          "that channel isn't one of the workspace's public channels",
        );
      }
      picks.push({ id: found.id, name: found.name });
    }
    const config = withSlackPicks(row.config, picks);
    await tx
      .update(connection)
      .set({ config })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: session.user.id,
      change: {
        kind: SLACK_CHANNELS_CHANGE,
        by: "client",
        before: before.map((p) => p.id),
        after: slackPickedChannels(config).map((p) => p.id),
      },
    });
    return view({ ...row, config }, channels);
  });
}
