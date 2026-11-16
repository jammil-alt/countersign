// The teams connector against a fake Microsoft: the bot's token is fetched from its own Entra
// tenant, cached, and sent only to allow-listed service URLs; the Bot Connector's tokens on
// activities are verified (signature by a published, endorsed key, issuer, audience, expiry, the
// serviceUrl claim); binding codes work once, for one client, for 15 minutes; channels bind and
// unbind; model text loses every mention, tag and hidden link; `teams.message.post` is behind
// approval by default, refuses a channel the client hasn't bound, and posts once per action.
import { DEFAULT_PERMISSIONS, decideToolCall, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteAttemptServices, WriteAttemptState } from "../attempts";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { connectionDefaults } from "../permissions";
import { toBase64Url, utf8 } from "../runtime";
import { FAKE_TEAMS, fakeTeams } from "./fake";
import {
  allowedServiceUrl,
  BOT_OPENID_URL,
  BotSigningKeys,
  bindTeamsChannel,
  botTokenUrl,
  checkTeamsBindingCode,
  createTeamsConnector,
  findTeamsBindingCode,
  isTeamsConnector,
  makeTeamsBindingCode,
  parseTeamsActivity,
  plainTeamsText,
  readTeamsConfig,
  readTeamsCredentials,
  renameInTeamsConfig,
  TEAMS_MAX_CHANNELS,
  TEAMS_POST_TOOL,
  TEAMS_REPLIES,
  type TeamsActivity,
  type TeamsConfig,
  teamsBindingCodeHash,
  unbindTeamsChannel,
  unbindTeamsTeam,
  verifyBotToken,
} from "./index";

const TENANT_A = "0192f7a0-0000-7000-8000-0000000000aa";
const TENANT_B = "0192f7a0-0000-7000-8000-0000000000bb";
const CONN_A = "0192f7a0-0000-7000-8000-00000000000a";
const CONN_B = "0192f7a0-0000-7000-8000-00000000000b";
const KEY = "0192f7a0-run:post:post:0";
const SERVICE = "https://smba.trafficmanager.net/amer";
const OTHER_CHANNEL = "19:fakeChannelOther000000000000000@thread.tacv2";

const BOUND: TeamsConfig = {
  channels: [
    {
      tenantId: FAKE_TEAMS.clientTenantId,
      teamId: FAKE_TEAMS.teamId,
      teamName: "Acme Millwork",
      channelId: FAKE_TEAMS.channelId,
      channelName: "Orders",
      serviceUrl: SERVICE,
      boundAt: "2026-11-12T15:00:00.000Z",
      boundBy: "Ana Ruiz",
    },
  ],
};

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

function connection(config: TeamsConfig = BOUND): ConnectionRef {
  return {
    id: CONN_A,
    tenantId: TENANT_A,
    connector: "teams",
    status: "connected",
    externalAccountId: null,
    config: config as unknown as ConnectionRef["config"],
    permissions: {},
  };
}

async function setup(config: TeamsConfig = BOUND) {
  const teams = await fakeTeams();
  teams.installIn(FAKE_TEAMS.teamId, [FAKE_TEAMS.teamId, FAKE_TEAMS.channelId], {
    channels: { [FAKE_TEAMS.channelId]: "Orders" },
  });
  const connector = createTeamsConnector({
    appId: teams.appId,
    appSecret: teams.appSecret,
    tenantId: teams.tenantId,
    fetch: teams.fetch,
  });
  const attempts = memoryAttempts();
  const ctx = {
    tenantId: TENANT_A,
    connection: connection(config),
    credentials: memoryCredentials(null),
    logger: noopLogger,
    now: () => new Date(),
    services: { attempts: attempts.s },
    idempotencyKey: KEY,
  };
  return { teams, connector, ctx, ...attempts };
}

const POST = {
  channel: FAKE_TEAMS.channelId,
  text: "Order 1042 from Hardwood Supply arrives Friday.",
};

describe("service URLs", () => {
  it("allows Teams' public host only, as written", () => {
    expect(allowedServiceUrl("https://smba.trafficmanager.net/amer/")).toBe(SERVICE);
    expect(allowedServiceUrl("https://smba.trafficmanager.net/teams")).toBe(
      "https://smba.trafficmanager.net/teams",
    );
    expect(allowedServiceUrl("https://SMBA.trafficmanager.net/amer-client-ss.msg/")).toBe(
      "https://smba.trafficmanager.net/amer-client-ss.msg",
    );
    for (const bad of [
      "http://smba.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net.evil.example/amer/",
      "https://evil.smba.trafficmanager.net/amer/",
      "https://user:pw@smba.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net:8443/amer/",
      "https://smba.trafficmanager.net/amer/?x=1",
      "https://smba.trafficmanager.net/amer/%2e%2e/",
      "https://smba.infra.gcc.teams.microsoft.com/teams",
      "https://evil.example/teams/",
      "",
      null,
    ]) {
      expect(allowedServiceUrl(bad)).toBeNull();
    }
  });
});

describe("the bot's token", () => {
  it("comes from the bot's own Entra tenant for the Bot Connector, and is kept", async () => {
    const { teams, connector, ctx } = await setup();
    let form: Record<string, string> = {};
    const spy: typeof teams.fetch = async (url, init) => {
      if (url === botTokenUrl(FAKE_TEAMS.botTenantId)) form = formDecode(init?.body ?? "");
      return teams.fetch(url, init);
    };
    const c = createTeamsConnector({
      appId: teams.appId,
      appSecret: teams.appSecret,
      tenantId: teams.tenantId,
      fetch: spy,
    });
    await executeWrite(c, TEAMS_POST_TOOL, POST, ctx);
    expect(form).toEqual({
      grant_type: "client_credentials",
      client_id: FAKE_TEAMS.appId,
      client_secret: FAKE_TEAMS.appSecret,
      scope: "https://api.botframework.com/.default",
    });
    expect(botTokenUrl(FAKE_TEAMS.botTenantId)).toBe(
      `https://login.microsoftonline.com/${FAKE_TEAMS.botTenantId}/oauth2/v2.0/token`,
    );

    const tokenCalls = () =>
      teams.requests.filter((r) => r.url === botTokenUrl(FAKE_TEAMS.botTenantId)).length;
    await executeWrite(connector, TEAMS_POST_TOOL, POST, { ...ctx, idempotencyKey: `${KEY}:a` });
    await executeWrite(connector, TEAMS_POST_TOOL, POST, { ...ctx, idempotencyKey: `${KEY}:b` });
    // c fetched one token; the connector one more, kept for its second post.
    expect(tokenCalls()).toBe(2);
    // A refused token (a rotated secret) gets one new token and one retry.
    teams.expireTokens();
    await executeWrite(connector, TEAMS_POST_TOOL, POST, { ...ctx, idempotencyKey: `${KEY}:c` });
    expect(tokenCalls()).toBe(3);
    expect(teams.posts).toHaveLength(4);
  });

  it("goes only to the bot connector at an allow-listed service URL", async () => {
    const evil: TeamsConfig = {
      channels: [
        {
          ...(BOUND.channels[0] as TeamsConfig["channels"][number]),
          serviceUrl: "https://evil.example/teams",
        },
      ],
    };
    // A config written with a foreign service URL doesn't even read as a bound channel.
    expect(readTeamsConfig(evil)).toEqual({ channels: [] });
    const { teams, connector, ctx } = await setup(evil);
    await expect(executeWrite(connector, TEAMS_POST_TOOL, POST, ctx)).rejects.toThrow(
      /isn't connected to this client/,
    );
    // A reply to an activity naming another host is refused before any token is fetched.
    const act = parseTeamsActivity({
      ...(await teams.activity()).json,
      serviceUrl: "https://evil.example/teams/",
    }) as TeamsActivity;
    await expect(connector.reply(act, "badCode")).rejects.toThrow(/isn't one we send to/);
    await executeWrite(connector, TEAMS_POST_TOOL, POST, { ...ctx, connection: connection() });
    for (const r of teams.requests.filter((x) => x.bearer)) {
      expect(r.url.startsWith("https://smba.trafficmanager.net/")).toBe(true);
    }
    expect(teams.requests.some((r) => r.url.includes("evil.example"))).toBe(false);
  });

  it("is not configured without all three settings", async () => {
    const teams = await fakeTeams();
    const full = { appId: teams.appId, appSecret: teams.appSecret, tenantId: teams.tenantId };
    expect(createTeamsConnector(full).isConfigured?.()).toBe(true);
    expect(createTeamsConnector({ ...full, appSecret: undefined }).isConfigured?.()).toBe(false);
    expect(createTeamsConnector({ ...full, tenantId: "common" }).isConfigured?.()).toBe(false);
    expect(createTeamsConnector({ ...full, appId: "mezonas" }).isConfigured?.()).toBe(false);
    expect(isTeamsConnector(createTeamsConnector(full))).toBe(true);
  });
});

describe("activities from the Bot Connector", () => {
  it("are accepted with the Bot Connector's token and refused otherwise", async () => {
    const { teams, connector } = await setup();
    const ok = await teams.activity({ text: "<at>Mezonas</at> MZ-7K2Q-9XHD-4RTM" });
    const accepted = await connector.verifyActivity(ok.headers, ok.body);
    expect(accepted).toMatchObject({
      ok: true,
      activity: {
        type: "message",
        conversation: { kind: "channel" },
        channel: { id: FAKE_TEAMS.channelId },
        team: { id: FAKE_TEAMS.teamId },
        tenantId: FAKE_TEAMS.clientTenantId,
        from: { name: "Ana Ruiz", human: true },
      },
    });
    expect(await connector.verifyWebhook?.(ok.headers, ok.body)).toBe(true);

    const refusal = async (token: Parameters<typeof teams.activity>[1]) => {
      const a = await teams.activity({}, token);
      const r = await connector.verifyActivity(a.headers, a.body);
      return r.ok ? "accepted" : `${r.status} ${r.reason}`;
    };
    expect(await refusal({ iss: "https://sts.windows.net/someone/" })).toBe("401 issuer");
    expect(await refusal({ aud: "00000000-0000-4000-8000-000000000000" })).toBe("401 audience");
    expect(await refusal({ expiresInS: -600 })).toBe("401 expired");
    // Still inside the five minutes' skew.
    expect(await refusal({ expiresInS: -120 })).toBe("accepted");
    expect(await refusal({ signer: "stranger" })).toBe("401 signature");
    expect(await refusal({ kid: "not-published" })).toBe("401 unknown_key");
    // A token for another service URL than the activity's.
    expect(await refusal({ serviceUrl: "https://smba.trafficmanager.net/emea/" })).toBe(
      "401 service_url",
    );

    const a = await teams.activity();
    expect((await connector.verifyActivity({}, a.body)).ok).toBe(false);
    expect((await connector.verifyActivity({ authorization: "Basic x" }, a.body)).ok).toBe(false);
    expect(await connector.verifyActivity(a.headers, new Uint8Array(200 * 1024))).toMatchObject({
      ok: false,
      status: 413,
    });
    // A body changed after signing to point elsewhere: the claim no longer matches.
    const moved = utf8(JSON.stringify({ ...a.json, serviceUrl: "https://evil.example/teams/" }));
    expect(await connector.verifyActivity(a.headers, moved)).toMatchObject({
      ok: false,
      reason: "service_url",
    });
    // `alg: none` (or anything but RS256) is never accepted.
    const [, claims, sig] = a.headers.authorization.slice(7).split(".");
    const none = toBase64Url(utf8(JSON.stringify({ alg: "none", kid: FAKE_TEAMS.keyId })));
    expect(
      await connector.verifyActivity({ authorization: `Bearer ${none}.${claims}.${sig}` }, a.body),
    ).toMatchObject({ ok: false, reason: "algorithm" });
  });

  it("refuses a token signed for a host we don't serve, another bot, or a key not endorsed for Teams", async () => {
    const { teams, connector } = await setup();
    // Signed correctly for a GCC service URL: verified, then refused as off our list.
    const gcc = await teams.activity({
      serviceUrl: "https://smba.infra.gcc.teams.microsoft.com/teams",
    });
    expect(await connector.verifyActivity(gcc.headers, gcc.body)).toMatchObject({
      ok: false,
      status: 403,
      reason: "service_url",
    });
    const other = await teams.activity({ recipientId: "28:00000000-0000-4000-8000-000000000000" });
    expect(await connector.verifyActivity(other.headers, other.body)).toMatchObject({
      ok: false,
      reason: "recipient",
    });

    const fresh = await fakeTeams();
    fresh.dropEndorsements();
    const c = createTeamsConnector({
      appId: fresh.appId,
      appSecret: fresh.appSecret,
      tenantId: fresh.tenantId,
      fetch: fresh.fetch,
    });
    const a = await fresh.activity();
    expect(await c.verifyActivity(a.headers, a.body)).toMatchObject({
      ok: false,
      status: 403,
      reason: "endorsement",
    });
    // Not configured: nothing is accepted.
    const unset = createTeamsConnector({ fetch: teams.fetch });
    expect((await unset.verifyActivity(a.headers, a.body)).ok).toBe(false);
  });

  it("caches the signing keys and refetches for an unknown key at most once a minute", async () => {
    const teams = await fakeTeams();
    let at = Date.now();
    const keys = new BotSigningKeys(
      () => teams.fetch,
      () => new Date(at),
    );
    const fetches = () => teams.requests.filter((r) => r.url === BOT_OPENID_URL).length;
    const check = async (kid?: string) =>
      verifyBotToken(await teams.signToken(SERVICE, kid ? { kid } : {}), {
        appId: FAKE_TEAMS.appId,
        keys,
        now: new Date(),
        serviceUrl: SERVICE,
        channelId: "msteams",
      });
    for (let i = 0; i < 3; i++) expect((await check()).ok).toBe(true);
    expect(fetches()).toBe(1);
    await check("rotated-1");
    await check("rotated-2");
    expect(fetches()).toBe(1);
    at += 61_000;
    await check("rotated-3");
    expect(fetches()).toBe(2);
    // Past 24 hours the keys are fetched again.
    at += 24 * 3600_000;
    await check();
    expect(fetches()).toBe(3);
  });

  it("are read for their kind, channel and team", async () => {
    const teams = await fakeTeams();
    const read = async (o: Parameters<typeof teams.activity>[0]) =>
      parseTeamsActivity((await teams.activity(o)).json);
    expect(
      await read({ type: "conversationUpdate", botAdded: true, eventType: "teamMemberAdded" }),
    ).toMatchObject({
      type: "installed",
      text: null,
    });
    expect(
      await read({ type: "conversationUpdate", botRemoved: true, eventType: "teamMemberRemoved" }),
    ).toMatchObject({
      type: "removed",
      team: { id: FAKE_TEAMS.teamId },
    });
    expect(await read({ type: "installationUpdate", action: "remove" })).toMatchObject({
      type: "removed",
    });
    expect(await read({ type: "conversationUpdate", eventType: "channelDeleted" })).toMatchObject({
      type: "channel_deleted",
    });
    expect(
      await read({
        type: "conversationUpdate",
        eventType: "channelRenamed",
        channelName: "Purchasing",
      }),
    ).toMatchObject({ type: "channel_renamed", channel: { name: "Purchasing" } });
    expect(await read({ type: "conversationUpdate", eventType: "teamDeleted" })).toMatchObject({
      type: "team_deleted",
    });
    expect(await read({ conversationType: "groupChat" })).toMatchObject({
      conversation: { kind: "group_chat" },
      channel: null,
    });
    expect(parseTeamsActivity({ type: "message", channelId: "slack" })).toBeNull();
    expect(parseTeamsActivity("nope")).toBeNull();
  });
});

describe("binding codes", () => {
  const now = new Date("2026-11-12T15:00:00Z");

  it("bind once, for the client and connection they were made for, within 15 minutes", async () => {
    const { code, pending } = await makeTeamsBindingCode({
      tenantId: TENANT_A,
      connectionId: CONN_A,
      createdBy: "user-1",
      now,
    });
    expect(code).toMatch(/^MZ-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(pending.expiresAt).toBe("2026-11-12T15:15:00.000Z");
    expect(JSON.stringify(pending)).not.toContain(code.replace(/-/g, ""));
    const canonical = findTeamsBindingCode(`<at>Mezonas</at> ${code.toLowerCase()}`) as string;
    expect(canonical).toBe(code.replace(/-/g, ""));
    const later = new Date(now.getTime() + 60_000);
    expect(await checkTeamsBindingCode(pending, TENANT_A, CONN_A, canonical, later)).toBe("ok");
    // Wrong code, another client's or connection's: never a match.
    expect(await checkTeamsBindingCode(pending, TENANT_A, CONN_A, "MZ7K2Q9XHD4RTM", later)).toBe(
      "wrong",
    );
    expect(await checkTeamsBindingCode(pending, TENANT_B, CONN_A, canonical, later)).toBe("wrong");
    expect(await checkTeamsBindingCode(pending, TENANT_A, CONN_B, canonical, later)).toBe("wrong");
    // Expired.
    const late = new Date(now.getTime() + 15 * 60_000);
    expect(await checkTeamsBindingCode(pending, TENANT_A, CONN_A, canonical, late)).toBe("expired");
    // Used: the API stores `pendingCode: null`, so the same code again finds nothing.
    const used = readTeamsCredentials({ pendingCode: null });
    expect(await checkTeamsBindingCode(used.pendingCode, TENANT_A, CONN_A, canonical, later)).toBe(
      "none",
    );
    // A Google Chat code's hash never matches a Teams code (different label).
    expect(await teamsBindingCodeHash(TENANT_A, CONN_A, canonical)).toBe(pending.hash);
  });

  it("are found after the bot's mention, in Teams' markup", () => {
    expect(findTeamsBindingCode("<at>Mezonas</at> MZ-7K2Q-9XHD-4RTM")).toBe("MZ7K2Q9XHD4RTM");
    expect(findTeamsBindingCode("<p><at>Mezonas</at>&nbsp;MZ-7K2Q-9XHD-4RTM</p>")).toBe(
      "MZ7K2Q9XHD4RTM",
    );
    expect(findTeamsBindingCode("<at>Mezonas</at>MZ-7K2Q-9XHD-4RTM")).toBe("MZ7K2Q9XHD4RTM");
    // A code inside the mention's own label isn't the code.
    expect(findTeamsBindingCode("<at>MZ-7K2Q-9XHD-4RTM</at> hello")).toBeNull();
    expect(findTeamsBindingCode("<at>Mezonas</at> hello")).toBeNull();
    expect(findTeamsBindingCode(null)).toBeNull();
  });
});

describe("channels", () => {
  const at = new Date("2026-11-12T16:00:00Z");

  it("bind from a channel mention once, never a chat, up to the limit; unbind and rename", async () => {
    const teams = await fakeTeams();
    const mention = parseTeamsActivity(
      (await teams.activity({ teamName: "Acme Millwork", channelName: "Orders" })).json,
    ) as TeamsActivity;
    const empty: TeamsConfig = { channels: [] };
    const r = bindTeamsChannel(empty, mention, at);
    expect(r).toMatchObject({
      ok: true,
      channel: {
        tenantId: FAKE_TEAMS.clientTenantId,
        teamId: FAKE_TEAMS.teamId,
        teamName: "Acme Millwork",
        channelId: FAKE_TEAMS.channelId,
        channelName: "Orders",
        serviceUrl: SERVICE,
        boundAt: at.toISOString(),
        boundBy: "Ana Ruiz",
      },
    });
    if (!r.ok) throw new Error("not bound");
    expect(readTeamsConfig(r.config)).toEqual(r.config);
    expect(bindTeamsChannel(r.config, mention, at)).toEqual({ ok: false, reason: "already" });
    const chat = parseTeamsActivity((await teams.activity({ conversationType: "groupChat" })).json);
    expect(bindTeamsChannel(empty, chat as TeamsActivity, at)).toEqual({
      ok: false,
      reason: "not_channel",
    });
    const personal = parseTeamsActivity(
      (await teams.activity({ conversationType: "personal" })).json,
    );
    expect(bindTeamsChannel(empty, personal as TeamsActivity, at)).toEqual({
      ok: false,
      reason: "not_channel",
    });
    const full: TeamsConfig = {
      channels: Array.from({ length: TEAMS_MAX_CHANNELS }, (_, i) => ({
        ...r.channel,
        channelId: `19:fill${i}@thread.tacv2`,
      })),
    };
    expect(bindTeamsChannel(full, mention, at)).toEqual({ ok: false, reason: "full" });

    const renamed = renameInTeamsConfig(r.config, {
      channelId: FAKE_TEAMS.channelId,
      channelName: "Purchasing",
    });
    expect(renamed.changed).toBe(true);
    expect(renamed.config.channels[0]?.channelName).toBe("Purchasing");
    expect(
      renameInTeamsConfig(r.config, { teamId: "19:x@thread.tacv2", teamName: "x" }).changed,
    ).toBe(false);

    const one = unbindTeamsChannel(r.config, FAKE_TEAMS.channelId);
    expect(one.removed).toHaveLength(1);
    expect(one.config.channels).toEqual([]);
    const two = { channels: [...r.config.channels, { ...r.channel, channelId: OTHER_CHANNEL }] };
    expect(unbindTeamsTeam(two, FAKE_TEAMS.teamId).removed).toHaveLength(2);
  });

  it("reply with fixed lines in the thread that asked, and look up names", async () => {
    const { teams, connector } = await setup();
    const a = parseTeamsActivity(
      (await teams.activity({ text: "<at>Mezonas</at> hi" })).json,
    ) as TeamsActivity;
    await connector.reply(a, "onlyPosts");
    expect(teams.replies).toEqual([
      { conversationId: a.conversation.id, replyToId: a.id, text: TEAMS_REPLIES.onlyPosts },
    ]);
    expect(
      await connector.lookupNames({
        serviceUrl: SERVICE,
        teamId: FAKE_TEAMS.teamId,
        channelId: FAKE_TEAMS.channelId,
      }),
    ).toEqual({ teamName: "Acme Millwork", channelName: "Orders" });
    expect(
      await connector.lookupNames({
        serviceUrl: SERVICE,
        teamId: FAKE_TEAMS.teamId,
        channelId: FAKE_TEAMS.teamId,
      }),
    ).toEqual({ teamName: "Acme Millwork", channelName: "General" });
    teams.uninstallFrom(FAKE_TEAMS.teamId);
    expect(
      await connector.lookupNames({
        serviceUrl: SERVICE,
        teamId: FAKE_TEAMS.teamId,
        channelId: FAKE_TEAMS.channelId,
      }),
    ).toEqual({ teamName: null, channelName: null });
  });
});

describe("plain text for Teams", () => {
  it("drops tags and mentions, writes links out and keeps the rest", () => {
    expect(plainTeamsText("Heads up <at>Ana Ruiz</at>: bill INV-1042 is due.")).toBe(
      "Heads up ‹at>Ana Ruiz‹/at>: bill INV-1042 is due.",
    );
    expect(plainTeamsText('See <a href="https://evil.example">the invoice</a>')).not.toMatch(/<a/);
    expect(plainTeamsText("<img src=https://evil.example/px.gif>")).not.toMatch(/<img/);
    expect(plainTeamsText("See [the invoice](https://evil.example/x)")).toBe(
      "See the invoice (https://evil.example/x)",
    );
    expect(plainTeamsText("![logo](https://evil.example/px.gif)")).toBe(
      "logo (https://evil.example/px.gif)",
    );
    expect(plainTeamsText("[https://mezonas.com](https://mezonas.com)")).toBe(
      "https://mezonas.com",
    );
    expect(plainTeamsText("[click][1]\n[1]: https://evil.example")).toBe(
      "[click] [1]\n[1] : https://evil.example",
    );
    expect(plainTeamsText("2 < 3 and 5 > 4, <3")).toBe("2 < 3 and 5 > 4, <3");
    // Pieces left around a rewritten link can't make a new one.
    expect(plainTeamsText("[[a](b)](https://evil.example)")).toBe("a (b) (https://evil.example)");
    expect(plainTeamsText("a\u0000b\u0007c\r\nd\te‮f")).toBe("abc\nd\tef");
    expect(plainTeamsText("x".repeat(9000))).toHaveLength(4000);
  });
});

describe("teams.message.post", () => {
  it("is an external create behind approval by default", async () => {
    const { connector } = await setup();
    const spec = connector.manifest.tools.find((t) => t.id === TEAMS_POST_TOOL);
    expect(spec).toMatchObject({ sideEffect: "external", verb: "create", entity: "message" });
    expect(connector.manifest).toMatchObject({
      id: "teams",
      name: "Microsoft Teams",
      auth: "none",
    });
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ create: "approval", delete: "off" });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    for (const stepApproval of ["required", "not_required"] as const) {
      expect(
        decideToolCall({
          sideEffect: "external",
          verb: "create",
          matrix,
          stepApproval,
          agentMode: "act",
        }),
      ).toBe("approval");
    }
  });

  it("shows the bound channel and the text as it will go, and posts nothing then", async () => {
    const { teams, connector, ctx } = await setup();
    const { before } = await captureBefore(
      connector,
      TEAMS_POST_TOOL,
      { ...POST, text: "Cherry veneer is in. [details](https://evil.example)" },
      ctx,
    );
    expect(before).toEqual({
      team: { id: FAKE_TEAMS.teamId, name: "Acme Millwork" },
      channel: { id: FAKE_TEAMS.channelId, name: "Orders" },
      text: "Cherry veneer is in. details (https://evil.example)",
    });
    expect(teams.posts).toHaveLength(0);
  });

  it("refuses a channel this client hasn't bound, before any call", async () => {
    const { teams, connector, ctx, started } = await setup();
    teams.installIn("19:otherTeam@thread.tacv2", [OTHER_CHANNEL]);
    const other = { channel: OTHER_CHANNEL, text: "hello" };
    await expect(captureBefore(connector, TEAMS_POST_TOOL, other, ctx)).rejects.toThrow(
      /isn't connected to this client/,
    );
    await expect(executeWrite(connector, TEAMS_POST_TOOL, other, ctx)).rejects.toThrow(
      /isn't connected to this client/,
    );
    // Approved while bound, unbound before it ran: refused.
    await expect(
      executeWrite(connector, TEAMS_POST_TOOL, POST, {
        ...ctx,
        connection: connection({ channels: [] }),
      }),
    ).rejects.toThrow(/isn't connected/);
    await expect(
      executeWrite(connector, TEAMS_POST_TOOL, { channel: "../../x", text: "x" }, ctx),
    ).rejects.toThrow(/invalid input/);
    expect(teams.posts).toHaveLength(0);
    expect(teams.requests).toHaveLength(0);
    expect(started.size).toBe(0);
  });

  it("posts once as a new plain-text post in the channel; a retry returns the result", async () => {
    const { teams, connector, ctx, started, done } = await setup();
    const first = await executeWrite(connector, TEAMS_POST_TOOL, POST, ctx);
    expect(first.output).toEqual({
      channel: FAKE_TEAMS.channelId,
      channelLabel: "Acme Millwork › Orders",
      team: "Acme Millwork",
      conversationId: teams.posts[0]?.conversationId,
      activityId: teams.posts[0]?.activityId,
      text: POST.text,
    });
    expect(first.summary).toBe("Posted in Acme Millwork › Orders on Microsoft Teams");
    expect(teams.posts[0]?.body).toEqual({
      isGroup: true,
      channelData: {
        channel: { id: FAKE_TEAMS.channelId },
        tenant: { id: FAKE_TEAMS.clientTenantId },
      },
      tenantId: FAKE_TEAMS.clientTenantId,
      activity: { type: "message", text: POST.text, textFormat: "plain" },
    });
    expect(started.get(`${KEY}#1`)?.details).toMatchObject({ channelId: FAKE_TEAMS.channelId });
    expect(done.get(KEY)).toEqual(first.output);
    const again = await executeWrite(connector, TEAMS_POST_TOOL, POST, ctx);
    expect(again.output).toEqual(first.output);
    expect(teams.posts).toHaveLength(1);
    // No token or secret in what the tool returns.
    for (const t of teams.issued) expect(JSON.stringify(first.output)).not.toContain(t);
    expect(JSON.stringify(first.output)).not.toContain(FAKE_TEAMS.appSecret);
  });

  it("never posts again after a lost answer or a 5xx", async () => {
    const { teams, connector, ctx } = await setup();
    teams.loseNextAnswer();
    await expect(executeWrite(connector, TEAMS_POST_TOOL, POST, ctx)).rejects.toThrow(
      /network connection lost/,
    );
    expect(teams.posts).toHaveLength(1);
    const retry = executeWrite(connector, TEAMS_POST_TOOL, POST, ctx);
    await expect(retry).rejects.toBeInstanceOf(UnconfirmedWriteError);
    await expect(retry).rejects.toThrow(/post in Acme Millwork › Orders may have been made/);
    expect(teams.posts).toHaveLength(1);

    const other = await setup();
    other.teams.breakNext();
    await expect(executeWrite(other.connector, TEAMS_POST_TOOL, POST, other.ctx)).rejects.toThrow(
      /didn't say whether/,
    );
    await expect(
      executeWrite(other.connector, TEAMS_POST_TOOL, POST, other.ctx),
    ).rejects.toBeInstanceOf(UnconfirmedWriteError);
    expect(other.teams.posts).toHaveLength(1);
  });

  it("may try again after Teams refused with an answer, and says why in plain words", async () => {
    const { teams, connector, ctx, refused } = await setup();
    teams.refuseNext(429);
    await expect(executeWrite(connector, TEAMS_POST_TOOL, POST, ctx)).rejects.toThrow(
      /slow down posting/,
    );
    expect(refused.has(`${KEY}#1`)).toBe(true);
    const out = await executeWrite(connector, TEAMS_POST_TOOL, POST, ctx);
    expect((out.output as { activityId: string }).activityId).toBe(teams.posts[0]?.activityId);
    expect(teams.posts).toHaveLength(1);

    // The app was taken out of the team: Teams says so and nothing is posted.
    const gone = await setup();
    gone.teams.uninstallFrom(FAKE_TEAMS.teamId);
    const err = await executeWrite(gone.connector, TEAMS_POST_TOOL, POST, gone.ctx).catch((e) => e);
    expect(String(err)).toMatch(/may have been removed from that team/);
    expect((err as { notWritten?: boolean }).notWritten).toBe(true);
    expect(gone.teams.posts).toHaveLength(0);
  });

  it("refuses to run without the record of attempts or the bot's keys", async () => {
    const { teams, connector, ctx } = await setup();
    await expect(
      executeWrite(connector, TEAMS_POST_TOOL, POST, { ...ctx, services: {} }),
    ).rejects.toThrow(/record of attempts/);
    const unset = createTeamsConnector({ fetch: teams.fetch });
    await expect(executeWrite(unset, TEAMS_POST_TOOL, POST, ctx)).rejects.toThrow(
      /not set up on this deployment/,
    );
    expect(teams.posts).toHaveLength(0);
  });
});
