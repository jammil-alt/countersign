// A fake Google Search Console (re-exported by @countersign/connectors/testing; never imported by
// the Worker): a service account with a real RSA key, Google's token endpoint checking the signed
// assertion and its `webmasters.readonly` scope, and the Search Analytics query answering from the
// rows a test gives it, by `date` and `page` or `date`, `query` and `page`, with `rowLimit` and
// `startRow`, final figures only (days up to `finalThrough`), and 403 for a property the account
// isn't a user on. Shaped like Google's answers as far as we know them (NOTES.md).

import { decodeJwt } from "../gchat/jwt";
import { GOOGLE_TOKEN_URL } from "../gmail/index";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { toBase64 } from "../runtime";
import { GSC_API, GSC_SCOPE } from "./index";

export const FAKE_GSC = {
  clientEmail: "search-reader@mezonas-fake.iam.gserviceaccount.com",
  keyId: "fake-gsc-key-1",
  property: "sc-domain:mezonas.com",
} as const;

interface Key {
  readonly type: string;
}
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
interface FakeSubtle {
  generateKey(
    a: typeof ALG & { modulusLength: number; publicExponent: Uint8Array },
    extractable: boolean,
    usages: string[],
  ): Promise<{ privateKey: Key; publicKey: Key }>;
  exportKey(format: "pkcs8", key: Key): Promise<ArrayBuffer>;
  verify(a: "RSASSA-PKCS1-v1_5", key: Key, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
}
const subtle = () => (globalThis as unknown as { crypto: { subtle: FakeSubtle } }).crypto.subtle;

function pem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der);
  let body = "";
  for (let i = 0; i < b64.length; i += 64) body += `${b64.slice(i, i + 64)}\n`;
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

/** One row of the fake's figures: a day, a query and a page's URL. */
export interface FakeGscRow {
  day: string;
  query: string;
  url: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface FakeSearchConsole {
  fetch: FetchLike;
  /** The service account's key JSON, as Google Cloud downloads it. */
  serviceAccountKey: string;
  /** Another account's key, which Google refuses. */
  strangerKey: string;
  rows: FakeGscRow[];
  /** Days after this are not final yet: not answered. */
  finalThrough: string;
  /** Properties the account is a user on. */
  properties: Set<string>;
  /** The next query answers this status (once). */
  failNext(status: number): void;
  /** The queries asked: dimensions and span (never the token). */
  queries: { property: string; dimensions: string[]; from: string; to: string; startRow: number }[];
  /** Every URL fetched, in order. */
  urls: string[];
}

export async function fakeSearchConsole(
  options: { rows?: FakeGscRow[]; finalThrough?: string } = {},
): Promise<FakeSearchConsole> {
  const generate = () =>
    subtle().generateKey(
      { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    );
  const sa = await generate();
  const stranger = await generate();
  const keyJson = async (privateKey: Key, email: string) =>
    JSON.stringify({
      type: "service_account",
      project_id: "mezonas-fake",
      private_key_id: FAKE_GSC.keyId,
      private_key: pem(
        "PRIVATE KEY",
        new Uint8Array(await subtle().exportKey("pkcs8", privateKey)),
      ),
      client_email: email,
      token_uri: GOOGLE_TOKEN_URL,
    });
  const live = new Set<string>();
  let n = 0;
  let fail = 0;
  const fake: FakeSearchConsole = {
    fetch: async () => respond(500, {}),
    serviceAccountKey: await keyJson(sa.privateKey, FAKE_GSC.clientEmail),
    strangerKey: await keyJson(stranger.privateKey, "stranger@other.iam.gserviceaccount.com"),
    rows: options.rows ?? [],
    finalThrough: options.finalThrough ?? "9999-12-31",
    properties: new Set([FAKE_GSC.property]),
    failNext(status) {
      fail = status;
    },
    queries: [],
    urls: [],
  };

  async function token(init: HttpRequestInit | undefined) {
    const form = formDecode(init?.body ?? "");
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
      c.iss !== FAKE_GSC.clientEmail ||
      c.aud !== GOOGLE_TOKEN_URL ||
      c.scope !== GSC_SCOPE
    ) {
      return respond(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    }
    const t = `ya29.fake-gsc-${++n}`;
    live.add(t);
    return respond(200, { access_token: t, expires_in: 3599, token_type: "Bearer" });
  }

  function query(url: string, init: HttpRequestInit | undefined) {
    const auth = init?.headers?.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !live.has(auth.slice("Bearer ".length))) {
      return respond(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    }
    if (fail) {
      const status = fail;
      fail = 0;
      return respond(status, { error: { code: status, message: "something went wrong" } });
    }
    const rest = url.slice(`${GSC_API}/`.length);
    const property = decodeURIComponent(rest.slice(0, rest.indexOf("/searchAnalytics/query")));
    if (!fake.properties.has(property)) {
      return respond(403, {
        error: { code: 403, message: "User does not have sufficient permission for site." },
      });
    }
    const body = JSON.parse(init?.body ?? "{}") as {
      startDate: string;
      endDate: string;
      dimensions: string[];
      dataState?: string;
      rowLimit?: number;
      startRow?: number;
    };
    const startRow = body.startRow ?? 0;
    fake.queries.push({
      property,
      dimensions: body.dimensions,
      from: body.startDate,
      to: body.endDate,
      startRow,
    });
    const until = body.dataState === "final" ? fake.finalThrough : "9999-12-31";
    const groups = new Map<string, { keys: string[]; i: number; c: number; w: number }>();
    for (const r of fake.rows) {
      if (r.day < body.startDate || r.day > body.endDate || r.day > until) continue;
      const keys = body.dimensions.map((d) =>
        d === "date" ? r.day : d === "query" ? r.query : d === "page" ? r.url : "",
      );
      const k = keys.join("\u0000");
      const g = groups.get(k) ?? { keys, i: 0, c: 0, w: 0 };
      g.i += r.impressions;
      g.c += r.clicks;
      g.w += r.position * r.impressions;
      groups.set(k, g);
    }
    const all = [...groups.values()]
      .sort((a, b) => b.c - a.c || b.i - a.i || (a.keys.join() < b.keys.join() ? -1 : 1))
      .map((g) => ({
        keys: g.keys,
        clicks: g.c,
        impressions: g.i,
        ctr: g.i > 0 ? g.c / g.i : 0,
        position: g.i > 0 ? g.w / g.i : 0,
      }));
    const page = all.slice(startRow, startRow + (body.rowLimit ?? 1000));
    // Google leaves `rows` out when there are none.
    return respond(200, page.length ? { rows: page, responseAggregationType: "byPage" } : {});
  }

  fake.fetch = async (url, init) => {
    fake.urls.push(url);
    if (url === GOOGLE_TOKEN_URL) return token(init);
    if (url.startsWith(`${GSC_API}/`) && url.endsWith("/searchAnalytics/query")) {
      return query(url, init);
    }
    return respond(404, { error: { code: 404, message: "Not found" } });
  };
  return fake;
}
