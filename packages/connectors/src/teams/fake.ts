// A fake Microsoft for the Teams bot (re-exported by @countersign/connectors/testing; never imported
// by the Worker): Entra's token endpoint for the bot's single tenant (client credentials), the Bot
// Connector's OpenID metadata and signing keys (a real RSA key as a JWK, endorsed for `msteams`),
// activities signed like the Bot Connector's, and the Bot Connector's calls the bot makes: create a
// conversation in a channel (a new post), reply in a thread, and read a team's name and channels.
// Shaped like Microsoft's answers as far as we know them (NOTES.md). Every request is recorded
// with whether it carried a bearer token, so a test can see where the token went.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { toBase64Url, utf8 } from "../runtime";
import { BOT_CONNECTOR_ISSUER, BOT_CONNECTOR_SCOPE, BOT_OPENID_URL, botTokenUrl } from "./auth";

export const FAKE_TEAMS = {
  appId: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  appSecret: "fake-teams-bot-secret",
  /** Mezonas' own Entra tenant, where the bot's app lives. */
  botTenantId: "0a1b2c3d-0000-4000-8000-00000000b075",
  /** A client's Entra tenant. */
  clientTenantId: "11111111-2222-4333-8444-555555555555",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  keyId: "fake-botframework-key-1",
  keysUrl: "https://login.botframework.com/v1/.well-known/keys",
  teamId: "19:fakeTeamGeneral0000000000000000@thread.tacv2",
  teamName: "Acme Millwork",
  channelId: "19:fakeChannelOrders00000000000000@thread.tacv2",
  channelName: "Orders",
} as const;

interface Key {
  readonly type: string;
}
interface Pair {
  privateKey: Key;
  publicKey: Key;
}
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
interface FakeSubtle {
  generateKey(
    a: typeof ALG & { modulusLength: number; publicExponent: Uint8Array },
    extractable: boolean,
    usages: string[],
  ): Promise<Pair>;
  exportKey(format: "jwk", key: Key): Promise<{ n: string; e: string }>;
  sign(a: "RSASSA-PKCS1-v1_5", key: Key, data: Uint8Array): Promise<ArrayBuffer>;
}
const subtle = () => (globalThis as unknown as { crypto: { subtle: FakeSubtle } }).crypto.subtle;

async function newPair(): Promise<Pair> {
  return subtle().generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
}

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h.get(n.toLowerCase()) ?? null },
    text: async () => text,
  };
}

export interface FakeTeamsPost {
  channelId: string;
  tenantId: string | null;
  conversationId: string;
  activityId: string;
  text: string;
  textFormat: string | null;
  body: Record<string, unknown>;
}

export interface FakeTeamsReply {
  conversationId: string;
  replyToId: string;
  text: string;
}

export interface FakeActivityOptions {
  type?: "message" | "conversationUpdate" | "installationUpdate";
  text?: string;
  teamId?: string;
  teamName?: string | null;
  channelId?: string;
  channelName?: string | null;
  conversationType?: "channel" | "groupChat" | "personal";
  serviceUrl?: string;
  tenantId?: string;
  fromName?: string;
  fromId?: string;
  eventType?: string;
  /** For conversationUpdate: the bot itself added or removed. */
  botAdded?: boolean;
  botRemoved?: boolean;
  action?: "add" | "remove";
  recipientId?: string;
}

export interface FakeTokenOptions {
  aud?: string;
  iss?: string;
  expiresInS?: number;
  kid?: string;
  signer?: "botframework" | "stranger";
  /** The token's `serviceUrl` claim; defaults to the activity's. */
  serviceUrl?: string;
}

export interface FakeTeams {
  fetch: FetchLike;
  appId: string;
  appSecret: string;
  tenantId: string;
  posts: FakeTeamsPost[];
  replies: FakeTeamsReply[];
  /** Every request: where it went, and whether it carried a bearer token. */
  requests: { url: string; method: string; bearer: boolean }[];
  /** Access tokens Entra issued to the bot (to check none reaches a response). */
  issued: string[];
  /** An activity as the Bot Connector sends it: the headers and the raw body. */
  activity(
    opts?: FakeActivityOptions,
    token?: FakeTokenOptions,
  ): Promise<{
    headers: { authorization: string };
    body: Uint8Array;
    json: Record<string, unknown>;
  }>;
  /** A token as the Bot Connector signs one, for an activity with this service URL. */
  signToken(serviceUrl: string, opts?: FakeTokenOptions): Promise<string>;
  installIn(
    teamId: string,
    channelIds: string[],
    names?: { team?: string; channels?: Record<string, string | null> },
  ): void;
  uninstallFrom(teamId: string): void;
  /** The next post is made and then the answer is lost (the fetch throws). */
  loseNextAnswer(): void;
  /** The next post is refused with this status (nothing posted). */
  refuseNext(status: number): void;
  /** The next post fails with a 5xx after it was made (whether it posted is unknown to the bot). */
  breakNext(): void;
  /** Every bot token stops working (a rotated secret). */
  expireTokens(): void;
  /** The keys stop being endorsed for `msteams`. */
  dropEndorsements(): void;
}

export async function fakeTeams(): Promise<FakeTeams> {
  const botframework = await newPair();
  const stranger = await newPair();
  const jwk = await subtle().exportKey("jwk", botframework.publicKey);
  let endorsed = true;

  let n = 0;
  const live = new Set<string>();
  const issued: string[] = [];
  const posts: FakeTeamsPost[] = [];
  const replies: FakeTeamsReply[] = [];
  const requests: FakeTeams["requests"] = [];
  const teams = new Map<string, { name: string; channels: Map<string, string | null> }>();
  let lose = false;
  let refuseStatus = 0;
  let broken = false;

  function token(form: Record<string, string>): HttpResponseLike {
    if (form.grant_type !== "client_credentials") {
      return respond(400, { error: "unsupported_grant_type" });
    }
    if (form.client_id !== FAKE_TEAMS.appId || form.client_secret !== FAKE_TEAMS.appSecret) {
      return respond(401, {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid client secret provided.",
      });
    }
    if (form.scope !== BOT_CONNECTOR_SCOPE) return respond(400, { error: "invalid_scope" });
    const t = `eyJ.fake-bot-${++n}`;
    live.add(t);
    issued.push(t);
    return respond(200, {
      token_type: "Bearer",
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: t,
    });
  }

  function authed(init: HttpRequestInit | undefined): boolean {
    const auth = init?.headers?.authorization ?? "";
    return auth.startsWith("Bearer ") && live.has(auth.slice("Bearer ".length));
  }

  function connectorCall(path: string, init: HttpRequestInit | undefined): HttpResponseLike {
    if (!authed(init)) {
      return respond(401, { message: "Authorization has been denied for this request." });
    }
    const method = init?.method ?? "GET";
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    // amer / v3 / …
    const v3 = parts.indexOf("v3");
    const rest = v3 < 0 ? [] : parts.slice(v3 + 1);
    if (method === "GET" && rest[0] === "teams" && rest[1]) {
      const team = teams.get(rest[1]);
      if (!team)
        return respond(403, {
          error: {
            code: "BotNotInConversationRoster",
            message: "The bot is not part of the conversation roster.",
          },
        });
      if (rest.length === 2)
        return respond(200, {
          id: rest[1],
          name: team.name,
          aadGroupId: "f3ec8cd2-e704-4344-8c47-9a3a21d683c0",
        });
      if (rest[2] === "conversations") {
        return respond(200, {
          conversations: [...team.channels].map(([id, name]) =>
            name === null ? { id } : { id, name },
          ),
        });
      }
    }
    if (method !== "POST" || rest[0] !== "conversations") {
      return respond(404, { error: { code: "NotFound", message: "Not found" } });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init?.body ?? "") as Record<string, unknown>;
    } catch {
      return respond(400, { error: { code: "BadArgument", message: "Invalid JSON" } });
    }
    if (rest.length === 1) {
      // Create a conversation in a channel: a new post.
      if (refuseStatus) {
        const s = refuseStatus;
        refuseStatus = 0;
        return respond(s, {
          error: { code: s === 429 ? "Throttled" : "BadArgument", message: "refused" },
        });
      }
      const cd = body.channelData as
        | { channel?: { id?: unknown }; tenant?: { id?: unknown } }
        | undefined;
      const channelId = typeof cd?.channel?.id === "string" ? cd.channel.id : "";
      const installed = [...teams.values()].some((t) => t.channels.has(channelId));
      if (!installed) {
        return respond(403, {
          error: {
            code: "BotNotInConversationRoster",
            message: "The bot is not part of the conversation roster.",
          },
        });
      }
      const activity = body.activity as { text?: unknown; textFormat?: unknown } | undefined;
      if (
        body.isGroup !== true ||
        typeof activity?.text !== "string" ||
        activity.text.length === 0
      ) {
        return respond(400, { error: { code: "BadArgument", message: "Invalid activity" } });
      }
      const activityId = String(1730000000000 + ++n);
      const post: FakeTeamsPost = {
        channelId,
        tenantId: typeof cd?.tenant?.id === "string" ? cd.tenant.id : null,
        conversationId: `${channelId};messageid=${activityId}`,
        activityId,
        text: activity.text,
        textFormat: typeof activity.textFormat === "string" ? activity.textFormat : null,
        body,
      };
      posts.push(post);
      if (broken) {
        broken = false;
        return respond(502, undefined);
      }
      return respond(201, { id: post.conversationId, activityId });
    }
    if (rest.length === 4 && rest[2] === "activities") {
      const text = (body as { text?: unknown }).text;
      replies.push({
        conversationId: rest[1] ?? "",
        replyToId: rest[3] ?? "",
        text: typeof text === "string" ? text : "",
      });
      return respond(200, { id: String(++n) });
    }
    return respond(404, { error: { code: "NotFound", message: "Not found" } });
  }

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      bearer: (init?.headers?.authorization ?? "").startsWith("Bearer "),
    });
    if (url === botTokenUrl(FAKE_TEAMS.botTenantId) && method === "POST")
      return token(formDecode(init?.body ?? ""));
    if (url === BOT_OPENID_URL) {
      return respond(200, {
        issuer: BOT_CONNECTOR_ISSUER,
        authorization_endpoint: "https://invalid.botframework.com",
        jwks_uri: FAKE_TEAMS.keysUrl,
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
      });
    }
    if (url === FAKE_TEAMS.keysUrl) {
      return respond(200, {
        keys: [
          {
            kty: "RSA",
            use: "sig",
            kid: FAKE_TEAMS.keyId,
            x5t: FAKE_TEAMS.keyId,
            n: jwk.n,
            e: jwk.e,
            endorsements: endorsed ? ["msteams", "webchat", "skype"] : ["webchat"],
          },
        ],
      });
    }
    const u = parseUrl(url);
    if (u && u.hostname === "smba.trafficmanager.net") {
      const res = connectorCall(u.pathname, init);
      if (lose && method === "POST" && res.status >= 200 && res.status < 300) {
        lose = false;
        throw new TypeError("network connection lost");
      }
      return res;
    }
    return respond(404, { error: { code: "NotFound", message: `no fake for ${url}` } });
  };

  async function signToken(serviceUrl: string, opts: FakeTokenOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: opts.kid ?? FAKE_TEAMS.keyId,
      x5t: opts.kid ?? FAKE_TEAMS.keyId,
    };
    const claims = {
      serviceUrl: opts.serviceUrl ?? serviceUrl,
      nbf: now - 5,
      exp: now + (opts.expiresInS ?? 3600),
      iss: opts.iss ?? BOT_CONNECTOR_ISSUER,
      aud: opts.aud ?? FAKE_TEAMS.appId,
    };
    const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
    const input = `${part(header)}.${part(claims)}`;
    const key = opts.signer === "stranger" ? stranger.privateKey : botframework.privateKey;
    const sig = await subtle().sign("RSASSA-PKCS1-v1_5", key, utf8(input));
    return `${input}.${toBase64Url(new Uint8Array(sig))}`;
  }

  return {
    fetch,
    appId: FAKE_TEAMS.appId,
    appSecret: FAKE_TEAMS.appSecret,
    tenantId: FAKE_TEAMS.botTenantId,
    posts,
    replies,
    requests,
    issued,
    signToken,
    async activity(opts = {}, tokenOpts = {}) {
      const type = opts.type ?? "message";
      const serviceUrl = opts.serviceUrl ?? FAKE_TEAMS.serviceUrl;
      const teamId = opts.teamId ?? FAKE_TEAMS.teamId;
      const channelId = opts.channelId ?? FAKE_TEAMS.channelId;
      const kind = opts.conversationType ?? "channel";
      const bot = { id: opts.recipientId ?? `28:${FAKE_TEAMS.appId}`, name: "Mezonas" };
      const json: Record<string, unknown> = {
        type,
        id: type === "message" ? String(1730000000000 + ++n) : `f:${++n}`,
        timestamp: new Date().toISOString(),
        channelId: "msteams",
        serviceUrl,
        from: {
          id: opts.fromId ?? "29:1fakeUserAnaRuiz",
          name: opts.fromName ?? "Ana Ruiz",
          aadObjectId: "eddfa9d4-346e-4cce-a18f-fa6261ad776b",
        },
        conversation: {
          isGroup: kind !== "personal",
          conversationType: kind,
          tenantId: opts.tenantId ?? FAKE_TEAMS.clientTenantId,
          id:
            kind === "channel"
              ? type === "message"
                ? `${channelId};messageid=${1730000000000 + n}`
                : channelId
              : `19:fakeGroupChat${n}@thread.v2`,
        },
        recipient: bot,
        channelData:
          kind === "channel"
            ? {
                ...(opts.eventType ? { eventType: opts.eventType } : {}),
                teamsChannelId: channelId,
                teamsTeamId: teamId,
                channel:
                  opts.channelName === undefined
                    ? { id: channelId }
                    : { id: channelId, name: opts.channelName },
                team:
                  opts.teamName === undefined
                    ? { id: teamId }
                    : { id: teamId, name: opts.teamName },
                tenant: { id: opts.tenantId ?? FAKE_TEAMS.clientTenantId },
              }
            : { tenant: { id: opts.tenantId ?? FAKE_TEAMS.clientTenantId } },
      };
      if (type === "message") {
        json.text = opts.text ?? "<at>Mezonas</at> hello";
        json.entities = [{ type: "mention", text: "<at>Mezonas</at>", mentioned: bot }];
      }
      if (opts.botAdded) json.membersAdded = [{ id: bot.id }];
      if (opts.botRemoved) json.membersRemoved = [{ id: bot.id }];
      if (opts.action) json.action = opts.action;
      const tok = await signToken(serviceUrl, tokenOpts);
      return {
        headers: { authorization: `Bearer ${tok}` },
        body: utf8(JSON.stringify(json)),
        json,
      };
    },
    installIn(teamId, channelIds, names = {}) {
      const channels = new Map<string, string | null>();
      for (const id of channelIds) channels.set(id, names.channels?.[id] ?? null);
      teams.set(teamId, { name: names.team ?? FAKE_TEAMS.teamName, channels });
    },
    uninstallFrom(teamId) {
      teams.delete(teamId);
    },
    loseNextAnswer() {
      lose = true;
    },
    refuseNext(status) {
      refuseStatus = status;
    },
    breakNext() {
      broken = true;
    },
    expireTokens() {
      live.clear();
    },
    dropEndorsements() {
      endorsed = false;
    },
  };
}
