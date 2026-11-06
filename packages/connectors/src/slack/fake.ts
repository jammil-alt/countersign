// v0.14 W4-C: a fake Slack for tests (re-exported by @countersign/connectors/testing; never imported
// by the Worker): `oauth.v2.access` (codes for a workspace install, bot tokens), `conversations.list`
// (public and private channels, paged), `chat.postMessage` (only into channels the bot is in, with a
// live token that carries `chat:write`; keeps every message) and `auth.revoke`. It can refuse the
// next posts with an error, or post and lose the answer (the network fails after Slack posted).
// Shaped like Slack's answers as far as we know them (NOTES.md).

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { SLACK_API } from "./index";

export const FAKE_SLACK = {
  clientId: "1234567890.9876543210",
  clientSecret: "fake-slack-client-secret",
} as const;

export interface FakeSlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  isArchived?: boolean;
  /** Whether our bot is in it. */
  member: boolean;
}

export interface FakeSlackPost {
  team: string;
  channel: string;
  ts: string;
  /** The JSON we posted. */
  body: {
    channel: string;
    text: string;
    blocks?: { type: string; text?: { type: string; text: string } }[];
    parse?: string;
    link_names?: boolean;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
    [k: string]: unknown;
  };
}

interface Install {
  teamId: string;
  teamName: string;
  scopes: string[];
  enterprise: boolean;
  userToken: boolean;
  rotation: boolean;
}

export interface FakeSlack {
  fetch: FetchLike;
  requests: { url: string; method: string; body: string | undefined }[];
  posted: FakeSlackPost[];
  /** The workspace's channels (tests may change them). */
  channels: FakeSlackChannel[];
  issueCode(opts?: Partial<Install>): string;
  issued(): { botTokens: string[]; userTokens: string[] };
  revoked(): string[];
  /** The next `count` posts are refused with this Slack error (HTTP 200, or `status`). */
  refuseNext(count: number, error: string, status?: number): void;
  /** The next post goes into the channel, and its answer is lost (the fetch throws). */
  loseNextAnswer(): void;
  /** The next post answers 500 with no JSON (whether it posted is unknown). */
  breakNext(): void;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const res: HttpResponseLike = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) =>
        n.toLowerCase() === "content-type"
          ? "application/json; charset=utf-8"
          : (headers[n.toLowerCase()] ?? null),
    },
    text: async () => text,
  };
  return res;
}

const DEFAULT_CHANNELS: FakeSlackChannel[] = [
  { id: "C0ORDERS01", name: "orders", member: true },
  { id: "C0GENERAL1", name: "general", member: false },
  { id: "C0ACCTS001", name: "accounts", member: true },
  { id: "C0OLDSTUF1", name: "old-stuff", member: true, isArchived: true },
  { id: "G0PRIVATE1", name: "board", member: true, isPrivate: true },
];

export function fakeSlack(): FakeSlack {
  let n = 0;
  let ts = 1_762_430_000;
  const requests: FakeSlack["requests"] = [];
  const posted: FakeSlackPost[] = [];
  const channels = DEFAULT_CHANNELS.map((c) => ({ ...c }));
  const codes = new Map<string, Install>();
  const bots = new Map<string, { install: Install; live: boolean }>();
  const users: string[] = [];
  const revokedTokens: string[] = [];
  let refusing = { count: 0, error: "", status: 200 };
  let lose = false;
  let broken = false;

  function oauth(form: Record<string, string>): HttpResponseLike {
    if (form.client_id !== FAKE_SLACK.clientId || form.client_secret !== FAKE_SLACK.clientSecret) {
      return respond(200, { ok: false, error: "invalid_client_id" });
    }
    const install = codes.get(form.code ?? "");
    if (!install) return respond(200, { ok: false, error: "invalid_code" });
    if (!form.redirect_uri) return respond(200, { ok: false, error: "bad_redirect_uri" });
    codes.delete(form.code ?? "");
    const token = `xoxb-${install.teamId}-fake-${++n}`;
    bots.set(token, { install, live: true });
    const userToken = install.userToken ? `xoxp-${install.teamId}-fake-${++n}` : undefined;
    if (userToken) users.push(userToken);
    return respond(200, {
      ok: true,
      access_token: token,
      token_type: "bot",
      scope: install.scopes.join(","),
      bot_user_id: "U0MEZONAS1",
      app_id: "A0MEZONAS1",
      team: install.enterprise ? null : { name: install.teamName, id: install.teamId },
      enterprise: install.enterprise ? { name: "Acme Group", id: "E0ACMEGRP1" } : null,
      is_enterprise_install: install.enterprise,
      authed_user: {
        id: "U0ADMIN001",
        ...(userToken ? { scope: "chat:write", access_token: userToken, token_type: "user" } : {}),
      },
      ...(install.rotation ? { refresh_token: `xoxe-1-fake-${++n}`, expires_in: 43200 } : {}),
    });
  }

  function bearer(init: HttpRequestInit | undefined) {
    const auth = init?.headers?.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice("Bearer ".length);
    const bot = bots.get(token);
    return bot ? { token, ...bot } : null;
  }

  function list(url: string, init: HttpRequestInit | undefined): HttpResponseLike {
    const bot = bearer(init);
    if (!bot) return respond(200, { ok: false, error: "not_authed" });
    if (!bot.live) return respond(200, { ok: false, error: "token_revoked" });
    if (!bot.install.scopes.includes("channels:read")) {
      return respond(200, { ok: false, error: "missing_scope", needed: "channels:read" });
    }
    const q = formDecode(url.split("?")[1] ?? "");
    const types = (q.types ?? "public_channel").split(",");
    const limit = Number(q.limit ?? "100");
    const start = Number(q.cursor ? q.cursor.replace("cursor-", "") : "0");
    const visible = channels.filter(
      (c) =>
        (c.isPrivate ? types.includes("private_channel") : types.includes("public_channel")) &&
        !(q.exclude_archived === "true" && c.isArchived),
    );
    const page = visible.slice(start, start + limit);
    const next = start + limit < visible.length ? `cursor-${start + limit}` : "";
    return respond(200, {
      ok: true,
      channels: page.map((c) => ({
        id: c.id,
        name: c.name,
        is_channel: !c.isPrivate,
        is_private: c.isPrivate === true,
        is_archived: c.isArchived === true,
        is_member: c.member,
        num_members: 4,
      })),
      response_metadata: { next_cursor: next },
    });
  }

  async function post(init: HttpRequestInit | undefined): Promise<HttpResponseLike> {
    const bot = bearer(init);
    if (!bot) return respond(200, { ok: false, error: "not_authed" });
    if (!bot.live) return respond(200, { ok: false, error: "token_revoked" });
    if (!bot.install.scopes.includes("chat:write")) {
      return respond(200, { ok: false, error: "missing_scope", needed: "chat:write" });
    }
    if (refusing.count > 0) {
      refusing.count--;
      return respond(
        refusing.status,
        { ok: false, error: refusing.error },
        refusing.status === 429 ? { "retry-after": "30" } : {},
      );
    }
    if (broken) {
      broken = false;
      return {
        status: 500,
        ok: false,
        headers: { get: () => null },
        text: async () => "<html>upstream error</html>",
      };
    }
    let body: FakeSlackPost["body"];
    try {
      body = JSON.parse(init?.body ?? "") as FakeSlackPost["body"];
    } catch {
      return respond(200, { ok: false, error: "invalid_json" });
    }
    if (!body.text && !body.blocks?.length) return respond(200, { ok: false, error: "no_text" });
    const channel = channels.find((c) => c.id === body.channel);
    if (!channel || (channel.isPrivate && !channel.member)) {
      return respond(200, { ok: false, error: "channel_not_found" });
    }
    if (channel.isArchived) return respond(200, { ok: false, error: "is_archived" });
    if (!channel.member) return respond(200, { ok: false, error: "not_in_channel" });
    const at = `${++ts}.000${String(++n).padStart(3, "0")}`;
    posted.push({ team: bot.install.teamId, channel: channel.id, ts: at, body });
    if (lose) {
      lose = false;
      throw new Error("network connection lost");
    }
    return respond(200, {
      ok: true,
      channel: channel.id,
      ts: at,
      message: { type: "message", subtype: "bot_message", text: body.text, ts: at },
    });
  }

  function revoke(init: HttpRequestInit | undefined): HttpResponseLike {
    const bot = bearer(init);
    if (!bot) return respond(200, { ok: false, error: "invalid_auth" });
    if (!bot.live) return respond(200, { ok: false, error: "token_revoked" });
    bot.live = false;
    bots.set(bot.token, { install: bot.install, live: false });
    revokedTokens.push(bot.token);
    return respond(200, { ok: true, revoked: true });
  }

  return {
    requests,
    posted,
    channels,
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? "GET", body: init?.body });
      const method = init?.method ?? "GET";
      const path = url.split("?")[0];
      if (path === `${SLACK_API}/oauth.v2.access` && method === "POST") {
        return oauth(formDecode(init?.body ?? ""));
      }
      if (path === `${SLACK_API}/conversations.list` && method === "GET") return list(url, init);
      if (path === `${SLACK_API}/chat.postMessage` && method === "POST") return post(init);
      if (path === `${SLACK_API}/auth.revoke` && method === "POST") return revoke(init);
      return respond(404, { ok: false, error: "unknown_method" });
    },
    issueCode(opts = {}) {
      const code = `fake-slack-code-${++n}`;
      codes.set(code, {
        teamId: opts.teamId ?? "T0ACMEMILL",
        teamName: opts.teamName ?? "Acme Millwork",
        scopes: opts.scopes ?? ["chat:write", "channels:read"],
        enterprise: opts.enterprise ?? false,
        userToken: opts.userToken ?? false,
        rotation: opts.rotation ?? false,
      });
      return code;
    },
    issued: () => ({ botTokens: [...bots.keys()], userTokens: [...users] }),
    revoked: () => [...revokedTokens],
    refuseNext(count, error, status = 200) {
      refusing = { count, error, status };
    },
    loseNextAnswer() {
      lose = true;
    },
    breakNext() {
      broken = true;
    },
  };
}
