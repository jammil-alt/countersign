// v0.14 W4-C: "slack", posting to the Slack channels a client picks (ARCHITECTURE §6.11 row 6,
// docs/plan.md §1.56). The client admin installs our Slack app into the client's own workspace from
// the portal (Slack OAuth v2, a bot with `chat:write` and `channels:read`), the bot token goes to
// the client's vault, and the admin picks the channels agents may post to (kept in the
// connection's config). `slack.message.post` is the one tool: external, create, entity `message`,
// behind approval by default, posted once (the attempt recorded before Slack is called, since
// `chat.postMessage` takes no idempotency key). Nothing here reads messages: we hold no history
// scope. Listing channels is for the admin's picker, not an agent tool. Disconnect calls
// `auth.revoke`. Unchecked facts about Slack: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { WriteAttemptServices } from "../attempts";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { cleanSlackText, SLACK_TEXT_MAX, slackMessage } from "./text";

export const SLACK_CONNECTOR_ID = "slack";
export const SLACK_POST_TOOL = "slack.message.post";

export const SLACK_ORIGIN = "https://slack.com";
export const SLACK_AUTHORIZE_URL = `${SLACK_ORIGIN}/oauth/v2/authorize`;
export const SLACK_API = `${SLACK_ORIGIN}/api`;

// DECISION: bot scopes `chat:write` (post where the bot is a member) and `channels:read` (list
// public channels for the admin's picker); no `chat:write.public`, no history scope, no user
// scopes. Private channels are out: they would need `groups:read` to be listed, and a client who
// wants one can ask; adding it is one scope and the picker's `types` (plan §1.56).
export const SLACK_SCOPES: readonly string[] = ["chat:write", "channels:read"];
const ALLOWED_SCOPES = new Set(SLACK_SCOPES);

/** At most this many channels picked per connection, and listed for the picker. */
export const SLACK_MAX_PICKED = 50;
export const SLACK_MAX_LISTED = 2000;
const LIST_PAGE = 200;
/** Answers longer than this are refused unread (a page of 200 channels is far smaller). */
const MAX_ANSWER_CHARS = 2_000_000;
/** After this many refused attempts under one key, the action stops trying. */
const MAX_ATTEMPTS = 5;

/** A Slack id (team, user, channel, app): upper-case letters and digits (index checks). */
export function isSlackId(value: string): boolean {
  if (value.length < 2 || value.length > 24) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a))) return false;
  }
  return true;
}

const SlackId = z.string().refine(isSlackId, "not a Slack id");

/** A channel's name as Slack gives it, without `#`: lower case, at most 80 characters. */
const ChannelName = z.string().min(1).max(80);

export const SlackChannelRef = z.object({ id: SlackId, name: ChannelName });
export type SlackChannelRef = z.infer<typeof SlackChannelRef>;

/** The client admin's picks, for the workspace they were made in. */
export const SlackPicked = z.object({
  teamId: SlackId,
  channels: z.array(SlackChannelRef).max(SLACK_MAX_PICKED),
});

/** `connection.config`: the workspace, the bot, the scopes and the picked channels. Never a token. */
export const SlackConfig = z.looseObject({
  teamId: SlackId,
  teamName: z.string(),
  /** Shown on the Connections card (the workspace's name). */
  accountName: z.string().optional(),
  botUserId: SlackId,
  appId: SlackId,
  scopes: z.array(z.string()),
  picked: SlackPicked.optional(),
});
export type SlackConfig = z.infer<typeof SlackConfig>;

/** The encrypted credentials: the bot token and what it belongs to. */
export const SlackCredentials = z.object({
  accessToken: z.string().min(8),
  tokenType: z.literal("bot"),
  scope: z.string(),
  teamId: SlackId,
  botUserId: SlackId,
  appId: SlackId,
});
export type SlackCredentials = z.infer<typeof SlackCredentials>;

/** The channels picked for this connection's workspace (picks from another workspace don't count). */
// DECISION: picks carry the workspace they were made in, so reconnecting to another workspace (a
// reconnect keeps the old config) leaves none picked instead of pointing at the old ids.
export function slackPickedChannels(config: unknown): SlackChannelRef[] {
  const c = SlackConfig.safeParse(config);
  if (!c.success || !c.data.picked || c.data.picked.teamId !== c.data.teamId) return [];
  return c.data.picked.channels;
}

/** The config with these channels picked (replacing the picks), for the admin's route. */
export function withSlackPicks(config: unknown, channels: SlackChannelRef[]): JsonObject {
  const c = SlackConfig.parse(config);
  const seen = new Set<string>();
  const unique = channels.filter((ch) => !seen.has(ch.id) && seen.add(ch.id));
  return {
    ...(c as JsonObject),
    picked: SlackPicked.parse({ teamId: c.teamId, channels: unique }) as unknown as JsonObject,
  };
}

/** The tool's input: plain words to a picked channel. No blocks, no attachments, nothing else. */
export const SlackPostInput = z.strictObject({
  channel: z
    .string()
    .trim()
    .min(1)
    .max(81)
    .describe("A channel the client picked: its name (e.g. #orders) or its id"),
  text: z
    .string()
    .min(1)
    .max(SLACK_TEXT_MAX)
    .describe("Plain text. Shown as written: no formatting, links or mentions"),
});
export type SlackPostInput = z.infer<typeof SlackPostInput>;

export const SlackPostOutput = z.object({
  channel: z.string(),
  channelName: z.string(),
  /** Slack's id of the posted message (its timestamp in the channel). */
  ts: z.string(),
  workspace: z.string(),
});
export type SlackPostOutput = z.infer<typeof SlackPostOutput>;

/** What the approver sees and `external_action.before` keeps: the message as it would show. */
export const SlackPostBefore = z.object({
  workspace: z.string(),
  channel: SlackChannelRef,
  text: z.string(),
});

export class SlackApiError extends Error {
  constructor(
    readonly status: number,
    /** Slack's error code (`not_in_channel`), or ours when Slack gave none. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export class SlackNotConfiguredError extends Error {
  constructor() {
    super("Slack sign-in is not set up on this deployment (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET)");
    this.name = "SlackNotConfiguredError";
  }
}

/** A post to a channel the client admin didn't pick. */
export class SlackChannelNotPickedError extends Error {
  constructor(channel: string) {
    super(`${channel} is not one of the channels the client picked for agents`);
    this.name = "SlackChannelNotPickedError";
  }
}

/** Slack's answers that mean the token is gone: the client must install the app again. */
const AUTH_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "no_permission",
  "team_access_not_granted",
  "ekm_access_denied",
  "invalid_token",
]);

/** Plain words for Slack's refusals of a post (the rest pass Slack's code through). */
const POST_REFUSALS: ReadonlyMap<string, (channel: string) => string> = new Map([
  ["not_in_channel", (c) => `the Mezonas app isn't in #${c}; add it to the channel in Slack first`],
  ["channel_not_found", (c) => `Slack can't find #${c}; it may be gone or private now`],
  ["is_archived", (c) => `#${c} is archived`],
  ["restricted_action", (c) => `the workspace doesn't let apps post in #${c}`],
  ["ratelimited", (c) => `Slack asked us to slow down posting to #${c}; try again in a minute`],
  ["msg_too_long", () => "Slack refused the message as too long"],
  ["no_text", () => "the message has no text"],
] satisfies [string, (channel: string) => string][]);

export interface SlackOptions {
  /** Our Slack app ("Mezonas"): its client id and client secret. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

export interface SlackChannelListing {
  id: string;
  name: string;
  /** Whether the bot is in the channel (it can only post where it is). */
  isMember: boolean;
}

export interface SlackConnector extends Connector {
  /**
   * The workspace's public channels (not archived), for the client admin's picker. Not a tool:
   * no agent can call it. At most SLACK_MAX_LISTED.
   */
  listChannels(ctx: ConnectionContext): Promise<SlackChannelListing[]>;
}

export function isSlackConnector(c: Connector | undefined): c is SlackConnector {
  return (
    c?.manifest.id === SLACK_CONNECTOR_ID &&
    typeof (c as Partial<SlackConnector>).listChannels === "function"
  );
}

const OAuthAnswer = z.union([
  z.looseObject({
    ok: z.literal(true),
    access_token: z.string().min(8),
    token_type: z.string(),
    scope: z.string(),
    bot_user_id: z.string(),
    app_id: z.string(),
    team: z.looseObject({ id: z.string(), name: z.string() }).nullable().optional(),
    is_enterprise_install: z.boolean().optional(),
    authed_user: z.looseObject({ access_token: z.string().optional() }).optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  }),
  z.looseObject({ ok: z.literal(false), error: z.string() }),
]);

const ApiAnswer = z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.looseObject({ ok: z.literal(false), error: z.string() }),
]);

const ListAnswer = z.looseObject({
  ok: z.literal(true),
  channels: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        is_archived: z.boolean().optional(),
        is_private: z.boolean().optional(),
        is_member: z.boolean().optional(),
      }),
    )
    .max(1000),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional(),
});

const PostAnswer = z.looseObject({ ok: z.literal(true), channel: z.string(), ts: z.string() });

/** Parses Slack's JSON answer, or null when it isn't JSON (or is far too long to be Slack's). */
async function readAnswer(res: { text(): Promise<string> }): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_ANSWER_CHARS) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function attemptServices(ctx: ToolContext): WriteAttemptServices {
  const s = ctx.services?.attempts;
  if (!s) throw new Error("Slack posts need the platform's record of attempts");
  return s;
}

async function credentialsOf(ctx: ConnectionContext): Promise<SlackCredentials> {
  const creds = SlackCredentials.safeParse(await ctx.credentials.get());
  if (!creds.success) throw new ReconnectRequiredError("the Slack connection has no valid token");
  return creds.data;
}

function configOf(ctx: ConnectionContext): SlackConfig {
  const c = SlackConfig.safeParse(ctx.connection.config);
  if (!c.success) throw new ReconnectRequiredError("the Slack connection has no workspace");
  return c.data;
}

/**
 * The picked channel the input names: its id, or its name with or without `#` (any case).
 * Anything else is refused, picked in another workspace included.
 */
export function pickedChannel(config: unknown, named: string): SlackChannelRef {
  const wanted = named.trim();
  const bare = (wanted.startsWith("#") ? wanted.slice(1) : wanted).toLowerCase();
  const picks = slackPickedChannels(config);
  const found = picks.find((c) => c.id === wanted) ?? picks.find((c) => c.name === bare);
  if (!found) throw new SlackChannelNotPickedError(wanted.startsWith("#") ? wanted : `#${bare}`);
  return found;
}

export function createSlackConnector(options: SlackOptions = {}): SlackConnector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new SlackNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  /** A Web API method with the bot token: JSON in, Slack's answer (or null) out. */
  async function api(
    method: string,
    token: string,
    init: { json?: JsonObject; query?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ status: number; answer: unknown; retryAfter: string | null }> {
    const query = init.query ? `?${formEncode(init.query)}` : "";
    const res = await doFetch()(`${SLACK_API}/${method}${query}`, {
      method: init.json ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.json ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
      redirect: "manual",
      signal: timeoutSignal(init.timeoutMs ?? 15_000),
    });
    return {
      status: res.status,
      answer: await readAnswer(res),
      retryAfter: res.headers.get("retry-after"),
    };
  }

  /** `auth.revoke` for a token; an already revoked token is not an error. */
  async function revokeToken(token: string): Promise<void> {
    const { status, answer } = await api("auth.revoke", token, { json: {} });
    const parsed = ApiAnswer.safeParse(answer);
    if (parsed.success && (parsed.data.ok || AUTH_ERRORS.has(parsed.data.error))) return;
    throw new SlackApiError(
      status,
      parsed.success && !parsed.data.ok ? parsed.data.error : "unexpected_answer",
      `Slack didn't revoke the token (${status})`,
    );
  }

  async function listChannels(ctx: ConnectionContext): Promise<SlackChannelListing[]> {
    const creds = await credentialsOf(ctx);
    const out: SlackChannelListing[] = [];
    let cursor = "";
    for (let page = 0; page < SLACK_MAX_LISTED / LIST_PAGE; page++) {
      const { status, answer } = await api("conversations.list", creds.accessToken, {
        query: {
          types: "public_channel",
          exclude_archived: "true",
          limit: String(LIST_PAGE),
          ...(cursor ? { cursor } : {}),
        },
      });
      const refused = ApiAnswer.safeParse(answer);
      if (refused.success && !refused.data.ok) {
        if (AUTH_ERRORS.has(refused.data.error)) {
          throw new ReconnectRequiredError(`Slack refused the token: ${refused.data.error}`);
        }
        throw new SlackApiError(
          status,
          refused.data.error,
          `Slack didn't list the channels (${refused.data.error})`,
        );
      }
      const listed = ListAnswer.safeParse(answer);
      if (!listed.success) {
        throw new SlackApiError(status, "unexpected_answer", "Slack's channel list was unreadable");
      }
      for (const ch of listed.data.channels) {
        if (ch.is_archived || ch.is_private || !isSlackId(ch.id)) continue;
        if (!ChannelName.safeParse(ch.name).success) continue;
        out.push({ id: ch.id, name: ch.name, isMember: ch.is_member === true });
      }
      cursor = listed.data.response_metadata?.next_cursor ?? "";
      if (!cursor || out.length >= SLACK_MAX_LISTED) break;
    }
    return out.slice(0, SLACK_MAX_LISTED).sort((a, b) => a.name.localeCompare(b.name));
  }

  const connector = defineConnector({
    id: SLACK_CONNECTOR_ID,
    name: "Slack",
    description: "Post messages to the Slack channels you pick. We can't read your messages.",
    icon: "message",
    auth: "oauth2",
    entities: [],
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        // Slack's bot scopes are comma-separated; no `user_scope`: we act as the bot only.
        scope: SLACK_SCOPES.join(","),
        redirect_uri: req.redirectUri,
        state: req.state,
      });
      return { redirectUrl: `${SLACK_AUTHORIZE_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Slack callback has no code");
      const c = client();
      const res = await doFetch()(`${SLACK_API}/oauth.v2.access`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: formEncode({
          client_id: c.id,
          client_secret: c.secret,
          code,
          redirect_uri: req.redirectUri,
        }),
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      const parsed = OAuthAnswer.safeParse(await readAnswer(res));
      if (!parsed.success)
        throw new SlackApiError(
          res.status,
          "unexpected_answer",
          "Slack's token answer has an unexpected shape",
        );
      const answer = parsed.data;
      if (!answer.ok) throw new Error(`Slack refused the sign-in: ${answer.error}`);

      // Refused grants: nothing is stored, and the tokens Slack just gave are revoked (best effort).
      const refuse = async (message: string): Promise<never> => {
        for (const t of [answer.access_token, answer.authed_user?.access_token]) {
          if (t) await revokeToken(t).catch(() => {});
        }
        throw new SignInRefusedError(message);
      };
      // DECISION: one workspace per connection. An org-wide (Enterprise Grid) install has no single
      // team and would reach every workspace in the organization, so it is refused.
      if (answer.is_enterprise_install || !answer.team) {
        return refuse("Install Mezonas into one Slack workspace, not the whole organization");
      }
      if (answer.token_type !== "bot") {
        return refuse("Slack didn't give us a bot token; connect again");
      }
      const scopes = answer.scope
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!scopes.includes("chat:write")) {
        return refuse("Slack didn't give us permission to post. Connect again and allow it.");
      }
      if (scopes.some((s) => !ALLOWED_SCOPES.has(s)) || answer.authed_user?.access_token) {
        return refuse("Slack gave more access than we ask for, so we didn't keep it");
      }
      // DECISION: token rotation stays off on our Slack app, so a bot token doesn't expire; an
      // answer with a refresh token means the app was changed, and is refused (NOTES.md).
      if (answer.refresh_token || answer.expires_in) {
        return refuse("Slack gave an expiring token, which we don't keep; ask us to check the app");
      }
      if (![answer.team.id, answer.bot_user_id, answer.app_id].every(isSlackId)) {
        return refuse("Slack's answer didn't name the workspace and bot");
      }
      const teamName = answer.team.name.trim().slice(0, 200) || answer.team.id;
      const credentials = SlackCredentials.parse({
        accessToken: answer.access_token,
        tokenType: "bot",
        scope: scopes.join(","),
        teamId: answer.team.id,
        botUserId: answer.bot_user_id,
        appId: answer.app_id,
      });
      return {
        externalAccountId: answer.team.id,
        credentials: credentials as unknown as JsonObject,
        config: {
          teamId: answer.team.id,
          teamName,
          accountName: teamName,
          botUserId: answer.bot_user_id,
          appId: answer.app_id,
          scopes,
        },
      };
    },

    // DECISION: disconnect revokes the bot token at Slack (`auth.revoke`), then the platform drops
    // it. The app stays listed in the workspace until an admin removes it there (NOTES.md).
    async revoke(ctx) {
      const creds = SlackCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success) return;
      await revokeToken(creds.data.accessToken);
    },

    tools: [
      defineWriteTool({
        id: SLACK_POST_TOOL,
        entity: "message",
        description:
          "Post a plain-text message to a Slack channel the client picked. Shown as written: no formatting, links or mentions.",
        verb: "create",
        // R5: a post can't be taken back.
        undo: { kind: "none" },
        summary: "Posted in #{{channelName}} on Slack",
        input: SlackPostInput,
        output: SlackPostOutput,
        beforeSchema: SlackPostBefore,
        async before(input, ctx) {
          const config = configOf(ctx);
          const channel = pickedChannel(config, input.channel);
          const text = cleanSlackText(input.text);
          if (!text.trim()) throw new Error("the message has no text");
          return { workspace: config.teamName, channel, text };
        },
        async run(input, ctx) {
          const attempts = attemptServices(ctx);
          const key = ctx.idempotencyKey;
          // A re-run after the post was recorded returns it, before any check.
          const state = await attempts.stateFor(key);
          if (state.done) return SlackPostOutput.parse(state.done);
          // DECISION: chat.postMessage takes no idempotency key and we can't read the channel to
          // check (no history scope), so an attempt started without Slack's answer is never posted
          // again: the action fails as unconfirmed and the operator checks the channel. An attempt
          // Slack refused with an answer posted nothing and may be tried again (plan §1.56).
          if (state.started > state.refused) {
            const last = state.last;
            throw new UnconfirmedWriteError(
              `The Slack message to #${String(last?.details.channelName ?? input.channel)} may have been posted`,
              `we started it at ${last?.startedAt.toISOString() ?? "an unknown time"} and have no answer from Slack, and we can't read the channel to check`,
              {
                channel: "slack",
                ...(last?.details ?? {}),
                ...(last ? { startedAt: last.startedAt.toISOString() } : {}),
              },
            );
          }
          if (state.started >= MAX_ATTEMPTS) {
            throw new Error(`Slack refused this message ${state.started} times; we stopped trying`);
          }
          const config = configOf(ctx);
          // Checked again at the post: the admin may have unpicked the channel since approval.
          const channel = pickedChannel(config, input.channel);
          if (!cleanSlackText(input.text).trim()) throw new Error("the message has no text");
          const creds = await credentialsOf(ctx);
          if (creds.teamId !== config.teamId) {
            throw new ReconnectRequiredError("the Slack token is for another workspace");
          }
          const message = slackMessage(input.text);
          const attempt = state.started + 1;
          const details: JsonObject = {
            workspace: config.teamName,
            teamId: config.teamId,
            channelId: channel.id,
            channelName: channel.name,
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
              `The Slack message to #${channel.name} may have been posted`,
              "another run of this action started posting it at the same time",
              { channel: "slack", ...details },
            );
          }
          // A network failure or timeout throws here with the attempt open: unconfirmed on retry.
          const { status, answer, retryAfter } = await api("chat.postMessage", creds.accessToken, {
            json: {
              channel: channel.id,
              text: message.text,
              blocks: message.blocks as unknown as JsonObject[],
              // Nothing of ours turns names into mentions, links into previews, or text into mrkdwn.
              parse: "none",
              link_names: false,
              unfurl_links: false,
              unfurl_media: false,
            },
            timeoutMs: 30_000,
          });
          const posted = PostAnswer.safeParse(answer);
          if (posted.success) {
            const output: SlackPostOutput = {
              channel: posted.data.channel,
              channelName: channel.name,
              ts: posted.data.ts,
              workspace: config.teamName,
            };
            await attempts.done({ idempotencyKey: key, output, at: ctx.now() });
            return output;
          }
          const refused = ApiAnswer.safeParse(answer);
          // Slack answered and posted nothing: an `ok: false`, or a 429 (rate limit) of any shape.
          if ((refused.success && !refused.data.ok) || status === 429) {
            const code =
              refused.success && !refused.data.ok
                ? refused.data.error
                : status === 429
                  ? "ratelimited"
                  : "unexpected_answer";
            await attempts.refused({ idempotencyKey: key, attempt, reason: code, at: ctx.now() });
            if (AUTH_ERRORS.has(code)) {
              throw new ReconnectRequiredError(`Slack refused the token: ${code}`);
            }
            const words = POST_REFUSALS.get(code)?.(channel.name);
            throw new SlackApiError(
              status,
              code,
              `${words ?? `Slack refused the message (${code})`}${retryAfter && code === "ratelimited" ? ` (retry after ${Number.parseInt(retryAfter, 10) || 1} s)` : ""}`,
            );
          }
          // A 5xx or an answer we can't read: Slack may have posted it; the attempt stays open.
          throw new SlackApiError(
            status,
            "no_answer",
            `Slack didn't say whether the message to #${channel.name} was posted (${status})`,
          );
        },
      }),
    ],
  });
  return { ...connector, listChannels };
}
