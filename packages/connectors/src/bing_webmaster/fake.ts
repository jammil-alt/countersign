// A fake Bing Webmaster Tools (re-exported by @countersign/connectors/testing; never imported by
// the Worker): `GetQueryStats` and `GetPageStats` answering from the rows a test gives it, under
// `d`, with dates in Microsoft's JSON form at Pacific time as Bing shows them, and 401 for a key or
// site it doesn't know. Shaped like Bing's published JSON as far as we know it (NOTES.md).

import type { FetchLike, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { BING_API } from "./index";

export const FAKE_BING = {
  apiKey: "fake-bing-key-0123456789abcdef",
  siteUrl: "https://mezonas.com/",
} as const;

export interface FakeBingRow {
  day: string;
  query: string;
  url: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface FakeBing {
  fetch: FetchLike;
  rows: FakeBingRow[];
  /** Methods asked, in order (never the key). */
  calls: string[];
  failNext(status: number): void;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    text: async () => text,
  };
}

/** A day as Bing writes it: midnight Pacific (UTC−7 in summer), `/Date(ms-0700)/`. */
export function bingDate(day: string): string {
  return `/Date(${Date.parse(`${day}T07:00:00Z`)}-0700)/`;
}

export function fakeBing(rows: FakeBingRow[] = []): FakeBing {
  let fail = 0;
  const fake: FakeBing = {
    fetch: async () => respond(500, {}),
    rows,
    calls: [],
    failNext(status) {
      fail = status;
    },
  };
  fake.fetch = async (url) => {
    const u = parseUrl(url);
    if (!u || !url.startsWith(`${BING_API}/`)) return respond(404, {});
    const method = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
    const q = formDecode(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
    fake.calls.push(method);
    if (fail) {
      const status = fail;
      fail = 0;
      return respond(status, { ErrorCode: 0, Message: "fail" });
    }
    if (q.apikey !== FAKE_BING.apiKey) {
      return respond(401, { ErrorCode: 3, Message: "InvalidApiKey" });
    }
    if (q.siteUrl !== FAKE_BING.siteUrl) {
      // UNCHECKED: Bing's answer for a site the key's user can't see; an error object, no `d`.
      return respond(200, { ErrorCode: 14, Message: "NotAuthorized" });
    }
    const by = method === "GetPageStats" ? "url" : method === "GetQueryStats" ? "query" : null;
    if (!by) return respond(404, {});
    const groups = new Map<string, { key: string; day: string; i: number; c: number; w: number }>();
    for (const r of fake.rows) {
      const key = r[by];
      const k = `${r.day}\u0000${key}`;
      const g = groups.get(k) ?? { key, day: r.day, i: 0, c: 0, w: 0 };
      g.i += r.impressions;
      g.c += r.clicks;
      g.w += r.position * r.impressions;
      groups.set(k, g);
    }
    return respond(200, {
      d: [...groups.values()].map((g) => ({
        __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
        AvgClickPosition: -1,
        AvgImpressionPosition: g.i > 0 ? g.w / g.i : -1,
        Clicks: g.c,
        Date: bingDate(g.day),
        Impressions: g.i,
        Query: g.key,
      })),
    });
  };
  return fake;
}
