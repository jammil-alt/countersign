// v0.14 W4-A: a fake Meta Graph API for tests (re-exported by @countersign/connectors/testing; never
// imported by the Worker). Embedded Signup's code exchange, `debug_token`, a WhatsApp Business
// Account's numbers, `subscribed_apps` (subscribe and unsubscribe), number registration, sends
// (`/<phone>/messages`, bearer checked, every body kept), and media: the two-step download (a
// media id resolves to a signed link on Meta's media host, which needs the bearer too and can be
// made to expire). It also builds webhook deliveries signed with the app secret, as Meta signs
// them. Shaped like Meta's answers as far as we know them (NOTES.md). Nothing here is live.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, hmacSha256Hex, parseUrl } from "../http";
import { GRAPH_ORIGIN, GRAPH_VERSION } from "./graph";

export const FAKE_META = {
  appId: "1100220033",
  appSecret: "fake-meta-app-secret-0123456789",
  configId: "4400550066",
  verifyToken: "fake-meta-verify-token",
} as const;

/** The fake's media host (the one listed origin). */
export const FAKE_META_MEDIA_HOST = "https://lookaside.fbsbx.com";

export interface FakeMetaNumber {
  id: string;
  display: string;
  verifiedName: string;
}

export interface FakeMetaAccount {
  wabaId: string;
  numbers: FakeMetaNumber[];
}

export interface FakeMetaSend {
  phoneNumberId: string;
  token: string;
  body: Record<string, unknown>;
  wamid: string;
}

interface Grant {
  wabaIds: string[];
  scopes: string[];
  appId: string;
}

interface FakeMediaItem {
  id: string;
  phoneNumberId: string;
  mimeType: string;
  bytes: Uint8Array;
  /** What the signed link answers with as its type, when a test wants it to differ. */
  servedType?: string;
  /** Leave out Content-Length (a chunked answer). */
  noLength?: boolean;
  /** The size `resolve` declares, when a test wants it to differ. */
  declaredSize?: number;
  /** Where the signed link points (default the media host). */
  linkOrigin?: string;
}

export interface FakeMeta {
  fetch: FetchLike;
  requests: { url: string; method: string; authorization: string | null }[];
  accounts: FakeMetaAccount[];
  sent: FakeMetaSend[];
  /** WABA ids our app is subscribed to. */
  subscribed: Set<string>;
  /** Number id → the PIN it was registered with. */
  registered: Map<string, string>;
  issueCode(opts?: Partial<Grant>): string;
  /** Business tokens issued so far. */
  tokens(): string[];
  /** Makes a token stop working (Meta answers 401 with code 190). */
  expireToken(token: string): void;
  /** The next `count` sends are refused with this Graph error code (HTTP 400). */
  refuseNext(count: number, code: number): void;
  /** The next send goes out, and its answer is lost (the fetch throws). */
  loseNextAnswer(): void;
  /** The next registration is refused. */
  refuseRegistration(): void;
  addMedia(item: Omit<FakeMediaItem, "id">): string;
  /** The next `count` downloads of a signed link answer 404 (the link expired). */
  expireNextLinks(count: number): void;
  /** How many times each media id was resolved. */
  resolved: Map<string, number>;
  /** A webhook delivery (raw body as sent, and its signature under `secret`). */
  deliver(payload: unknown, secret?: string): Promise<{ body: string; signature: string }>;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) => (n.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null),
    },
    text: async () => text,
  };
}

function bytesResponse(status: number, bytes: Uint8Array, headers: Map<string, string>) {
  let at = 0;
  let cancelled = false;
  const res: HttpResponseLike = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    text: async () => "",
    body: {
      getReader: () => ({
        async read() {
          if (cancelled || at >= bytes.length) return { done: true };
          const value = bytes.subarray(at, at + 64 * 1024);
          at += value.length;
          return { done: false, value };
        },
        async cancel() {
          cancelled = true;
        },
      }),
    },
  };
  return res;
}

const graphError = (status: number, code: number, message: string) =>
  respond(status, { error: { message, type: "OAuthException", code, fbtrace_id: "Afake" } });

export const DEFAULT_FAKE_ACCOUNTS: FakeMetaAccount[] = [
  {
    wabaId: "102030405060",
    numbers: [{ id: "509876543210", display: "+1 512-555-0199", verifiedName: "Acme Millwork" }],
  },
];

export function fakeMeta(accounts: FakeMetaAccount[] = DEFAULT_FAKE_ACCOUNTS): FakeMeta {
  let n = 0;
  const requests: FakeMeta["requests"] = [];
  const codes = new Map<string, Grant>();
  const live = new Map<string, Grant>();
  const sent: FakeMetaSend[] = [];
  const subscribed = new Set<string>();
  const registered = new Map<string, string>();
  const media = new Map<string, FakeMediaItem>();
  const resolved = new Map<string, number>();
  let refusing = { count: 0, code: 0 };
  let lose = false;
  let refuseRegister = false;
  let expireLinks = 0;
  const allAccounts = accounts.map((a) => ({ ...a, numbers: a.numbers.map((x) => ({ ...x })) }));

  const bearer = (init?: HttpRequestInit) => {
    const h = init?.headers ?? {};
    const raw = Object.entries(h).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
    return raw.startsWith("Bearer ") ? raw.slice(7) : null;
  };
  const tokenGrant = (init?: HttpRequestInit) => {
    const t = bearer(init);
    return t ? live.get(t) : undefined;
  };
  const numberById = (id: string) =>
    allAccounts
      .flatMap((a) => a.numbers.map((x) => ({ ...x, wabaId: a.wabaId })))
      .find((x) => x.id === id);

  const fetch: FetchLike = async (rawUrl, init) => {
    const method = init?.method ?? "GET";
    requests.push({ url: rawUrl, method, authorization: bearer(init) });
    const url = parseUrl(rawUrl);
    if (!url) throw new Error(`fake meta: bad url ${rawUrl}`);
    const qi = rawUrl.indexOf("?");
    const query = qi < 0 ? {} : formDecode(rawUrl.slice(qi + 1));
    const q = { get: (k: string): string | null => query[k] ?? null };

    if (url.origin === FAKE_META_MEDIA_HOST) {
      const item = media.get(q.get("mid") ?? "");
      if (!item) return respond(404, {});
      if (!tokenGrant(init)) return respond(401, {});
      if (expireLinks > 0) {
        expireLinks -= 1;
        return respond(404, {});
      }
      const headers = new Map<string, string>([["content-type", item.servedType ?? item.mimeType]]);
      if (!item.noLength) headers.set("content-length", String(item.bytes.length));
      return bytesResponse(200, item.bytes, headers);
    }
    if (url.origin !== GRAPH_ORIGIN) throw new Error(`fake meta: unexpected host ${url.origin}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== GRAPH_VERSION) return graphError(400, 2635, "unpinned version");
    const path = parts.slice(1);

    if (path.join("/") === "oauth/access_token" && method === "GET") {
      if (
        q.get("client_id") !== FAKE_META.appId ||
        q.get("client_secret") !== FAKE_META.appSecret
      ) {
        return graphError(400, 101, "Error validating client secret.");
      }
      const grant = codes.get(q.get("code") ?? "");
      if (!grant) return graphError(400, 100, "Invalid verification code format.");
      codes.delete(q.get("code") ?? "");
      const token = `EAAfake${++n}${"x".repeat(24)}`;
      live.set(token, grant);
      return respond(200, { access_token: token, token_type: "bearer" });
    }
    if (path.join("/") === "debug_token" && method === "GET") {
      if (q.get("access_token") !== `${FAKE_META.appId}|${FAKE_META.appSecret}`) {
        return graphError(400, 190, "Invalid OAuth access token.");
      }
      const grant = live.get(q.get("input_token") ?? "");
      if (!grant) return respond(200, { data: { app_id: FAKE_META.appId, is_valid: false } });
      return respond(200, {
        data: {
          app_id: grant.appId,
          type: "SYSTEM_USER",
          application: "Mezonas",
          is_valid: true,
          scopes: grant.scopes,
          granular_scopes: grant.scopes.map((scope) => ({ scope, target_ids: grant.wabaIds })),
        },
      });
    }

    const grant = tokenGrant(init);
    const [id, sub] = path;
    if (!grant) return graphError(401, 190, "Error validating access token.");

    if (sub === "phone_numbers" && method === "GET") {
      const acct = allAccounts.find((a) => a.wabaId === id);
      if (!acct || !grant.wabaIds.includes(acct.wabaId)) return graphError(403, 200, "denied");
      return respond(200, {
        data: acct.numbers.map((x) => ({
          id: x.id,
          display_phone_number: x.display,
          verified_name: x.verifiedName,
          quality_rating: "GREEN",
        })),
      });
    }
    if (sub === "subscribed_apps") {
      if (!id || !grant.wabaIds.includes(id)) return graphError(403, 200, "denied");
      if (method === "POST") subscribed.add(id);
      else if (method === "DELETE") subscribed.delete(id);
      return respond(200, { success: true });
    }
    if (sub === "register" && method === "POST") {
      const num = numberById(id ?? "");
      if (!num || !grant.wabaIds.includes(num.wabaId)) return graphError(403, 200, "denied");
      if (refuseRegister) {
        refuseRegister = false;
        return graphError(400, 133005, "Two step verification PIN mismatch.");
      }
      const body = JSON.parse(init?.body ?? "{}") as { pin?: string; messaging_product?: string };
      if (body.messaging_product !== "whatsapp" || !/^\d{6}$/.test(body.pin ?? "")) {
        return graphError(400, 100, "Invalid parameter");
      }
      registered.set(num.id, body.pin ?? "");
      return respond(200, { success: true });
    }
    if (sub === "messages" && method === "POST") {
      const num = numberById(id ?? "");
      if (!num || !grant.wabaIds.includes(num.wabaId)) return graphError(403, 200, "denied");
      if (refusing.count > 0) {
        refusing = { count: refusing.count - 1, code: refusing.code };
        return graphError(400, refusing.code, "refused by the fake");
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const wamid = `wamid.HBgFAKE${String(++n).padStart(6, "0")}AA==`;
      sent.push({ phoneNumberId: num.id, token: bearer(init) ?? "", body, wamid });
      if (lose) {
        lose = false;
        throw new Error("fake meta: the answer was lost");
      }
      return respond(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: wamid, message_status: "accepted" }],
      });
    }
    if (id && !sub && method === "GET") {
      const item = media.get(id);
      if (!item) return graphError(404, 100, "Unsupported get request.");
      const phone = q.get("phone_number_id");
      if (phone && phone !== item.phoneNumberId) return graphError(400, 100, "wrong number");
      const owner = numberById(item.phoneNumberId);
      if (!owner || !grant.wabaIds.includes(owner.wabaId)) return graphError(403, 200, "denied");
      resolved.set(id, (resolved.get(id) ?? 0) + 1);
      const origin = item.linkOrigin ?? FAKE_META_MEDIA_HOST;
      return respond(200, {
        messaging_product: "whatsapp",
        url: `${origin}/whatsapp_business/attachments/?mid=${id}&ext=${resolved.get(id)}&hash=fake`,
        mime_type: item.mimeType,
        sha256: "fake",
        file_size: item.declaredSize ?? item.bytes.length,
        id,
      });
    }
    return graphError(400, 100, `fake meta: no route ${method} ${url.pathname}`);
  };

  return {
    fetch,
    requests,
    accounts: allAccounts,
    sent,
    subscribed,
    registered,
    resolved,
    issueCode(opts = {}) {
      const code = `fake-code-${++n}`;
      codes.set(code, {
        wabaIds: opts.wabaIds ?? allAccounts.map((a) => a.wabaId),
        scopes: opts.scopes ?? ["whatsapp_business_messaging", "whatsapp_business_management"],
        appId: opts.appId ?? FAKE_META.appId,
      });
      return code;
    },
    tokens: () => [...live.keys()],
    expireToken(token) {
      live.delete(token);
    },
    refuseNext(count, code) {
      refusing = { count, code };
    },
    loseNextAnswer() {
      lose = true;
    },
    refuseRegistration() {
      refuseRegister = true;
    },
    addMedia(item) {
      const id = String(7_000_000_000 + ++n);
      media.set(id, { ...item, id });
      return id;
    },
    expireNextLinks(count) {
      expireLinks = count;
    },
    async deliver(payload, secret = FAKE_META.appSecret) {
      const body = JSON.stringify(payload);
      return { body, signature: `sha256=${await hmacSha256Hex(secret, body)}` };
    },
  };
}

/** A `messages` delivery with one inbound message to a number, as Meta posts it. */
export function fakeInboundPayload(input: {
  phoneNumberId: string;
  display?: string;
  /** E.164 of the sender. */
  from: string;
  wamid: string;
  text?: string;
  profileName?: string;
  media?: {
    type: "image" | "document" | "audio" | "video" | "sticker";
    id: string;
    mime: string;
    caption?: string;
  };
  groupId?: string;
  timestamp?: number;
}): Record<string, unknown> {
  const waId = input.from.replace(/^\+/, "");
  const message: Record<string, unknown> = {
    from: waId,
    id: input.wamid,
    timestamp: String(input.timestamp ?? 1_762_430_000),
    ...(input.groupId ? { group_id: input.groupId } : {}),
  };
  const m = input.media;
  const full = m
    ? {
        ...message,
        type: m.type,
        ...Object.fromEntries([
          [
            m.type,
            {
              id: m.id,
              mime_type: m.mime,
              sha256: "fake",
              ...(m.caption ? { caption: m.caption } : {}),
            },
          ],
        ]),
      }
    : { ...message, type: "text", text: { body: input.text ?? "" } };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102030405060",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: input.display ?? "15125550199",
                phone_number_id: input.phoneNumberId,
              },
              contacts: [{ profile: { name: input.profileName ?? "Someone" }, wa_id: waId }],
              messages: [full],
            },
          },
        ],
      },
    ],
  };
}

/** A `messages` delivery with one status callback, as Meta posts it. */
export function fakeStatusPayload(input: {
  phoneNumberId: string;
  wamid: string;
  status: string;
  /** E.164 of the recipient. */
  to: string;
  opaque?: string;
  errorCode?: number;
}): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102030405060",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15125550199",
                phone_number_id: input.phoneNumberId,
              },
              statuses: [
                {
                  id: input.wamid,
                  status: input.status,
                  timestamp: "1762430100",
                  recipient_id: input.to.replace(/^\+/, ""),
                  ...(input.opaque ? { biz_opaque_callback_data: input.opaque } : {}),
                  ...(input.errorCode ? { errors: [{ code: input.errorCode, title: "x" }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
