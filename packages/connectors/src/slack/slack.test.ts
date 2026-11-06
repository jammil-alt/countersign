// v0.14 W4-C: the slack connector against a fake Slack (docs/plan.md §1.56). Sign-in asks for the
// bot scopes `chat:write,channels:read` only and refuses (storing nothing, revoking what Slack gave)
// an org-wide install, a grant without `chat:write`, one with more, a user token, an expiring
// token; the token is in the credentials only. Channels list for the admin's picker; picks hold
// for their own workspace. `slack.message.post` is behind approval by default (also with an `auto`
// matrix in act mode), refuses a channel not picked, posts plain text once per key (a lost answer
// is never posted again; a refusal Slack answered may be tried again), and never lets a mention
// through. Disconnect revokes the token.
import { DEFAULT_PERMISSIONS, decideToolCall, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteAttemptServices, WriteAttemptState } from "../attempts";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode, parseUrl } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import { FAKE_SLACK, fakeSlack } from "./fake";
import {
  createSlackConnector,
  isSlackConnector,
  pickedChannel,
  SLACK_AUTHORIZE_URL,
  SLACK_POST_TOOL,
  SlackChannelNotPickedError,
  slackPickedChannels,
  withSlackPicks,
} from "./index";
import { breakBroadcasts, cleanSlackText, escapeSlackText, slackMessage } from "./text";

const REDIRECT = "https://staging.mezonas.com/connections/slack/callback";
const NOW = new Date("2026-11-06T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const KEY = "0192f7a0-run:post:post:0";

function memoryAttempts() {
  const started = new Map<string, { details: JsonObject; at: Date }>();
  const refused = new Set<string>();
  const done = new Map<string, JsonObject>();
  const s: WriteAttemptServices = {
    async stateFor(key): Promise<WriteAttemptState> {
      const mine = [...started.entries()].filter(([k]) => k.startsWith(`${key}#`));
      const last = mine.at(-1)?.[1];
      return {
        done: done.get(key) ?? null,
        started: mine.length,
        refused: [...refused].filter((k) => k.startsWith(`${key}#`)).length,
        last: last ? { details: last.details, startedAt: last.at } : null,
      };
    },
    async start({ idempotencyKey, attempt, details, at }) {
      const k = `${idempotencyKey}#${attempt}`;
      if (started.has(k)) return false;
      started.set(k, { details, at });
      return true;
    },
    async refused({ idempotencyKey, attempt }) {
      refused.add(`${idempotencyKey}#${attempt}`);
    },
    async done({ idempotencyKey, output }) {
      if (!done.has(idempotencyKey)) done.set(idempotencyKey, output);
    },
  };
  return { s, started, refused, done };
}

async function signIn(slack = fakeSlack(), code = slack.issueCode()) {
  const connector = createSlackConnector({ ...FAKE_SLACK, fetch: slack.fetch });
  const grant = await connector.handleCallback?.(
    { code, state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, slack };
}

async function setup(
  picks: { id: string; name: string }[] = [{ id: "C0ORDERS01", name: "orders" }],
) {
  const { connector, grant, slack } = await signIn();
  const attempts = memoryAttempts();
  const credentials = memoryCredentials(grant.credentials);
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000005",
    tenantId: TENANT,
    connector: "slack",
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: withSlackPicks(grant.config, picks),
    permissions: {},
  };
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { attempts: attempts.s },
    idempotencyKey: KEY,
  };
  return { connector, slack, ctx, grant, ...attempts };
}

const ORDER = { channel: "#orders", text: "Order 1042 from Hardwood Supply arrives Friday." };

describe("slack sign-in", () => {
  it("installs a bot with chat:write and channels:read only", async () => {
    const connector = createSlackConnector(FAKE_SLACK);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createSlackConnector({}).isConfigured?.()).toBe(false);
    expect(isSlackConnector(connector)).toBe(true);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const url = parseUrl(redirectUrl);
    expect(`${url?.origin}${url?.pathname}`).toBe(SLACK_AUTHORIZE_URL);
    expect(formDecode(redirectUrl.split("?")[1] ?? "")).toEqual({
      client_id: FAKE_SLACK.clientId,
      scope: "chat:write,channels:read",
      redirect_uri: REDIRECT,
      state: "the-state",
    });
  });

  it("keeps the token in the credentials and the workspace in the config", async () => {
    const { grant, slack } = await signIn();
    const [token] = slack.issued().botTokens;
    expect(grant.externalAccountId).toBe("T0ACMEMILL");
    expect(grant.credentials).toEqual({
      accessToken: token,
      tokenType: "bot",
      scope: "chat:write,channels:read",
      teamId: "T0ACMEMILL",
      botUserId: "U0MEZONAS1",
      appId: "A0MEZONAS1",
    });
    expect(grant.config).toEqual({
      teamId: "T0ACMEMILL",
      teamName: "Acme Millwork",
      accountName: "Acme Millwork",
      botUserId: "U0MEZONAS1",
      appId: "A0MEZONAS1",
      scopes: ["chat:write", "channels:read"],
    });
    expect(JSON.stringify(grant.config)).not.toContain("xoxb-");
    const exchange = slack.requests.find((r) => r.url.endsWith("/oauth.v2.access"));
    expect(formDecode(exchange?.body ?? "")).toMatchObject({ redirect_uri: REDIRECT });
  });

  it.each([
    ["an org-wide install", { enterprise: true }, /one Slack workspace/],
    ["a grant without chat:write", { scopes: ["channels:read"] }, /permission to post/],
    [
      "a grant with more",
      { scopes: ["chat:write", "channels:read", "channels:history"] },
      /more access/,
    ],
    ["a user token", { userToken: true }, /more access/],
    ["an expiring token", { rotation: true }, /expiring token/],
  ])("refuses %s, keeps nothing and revokes what Slack gave", async (_name, opts, words) => {
    const slack = fakeSlack();
    const refused = signIn(slack, slack.issueCode(opts));
    await expect(refused).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(refused).rejects.toThrow(words);
    expect(slack.revoked()).toEqual(slack.issued().botTokens);
  });

  it("refuses a code Slack doesn't know", async () => {
    const slack = fakeSlack();
    await expect(signIn(slack, "not-a-code")).rejects.toThrow(/invalid_code/);
  });

  it("revokes the token on disconnect; an already revoked token is fine", async () => {
    const { connector, ctx, slack } = await setup();
    await connector.revoke?.(ctx);
    expect(slack.revoked()).toEqual(slack.issued().botTokens);
    await connector.revoke?.(ctx);
    await expect(connector.listChannels(ctx)).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("slack channels", () => {
  it("lists public channels that aren't archived, for the picker, with the bot's membership", async () => {
    const { connector, ctx } = await setup();
    expect(await connector.listChannels(ctx)).toEqual([
      { id: "C0ACCTS001", name: "accounts", isMember: true },
      { id: "C0GENERAL1", name: "general", isMember: false },
      { id: "C0ORDERS01", name: "orders", isMember: true },
    ]);
  });

  it("pages through Slack's cursor", async () => {
    const { connector, ctx, slack } = await setup();
    for (let i = 0; i < 450; i++) {
      slack.channels.push({
        id: `C0MANY${String(i).padStart(4, "0")}`,
        name: `c-${i}`,
        member: false,
      });
    }
    expect(await connector.listChannels(ctx)).toHaveLength(453);
    expect(slack.requests.filter((r) => r.url.includes("conversations.list"))).toHaveLength(3);
  });

  it("holds picks only for their own workspace", async () => {
    const { grant } = await signIn();
    const config = withSlackPicks(grant.config, [
      { id: "C0ORDERS01", name: "orders" },
      { id: "C0ORDERS01", name: "orders" },
    ]);
    expect(slackPickedChannels(config)).toEqual([{ id: "C0ORDERS01", name: "orders" }]);
    expect(pickedChannel(config, "#Orders").id).toBe("C0ORDERS01");
    expect(pickedChannel(config, "C0ORDERS01").id).toBe("C0ORDERS01");
    expect(() => pickedChannel(config, "general")).toThrow(SlackChannelNotPickedError);
    // Reconnected to another workspace: the old picks don't count.
    const moved = { ...config, teamId: "T0OTHERWS1" };
    expect(slackPickedChannels(moved)).toEqual([]);
    expect(() => pickedChannel(moved, "orders")).toThrow(SlackChannelNotPickedError);
  });
});

describe("slack.message.post", () => {
  it("is behind approval by default, also with an auto matrix in act mode", async () => {
    const { connector } = await setup();
    expect(connector.manifest.defaultPermissions).toBeUndefined();
    const spec = connector.manifest.tools.find((t) => t.id === SLACK_POST_TOOL);
    expect(spec).toMatchObject({ sideEffect: "external", verb: "create", entity: "message" });
    expect(connector.manifest.tools).toHaveLength(1);
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ create: "approval", delete: "off" });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    const auto = { ...matrix, create: "auto" as const };
    // A step that says nothing about approval waits for a person, whatever the matrix and mode.
    expect(
      decideToolCall({ sideEffect: "external", verb: "create", matrix: auto, agentMode: "act" }),
    ).toBe("approval");
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: auto,
        stepApproval: "required",
        agentMode: "act",
      }),
    ).toBe("approval");
    // Only the operator's step setting and an `auto` matrix together let it run on its own.
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: auto,
        stepApproval: "not_required",
        agentMode: "act",
      }),
    ).toBe("run");
  });

  it("takes plain words only: no blocks or other fields", async () => {
    const { connector, ctx, slack } = await setup();
    await expect(
      executeWrite(
        connector,
        SLACK_POST_TOOL,
        { ...ORDER, blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!channel>" } }] },
        ctx,
      ),
    ).rejects.toThrow();
    expect(slack.posted).toHaveLength(0);
  });

  it("records what would be posted as its before state, and posts nothing then", async () => {
    const { connector, ctx, slack } = await setup();
    const { before } = await captureBefore(connector, SLACK_POST_TOOL, ORDER, ctx);
    expect(before).toEqual({
      workspace: "Acme Millwork",
      channel: { id: "C0ORDERS01", name: "orders" },
      text: ORDER.text,
    });
    expect(slack.posted).toHaveLength(0);
  });

  it("refuses a channel the client didn't pick, before and at the post", async () => {
    const { connector, ctx, slack, started } = await setup();
    // In the workspace and the bot is in it, but not picked.
    const other = { ...ORDER, channel: "#accounts" };
    await expect(captureBefore(connector, SLACK_POST_TOOL, other, ctx)).rejects.toThrow(
      /#accounts is not one of the channels the client picked/,
    );
    await expect(executeWrite(connector, SLACK_POST_TOOL, other, ctx)).rejects.toBeInstanceOf(
      SlackChannelNotPickedError,
    );
    // Picked when approved, unpicked before the post.
    const unpicked = {
      ...ctx,
      connection: { ...ctx.connection, config: withSlackPicks(ctx.connection.config, []) },
    };
    await expect(executeWrite(connector, SLACK_POST_TOOL, ORDER, unpicked)).rejects.toBeInstanceOf(
      SlackChannelNotPickedError,
    );
    expect(slack.posted).toHaveLength(0);
    expect(started.size).toBe(0);
  });

  it("posts an approved message once: plain text, no mentions, no previews", async () => {
    const { connector, ctx, slack, started, done } = await setup();
    const first = await executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx);
    expect(first.output).toEqual({
      channel: "C0ORDERS01",
      channelName: "orders",
      ts: slack.posted[0]?.ts,
      workspace: "Acme Millwork",
    });
    expect(first.summary).toBe("Posted in #orders on Slack");
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]?.body).toEqual({
      channel: "C0ORDERS01",
      text: ORDER.text,
      blocks: [{ type: "section", text: { type: "plain_text", text: ORDER.text, emoji: true } }],
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    // The attempt was recorded before Slack was called, and the post once after.
    expect(started.get(`${KEY}#1`)?.details).toMatchObject({ channelId: "C0ORDERS01" });
    expect(done.get(KEY)).toEqual(first.output);

    // The same key again (a retried step): what was posted comes back; nothing is posted.
    const again = await executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx);
    expect(again.output).toEqual(first.output);
    expect(slack.posted).toHaveLength(1);
  });

  it("never posts again after a lost answer", async () => {
    const { connector, ctx, slack } = await setup();
    slack.loseNextAnswer();
    await expect(executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx)).rejects.toThrow(
      /network connection lost/,
    );
    // Slack posted it; we never heard. The retry doesn't post again.
    expect(slack.posted).toHaveLength(1);
    const retry = executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx);
    await expect(retry).rejects.toBeInstanceOf(UnconfirmedWriteError);
    await expect(retry).rejects.toThrow(/message to #orders may have been posted/);
    expect(slack.posted).toHaveLength(1);

    // A 500 with no answer is the same: whether it posted is unknown.
    const other = await setup();
    other.slack.breakNext();
    await expect(executeWrite(other.connector, SLACK_POST_TOOL, ORDER, other.ctx)).rejects.toThrow(
      /didn't say whether/,
    );
    await expect(
      executeWrite(other.connector, SLACK_POST_TOOL, ORDER, other.ctx),
    ).rejects.toBeInstanceOf(UnconfirmedWriteError);
    expect(other.slack.posted).toHaveLength(0);
  });

  it("may try again after Slack refused with an answer, and says why in plain words", async () => {
    const { connector, ctx, slack, refused } = await setup();
    slack.refuseNext(1, "ratelimited", 429);
    await expect(executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx)).rejects.toThrow(
      /slow down posting to #orders.*retry after 30 s/,
    );
    expect(refused.has(`${KEY}#1`)).toBe(true);
    const out = await executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx);
    expect((out.output as { ts: string }).ts).toBe(slack.posted[0]?.ts);
    expect(slack.posted).toHaveLength(1);

    // The bot isn't in a picked channel: Slack says so and nothing is posted.
    const general = await setup([{ id: "C0GENERAL1", name: "general" }]);
    await expect(
      executeWrite(
        general.connector,
        SLACK_POST_TOOL,
        { ...ORDER, channel: "general" },
        general.ctx,
      ),
    ).rejects.toThrow(/Mezonas app isn't in #general; add it to the channel/);
    expect(general.slack.posted).toHaveLength(0);
  });

  it("asks for a reconnect when the token was revoked in Slack", async () => {
    const { connector, ctx, slack } = await setup();
    await connector.revoke?.(ctx);
    await expect(executeWrite(connector, SLACK_POST_TOOL, ORDER, ctx)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
    expect(slack.posted).toHaveLength(0);
  });

  it("refuses to run without the platform's record of attempts", async () => {
    const { connector, ctx, slack } = await setup();
    await expect(
      executeWrite(connector, SLACK_POST_TOOL, ORDER, { ...ctx, services: {} }),
    ).rejects.toThrow(/record of attempts/);
    expect(slack.posted).toHaveLength(0);
  });

  it("never lets a mention, a link or formatting through", async () => {
    const { connector, ctx, slack } = await setup();
    const text =
      "<!channel> <!here|here> <!everyone> <@U0ADMIN001> <#C0GENERAL1> <!subteam^S01|@ops> " +
      "<https://evil.example|click> @channel @Here @everyone & *bold*";
    await executeWrite(connector, SLACK_POST_TOOL, { ...ORDER, text }, ctx);
    const body = slack.posted[0]?.body;
    // No `<` survives in the text Slack parses, so no control sequence can form.
    expect(body?.text).not.toMatch(/[<>]/);
    expect(body?.text).toContain("&lt;!channel&gt; &lt;!here|here&gt;");
    expect(body?.text).toContain("&lt;@U0ADMIN001&gt;");
    expect(body?.text).toContain("&amp; *bold*");
    for (const word of ["@channel", "@Here", "@everyone"]) {
      expect(body?.text).not.toContain(word);
      expect(body?.blocks?.[0]?.text?.text).not.toContain(word);
    }
    expect(body?.text).toContain("@⁠channel");
    // The visible message is plain text: Slack shows it as written.
    expect(body?.blocks).toEqual([
      { type: "section", text: { type: "plain_text", text: breakBroadcasts(text), emoji: true } },
    ]);
    expect(body).toMatchObject({ parse: "none", link_names: false });
  });
});

describe("slack text", () => {
  it("escapes Slack's three characters and nothing else", () => {
    expect(escapeSlackText("a < b && c > d *e* _f_ `g`")).toBe(
      "a &lt; b &amp;&amp; c &gt; d *e* _f_ `g`",
    );
  });

  it("breaks whole-word broadcasts only", () => {
    expect(breakBroadcasts("@channel, @HERE! @everyone @channels @herein a@here")).toBe(
      "@⁠channel, @⁠HERE! @⁠everyone @channels @herein a@⁠here",
    );
  });

  it("keeps line breaks and tabs and drops other control characters", () => {
    expect(cleanSlackText("a\r\nb\rc\td\u0000e\u001bf\u0085g﻿h")).toBe("a\nb\nc\tdefgh");
    expect(slackMessage("x\u0007").text).toBe("x");
  });

  it("refuses a message with nothing left to post", async () => {
    const { connector, ctx, slack } = await setup();
    await expect(
      executeWrite(connector, SLACK_POST_TOOL, { ...ORDER, text: "\u0000\u0001" }, ctx),
    ).rejects.toThrow(/no text/);
    expect(slack.posted).toHaveLength(0);
  });
});
