/**
 * Measuring a client's website, the pure half (docs/marketing-plan.md §4.3; ported from Plenary
 * Labs' `apps/site/src/analytics.ts`, copied, not shared).
 *
 * The page's script reports what happened: a view, time engaged, how far down the reader got, a
 * click on a tracked element, a form coming into sight. This module turns those reports into the
 * events the pack stores (./collect.ts), adding what only the server knows and dropping what must
 * never be kept:
 *
 * - **The visit**: a hash of the site's salt for the day, the IP address and the user agent.
 *   Neither the IP nor the user agent goes further than `visitHash`, and the salt is deleted once
 *   its day is over, so the hash cannot be made again or followed into another day.
 * - **Where the visitor is**: country, region, city and time zone, as Cloudflare places the
 *   connection. Approximate, and sometimes missing.
 * - **What they read with**: phone, tablet or desktop, and the browser and operating system
 *   *families*, from the user agent. The user agent string itself is not kept.
 * - **Where they came from**: campaign tags when the address has them, otherwise the referrer,
 *   classified into direct, search, social, referral or internal. The query string of the page
 *   and of the referrer is never kept; only the `utm_*` tags are read out of it.
 *
 * Everything here is pure except `visitHash`, which uses Web Crypto.
 */

export const SOURCE_GROUPS = [
  "direct",
  "search",
  "social",
  "referral",
  "campaign",
  "internal",
] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];
export const DEVICE_CLASSES = ["phone", "tablet", "desktop"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
/** Why a request was not counted (`site_bot_daily.reason`). */
export const BOT_REASONS = ["user_agent", "webdriver", "rate", "malformed"] as const;
export type BotReason = (typeof BOT_REASONS)[number];
export const EVENT_KINDS = ["view", "engage", "click", "form_seen"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The most a page sends in one beacon. */
export const MAX_EVENTS = 20;
/** A beacon larger than this is not a page's. */
export const MAX_BEACON_BYTES = 16_384;

/** `data-track` names: lower case, digits and hyphens, as the app's test ids. */
export const TRACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What the page's script sends, one entry per thing that happened. Short keys: it is sent a lot. */
export type ClientEvent =
  | { k: "view"; id: string; p: string; q?: string; r?: string; wd?: boolean }
  | { k: "engage"; id: string; p: string; ms: number; s: number }
  | { k: "click"; id: string; p: string; n: string; y: number }
  | { k: "form_seen"; id: string; p: string; f: string };

/** The event the pack stores (`site_event`), without its client and site. */
export type SiteEvent = {
  day: string;
  visit: string;
  viewId: string;
  kind: EventKind;
  at: string;
  path: string;
  referrerHost?: string;
  referrerPath?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  sourceGroup?: SourceGroup;
  sourceName?: string;
  country?: string;
  region?: string;
  city?: string;
  timeZone?: string;
  device?: DeviceClass;
  browser?: string;
  os?: string;
  language?: string;
  engagedMs?: number;
  scroll?: number;
  target?: string;
  position?: number;
  form?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
const isPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  value.length <= 512;
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const shortString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
/** One reported event, checked field by field; anything else is null. */
function parseEvent(value: unknown): ClientEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !UUID.test(e.id) || !isPath(e.p)) return null;
  switch (e.k) {
    case "view":
      if (e.q !== undefined && (typeof e.q !== "string" || e.q.length > 2048)) return null;
      if (e.r !== undefined && (typeof e.r !== "string" || e.r.length > 2048)) return null;
      return {
        k: "view",
        id: e.id,
        p: e.p,
        ...(typeof e.q === "string" ? { q: e.q } : {}),
        ...(typeof e.r === "string" ? { r: e.r } : {}),
        ...(e.wd === true ? { wd: true } : {}),
      };
    case "engage":
      if (!isInt(e.ms, 0, 3_600_000) || !isInt(e.s, 0, 4)) return null;
      return { k: "engage", id: e.id, p: e.p, ms: e.ms, s: e.s };
    case "click":
      if (typeof e.n !== "string" || !TRACK_NAME.test(e.n) || !isInt(e.y, 0, 100)) return null;
      return { k: "click", id: e.id, p: e.p, n: e.n, y: e.y };
    case "form_seen":
      if (!shortString(e.f, 40)) return null;
      return { k: "form_seen", id: e.id, p: e.p, f: e.f };
    default:
      return null;
  }
}

/** A beacon's body: `{"events": [...]}` with one to `MAX_EVENTS` valid events, or null. */
export function parseBeacon(text: string): ClientEvent[] | null {
  if (text.length > MAX_BEACON_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return null;
  const parsed = events.map(parseEvent);
  return parsed.every((event) => event !== null) ? (parsed as ClientEvent[]) : null;
}

// ── Where a visit came from ────────────────────────────────────────────────────────────────────

/** Hosts by what they are, matched on the host or any parent domain. */
const SEARCH: Record<string, string> = {
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "search.yahoo.com": "yahoo",
  "ecosia.org": "ecosia",
  "search.brave.com": "brave",
  "kagi.com": "kagi",
  "startpage.com": "startpage",
  "qwant.com": "qwant",
  "baidu.com": "baidu",
  "perplexity.ai": "perplexity",
  "chatgpt.com": "chatgpt",
};
const SOCIAL: Record<string, string> = {
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "x.com": "x",
  "twitter.com": "x",
  "t.co": "x",
  "facebook.com": "facebook",
  "fb.me": "facebook",
  "instagram.com": "instagram",
  "threads.net": "threads",
  "bsky.app": "bluesky",
  "mastodon.social": "mastodon",
  "youtube.com": "youtube",
  "tiktok.com": "tiktok",
};

/** The entry in `table` for `host` or the nearest parent domain that has one. */
function lookup(table: Record<string, string>, host: string): string | undefined {
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const name = table[labels.slice(i).join(".")];
    if (name) return name;
  }
  return undefined;
}

/** Google's many country domains (`google.com`, `google.co.uk`, `google.de`), and nothing else. */
const isGoogle = (host: string) => /(^|\.)google\.(com|[a-z]{2}|com?\.[a-z]{2})$/.test(host);

const clip = (value: string | null, max: number) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

export type Source = {
  sourceGroup: SourceGroup;
  sourceName?: string;
  referrerHost?: string;
  referrerPath?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
};

/**
 * Where a page view came from. Campaign tags win when present, whatever the referrer: they are
 * the only way to know which link was followed, since most sites send only their own origin as
 * the referrer. A referrer on this site, or on the app, is `internal`.
 */
export function classifySource(input: {
  search?: string | undefined;
  referrer?: string | undefined;
  siteHost: string;
}): Source {
  const params = new URLSearchParams(input.search ?? "");
  const utm = {
    utmSource: clip(params.get("utm_source"), 100),
    utmMedium: clip(params.get("utm_medium"), 100),
    utmCampaign: clip(params.get("utm_campaign"), 100),
    utmContent: clip(params.get("utm_content"), 100),
  };
  const tags = Object.fromEntries(Object.entries(utm).filter(([, value]) => value !== undefined));

  let referrer: URL | null = null;
  try {
    referrer = input.referrer ? new URL(input.referrer) : null;
  } catch {
    referrer = null;
  }
  const host =
    referrer && /^https?:$/.test(referrer.protocol)
      ? referrer.hostname
          .toLowerCase()
          .replace(/^www\./, "")
          .slice(0, 253)
      : undefined;
  const siteRoot = input.siteHost.toLowerCase().replace(/^www\./, "");
  const internal = host !== undefined && (host === siteRoot || host.endsWith(`.${siteRoot}`));

  const campaign = utm.utmCampaign ?? utm.utmSource;
  if (campaign !== undefined) {
    return {
      sourceGroup: "campaign",
      sourceName: campaign,
      ...(host && !internal ? { referrerHost: host } : {}),
      ...tags,
    };
  }
  if (host === undefined) return { sourceGroup: "direct" };
  if (internal) return { sourceGroup: "internal", referrerHost: host };

  const search = isGoogle(host) ? "google" : lookup(SEARCH, host);
  if (search) return { sourceGroup: "search", sourceName: search, referrerHost: host };
  const social = lookup(SOCIAL, host);
  if (social) return { sourceGroup: "social", sourceName: social, referrerHost: host };

  // Another site: the path is worth keeping (which post linked here) when the site sends one;
  // its query string never is.
  const path = referrer && referrer.pathname !== "/" ? referrer.pathname.slice(0, 512) : undefined;
  return {
    sourceGroup: "referral",
    sourceName: host,
    referrerHost: host,
    ...(path ? { referrerPath: path } : {}),
  };
}

// ── Who is reading, in categories ──────────────────────────────────────────────────────────────

/** Phone, tablet or computer, from the user agent alone: nothing is read from the browser. */
export function deviceOf(ua: string): DeviceClass {
  // An iPad in desktop mode says "Macintosh" and is counted as a computer.
  if (/iPad|Tablet|PlayBook|Silk|Kindle/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) {
    return "tablet";
  }
  if (/Mobi|iPhone|iPod|Android|Windows Phone/.test(ua)) return "phone";
  return "desktop";
}

/**
 * The reader's first language from the request's `Accept-Language` header, which every request
 * carries: "en-GB" from "en-GB,en;q=0.9". Undefined for none, "*", or anything malformed.
 */
export function languageOf(header: string | null): string | undefined {
  const first = header?.split(",")[0]?.split(";")[0]?.trim();
  return first && first.length <= 35 && LANGUAGE.test(first) ? first : undefined;
}

/** The browser's family from its user agent: the string itself goes no further. */
export function browserOf(ua: string): string {
  if (/Edg(A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return "Other";
}

/** The operating system's family from the user agent. */
export function osOf(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

/**
 * Crawlers, link previewers, monitors and scripts, by their user agent. Not exhaustive and not
 * meant to be: most of them never run the page's script, so they never send a beacon at all. This
 * is for counting the ones that ask for a page, and for dropping the few that run scripts.
 */
const BOT =
  /bot\b|bot\/|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|preview|pinterest|vkshare|w3c_validator|whatsapp|bingpreview|yandex|baiduspider|semrush|ahrefs|mj12|petalbot|bytespider|gptbot|claudebot|claude-web|anthropic-ai|perplexity|ccbot|headlesschrome|phantomjs|lighthouse|pagespeed|chrome-lighthouse|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp|axios|node-fetch|undici|postman|insomnia|httpclient|scrapy|uptime|pingdom|statuscake|monitor/i;

export function isBotAgent(ua: string): boolean {
  return ua.trim() === "" || BOT.test(ua);
}

// ── The visit ──────────────────────────────────────────────────────────────────────────────────

/** The UTC day of an instant, `YYYY-MM-DD`: the day a visit hash belongs to. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * One browser on one day: SHA-256 over the day's salt, the IP address and the user agent, cut to
 * 128 bits. The inputs stay here; only the hash is handed on.
 */
export async function visitHash(salt: string, ip: string, ua: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\n${ip}\n${ua}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Where Cloudflare places a request, as far as it can. Never the address itself. */
export type Place = { country?: string; region?: string; city?: string; timeZone?: string };

export function placeOf(cf: Record<string, unknown> | undefined): Place {
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;
  const country = text(cf?.country, 2);
  const place: Place = {};
  // Cloudflare marks Tor as `T1` and unknown as `XX`: neither is a country.
  if (country && /^[A-Z]{2}$/.test(country) && country !== "XX") place.country = country;
  const region = text(cf?.region, 100);
  if (region) place.region = region;
  const city = text(cf?.city, 100);
  if (city) place.city = city;
  const timeZone = text(cf?.timezone, 64);
  if (timeZone) place.timeZone = timeZone;
  return place;
}

/**
 * The events to store for one beacon. A view carries the visit's context; the others carry only
 * their own fields.
 */
export function toSiteEvents(
  events: readonly ClientEvent[],
  context: {
    day: string;
    visit: string;
    at: string;
    ua: string;
    language?: string | undefined;
    place: Place;
    siteHost: string;
  },
): SiteEvent[] {
  return events.map((event) => {
    const base = {
      day: context.day,
      visit: context.visit,
      viewId: event.id,
      at: context.at,
      path: event.p,
    };
    switch (event.k) {
      case "view": {
        const language = context.language;
        return {
          ...base,
          kind: "view",
          ...classifySource({ search: event.q, referrer: event.r, siteHost: context.siteHost }),
          ...context.place,
          device: deviceOf(context.ua),
          browser: browserOf(context.ua),
          os: osOf(context.ua),
          ...(language ? { language } : {}),
        };
      }
      case "engage":
        return { ...base, kind: "engage", engagedMs: event.ms, scroll: event.s };
      case "click":
        return { ...base, kind: "click", target: event.n, position: event.y };
      default:
        // `form_seen`: the only kind left.
        return { ...base, kind: "form_seen", form: event.f };
    }
  });
}
