// "gchat": Google Chat (ARCHITECTURE §6.11 row 8, docs/plan.md §1.60). A Google Chat app of
// Mezonas' own, authenticating as itself (a service account with the `chat.bot` scope); there are
// no per-client user tokens. The client admin adds the app to a space in its own Workspace and
// mentions it with a one-time code from the portal; that binds the space to the client
// (./codes.ts; apps/api does the binding). Agents post with `gchat.message.post` (`external`,
// create, entity `message`, behind approval) to the client's bound spaces only, as plain text
// with every mention dropped, once per action: the message carries a client-assigned id and a
// request id from the action's key, so a retry gets the same message back. The app reads nothing
// beyond the binding mention. Unchecked facts about Google: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import { type Connector, defineConnector, defineWriteTool, type ToolContext } from "../connector";
import { type FetchLike, globalFetch, timeoutSignal } from "../http";
import { sha256Bytes, toHex, utf8 } from "../runtime";
import {
  AppTokens,
  bearerOf,
  ChatSigningKeys,
  isProjectNumber,
  parseServiceAccount,
  verifyChatToken,
} from "./auth";
import { isSpaceName, type SpaceKind } from "./events";
import { GCHAT_TEXT_MAX, plainChatText } from "./text";

export * from "./auth";
export * from "./codes";
export * from "./events";
export * from "./text";

export const GCHAT_CONNECTOR_ID = "gchat";
export const GCHAT_POST_TOOL = "gchat.message.post";
export const CHAT_API = "https://chat.googleapis.com/v1";
/** Most spaces one client can bind. */
export const GCHAT_MAX_SPACES = 50;
/** Chat's own limit on a message's text. */
const CHAT_TEXT_LIMIT = 4096;

// --- What the connection keeps ------------------------------------------------------------------

export const GchatSpace = z.object({
  /** `spaces/AAAA…`, Chat's resource name. */
  name: z.string().refine(isSpaceName, "not a Chat space"),
  displayName: z.string().max(200).nullable(),
  kind: z.enum(["space", "group_chat"]),
  boundAt: z.string(),
  /** Who mentioned the app with the code (their Chat display name), for the record. */
  boundBy: z.string().max(200).nullable(),
});
export type GchatSpace = z.infer<typeof GchatSpace>;

/** `connection.config`: the bound spaces. Not secret; the operator sees them. */
export const GchatConfig = z.object({ spaces: z.array(GchatSpace).max(GCHAT_MAX_SPACES) });
export type GchatConfig = z.infer<typeof GchatConfig>;

/** The bound spaces in a connection's config; anything unreadable counts as none. */
export function readGchatConfig(config: unknown): GchatConfig {
  const spaces = (config as { spaces?: unknown } | null)?.spaces;
  if (!Array.isArray(spaces)) return { spaces: [] };
  const out: GchatSpace[] = [];
  for (const s of spaces.slice(0, GCHAT_MAX_SPACES)) {
    const r = GchatSpace.safeParse(s);
    if (r.success) out.push(r.data);
  }
  return { spaces: out };
}

/** The connection's credentials: only the pending code's hash (encrypted with the client's key). */
export const GchatCredentials = z.object({
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
export type GchatCredentials = z.infer<typeof GchatCredentials>;

export function readGchatCredentials(value: unknown): GchatCredentials {
  const r = GchatCredentials.safeParse(value ?? {});
  return r.success ? r.data : {};
}

/** Adds a space (or answers why not): pure, for the binding in apps/api. */
export function bindSpace(
  config: GchatConfig,
  space: { name: string; displayName: string | null; kind: SpaceKind },
  by: string | null,
  at: Date,
): { ok: true; config: GchatConfig } | { ok: false; reason: "already" | "dm" | "full" } {
  if (space.kind === "dm") return { ok: false, reason: "dm" };
  if (config.spaces.some((s) => s.name === space.name)) return { ok: false, reason: "already" };
  if (config.spaces.length >= GCHAT_MAX_SPACES) return { ok: false, reason: "full" };
  return {
    ok: true,
    config: {
      spaces: [
        ...config.spaces,
        {
          name: space.name,
          displayName: space.displayName,
          kind: space.kind,
          boundAt: at.toISOString(),
          boundBy: by,
        },
      ],
    },
  };
}

/** The config without this space, and whether it was there. */
export function unbindSpace(
  config: GchatConfig,
  spaceName: string,
): { config: GchatConfig; removed: GchatSpace | null } {
  const removed = config.spaces.find((s) => s.name === spaceName) ?? null;
  return { config: { spaces: config.spaces.filter((s) => s.name !== spaceName) }, removed };
}

// --- The tool -----------------------------------------------------------------------------------

export class GchatSpaceNotBoundError extends Error {
  constructor() {
    super(
      "that Google Chat space isn't connected to this client; the client admin connects it with a code",
    );
    this.name = "GchatSpaceNotBoundError";
  }
}

export class GchatNotConfiguredError extends Error {
  constructor() {
    super(
      "Google Chat is not set up on this deployment (GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_PROJECT_NUMBER)",
    );
    this.name = "GchatNotConfiguredError";
  }
}

export class GchatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GchatApiError";
  }
}

export const GchatPostInput = z.strictObject({
  /** A bound space's resource name, `spaces/AAAA…`. */
  space: z.string().max(200).refine(isSpaceName, "not a Chat space name (spaces/…)"),
  text: z.string().trim().min(1).max(GCHAT_TEXT_MAX),
});

export const GchatPostOutput = z.object({
  /** Chat's resource name of the message. */
  name: z.string(),
  space: z.string(),
  spaceLabel: z.string(),
  /** Our client-assigned id (`client-…`), from the action's key. */
  messageId: z.string(),
  createTime: z.string().nullable(),
  /** The text as posted (mentions dropped). */
  text: z.string(),
  /** A retry found the message this action already posted. */
  alreadyPosted: z.boolean(),
});
export type GchatPostOutput = z.infer<typeof GchatPostOutput>;

/** What the approver sees and `external_action.before` keeps: where it goes and what it says. */
export const GchatPostBefore = z.object({
  space: z.object({
    name: z.string(),
    displayName: z.string().nullable(),
    kind: z.enum(["space", "group_chat"]),
  }),
  text: z.string(),
});

const ChatMessage = z.looseObject({
  name: z.string().max(400),
  createTime: z.string().max(60).optional(),
  clientAssignedMessageId: z.string().max(100).optional(),
});

/**
 * An action's ids at Chat, from its idempotency key: `messageId` (`client-` and 32 hex, within
 * Chat's 63 lowercase letters, digits and hyphens) and `requestId`.
 */
// DECISION: both. `requestId` makes Chat answer a repeated create with the message it already made;
// `messageId` is unique within a space, so even a create Chat doesn't recognise by request can't
// post twice (409), and the message can be read back by it (NOTES.md).
export async function chatMessageIds(
  idempotencyKey: string,
): Promise<{ messageId: string; requestId: string }> {
  const hex = toHex(await sha256Bytes(utf8(`gchat:${idempotencyKey}`)));
  return { messageId: `client-${hex.slice(0, 32)}`, requestId: `mz-${hex.slice(32, 64)}` };
}

function spaceLabel(s: { displayName: string | null; kind: string }): string {
  return s.displayName ?? (s.kind === "group_chat" ? "a group chat" : "a space");
}

export interface GchatOptions {
  /** `GOOGLE_CHAT_SERVICE_ACCOUNT`: the service account's key JSON. */
  serviceAccount?: string | undefined;
  /** `GOOGLE_CHAT_PROJECT_NUMBER`: the audience of Chat's tokens to the app. */
  projectNumber?: string | undefined;
  fetch?: FetchLike;
  now?: () => Date;
}

/** The space this call may post to: one of the connection's bound spaces, or refused. */
function boundSpace(ctx: ToolContext, name: string): GchatSpace {
  const s = readGchatConfig(ctx.connection.config).spaces.find((x) => x.name === name);
  if (!s) throw new GchatSpaceNotBoundError();
  return s;
}

function postable(text: string): string {
  const t = plainChatText(text);
  if (!t) throw new Error("there is nothing to post once mentions are taken out");
  return t.length > CHAT_TEXT_LIMIT ? t.slice(0, CHAT_TEXT_LIMIT) : t;
}

export function createGchatConnector(options: GchatOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const now = options.now ?? (() => new Date());
  const account = parseServiceAccount(options.serviceAccount);
  const projectNumber = isProjectNumber(options.projectNumber) ? options.projectNumber : null;
  const configured = Boolean(account && projectNumber);
  const tokens = account ? new AppTokens(account, doFetch, now) : null;
  const keys = new ChatSigningKeys(doFetch, now);

  async function chat(
    method: "GET" | "POST",
    url: string,
    body?: JsonObject,
  ): Promise<{ status: number; json: unknown }> {
    if (!tokens) throw new GchatNotConfiguredError();
    const call = async (token: string) =>
      doFetch()(url, {
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
      // The cached token was refused (revoked, or the key rotated): one new token, one retry.
      tokens.drop();
      res = await call(await tokens.get());
    }
    const text = await res.text();
    let json: unknown = null;
    if (text.length > 0 && text.length <= 256 * 1024) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  function refused(status: number, json: unknown): GchatApiError {
    const m = (json as { error?: { message?: unknown } } | null)?.error?.message;
    if (status === 403 || status === 404) {
      return new GchatApiError(
        status,
        "Google Chat refused: Mezonas may have been removed from that space. Add it again and reconnect the space.",
      );
    }
    return new GchatApiError(
      status,
      `Google Chat refused the message (${status}): ${typeof m === "string" ? m.slice(0, 200) : "no reason given"}`,
    );
  }

  function output(
    msg: z.infer<typeof ChatMessage>,
    space: GchatSpace,
    messageId: string,
    text: string,
    alreadyPosted: boolean,
  ): GchatPostOutput {
    return {
      name: msg.name,
      space: space.name,
      spaceLabel: spaceLabel(space),
      messageId,
      createTime: msg.createTime ?? null,
      text,
      alreadyPosted,
    };
  }

  return defineConnector({
    id: GCHAT_CONNECTOR_ID,
    name: "Google Chat",
    description:
      "Agents post updates to the Google Chat spaces you connect. We can't read your messages.",
    icon: "message",
    // DECISION: no per-client sign-in (the app is Mezonas' own): auth `none`, connected from the
    // portal in one click once the deployment has the app's keys; a space is the client's only
    // after its code is posted there.
    auth: "none",
    entities: [],
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    isConfigured: () => configured,

    /** Google Chat's bearer token on an event (the `authorization` header), verified. */
    async verifyWebhook(headers) {
      if (!projectNumber) return false;
      const check = await verifyChatToken(bearerOf(headers.authorization), {
        projectNumber,
        keys,
        now: now(),
      });
      return check.ok;
    },

    tools: [
      defineWriteTool({
        id: GCHAT_POST_TOOL,
        entity: "message",
        description:
          "Post a plain-text message in one of the client's connected Google Chat spaces. Mentions are removed; nothing is read from the space.",
        verb: "create",
        summary: "Posted in {{spaceLabel}} on Google Chat",
        input: GchatPostInput,
        output: GchatPostOutput,
        beforeSchema: GchatPostBefore,
        async before(input, ctx) {
          const space = boundSpace(ctx, input.space);
          return {
            space: { name: space.name, displayName: space.displayName, kind: space.kind },
            text: postable(input.text),
          };
        },
        async run(input, ctx) {
          if (!configured) throw new GchatNotConfiguredError();
          // Checked again at the write: a space disconnected while the action waited is refused.
          const space = boundSpace(ctx, input.space);
          const text = postable(input.text);
          const { messageId, requestId } = await chatMessageIds(ctx.idempotencyKey);
          const base = `${CHAT_API}/${space.name}/messages`;
          const created = await chat(
            "POST",
            `${base}?messageId=${encodeURIComponent(messageId)}&requestId=${encodeURIComponent(requestId)}`,
            { text },
          );
          if (created.status >= 200 && created.status < 300) {
            const msg = ChatMessage.safeParse(created.json);
            if (!msg.success) {
              throw new GchatApiError(
                created.status,
                "Google Chat's answer has an unexpected shape",
              );
            }
            // A repeated request id (a lost answer) gets the message made the first time; Chat
            // answers it like a new one, so `alreadyPosted` is only known on the 409 path below.
            return output(msg.data, space, messageId, text, false);
          }
          if (created.status === 409) {
            // Our client-assigned id is already in this space: this action posted it before.
            const got = await chat("GET", `${base}/${messageId}`);
            const msg = ChatMessage.safeParse(got.json);
            if (got.status !== 200 || !msg.success) throw refused(got.status, got.json);
            return output(msg.data, space, messageId, text, true);
          }
          throw refused(created.status, created.json);
        },
      }),
    ],
  });
}
