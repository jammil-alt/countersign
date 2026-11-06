// A fake Google for the Chat app (re-exported by @countersign/connectors/testing; never imported by
// the Worker): a service account with a real RSA key, Google's token endpoint checking the app's
// signed assertion, the published certificates of `chat@system.gserviceaccount.com` (a real key in
// a minimal X.509 wrapper), signed event tokens like Chat's, and the Chat API's create and get of a
// message, honouring `requestId` (a repeat answers the first message) and `messageId` (unique per
// space: 409). Shaped like Google's answers as far as we know them (NOTES.md).

import { GOOGLE_TOKEN_URL } from "../gmail/index";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { toBase64, toBase64Url, utf8 } from "../runtime";
import { CHAT_CERTS_URL, CHAT_ISSUER } from "./auth";
import { CHAT_API } from "./index";
import { decodeJwt } from "./jwt";

export const FAKE_GCHAT = {
  projectNumber: "123456789012",
  clientEmail: "mezonas-chat@mezonas-fake.iam.gserviceaccount.com",
  keyId: "fake-sa-key-1",
  chatKeyId: "fake-chat-key-1",
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
  exportKey(format: "pkcs8" | "spki", key: Key): Promise<ArrayBuffer>;
  sign(a: "RSASSA-PKCS1-v1_5", key: Key, data: Uint8Array): Promise<ArrayBuffer>;
  verify(a: "RSASSA-PKCS1-v1_5", key: Key, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
}
const subtle = () => (globalThis as unknown as { crypto: { subtle: FakeSubtle } }).crypto.subtle;

async function newPair(): Promise<Pair> {
  return subtle().generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
}

function pem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der);
  let body = "";
  for (let i = 0; i < b64.length; i += 64) body += `${b64.slice(i, i + 64)}\n`;
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

/** One DER element. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  const len =
    n < 0x80
      ? [n]
      : n < 0x100
        ? [0x81, n]
        : n < 0x10000
          ? [0x82, n >> 8, n & 0xff]
          : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  const out = new Uint8Array(1 + len.length + n);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A certificate-shaped DER around a public key: enough for reading its key (not a valid chain). */
function fakeCertificate(spki: Uint8Array): Uint8Array {
  // sha256WithRSAEncryption, NULL params.
  const algId = der(
    0x30,
    cat(
      der(0x06, new Uint8Array([42, 134, 72, 134, 247, 13, 1, 1, 11])),
      der(0x05, new Uint8Array()),
    ),
  );
  const name = der(
    0x30,
    der(0x31, der(0x30, cat(der(0x06, new Uint8Array([85, 4, 3])), der(0x0c, utf8(CHAT_ISSUER))))),
  );
  const time = (s: string) => der(0x17, utf8(s));
  const tbs = der(
    0x30,
    cat(
      der(0xa0, der(0x02, new Uint8Array([2]))),
      der(0x02, new Uint8Array([1, 2, 3, 4])),
      algId,
      name,
      der(0x30, cat(time("260101000000Z"), time("361231000000Z"))),
      name,
      spki,
    ),
  );
  return der(0x30, cat(tbs, algId, der(0x03, new Uint8Array([0, 1, 2, 3]))));
}

export interface FakeChatMessage {
  space: string;
  name: string;
  clientAssignedMessageId: string | null;
  requestId: string | null;
  text: string;
  createTime: string;
}

export interface FakeGoogleChat {
  fetch: FetchLike;
  /** The `GOOGLE_CHAT_SERVICE_ACCOUNT` secret. */
  serviceAccount: string;
  projectNumber: string;
  messages: FakeChatMessage[];
  requests: { url: string; method: string }[];
  /** Access tokens Google issued to the app (to check none reaches a response). */
  issued: string[];
  /** A token as Chat signs one; overrides for the refusal tests. */
  signEvent(opts?: {
    aud?: string;
    iss?: string;
    expiresInS?: number;
    kid?: string;
    signer?: "chat" | "stranger";
  }): Promise<string>;
  addAppTo(space: string): void;
  removeAppFrom(space: string): void;
  /** The next create is made and then the answer is lost (the fetch throws). */
  loseNextAnswer(): void;
  /** The next create is refused with this status. */
  failNext(status: number): void;
  /** A create seen again by `requestId` returns nothing (to reach the `messageId` path). */
  forgetRequestIds(): void;
  /** Every app access token stops working (a rotated key). */
  expireTokens(): void;
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

export async function fakeGoogleChat(): Promise<FakeGoogleChat> {
  const sa = await newPair();
  const chatKey = await newPair();
  const stranger = await newPair();
  const saPem = pem(
    "PRIVATE KEY",
    new Uint8Array(await subtle().exportKey("pkcs8", sa.privateKey)),
  );
  const chatCert = pem(
    "CERTIFICATE",
    fakeCertificate(new Uint8Array(await subtle().exportKey("spki", chatKey.publicKey))),
  );
  const serviceAccount = JSON.stringify({
    type: "service_account",
    project_id: "mezonas-fake",
    private_key_id: FAKE_GCHAT.keyId,
    private_key: saPem,
    client_email: FAKE_GCHAT.clientEmail,
    client_id: "100000000000000000001",
    token_uri: GOOGLE_TOKEN_URL,
  });

  let n = 0;
  const members = new Set<string>();
  const messages: FakeChatMessage[] = [];
  const requests: FakeGoogleChat["requests"] = [];
  const live = new Set<string>();
  const issued: string[] = [];
  let lose = false;
  let failStatus = 0;
  let byRequest = true;

  async function token(form: Record<string, string>): Promise<HttpResponseLike> {
    if (form.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return respond(400, { error: "unsupported_grant_type" });
    }
    const jwt = decodeJwt(form.assertion ?? "");
    const ok =
      jwt !== null &&
      jwt.header.alg === "RS256" &&
      (await subtle().verify("RSASSA-PKCS1-v1_5", sa.publicKey, jwt.signature, jwt.signingInput));
    const c = jwt?.claims ?? {};
    if (
      !ok ||
      c.iss !== FAKE_GCHAT.clientEmail ||
      c.aud !== GOOGLE_TOKEN_URL ||
      c.scope !== "https://www.googleapis.com/auth/chat.bot"
    ) {
      return respond(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    }
    const t = `ya29.fake-chat-${++n}`;
    live.add(t);
    issued.push(t);
    return respond(200, { access_token: t, expires_in: 3599, token_type: "Bearer" });
  }

  function authed(init: HttpRequestInit | undefined): boolean {
    const auth = init?.headers?.authorization ?? "";
    return auth.startsWith("Bearer ") && live.has(auth.slice("Bearer ".length));
  }

  function chatCall(path: string, query: URLSearchParamsLike, init: HttpRequestInit | undefined) {
    if (!authed(init)) {
      return respond(401, {
        error: {
          code: 401,
          message: "Request had invalid authentication credentials.",
          status: "UNAUTHENTICATED",
        },
      });
    }
    // /v1/spaces/{id}/messages[/{message}]
    const parts = path.split("/");
    if (parts.length < 5 || parts[1] !== "v1" || parts[2] !== "spaces" || parts[4] !== "messages") {
      return respond(404, { error: { code: 404, message: "Not found", status: "NOT_FOUND" } });
    }
    const space = `spaces/${parts[3]}`;
    if (!members.has(space)) {
      return respond(404, {
        error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
      });
    }
    const method = init?.method ?? "GET";
    if (method === "GET" && parts.length === 6) {
      const id = parts[5] ?? "";
      const m = messages.find(
        (x) =>
          x.space === space &&
          (x.name === `${space}/messages/${id}` || x.clientAssignedMessageId === id),
      );
      return m
        ? respond(200, view(m))
        : respond(404, {
            error: { code: 404, message: "Message not found.", status: "NOT_FOUND" },
          });
    }
    if (method !== "POST" || parts.length !== 5) {
      return respond(404, { error: { code: 404, message: "Not found", status: "NOT_FOUND" } });
    }
    if (failStatus) {
      const s = failStatus;
      failStatus = 0;
      return respond(s, {
        error: { code: s, message: "Internal error encountered.", status: "INTERNAL" },
      });
    }
    const requestId = query.get("requestId");
    const messageId = query.get("messageId");
    if (requestId && byRequest) {
      const seen = messages.find((x) => x.space === space && x.requestId === requestId);
      if (seen) return respond(200, view(seen));
    }
    if (messageId) {
      if (!messageId.startsWith("client-") || messageId.length > 63) {
        return respond(400, {
          error: { code: 400, message: "Invalid message id", status: "INVALID_ARGUMENT" },
        });
      }
      if (messages.some((x) => x.space === space && x.clientAssignedMessageId === messageId)) {
        return respond(409, {
          error: { code: 409, message: "Message already exists", status: "ALREADY_EXISTS" },
        });
      }
    }
    let body: { text?: unknown };
    try {
      body = JSON.parse(init?.body ?? "") as { text?: unknown };
    } catch {
      return respond(400, {
        error: { code: 400, message: "Invalid JSON", status: "INVALID_ARGUMENT" },
      });
    }
    if (typeof body.text !== "string" || body.text.length === 0 || body.text.length > 4096) {
      return respond(400, {
        error: { code: 400, message: "Invalid text", status: "INVALID_ARGUMENT" },
      });
    }
    const m: FakeChatMessage = {
      space,
      name: `${space}/messages/fake${++n}.fake${n}`,
      clientAssignedMessageId: messageId,
      requestId,
      text: body.text,
      createTime: new Date().toISOString(),
    };
    messages.push(m);
    return respond(200, view(m));
  }

  function view(m: FakeChatMessage) {
    return {
      name: m.name,
      text: m.text,
      createTime: m.createTime,
      space: { name: m.space },
      sender: { name: "users/app", type: "BOT" },
      ...(m.clientAssignedMessageId ? { clientAssignedMessageId: m.clientAssignedMessageId } : {}),
    };
  }

  const chatOrigin = parseUrl(CHAT_API)?.origin;
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    if (url === GOOGLE_TOKEN_URL && init?.method === "POST")
      return token(formDecode(init.body ?? ""));
    if (url === CHAT_CERTS_URL) {
      return respond(
        200,
        { [FAKE_GCHAT.chatKeyId]: chatCert },
        { "cache-control": "public, max-age=3600, must-revalidate" },
      );
    }
    const u = parseUrl(url);
    if (u && u.origin === chatOrigin) {
      const q = url.indexOf("?");
      const query = formDecode(q < 0 ? "" : url.slice(q + 1));
      const res = chatCall(u.pathname, { get: (k) => query[k] ?? null }, init);
      if (lose && (init?.method ?? "GET") === "POST" && res.status === 200) {
        lose = false;
        throw new TypeError("network connection lost");
      }
      return res;
    }
    return respond(404, { error: { code: 404, message: `no fake for ${url}` } });
  };

  return {
    fetch,
    serviceAccount,
    projectNumber: FAKE_GCHAT.projectNumber,
    messages,
    requests,
    issued,
    async signEvent(opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: "RS256", kid: opts.kid ?? FAKE_GCHAT.chatKeyId, typ: "JWT" };
      const claims = {
        iss: opts.iss ?? CHAT_ISSUER,
        aud: opts.aud ?? FAKE_GCHAT.projectNumber,
        iat: now,
        exp: now + (opts.expiresInS ?? 3600),
      };
      const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
      const input = `${part(header)}.${part(claims)}`;
      const key = opts.signer === "stranger" ? stranger.privateKey : chatKey.privateKey;
      const sig = await subtle().sign("RSASSA-PKCS1-v1_5", key, utf8(input));
      return `${input}.${toBase64Url(new Uint8Array(sig))}`;
    },
    addAppTo: (space) => void members.add(space),
    removeAppFrom: (space) => void members.delete(space),
    loseNextAnswer() {
      lose = true;
    },
    failNext(status) {
      failStatus = status;
    },
    forgetRequestIds() {
      byRequest = false;
    },
    expireTokens() {
      live.clear();
    },
  };
}

interface URLSearchParamsLike {
  get(name: string): string | null;
}
