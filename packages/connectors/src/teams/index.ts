// "teams": Microsoft Teams. A Teams bot of Mezonas' own (an Azure Bot with a single-tenant Entra
// app), authenticating as itself to the Bot Connector; there are no per-client user tokens. The
// client's Teams admin adds the Mezonas app to a team, and the client admin mentions the bot in a
// channel with a one-time code from the portal; that binds the channel to the client (./codes.ts;
// apps/api does the binding). Agents post with `teams.message.post` (`external`, create, entity
// `message`, behind approval) to the client's bound channels only, as plain text, once per action:
// the Bot Connector takes no idempotency key, so the attempt is recorded before the call and an
// attempt with no answer is never sent again. The bot reads nothing beyond the binding mention
// (and the bound team's channel names, for the portal). Why a bot, not Graph or a webhook, and
// what is unchecked about Microsoft: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { WriteAttemptServices } from "../attempts";
import {
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";
import { fromUtf8 } from "../runtime";
import {
  allowedServiceUrl,
  BotSigningKeys,
  type BotTokenRefusal,
  BotTokens,
  bearerToken,
  isGuid,
  verifyBotToken,
} from "./auth";
import {
  activityRouting,
  isTeamsThreadId,
  parseTeamsActivity,
  TEAMS_ACTIVITY_MAX_BYTES,
  TEAMS_REPLIES,
  type TeamsActivity,
  type TeamsReplyKey,
} from "./events";
import { plainTeamsText, TEAMS_TEXT_MAX } from "./text";

export * from "./auth";
export * from "./codes";
export * from "./events";
export * from "./text";

export const TEAMS_CONNECTOR_ID = "teams";
export const TEAMS_POST_TOOL = "teams.message.post";
/** Most channels one client can bind. */
export const TEAMS_MAX_CHANNELS = 50;
/** After this many refused attempts under one key, the action stops trying. */
const MAX_ATTEMPTS = 5;
/** Answers longer than this are not read. */
const MAX_ANSWER_CHARS = 256 * 1024;

// --- What the connection keeps ------------------------------------------------------------------

export const TeamsChannel = z.object({
  /** The client's Microsoft Entra tenant (where the team lives). */
  tenantId: z.string().refine(isGuid, "not an Entra tenant id"),
  teamId: z.string().refine(isTeamsThreadId, "not a Teams team id"),
  teamName: z.string().max(200).nullable(),
  /** The channel's id, which is also its conversation id for a new post. */
  channelId: z.string().refine(isTeamsThreadId, "not a Teams channel id"),
  channelName: z.string().max(200).nullable(),
  /** Where the Bot Connector takes posts for this team (an allow-listed host only). */
  serviceUrl: z.string().refine((v) => allowedServiceUrl(v) === v, "not a Teams service URL"),
  boundAt: z.string(),
  /** Who mentioned the bot with the code (their Teams display name), for the record. */
  boundBy: z.string().max(200).nullable(),
});
export type TeamsChannel = z.infer<typeof TeamsChannel>;

/** `connection.config`: the bound channels. Not secret; the operator sees them. */
export const TeamsConfig = z.object({ channels: z.array(TeamsChannel).max(TEAMS_MAX_CHANNELS) });
export type TeamsConfig = z.infer<typeof TeamsConfig>;

/** The bound channels in a connection's config; anything unreadable counts as none. */
export function readTeamsConfig(config: unknown): TeamsConfig {
  const channels = (config as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels)) return { channels: [] };
  const out: TeamsChannel[] = [];
  for (const c of channels.slice(0, TEAMS_MAX_CHANNELS)) {
    const r = TeamsChannel.safeParse(c);
    if (r.success) out.push(r.data);
  }
  return { channels: out };
}

/** The connection's credentials: only the pending code's hash (encrypted with the client's key). */
export const TeamsCredentials = z.object({
  pendingCode: z
    .object({
      hash: z.string().length(64),
      createdAt: z.string(),
      expiresAt: z.string(),
      createdBy: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type TeamsCredentials = z.infer<typeof TeamsCredentials>;

export function readTeamsCredentials(value: unknown): TeamsCredentials {
  const r = TeamsCredentials.safeParse(value ?? {});
  return r.success ? r.data : {};
}

export type TeamsBindRefusal = "already" | "not_channel" | "full" | "service_url";

/**
 * Adds the channel a verified mention came from (or answers why not): pure, for the binding in
 * apps/api. Only a team channel binds, on an allow-listed service URL, with a tenant id.
 */
export function bindTeamsChannel(
  config: TeamsConfig,
  activity: TeamsActivity,
  at: Date,
):
  | { ok: true; config: TeamsConfig; channel: TeamsChannel }
  | { ok: false; reason: TeamsBindRefusal } {
  if (activity.conversation.kind !== "channel" || !activity.channel || !activity.team) {
    return { ok: false, reason: "not_channel" };
  }
  if (!isGuid(activity.tenantId)) return { ok: false, reason: "not_channel" };
  const serviceUrl = allowedServiceUrl(activity.serviceUrl);
  if (!serviceUrl) return { ok: false, reason: "service_url" };
  if (config.channels.some((c) => c.channelId === activity.channel?.id)) {
    return { ok: false, reason: "already" };
  }
  if (config.channels.length >= TEAMS_MAX_CHANNELS) return { ok: false, reason: "full" };
  const channel: TeamsChannel = {
    tenantId: activity.tenantId,
    teamId: activity.team.id,
    teamName: activity.team.name,
    channelId: activity.channel.id,
    channelName: activity.channel.name,
    serviceUrl,
    boundAt: at.toISOString(),
    boundBy: activity.from?.name ?? null,
  };
  return { ok: true, config: { channels: [...config.channels, channel] }, channel };
}

/** The config without this channel, and whether it was there. */
export function unbindTeamsChannel(
  config: TeamsConfig,
  channelId: string,
): { config: TeamsConfig; removed: TeamsChannel[] } {
  const removed = config.channels.filter((c) => c.channelId === channelId);
  return {
    config: { channels: config.channels.filter((c) => c.channelId !== channelId) },
    removed,
  };
}

/** The config without any channel of this team (the bot was removed, or the team deleted). */
export function unbindTeamsTeam(
  config: TeamsConfig,
  teamId: string,
): { config: TeamsConfig; removed: TeamsChannel[] } {
  const removed = config.channels.filter((c) => c.teamId === teamId);
  return { config: { channels: config.channels.filter((c) => c.teamId !== teamId) }, removed };
}

/** A renamed team or channel's new label; the config unchanged (and `changed: false`) otherwise. */
export function renameInTeamsConfig(
  config: TeamsConfig,
  rename: {
    teamId?: string;
    teamName?: string | null;
    channelId?: string;
    channelName?: string | null;
  },
): { config: TeamsConfig; changed: boolean } {
  let changed = false;
  const channels = config.channels.map((c) => {
    let next = c;
    if (rename.channelId && c.channelId === rename.channelId && rename.channelName !== undefined) {
      if (c.channelName !== rename.channelName) next = { ...next, channelName: rename.channelName };
    }
    if (rename.teamId && c.teamId === rename.teamId && rename.teamName !== undefined) {
      if (c.teamName !== rename.teamName) next = { ...next, teamName: rename.teamName };
    }
    if (next !== c) changed = true;
    return next;
  });
  return { config: changed ? { channels } : config, changed };
}

/** What a client sees a channel called: `Team › Channel`, or what is known. */
export function teamsChannelLabel(c: {
  teamName: string | null;
  channelName: string | null;
}): string {
  const channel = c.channelName ?? "a channel";
  return c.teamName ? `${c.teamName} › ${channel}` : channel;
}

// --- Errors -------------------------------------------------------------------------------------

export class TeamsChannelNotBoundError extends Error {
  readonly notWritten = true;
  constructor() {
    super(
      "that Teams channel isn't connected to this client; the client admin connects it with a code",
    );
    this.name = "TeamsChannelNotBoundError";
  }
}

export class TeamsNotConfiguredError extends Error {
  readonly notWritten = true;
  constructor() {
    super(
      "Microsoft Teams is not set up on this deployment (TEAMS_BOT_APP_ID, TEAMS_BOT_APP_SECRET, TEAMS_BOT_TENANT_ID)",
    );
    this.name = "TeamsNotConfiguredError";
  }
}

export class TeamsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Teams answered and posted nothing. */
    readonly notWritten: boolean,
  ) {
    super(message);
    this.name = "TeamsApiError";
  }
}

// --- The tool's shapes --------------------------------------------------------------------------

export const TeamsPostInput = z.strictObject({
  /** A bound channel's id, `19:…@thread.tacv2`. */
  channel: z.string().max(200).refine(isTeamsThreadId, "not a Teams channel id (19:…@thread…)"),
  text: z.string().trim().min(1).max(TEAMS_TEXT_MAX),
});

export const TeamsPostOutput = z.object({
  channel: z.string(),
  channelLabel: z.string(),
  team: z.string(),
  /** The new post's conversation (`<channel>;messageid=<id>`) and its activity id. */
  conversationId: z.string(),
  activityId: z.string().nullable(),
  /** The text as posted. */
  text: z.string(),
});
export type TeamsPostOutput = z.infer<typeof TeamsPostOutput>;

/** What the approver sees and `external_action.before` keeps: where it goes and what it says. */
export const TeamsPostBefore = z.object({
  team: z.object({ id: z.string(), name: z.string().nullable() }),
  channel: z.object({ id: z.string(), name: z.string().nullable() }),
  text: z.string(),
});

const CreatedConversation = z.looseObject({
  id: z.string().min(1).max(400),
  activityId: z.string().max(400).optional(),
});

// --- The connector ------------------------------------------------------------------------------

export interface TeamsOptions {
  /** `TEAMS_BOT_APP_ID`: the bot's Microsoft App ID (its Entra app's client id). */
  appId?: string | undefined;
  /** `TEAMS_BOT_APP_SECRET`: that app's client secret. */
  appSecret?: string | undefined;
  /** `TEAMS_BOT_TENANT_ID`: the Entra tenant the bot's app lives in (Mezonas'). */
  tenantId?: string | undefined;
  fetch?: FetchLike;
  now?: () => Date;
}

export type TeamsActivityCheck =
  | { ok: true; activity: TeamsActivity }
  | {
      ok: false;
      /** 401 for a token that doesn't hold, 403 for a channel or host we don't serve, 400/413. */
      status: 400 | 401 | 403 | 413;
      reason: BotTokenRefusal | "not_configured" | "too_large" | "invalid" | "recipient";
    };

export interface TeamsConnector extends Connector {
  /**
   * The messaging endpoint's check: the bearer token and the raw body (at most
   * TEAMS_ACTIVITY_MAX_BYTES), verified as the Bot Connector's, then the activity read. Nothing of
   * the body is trusted before the token holds.
   */
  verifyActivity(
    headers: { authorization?: string | null | undefined },
    body: Uint8Array,
  ): Promise<TeamsActivityCheck>;
  /** One fixed line, in the thread of the verified activity that asked; never client data. */
  reply(activity: TeamsActivity, key: TeamsReplyKey): Promise<void>;
  /**
   * The team's and channel's names as Teams has them (activities often carry ids only), for the
   * portal: team metadata only, never messages. Nulls when Teams doesn't say.
   */
  lookupNames(channel: {
    serviceUrl: string;
    teamId: string;
    channelId: string;
  }): Promise<{ teamName: string | null; channelName: string | null }>;
}

export function isTeamsConnector(c: Connector | undefined): c is TeamsConnector {
  return (
    c !== undefined &&
    c.manifest.id === TEAMS_CONNECTOR_ID &&
    typeof (c as Partial<TeamsConnector>).verifyActivity === "function"
  );
}

function attemptServices(ctx: ToolContext): WriteAttemptServices {
  const s = ctx.services?.attempts;
  if (!s) throw new Error("Teams posts need the platform's record of attempts");
  return s;
}

/** The channel this call may post to: one of the connection's bound channels, or refused. */
function boundChannel(ctx: ToolContext, channelId: string): TeamsChannel {
  const c = readTeamsConfig(ctx.connection.config).channels.find((x) => x.channelId === channelId);
  if (!c) throw new TeamsChannelNotBoundError();
  return c;
}

function postable(text: string): string {
  const t = plainTeamsText(text);
  if (!t) throw new Error("there is nothing to post once markup is taken out");
  return t;
}

export function createTeamsConnector(options: TeamsOptions = {}): TeamsConnector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const now = options.now ?? (() => new Date());
  const appId = isGuid(options.appId) ? options.appId.toLowerCase() : null;
  const tenantId = isGuid(options.tenantId) ? options.tenantId.toLowerCase() : null;
  const secret = options.appSecret && options.appSecret.length <= 512 ? options.appSecret : null;
  const configured = Boolean(appId && tenantId && secret);
  const tokens =
    appId && tenantId && secret
      ? new BotTokens({ appId, appSecret: secret, tenantId }, doFetch, now)
      : null;
  const keys = new BotSigningKeys(doFetch, now);

  /** A call to the Bot Connector at an allow-listed service URL, with the bot's token. */
  async function connector(
    method: "GET" | "POST",
    serviceUrl: string,
    path: string,
    body?: JsonObject,
  ): Promise<{ status: number; json: unknown }> {
    if (!tokens) throw new TeamsNotConfiguredError();
    // Checked here, at the only place the token is attached: nowhere else gets it.
    const base = allowedServiceUrl(serviceUrl);
    if (!base) throw new TeamsApiError(0, "that Teams service URL isn't one we send to", true);
    const call = async (token: string) =>
      doFetch()(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: timeoutSignal(20_000),
      });
    let res = await call(await tokens.get());
    if (res.status === 401) {
      // The cached token was refused before anything was done: one new token, one retry.
      tokens.drop();
      res = await call(await tokens.get());
    }
    const text = await res.text();
    let json: unknown = null;
    if (text.length > 0 && text.length <= MAX_ANSWER_CHARS) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  async function verifyActivity(
    headers: { authorization?: string | null | undefined },
    body: Uint8Array,
  ): Promise<TeamsActivityCheck> {
    if (!appId) return { ok: false, status: 401, reason: "not_configured" };
    if (body.length > TEAMS_ACTIVITY_MAX_BYTES)
      return { ok: false, status: 413, reason: "too_large" };
    let json: unknown = null;
    try {
      json = JSON.parse(fromUtf8(body));
    } catch {
      json = null;
    }
    // Only the two fields the token is checked against are read before it holds.
    const routing = activityRouting(json);
    const check = await verifyBotToken(bearerToken(headers.authorization), {
      appId,
      keys,
      now: now(),
      serviceUrl: routing?.serviceUrl ?? null,
      channelId: routing?.channelId ?? null,
    });
    if (!check.ok) {
      return {
        ok: false,
        status: check.reason === "endorsement" ? 403 : 401,
        reason: check.reason,
      };
    }
    const activity = parseTeamsActivity(json);
    if (!activity) return { ok: false, status: 400, reason: "invalid" };
    // DECISION: an activity whose service URL is off our allow-list is refused (403) even with a
    // good token: the bot could never answer it or post there, and binding would store it.
    if (!allowedServiceUrl(activity.serviceUrl))
      return { ok: false, status: 403, reason: "service_url" };
    // DECISION: the activity must be addressed to this bot (`28:<app id>`), when it names one.
    if (activity.recipientId !== null && activity.recipientId.toLowerCase() !== `28:${appId}`) {
      return { ok: false, status: 403, reason: "recipient" };
    }
    return { ok: true, activity };
  }

  async function reply(activity: TeamsActivity, key: TeamsReplyKey): Promise<void> {
    if (!configured) throw new TeamsNotConfiguredError();
    if (!activity.id) return;
    const path = `/v3/conversations/${encodeURIComponent(activity.conversation.id)}/activities/${encodeURIComponent(activity.id)}`;
    const res = await connector("POST", activity.serviceUrl, path, {
      type: "message",
      text: TEAMS_REPLIES[key],
      textFormat: "plain",
      replyToId: activity.id,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new TeamsApiError(res.status, `Teams refused the bot's reply (${res.status})`, true);
    }
  }

  async function lookupNames(channel: {
    serviceUrl: string;
    teamId: string;
    channelId: string;
  }): Promise<{ teamName: string | null; channelName: string | null }> {
    const out = { teamName: null as string | null, channelName: null as string | null };
    if (!configured || !isTeamsThreadId(channel.teamId) || !isTeamsThreadId(channel.channelId)) {
      return out;
    }
    const team = encodeURIComponent(channel.teamId);
    const clean = (v: unknown) => {
      if (typeof v !== "string") return null;
      const t = v.trim().slice(0, 200);
      return t || null;
    };
    try {
      const details = await connector("GET", channel.serviceUrl, `/v3/teams/${team}`);
      if (details.status === 200) out.teamName = clean((details.json as { name?: unknown })?.name);
      const list = await connector("GET", channel.serviceUrl, `/v3/teams/${team}/conversations`);
      const conversations = (list.json as { conversations?: unknown } | null)?.conversations;
      if (list.status === 200 && Array.isArray(conversations)) {
        const found = conversations.find(
          (c) => (c as { id?: unknown } | null)?.id === channel.channelId,
        ) as { name?: unknown } | undefined;
        // DECISION: Teams lists the General channel without a name; it is labelled "General".
        if (found) out.channelName = clean(found.name) ?? "General";
      }
    } catch {
      // Names are a nicety: the binding stands without them.
    }
    return out;
  }

  const base = defineConnector({
    id: TEAMS_CONNECTOR_ID,
    name: "Microsoft Teams",
    description:
      "Agents post updates to the Teams channels you connect. We can't read your messages.",
    icon: "message",
    // DECISION: no per-client sign-in (the bot is Mezonas' own): auth `none`, connected from the
    // portal in one click once the deployment has the bot's keys; a channel is the client's only
    // after its code is posted there.
    auth: "none",
    entities: [],
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    isConfigured: () => configured,

    /** The Bot Connector's bearer token and body, verified (`verifyActivity` returns the activity). */
    async verifyWebhook(headers, body) {
      return (await verifyActivity({ authorization: headers.authorization ?? null }, body)).ok;
    },

    tools: [
      defineWriteTool({
        id: TEAMS_POST_TOOL,
        entity: "message",
        description:
          "Post a plain-text message as a new post in one of the client's connected Microsoft Teams channels. Formatting, links with labels and mentions are removed; nothing is read from the channel.",
        verb: "create",
        // R5: a post can't be taken back.
        undo: { kind: "none" },
        summary: "Posted in {{channelLabel}} on Microsoft Teams",
        input: TeamsPostInput,
        output: TeamsPostOutput,
        beforeSchema: TeamsPostBefore,
        async before(input, ctx) {
          const c = boundChannel(ctx, input.channel);
          return {
            team: { id: c.teamId, name: c.teamName },
            channel: { id: c.channelId, name: c.channelName },
            text: postable(input.text),
          };
        },
        async run(input, ctx) {
          const attempts = attemptServices(ctx);
          const key = ctx.idempotencyKey;
          // A re-run after the post was recorded returns it, before any check.
          const state = await attempts.stateFor(key);
          if (state.done) return TeamsPostOutput.parse(state.done);
          // DECISION: the Bot Connector takes no idempotency key and the bot can't read the
          // channel to check, so an attempt started without Teams' answer is never sent again:
          // the action fails as unconfirmed and the operator checks the channel. An attempt Teams
          // refused with an answer posted nothing and may be tried again.
          if (state.started > state.refused) {
            const last = state.last;
            throw new UnconfirmedWriteError(
              `The Teams post in ${String(last?.details.channelLabel ?? "the channel")} may have been made`,
              `we started it at ${last?.startedAt.toISOString() ?? "an unknown time"} and have no answer from Teams, and we can't read the channel to check`,
              {
                channel: "teams",
                ...(last?.details ?? {}),
                ...(last ? { startedAt: last.startedAt.toISOString() } : {}),
              },
            );
          }
          if (state.started >= MAX_ATTEMPTS) {
            throw new Error(`Teams refused this post ${state.started} times; we stopped trying`);
          }
          if (!configured) throw new TeamsNotConfiguredError();
          // Checked again at the write: a channel disconnected while the action waited is refused.
          const channel = boundChannel(ctx, input.channel);
          const text = postable(input.text);
          const channelLabel = teamsChannelLabel(channel);
          const attempt = state.started + 1;
          const details: JsonObject = {
            team: channel.teamName,
            teamId: channel.teamId,
            channelId: channel.channelId,
            channelName: channel.channelName,
            channelLabel,
            attempt,
          };
          const claimed = await attempts.start({
            idempotencyKey: key,
            attempt,
            details,
            at: ctx.now(),
          });
          if (!claimed) {
            throw new UnconfirmedWriteError(
              `The Teams post in ${channelLabel} may have been made`,
              "another run of this action started posting it at the same time",
              { channel: "teams", ...details },
            );
          }
          // DECISION: a new post in the channel is "create a conversation" with the channel's id
          // (Microsoft's REST example for a new reply chain); `textFormat: "plain"` and no
          // entities, so nothing in it mentions anyone.
          // A network failure or timeout throws here with the attempt open: unconfirmed on retry.
          const res = await connector("POST", channel.serviceUrl, "/v3/conversations", {
            isGroup: true,
            channelData: { channel: { id: channel.channelId }, tenant: { id: channel.tenantId } },
            tenantId: channel.tenantId,
            activity: { type: "message", text, textFormat: "plain" },
          });
          if (res.status >= 200 && res.status < 300) {
            const made = CreatedConversation.safeParse(res.json);
            if (made.success) {
              const output: TeamsPostOutput = {
                channel: channel.channelId,
                channelLabel,
                team: channel.teamName ?? channel.teamId,
                conversationId: made.data.id,
                activityId: made.data.activityId ?? null,
                text,
              };
              await attempts.done({ idempotencyKey: key, output, at: ctx.now() });
              return output;
            }
            // A success we can't read: Teams posted it, but we can't say where. The attempt stays
            // open, so a retry is unconfirmed rather than a second post.
            throw new TeamsApiError(res.status, "Teams' answer has an unexpected shape", false);
          }
          if (res.status >= 400 && res.status < 500) {
            // Teams answered and posted nothing (refused, throttled, the bot gone from the team).
            await attempts.refused({
              idempotencyKey: key,
              attempt,
              reason: `http_${res.status}`,
              at: ctx.now(),
            });
            throw refusal(res.status, res.json, channelLabel);
          }
          // A 5xx: Teams may have posted it; the attempt stays open.
          throw new TeamsApiError(
            res.status,
            `Teams didn't say whether the post in ${channelLabel} was made (${res.status})`,
            false,
          );
        },
      }),
    ],
  });
  return { ...base, verifyActivity, reply, lookupNames };
}

/** Teams' refusal in plain words: error codes only, never the body's text. */
function refusal(status: number, json: unknown, channelLabel: string): TeamsApiError {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  const sub = typeof code === "string" ? ` (${code.slice(0, 60)})` : "";
  if (status === 401) {
    return new TeamsApiError(
      status,
      "Microsoft refused the Teams bot's token; check the bot's keys",
      true,
    );
  }
  if (status === 403 || status === 404) {
    return new TeamsApiError(
      status,
      `Teams refused the post in ${channelLabel}${sub}: Mezonas may have been removed from that team, or the channel deleted. Add the app again and reconnect the channel.`,
      true,
    );
  }
  if (status === 429) {
    return new TeamsApiError(
      status,
      `Teams asked us to slow down posting in ${channelLabel}; try again shortly`,
      true,
    );
  }
  return new TeamsApiError(
    status,
    `Teams refused the post in ${channelLabel} (${status})${sub}`,
    true,
  );
}
