// §1.97: Microsoft Teams' routes (docs/plan.md §1.97, ARCHITECTURE §6.11 row 11).
// - `POST /api/hooks/teams`: the Bot Connector's activities to the Mezonas bot, public, and the
//   messaging endpoint set on the Azure Bot. The bearer token is checked with the raw body (its
//   `serviceUrl` claim must match the activity's) before anything of the body is trusted; anything
//   else is refused with nothing to probe. The answer is an empty 200; the bot's one fixed line, if
//   any, goes back as its own call into the thread that asked.
// - `GET /api/connections/:id/teams`, `POST …/code`, `DELETE …/channels/:channelId`: the client
//   admin's card: the bound channels, a one-time code (shown once), and disconnecting a channel.

import {
  isTeamsConnector,
  TEAMS_ACTIVITY_MAX_BYTES,
  TEAMS_CONNECTOR_ID,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, errorResponse, HttpError, mount } from "../http";
import { reportHandled } from "../observability/report";
import {
  handleTeamsActivity,
  makeTeamsCode,
  teamsConnection,
  teamsView,
  unbindTeamsFromPortal,
} from "../teams/channels";

async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "too_large", "the activity is too large");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > limit) throw new HttpError(413, "too_large", "the activity is too large");
  return bytes;
}

const REFUSED: Record<number, [string, string]> = {
  400: ["invalid_request", "not a Teams activity"],
  401: ["unauthorized", "not a request from the Bot Connector"],
  403: ["forbidden", "not a channel this bot serves"],
  413: ["too_large", "the activity is too large"],
};

export function teamsRoutes(app: Hono<AppEnv>): void {
  app.post(routes.teamsEvents.path, async (c) => {
    try {
      const services = c.get("req").services();
      const connector = services.platform.connectors.get(TEAMS_CONNECTOR_ID);
      if (!isTeamsConnector(connector) || connector.isConfigured?.() === false) {
        throw new HttpError(503, "not_configured", "Microsoft Teams is not set up here");
      }
      // No token, nothing read.
      const authorization = c.req.header("authorization") ?? "";
      if (!authorization)
        throw new HttpError(401, "unauthorized", "not a request from the Bot Connector");
      const body = await readBody(c.req.raw, TEAMS_ACTIVITY_MAX_BYTES);
      const checked = await connector.verifyActivity({ authorization }, body);
      if (!checked.ok) {
        const [code, message] = REFUSED[checked.status] ?? ["invalid_request", "refused"];
        throw new HttpError(checked.status, code, message);
      }
      try {
        const reply = await handleTeamsActivity(
          services.db,
          services.env,
          connector,
          checked.activity,
        );
        if (reply) await connector.reply(checked.activity, reply);
      } catch (error) {
        // Teams retries a failed delivery; ours is reported, never echoed.
        reportHandled("teams activity failed", error, { connector: TEAMS_CONNECTOR_ID });
        throw new HttpError(500, "internal", "something went wrong");
      }
      return c.json(routes.teamsEvents.response.parse({}));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  mount(app, routes.portalTeams, async ({ tx, tenantIds, params, services }) => {
    const row = await teamsConnection(tx, tenantIds[0] as string, params.id);
    return teamsView(tx, services.env, row);
  });

  mount(app, routes.portalTeamsCode, async ({ tx, tenantIds, params, session, services }) => {
    const row = await teamsConnection(tx, tenantIds[0] as string, params.id);
    const connector = services.platform.connectors.get(TEAMS_CONNECTOR_ID);
    if (connector?.isConfigured?.() === false) {
      throw new HttpError(409, "not_available", "Microsoft Teams is not available yet");
    }
    const code = await makeTeamsCode(tx, services.env, row, session.user.id);
    return teamsView(tx, services.env, row, code);
  });

  mount(app, routes.portalTeamsUnbind, async ({ tx, tenantIds, params, session, services }) => {
    const row = await teamsConnection(tx, tenantIds[0] as string, params.id);
    const next = await unbindTeamsFromPortal(tx, row, params.channelId, session.user.id);
    return teamsView(tx, services.env, next);
  });
}
